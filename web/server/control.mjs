import { WebSocketServer } from "ws";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, openSync, closeSync, unlinkSync, statfsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from "node:os";
import path from "node:path";
import { resolveProxyEgress, resetTzCache } from "@tah/tz";
import { createDistributedControlStore } from "./distributed-store.mjs";
import { extractExactQuerySuffix } from "./exact-suffix.mjs";
import { verifySessionToken } from "../lib/session-token.mjs";
import { computeCampaignLaunchGapMs, evaluateResourceAdmission } from "./resource-admission.mjs";
import { createSerializedStateWriter } from "./serialized-state-writer.mjs";
import { createOrchestratorWorkerPool } from "./orchestrator-worker-pool.mjs";

function normalizedGoogleAdsId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function assertScriptFleetTarget({ customerId, campaignId }) {
  const normalizedCustomerId = normalizedGoogleAdsId(customerId);
  const normalizedCampaignId = normalizedGoogleAdsId(campaignId);
  if (!/^\d{10}$/.test(normalizedCustomerId)) {
    throw new Error("Rolling Apps Script Fleet requires a 10-digit Google Ads customer ID.");
  }
  if (!/^\d{1,20}$/.test(normalizedCampaignId)) {
    throw new Error("Rolling Apps Script Fleet requires a valid Google Ads campaign ID.");
  }
  return {
    customerId: normalizedCustomerId,
    campaignId: normalizedCampaignId,
  };
}

async function scriptBridgeRequest(body) {
  const token = process.env.TAH_API_BEARER_TOKEN ?? process.env.TAH_API_TOKEN ?? process.env.TAH_BEARER_TOKEN ?? "";
  const headers = { "content-type": "application/json" };
  if (token) {
    headers["x-api-key"] = token;
    headers.authorization = token.startsWith("Bearer ") ? token : "Bearer " + token;
  }
  const response = await fetch(new URL("/api/script-bridge", webAppUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw new Error(result.error ?? "Fleet API returned HTTP " + response.status);
  return result;
}
const PORT = Number(process.env.WS_PORT ?? 3101);
const ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();
const ORCH = process.env.ORCH_BIN ?? path.join(ROOT, "packages/orchestrator/dist/cli.js");
const ORCH_WORKER = process.env.ORCH_WORKER_BIN ?? path.join(ROOT, "packages/orchestrator/dist/worker.js");
const SCENARIOS = process.env.SCENARIO_DIR ?? path.join(ROOT, "runs", "scenarios");
const ORIGINS = new Set((process.env.CONTROL_ALLOWED_ORIGINS ?? "http://127.0.0.1:3100,http://localhost:3100").split(","));
const MAX_SAVED_CAMPAIGNS = 5_000;
let activeLimit = Math.min(5_000, Math.max(1, Number(process.env.TAH_MAX_ACTIVE_RUNS ?? 500)));
const MAX_LOCAL_WORKERS = Math.min(5_000, Math.max(1, Number(process.env.TAH_MAX_LOCAL_WORKERS ?? 100)));
const MAX_TOTAL_CONCURRENCY = Number(process.env.TAH_MAX_TOTAL_CONCURRENCY ?? 64);
const MAX_BROWSER_CONCURRENCY = Number(process.env.TAH_MAX_BROWSER_CONCURRENCY ?? 8);
const CAMPAIGN_START_SPREAD_MS = Math.max(0, Number(process.env.TAH_CAMPAIGN_START_SPREAD_MS ?? 58_000));
const CAMPAIGN_START_GAP_MS = Math.max(0, Number(process.env.TAH_CAMPAIGN_START_GAP_MS ?? computeCampaignLaunchGapMs(MAX_LOCAL_WORKERS, CAMPAIGN_START_SPREAD_MS)));
const SHARED_ORCHESTRATOR_ENABLED = process.env.TAH_SHARED_ORCHESTRATOR !== "false";
const SHARED_WORKER_PROCESSES = Math.min(16, Math.max(1, Number(process.env.TAH_SHARED_WORKER_PROCESSES ?? Math.min(4, Math.max(1, cpus().length)))));
const SHARED_WORKER_SLOTS = Math.min(5_000, Math.max(1, Number(process.env.TAH_SHARED_WORKER_SLOTS ?? Math.ceil(MAX_LOCAL_WORKERS / SHARED_WORKER_PROCESSES))));
const RECOMMENDED_VCPU_FOR_100_BROWSER_CAMPAIGNS = Math.max(8, Number(process.env.TAH_RECOMMENDED_VCPU_FOR_100_BROWSER_CAMPAIGNS ?? 8));
const MIN_AVAILABLE_MEMORY_RATIO = Math.min(0.5, Math.max(0.05, Number(process.env.TAH_MIN_AVAILABLE_MEMORY_RATIO ?? 0.15)));
const MAX_NORMALIZED_SYSTEM_LOAD = Math.min(4, Math.max(0.5, Number(process.env.TAH_MAX_NORMALIZED_SYSTEM_LOAD ?? 0.85)));
const RESOURCE_ADMISSION_RETRY_MS = Math.max(1_000, Number(process.env.TAH_RESOURCE_ADMISSION_RETRY_MS ?? 5_000));
const MAX_TOTAL_RPS = Number(process.env.TAH_MAX_TOTAL_RPS ?? 500);
const ALLOWED_TARGETS = (process.env.TAH_ALLOWED_TARGETS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
const STAGING_TARGETS = (process.env.TAH_STAGING_TARGETS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
const clients = new Set();
const routeTelemetry = { since: Date.now(), preflightAttempts: 0, redirectFirstCaptures: 0, browserFallbacks: 0, cachedFallbacks: 0, fallbackReasons: new Map() };
const orchestratorWorkers = createOrchestratorWorkerPool({
  workerFile: ORCH_WORKER,
  cwd: ROOT,
  processCount: SHARED_WORKER_PROCESSES,
  slotsPerProcess: SHARED_WORKER_SLOTS,
  onWorkerLog: (workerId, stream, data) => broadcast("log", { id: workerId, stream, data: String(data).slice(0, 16_384) }),
});
let leaderLosses = 0;
const runs = new Map();
const captureQueues = new Map();
const schedules = new Map();
const campaigns = new Map();
const registryPath = path.join(ROOT, "runs", "control-runs.json");
const scheduleRegistryPath = path.join(ROOT, "runs", "control-schedules.json");
const campaignRegistryPath = path.join(ROOT, "runs", "campaigns.json");
const controlSettingsPath = path.join(ROOT, "runs", "control-settings.json");
const controlLockPath = path.join(ROOT, "runs", ".control-server.lock");
const legacyCredentialKeyPath = path.join(ROOT, "runs", ".proxy-credentials.key");
const credentialBlobPath = path.join(ROOT, "runs", "proxy-credentials.enc.json");
const adsStatePath = process.env.TAH_ADS_CAPTURE_STATE_PATH || path.join(ROOT, "runs", "ads-capture-state.json");
const webAppUrl = process.env.TAH_WEB_APP_URL ?? "http://127.0.0.1:3100";
let sequence = 0;
let campaignSequence = 0;
let resourceAdmissionBlocks = 0;
let unchangedSuffixDeliveriesSkipped = 0;
const controlInstanceId = `${process.env.HOSTNAME ?? "local"}:${process.pid}:${randomUUID()}`;
const distributedStore = await createDistributedControlStore({
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  instanceId: controlInstanceId,
  required: process.env.TAH_DISTRIBUTED_REQUIRED === "true",
});
const queueDistributedStateSave = createSerializedStateWriter((name, value) => distributedStore.saveState(name, value));
const leaderLeaseMs = Math.max(5_000, Number(process.env.TAH_LEADER_LEASE_MS ?? 15_000));

function acquireControlLock() {
  mkdirSync(path.dirname(controlLockPath), { recursive: true });
  try {
    const fd = openSync(controlLockPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existingPid = 0;
    try { existingPid = Number(JSON.parse(readFileSync(controlLockPath, "utf8")).pid); } catch { /* stale lock */ }
    let alive = false;
    try { if (existingPid > 0) { process.kill(existingPid, 0); alive = true; } } catch { /* stale lock */ }
    if (alive) throw new Error(`Another control server is already running with PID ${existingPid}`);
    try { unlinkSync(controlLockPath); } catch { /* raced with cleanup */ }
    const fd = openSync(controlLockPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
  }
}
if (distributedStore.enabled) {
for (;;) {
  try {
    if (await distributedStore.acquireLeader(leaderLeaseMs)) break;
    console.warn("Distributed leader lease is held by another instance; waiting in standby");
  } catch (error) {
    console.error("Distributed leader acquisition failed; retrying:", error instanceof Error ? error.message : String(error));
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(2_000, Math.floor(leaderLeaseMs / 3))));
}
} else acquireControlLock();
process.on("exit", () => { try { unlinkSync(controlLockPath); } catch { /* already removed */ } });
const inheritedPort = Number(process.env.IPROYAL_PORT ?? 12321);
let proxy = process.env.IPROYAL_USER && process.env.IPROYAL_PASS ? {
  host: process.env.IPROYAL_HOSTNAME ?? "geo.iproyal.com", port: inheritedPort === 51230 ? 12321 : inheritedPort,
  user: process.env.IPROYAL_USER, pass: process.env.IPROYAL_PASS, verified: false,
} : null;
if (!proxy) {
  try { proxy = { ...loadStoredProxy(), verified: false, stored: true }; } catch { proxy = null; }
}

function credentialKey() {
  const raw = String(process.env.TAH_STATE_ENCRYPTION_KEY ?? "").trim();
  if (!raw) throw new Error("TAH_STATE_ENCRYPTION_KEY is required to store proxy credentials");
  const value = raw.startsWith("base64:") ? raw.slice(7) : raw;
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("TAH_STATE_ENCRYPTION_KEY must encode exactly 32 bytes");
  return key;
}

function decryptProxyConfig(blob, key) {
  const ivEncoding = blob.version === 2 ? "base64url" : "base64";
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, ivEncoding));
  if (blob.version === 2) decipher.setAAD(Buffer.from("traffic-armour:proxy-credentials:v2", "utf8"));
  decipher.setAuthTag(Buffer.from(blob.tag, ivEncoding));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.data, ivEncoding)), decipher.final()]).toString("utf8"));
}

function persistProxyConfig(value) {
  mkdirSync(path.dirname(credentialBlobPath), { recursive: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  cipher.setAAD(Buffer.from("traffic-armour:proxy-credentials:v2", "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ host: value.host, port: value.port, user: value.user, pass: value.pass }), "utf8"), cipher.final()]);
  const temporary = `${credentialBlobPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 2, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: encrypted.toString("base64url") }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, credentialBlobPath);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function loadStoredProxy() {
  const blob = JSON.parse(readFileSync(credentialBlobPath, "utf8"));
  try {
    return decryptProxyConfig(blob, credentialKey());
  } catch (currentError) {
    if (blob.version !== 1 || !existsSync(legacyCredentialKeyPath)) throw currentError;
    const legacyKey = Buffer.from(readFileSync(legacyCredentialKeyPath, "utf8").trim(), "base64");
    if (legacyKey.length !== 32) throw currentError;
    const value = decryptProxyConfig(blob, legacyKey);
    persistProxyConfig(value);
    try { unlinkSync(legacyCredentialKeyPath); } catch { /* migration already completed */ }
    return value;
  }
}

function clearStoredProxy() {
  try { unlinkSync(credentialBlobPath); } catch { /* no stored credentials */ }
  try { unlinkSync(legacyCredentialKeyPath); } catch { /* no legacy key */ }
}

const send = (ws, type, payload) => ws.send(JSON.stringify({ type, payload }));
const broadcast = (type, payload) => { for (const ws of clients) if (ws.readyState === 1) send(ws, type, payload); };
const maskIp = (ip) => ip?.includes(":") ? `${ip.split(":").slice(0, 3).join(":")}:***` : ip?.replace(/\.\d+$/, ".***");
const status = () => process.env.TAH_NO_PROXY === "1" ? { configured: true, verified: true, host: "direct", port: 0 } : proxy ? {
  configured: proxy.verified === true,
  verified: proxy.verified === true,
  host: proxy.host,
  port: proxy.port,
  user: `${proxy.user.slice(0, 3)}***`,
  egressIp: maskIp(proxy.egress?.ip),
  timezone: proxy.egress?.timezone,
  location: [proxy.egress?.city, proxy.egress?.state, proxy.egress?.country].filter(Boolean).join(", ") || undefined,
  verifiedAt: proxy.verifiedAt,
  stored: proxy.stored === true,
} : { configured: false, verified: false };
const clean = (value, max = 120) => String(value ?? "").trim().slice(0, max);
const scalar = (value) => JSON.stringify(String(value));
const atomicWriteJson = (filePath, value, mode) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", ...(mode ? { mode } : {}) });
  renameSync(temporary, filePath);
};

function captureExactL4Suffix(run) {
  if (run.tier !== "human") return null;
  const resultsPath = path.join(ROOT, "runs", run.id, "scenarios.jsonl");
  if (!existsSync(resultsPath)) throw new Error("L4 results file was not created");
  const results = readFileSync(resultsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const result = [...results].reverse().find(item => {
    if (item.tier !== "human" || typeof item.final_landing_url !== "string") return false;
    return extractExactQuerySuffix(item.final_landing_url) !== null;
  });
  if (!result) return null;

  return persistL4Capture(run, result);
}

function persistL4Capture(run, result) {
  const finalUrl = result.final_landing_url;
  if (typeof finalUrl !== "string") return null;
  const suffix = extractExactQuerySuffix(finalUrl);
  if (suffix === null) return null;
  let state = {};
  try { state = JSON.parse(readFileSync(adsStatePath, "utf8")); } catch { /* first capture */ }
  const capturedAt = new Date().toISOString();
  const capture = {
    capturedAt,
    runId: run.id,
    scenarioId: run.scenarioId,
    sessionId: result.session_id,
    repeatIndex: result.repeat_index,
    finalUrl,
    suffix,
  };
  if (run.campaignRecordId) {
    const campaign = campaigns.get(run.campaignRecordId);
    if (campaign) {
      const history = Array.isArray(campaign.captureHistory) ? campaign.captureHistory : [];
      campaign.latestSuffix = suffix;
      campaign.lastCapturedAt = capturedAt;
      campaign.captureHistory = [...history, capture].slice(-100);
      campaign.updatedAt = capturedAt;
      persistCampaigns();
    }
  }
  const history = Array.isArray(state.l4CaptureHistory) ? state.l4CaptureHistory : [];
  try {
    atomicWriteJson(adsStatePath, {
      ...state,
      suffix,
      finalQuery: suffix,
      finalUrl,
      capturedAt,
      capturedBy: "l4-browser",
      capturedRunId: run.id,
      capturedSessionId: result.session_id,
      l4CaptureHistory: [...history, capture].slice(-100),
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      level: "warn",
      event: "ads.capture_mirror_failed",
      runId: run.id,
      message: error instanceof Error ? error.message : String(error),
      ts: new Date().toISOString(),
    })}\n`);
  }
  return capture;
}

function queueL4Capture(run, result) {
  const previous = captureQueues.get(run.id) ?? Promise.resolve();
  const next = previous.then(async () => {
    const campaign = run.campaignRecordId ? campaigns.get(run.campaignRecordId) : undefined;
    const previousSuffix = campaign?.latestSuffix;
    const capture = persistL4Capture(run, result);
    if (!capture) {
      broadcast("l4_capture", { id: run.id, capture: null, syncError: "The final landing URL did not contain a suffix." });
      return;
    }
    let adsPush = null;
    let meshDelivery = null;
    let syncError;
    const suffixUnchanged = previousSuffix === capture.suffix;
    if (suffixUnchanged) unchangedSuffixDeliveriesSkipped++;
    if (!suffixUnchanged && run.syncGoogleAds) {
      try { adsPush = await pushCapturedSuffixToAds(run, capture); }
      catch (error) { syncError = error instanceof Error ? error.message : String(error); }
    } else if (!suffixUnchanged && run.useScriptMesh) {
      try { meshDelivery = await publishL4CaptureToMesh(run, capture); }
      catch (error) { syncError = error instanceof Error ? error.message : String(error); }
    }
    run.suffixCaptured = capture.suffix;
    run.adsSyncedAt = adsPush?.at;
    run.meshQueuedVersion = meshDelivery?.version;
    run.meshQueuedAt = meshDelivery ? new Date().toISOString() : undefined;
    run.syncError = syncError;
    if (campaign) {
      campaign.latestSuffix = capture.suffix;
      campaign.lastCapturedAt = capture.capturedAt;
      campaign.lastMeshVersion = meshDelivery?.version ?? campaign.lastMeshVersion;
      campaign.lastMeshQueuedAt = meshDelivery ? new Date().toISOString() : campaign.lastMeshQueuedAt;
      if (meshDelivery?.shardId) campaign.config.scriptFleetShardId = clean(meshDelivery.shardId, 80);
      campaign.lastError = syncError;
      campaign.updatedAt = new Date().toISOString();
      persistCampaigns();
    }
    persistRuns();
    broadcast("l4_capture", { id: run.id, capture, adsPush, meshDelivery, syncError, suffixUnchanged });
  }).catch(error => broadcast("l4_capture", { id: run.id, capture: null, syncError: error instanceof Error ? error.message : String(error) }));
  captureQueues.set(run.id, next);
}

function recordRouteDecision(run, decision) {
  if (!decision || typeof decision !== "object") return;
  const reason = clean(decision.reason || "unknown", 120) || "unknown";
  if (decision.preflightSkipped === true) routeTelemetry.cachedFallbacks++;
  else routeTelemetry.preflightAttempts++;
  if (decision.outcome === "redirect_capture") routeTelemetry.redirectFirstCaptures++;
  else if (decision.outcome === "browser_fallback") {
    routeTelemetry.browserFallbacks++;
    routeTelemetry.fallbackReasons.set(reason, Number(routeTelemetry.fallbackReasons.get(reason) || 0) + 1);
  }
  run.lastRouteDecision = { ...decision, reason, at: new Date().toISOString() };
  broadcast("route_decision", { id: run.id, decision: run.lastRouteDecision });
}

async function pushCapturedSuffixToAds(run, capture) {
  const token = process.env.TAH_ADS_API_TOKEN ?? process.env.TAH_API_TOKEN ?? process.env.TAH_BEARER_TOKEN ?? "";
  const headers = { "content-type": "application/json" };
  if (token) {
    headers["x-api-key"] = token;
    headers.authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  }
  const campaign = run?.campaignRecordId ? campaigns.get(run.campaignRecordId) : undefined;
  if (campaign && (!campaign.config.customerId || !campaign.config.googleCampaignId)) throw new Error("This campaign requires its own Google Ads customer ID and campaign ID before suffix sync can run");
  const perCampaign = Boolean(campaign && capture?.suffix);
  const response = await fetch(new URL(perCampaign ? "/api/campaign-ads" : "/api/ads", webAppUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(perCampaign ? { customerId: campaign.config.customerId, campaignId: campaign.config.googleCampaignId, loginCustomerId: campaign.config.loginCustomerId, suffix: capture.suffix, campaignRecordId: campaign.id } : { action: "push_to_ads" }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw new Error(result.error ?? `Google Ads API returned HTTP ${response.status}`);
  return result;
}

async function publishL4CaptureToMesh(run, capture) {
  const campaign = run?.campaignRecordId ? campaigns.get(run.campaignRecordId) : undefined;
  if (!campaign) throw new Error("Rolling Apps Script delivery requires a saved campaign record");
  const target = assertScriptFleetTarget({
    customerId: campaign.config.customerId,
    campaignId: campaign.config.googleCampaignId,
  });
  const version = Date.now();
  const result = await scriptBridgeRequest({
    action: "fleet-enqueue",
    campaignRecordId: campaign.id,
    campaignName: campaign.name,
    managerCustomerId: campaign.config.loginCustomerId,
    customerId: target.customerId,
    googleCampaignId: target.campaignId,
    shardId: campaign.config.scriptFleetShardId || "default",
    exactSuffix: capture.suffix,
    version,
    sourceRunId: run.id,
  });
  return { accepted: true, fleet: true, version, ...result };
}

async function setCampaignFleetEnrollment(payload) {
  const campaign = campaigns.get(clean(payload?.id, 120));
  if (!campaign) throw new Error("Campaign was not found");
  const enabled = payload?.enabled === true;
  const shardId = clean(payload?.shardId || campaign.config.scriptFleetShardId || "default", 80) || "default";
  let assignedShardId = shardId;
  if (enabled) {
    const target = assertScriptFleetTarget({
      customerId: campaign.config.customerId,
      campaignId: campaign.config.googleCampaignId,
    });
    const enrollment = await scriptBridgeRequest({
      action: "register-target",
      campaignRecordId: campaign.id,
      campaignName: campaign.name,
      managerCustomerId: campaign.config.loginCustomerId,
      customerId: target.customerId,
      googleCampaignId: target.campaignId,
      shardId,
    });
    assignedShardId = clean(enrollment?.shardId || shardId, 80) || shardId;
  } else {
    await scriptBridgeRequest({ action: "delete-target", campaignRecordId: campaign.id });
  }
  campaign.config.useScriptMesh = enabled;
  if (enabled) campaign.config.scriptFleetShardId = assignedShardId;
  else delete campaign.config.scriptFleetShardId;
  if (enabled) campaign.config.syncGoogleAds = false;
  campaign.updatedAt = new Date().toISOString();
  const active = activeRuns().find((run) => run.campaignRecordId === campaign.id);
  if (active) {
    active.useScriptMesh = enabled;
    if (enabled) active.syncGoogleAds = false;
    persistRuns();
  }
  persistCampaigns();
  return campaign;
}

const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const readChallenges = challengeDir => {
  if (!challengeDir || !existsSync(challengeDir)) return [];
  try { return readdirSync(challengeDir).filter(name => name.endsWith(".json") && !name.endsWith(".command.json")).map(name => { try { return JSON.parse(readFileSync(path.join(challengeDir, name), "utf8")); } catch { return null; } }).filter(Boolean).sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt))); } catch { return []; }
};
const publicRun = ({ child, scenarioPath, challengeDir, ...run }) => ({ ...run, challenges: readChallenges(challengeDir), alive: run.exitCode === null && (run.executionMode === "shared" ? orchestratorWorkers.has(run.id) : Boolean(child?.exitCode === null || pidAlive(run.pid))) });
const publicSchedule = schedule => ({
  id: schedule.id,
  scenarioId: schedule.payload.scenarioId,
  timezone: schedule.timezone,
  startTime: schedule.startTime,
  stopTime: schedule.stopTime,
  days: Array.isArray(schedule.days) ? schedule.days : [0, 1, 2, 3, 4, 5, 6],
  enabled: schedule.enabled,
  lastStartedWindow: schedule.lastStartedWindow,
  lastError: schedule.lastError,
});
const persistRuns = () => {
  const payload = [...runs.values()].map(publicRun);
  atomicWriteJson(registryPath, payload);
  if (distributedStore.enabled) queueDistributedStateSave("runs", payload).catch(error => console.error("[postgres] persist runs:", error.message));
};
const persistSchedules = () => {
  const payload = [...schedules.values()];
  atomicWriteJson(scheduleRegistryPath, payload);
  if (distributedStore.enabled) queueDistributedStateSave("schedules", payload).catch(error => console.error("[postgres] persist schedules:", error.message));
};
const persistCampaigns = () => {
  const payload = [...campaigns.values()];
  atomicWriteJson(campaignRegistryPath, payload);
  if (distributedStore.enabled) queueDistributedStateSave("campaigns", payload).catch(error => console.error("[postgres] persist campaigns:", error.message));
};
const persistControlSettings = () => {
  const payload = { activeLimit };
  atomicWriteJson(controlSettingsPath, payload);
  if (distributedStore.enabled) queueDistributedStateSave("settings", payload).catch(error => console.error("[postgres] persist settings:", error.message));
};
try {
  for (const run of JSON.parse(readFileSync(registryPath, "utf8"))) {
    const alive = run.executionMode === "shared" ? false : pidAlive(run.pid);
    runs.set(run.id, { ...run, child: null, exitCode: alive ? null : (run.exitCode ?? -1) });
    sequence = Math.max(sequence, Number(run.dashboardPort ?? 7499) - Number(process.env.TAH_RUN_DASHBOARD_PORT_START ?? 7500) + 1);
  }
} catch { /* first start or invalid prior registry */ }
try {
  for (const schedule of JSON.parse(readFileSync(scheduleRegistryPath, "utf8"))) schedules.set(schedule.id, schedule);
} catch { /* first start or invalid prior schedule registry */ }
try {
  for (const campaign of JSON.parse(readFileSync(campaignRegistryPath, "utf8"))) {
    campaigns.set(campaign.id, { ...campaign, activeRunId: undefined, status: campaign.status === "running" ? "stopped" : campaign.status });
    campaignSequence = Math.max(campaignSequence, Number(campaign.number ?? 0));
  }
} catch { /* first start or invalid prior campaign registry */ }
try {
  const settings = JSON.parse(readFileSync(controlSettingsPath, "utf8"));
  activeLimit = Math.min(5_000, Math.max(1, Number(settings.activeLimit ?? activeLimit)));
} catch { /* defaults remain active */ }

if (distributedStore.enabled) {
  const [dbRuns, dbSchedules, dbCampaigns, dbSettings] = await Promise.all([
    distributedStore.loadState("runs"),
    distributedStore.loadState("schedules"),
    distributedStore.loadState("campaigns"),
    distributedStore.loadState("settings"),
  ]);
  if (Array.isArray(dbRuns)) {
    runs.clear();
    for (const run of dbRuns) runs.set(run.id, { ...run, child: null, exitCode: run.exitCode ?? -1 });
  }
  if (Array.isArray(dbSchedules)) {
    schedules.clear();
    for (const schedule of dbSchedules) schedules.set(schedule.id, schedule);
  }
  if (Array.isArray(dbCampaigns)) {
    campaigns.clear();
    for (const campaign of dbCampaigns) {
      campaigns.set(campaign.id, { ...campaign, activeRunId: undefined, status: campaign.status === "running" ? "queued" : campaign.status });
      campaignSequence = Math.max(campaignSequence, Number(campaign.number ?? 0));
    }
  }
  if (dbSettings) activeLimit = Math.min(5_000, Math.max(1, Number(dbSettings.activeLimit ?? activeLimit)));
  await distributedStore.appendEvent("control.leader.acquired", { activeLimit });
}

const validClockTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ""));
const validTimezone = value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
};
const localScheduleClock = (timezone, now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: weekdays[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};
const previousDate = date => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};
const timeMinutes = value => { const [hour, minute] = value.split(":").map(Number); return hour * 60 + minute; };
const scheduleWindow = schedule => {
  const clock = localScheduleClock(schedule.timezone);
  const start = timeMinutes(schedule.startTime);
  const stop = timeMinutes(schedule.stopTime);
  const overnight = stop <= start;
  const effectiveWeekday = overnight && clock.minutes < stop ? (clock.weekday + 6) % 7 : clock.weekday;
  const selectedDay = (Array.isArray(schedule.days) ? schedule.days : [0, 1, 2, 3, 4, 5, 6]).includes(effectiveWeekday);
  const activeTime = overnight ? clock.minutes >= start || clock.minutes < stop : clock.minutes >= start && clock.minutes < stop;
  const active = selectedDay && activeTime;
  const windowKey = overnight && clock.minutes < stop ? previousDate(clock.date) : clock.date;
  return { active, windowKey };
};

function saveSchedule(payload) {
  validate(payload);
  const timezone = String(payload.schedule?.timezone ?? "");
  const startTime = String(payload.schedule?.startTime ?? "");
  const stopTime = String(payload.schedule?.stopTime ?? "");
  const days = Array.isArray(payload.schedule?.days) ? [...new Set(payload.schedule.days.map(Number))].sort((a, b) => a - b) : [];
  if (!validTimezone(timezone)) throw new Error("Select a valid IANA timezone");
  if (!validClockTime(startTime) || !validClockTime(stopTime) || startTime === stopTime) throw new Error("Select different valid start and stop times in 24-hour format");
  if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Select at least one valid weekday");
  const id = `schedule-${clean(payload.scenarioId || "l4", 80).replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const existing = schedules.get(id);
  const schedule = { id, timezone, startTime, stopTime, days, enabled: true, payload: { ...payload, schedule: undefined, continuous: true, repeats: 1, concurrent: 1, scheduleId: id }, lastStartedWindow: existing?.lastStartedWindow };
  schedules.set(id, schedule);
  persistSchedules();
  return schedule;
}

let schedulerTicking = false;
async function runScheduleTick() {
  if (schedulerTicking) return;
  schedulerTicking = true;
  try {
    for (const schedule of schedules.values()) {
      if (!schedule.enabled) continue;
      const window = scheduleWindow(schedule);
      const active = activeRuns().find(run => run.scheduleId === schedule.id);
      if (!window.active) {
        if (active) terminateRun(active);
        continue;
      }
      if (active || schedule.lastStartedWindow === window.windowKey) continue;
      try {
        await startRun(schedule.payload);
        schedule.lastStartedWindow = window.windowKey;
        schedule.lastError = undefined;
      } catch (error) {
        schedule.lastError = error instanceof Error ? error.message : String(error);
      }
      persistSchedules();
      broadcast("schedules", [...schedules.values()].map(publicSchedule));
    }
  } finally { schedulerTicking = false; }
}

function terminateRun(run) {
  if (!run) return false;
  if (run.executionMode === "shared") return orchestratorWorkers.stop(run.id);
  const pid = run?.child?.pid ?? run?.pid;
  if (!pidAlive(pid)) return false;
  if (process.platform === "win32") return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).status === 0;
  try { process.kill(-pid, "SIGTERM"); return true; } catch { try { process.kill(pid, "SIGTERM"); return true; } catch { return false; } }
}

const US_STATES = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland",
  MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "newhampshire", NJ: "newjersey",
  NM: "newmexico", NY: "newyork", NC: "northcarolina", ND: "northdakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhodeisland", SC: "southcarolina",
  SD: "southdakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "westvirginia", WI: "wisconsin", WY: "wyoming", DC: "districtofcolumbia",
};
const routeToken = (value) => clean(value, 120).toLowerCase().replace(/[^a-z0-9]/g, "");
const verificationUrl = ({ host, port, user, pass }, geo = {}) => {
  const country = clean(geo.country, 2).toUpperCase();
  const basePass = pass.replace(/_(?:country|state|city|session|lifetime|streaming)-.*$/i, "");
  let routedPass = basePass;
  if (country) routedPass += `_country-${country.toLowerCase()}`;
  if (geo.state) routedPass += `_state-${country === "US" ? (US_STATES[clean(geo.state, 40).toUpperCase()] ?? routeToken(geo.state)) : routeToken(geo.state)}`;
  if (geo.city) routedPass += `_city-${routeToken(geo.city)}`;
  const url = new URL(`http://${host}:${port}`);
  url.username = user;
  url.password = routedPass;
  return url;
};

async function setProxy(input) {
  const host = clean(input.host || "geo.iproyal.com", 253).toLowerCase();
  const port = Number(input.port || 12321);
  const user = clean(input.user, 200);
  const pass = String(input.pass ?? "");
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host)) throw new Error("Enter a valid IPRoyal gateway host or IP");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Proxy port must be between 1 and 65535");
  if (!/^[A-Za-z0-9._@-]{1,200}$/.test(user) || !pass || pass.length > 500) throw new Error("Enter valid IPRoyal credentials");
  const candidate = { host, port, user, pass, verified: false };
  resetTzCache();
  const egress = await resolveProxyEgress(verificationUrl(candidate, input.geo));
  if (!egress.verified || !egress.ip || !egress.timezone) throw new Error("The residential route could not be fully verified");
  proxy = { ...candidate, verified: true, verifiedAt: Date.now(), requestedGeo: input.geo, egress, stored: input.remember === true };
  if (input.remember === true) persistProxyConfig(proxy);
  else clearStoredProxy();
  return status();
}

function scenarioYaml(p) {
  const mode = p.tier === "trivial-http" ? p.proxyMode : "sticky-residential";
  const lines = [`id: ${scalar(p.scenarioId)}`, `tier: ${p.tier}`, `seed_url: ${scalar(p.seedUrl)}`, "geo:", `  country: ${p.geo.country}`];
  if (p.geo.state) lines.push(`  state: ${scalar(p.geo.state)}`);
  if (p.geo.city) lines.push(`  city: ${scalar(p.geo.city)}`);
  lines.push(`proxy_mode: ${mode}`, `repeats: ${p.repeats}`, `concurrent: ${p.concurrent}`);
  if (p.tier === "human") lines.push(`continuous: ${p.continuous === true}`);
  if (p.loadProfile?.mode === "burst") lines.push("load_profile:", "  mode: burst", `  target_rps: ${p.loadProfile.targetRps}`, `  duration_seconds: ${p.loadProfile.durationSeconds}`, `  ramp_seconds: ${p.loadProfile.rampSeconds}`, `  max_requests: ${p.loadProfile.maxRequests}`);
  if (p.tier !== "trivial-http") lines.push("fingerprint:", `  mode: ${p.fingerprintMode === "balanced" ? "balanced" : "hardened"}`, `  strict_timezone: ${process.env.TAH_NO_PROXY === "1" ? "false" : "true"}`);
  if (p.devicePool?.length && p.tier !== "trivial-http") lines.push(`device_pool: [${p.devicePool.map(scalar).join(", ")}]`);
  lines.push(`expected_verdict: ${p.expectedVerdict}`);
  const signatures = Array.isArray(p.challengeSignatures) && p.challengeSignatures.length ? p.challengeSignatures : ["cloudflare", "hcaptcha", "datadome", "perimeterx", "akamai", "kasada", "shape", "fingerprintjs", "generic"];
  lines.push("verdict_detection:", "  http_status: true", "  challenge_html: true", "  header_signals: true", "  cookies: true", "  timing: true", `  challenge_signatures: [${signatures.map(scalar).join(", ")}]`);
  if (p.tier === "human") lines.push("session:", "  pages:", "    min: 1", "    max: 1", "  internal_link_probability: 0", `  headless: ${p.session?.headless !== false}`, `  follow_external_redirects: ${p.session?.followExternalRedirects === true}`);
  if (p.tier === "human") lines.push("  challenge_handling:", `    enabled: ${p.session?.challengeHandling?.enabled === true}`, `    persistent: ${p.session?.challengeHandling?.persistent === true}`, `    timeout_seconds: ${Math.min(3600, Math.max(30, Number(p.session?.challengeHandling?.timeoutSeconds ?? 300)))}`, `    on_timeout: ${p.session?.challengeHandling?.onTimeout === "stop" ? "stop" : "skip"}`);
  lines.push("test_environment:", `  mode: ${p.testEnvironment?.mode === "staging" ? "staging" : "production"}`);
  return `${lines.join("\n")}\n`;
}

function validate(p) {
  let url; try { url = new URL(p.seedUrl); } catch { throw new Error("Enter a valid target URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Target URL must use HTTP or HTTPS");
  if (!["trivial-http", "headless", "stealth", "human"].includes(p.tier)) throw new Error("Invalid execution tier");
  if (!["rotating-residential", "sticky-residential"].includes(p.proxyMode)) throw new Error("Invalid proxy mode");
  if (!["allow", "challenge", "block"].includes(p.expectedVerdict)) throw new Error("Invalid expected verdict");
  if (!/^[A-Z]{2}$/.test(p.geo?.country ?? "")) throw new Error("Country must be a two-letter ISO code");
  if (!Number.isInteger(p.repeats) || p.repeats < 1 || p.repeats > 10000) throw new Error("Repeats must be between 1 and 10,000");
  if (!Number.isInteger(p.concurrent) || p.concurrent < 1 || p.concurrent > 100) throw new Error("Concurrency must be between 1 and 100");
  if (p.loadProfile != null) {
    if (p.tier !== "trivial-http" || p.loadProfile.mode !== "burst") throw new Error("Burst mode is available only for Raw HTTP");
    if (!Number.isInteger(p.loadProfile.targetRps) || p.loadProfile.targetRps < 1 || p.loadProfile.targetRps > 500) throw new Error("Target RPS must be between 1 and 500");
    if (!Number.isInteger(p.loadProfile.durationSeconds) || p.loadProfile.durationSeconds < 1 || p.loadProfile.durationSeconds > 60) throw new Error("Burst duration must be between 1 and 60 seconds");
    if (!Number.isInteger(p.loadProfile.rampSeconds) || p.loadProfile.rampSeconds < 0 || p.loadProfile.rampSeconds > p.loadProfile.durationSeconds) throw new Error("Ramp must be between 0 and the burst duration");
    if (!Number.isInteger(p.loadProfile.maxRequests) || p.loadProfile.maxRequests < 1 || p.loadProfile.maxRequests > 10000) throw new Error("Request ceiling must be between 1 and 10,000");
  }
  if (p.tier !== "trivial-http" && !p.devicePool?.length) throw new Error("Select at least one browser identity");
  if (p.tier === "human" && p.session?.pages?.max < p.session?.pages?.min) throw new Error("Invalid page range");
  if (p.continuous === true && p.tier !== "human") throw new Error("Continuous campaigns are available only for L4");
  if (p.tier === "human" && p.session?.challengeHandling?.enabled === true && (!Number.isInteger(p.session?.challengeHandling?.timeoutSeconds) || p.session.challengeHandling.timeoutSeconds < 30 || p.session.challengeHandling.timeoutSeconds > 3600)) throw new Error("Challenge timeout must be between 30 and 3,600 seconds");
  if (p.mitm === true && p.tier !== "trivial-http") throw new Error("TLS ClientHello capture is currently available only for Raw HTTP runs");
  if (process.env.TAH_NO_PROXY !== "1" && !proxy?.verified) throw new Error("Verify IPRoyal before launching traffic");
}

function targetAllowed(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return ALLOWED_TARGETS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
  } catch { return false; }
}
function stagingTargetAllowed(rawUrl) {
  try { const host = new URL(rawUrl).hostname.toLowerCase(); return STAGING_TARGETS.some(allowed => host === allowed || host.endsWith(`.${allowed}`)); } catch { return false; }
}

const activeRuns = () => [...runs.values()].filter(run => run.exitCode === null && (run.executionMode === "shared" ? orchestratorWorkers.has(run.id) : Boolean(run.child?.exitCode === null || pidAlive(run.pid))));

const listRuns = () => [...runs.values()].map(publicRun).sort((a, b) => b.startedAt - a.startedAt);
const lockedPorts = () => new Set(activeRuns().map(run => Number(run.proxyPort)).filter(port => Number.isInteger(port) && port > 0));
const publicCampaign = campaign => ({ ...campaign, config: { ...campaign.config, authorized: undefined } });
const listCampaigns = () => [...campaigns.values()].map(publicCampaign).sort((a, b) => a.number - b.number);
const broadcastCampaigns = () => {
  broadcast("campaigns", listCampaigns());
  broadcast("capacity", { activeLimit, effectiveActiveLimit: Math.min(activeLimit, MAX_LOCAL_WORKERS), active: activeRuns().length, queued: [...campaigns.values()].filter(campaign => campaign.status === "queued").length, lockedPorts: [...lockedPorts()] });
};

function saveCampaign(payload, id) {
  validate(payload);
  if (payload.syncGoogleAds === true && payload.useScriptMesh === true) throw new Error("Choose either direct Google Ads API sync or Rolling Apps Script Mesh delivery");
  if (payload.useScriptMesh === true) {
    if (!payload.customerId || !payload.googleCampaignId) throw new Error("Apps Script delivery requires one Google Ads customer ID and campaign ID");
    assertScriptFleetTarget({
      customerId: payload.customerId,
      campaignId: payload.googleCampaignId,
    });
  }
  const port = Number(payload.proxyPort ?? proxy?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Select a valid dedicated gateway port");
  if (payload.schedule) {
    if (!validTimezone(payload.schedule.timezone)) throw new Error("Select a valid IANA timezone");
    if (!validClockTime(payload.schedule.startTime) || !validClockTime(payload.schedule.stopTime) || payload.schedule.startTime === payload.schedule.stopTime) throw new Error("Select different valid schedule start and stop times");
    if (!Array.isArray(payload.schedule.days) || payload.schedule.days.length === 0 || payload.schedule.days.some(day => !Number.isInteger(Number(day)) || Number(day) < 0 || Number(day) > 6)) throw new Error("Select at least one valid schedule weekday");
  }
  const existing = id ? campaigns.get(id) : undefined;
  if (id && !existing) throw new Error("Campaign was not found");
  if (!existing && campaigns.size >= MAX_SAVED_CAMPAIGNS) throw new Error(`Saved campaign limit (${MAX_SAVED_CAMPAIGNS}) reached`);
  if (payload.syncGoogleAds === true || payload.useScriptMesh === true) {
    const normalizeGoogleId = value => String(value ?? "").replace(/\D/g, "");
    const targetCustomer = normalizeGoogleId(payload.customerId);
    const targetCampaign = normalizeGoogleId(payload.googleCampaignId);
    if (!targetCustomer || !targetCampaign) throw new Error("Google Ads delivery requires a customer ID and campaign ID");
    const duplicate = [...campaigns.values()].find((candidate) => candidate.id !== id
      && normalizeGoogleId(candidate.config?.customerId) === targetCustomer
      && normalizeGoogleId(candidate.config?.googleCampaignId) === targetCampaign);
    if (duplicate) {
      throw new Error(`Google Ads target is already owned by saved campaign ${String(duplicate.number).padStart(3, "0")} · ${duplicate.name}`);
    }
  }
  const number = existing?.number ?? ++campaignSequence;
  const campaignId = existing?.id ?? `campaign-${String(number).padStart(6, "0")}`;
  const now = new Date().toISOString();
  const campaign = {
    id: campaignId,
    number,
    name: clean(payload.scenarioId || `Campaign ${number}`, 80),
    status: existing?.status ?? (payload.schedule ? "scheduled" : "stopped"),
    desiredRunning: existing?.desiredRunning ?? false,
    activeRunId: existing?.activeRunId,
    restartPending: existing?.restartPending ?? false,
    lastError: existing?.lastError,
    latestSuffix: existing?.latestSuffix,
    lastCapturedAt: existing?.lastCapturedAt,
    lastStartedWindow: existing?.lastStartedWindow,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    config: {
      ...payload,
      scenarioId: clean(payload.scenarioId || `Campaign ${number}`, 80),
      proxyPort: port,
      customerId: clean(payload.customerId, 40),
      googleCampaignId: clean(payload.googleCampaignId, 80),
      loginCustomerId: clean(payload.loginCustomerId, 40),
      useScriptMesh: payload.useScriptMesh === true,
      useHourlyScript: undefined,
      repeats: 1,
      concurrent: 1,
      continuous: payload.tier === "human",
      authorized: payload.authorized === true,
    },
  };
  campaigns.set(campaignId, campaign);
  persistCampaigns();
  return campaign;
}

let campaignPumpRunning = false;
let campaignPumpTimer = null;
let campaignPumpDueAt = 0;
let nextCampaignStartAt = 0;

function availableMemoryBytes() {
  if (process.platform === "linux") {
    try {
      const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB$/m);
      if (match) return Number(match[1]) * 1024;
    } catch { /* use the portable fallback */ }
  }
  return freemem();
}

function currentResourceAdmission() {
  return evaluateResourceAdmission({
    availableMemoryBytes: availableMemoryBytes(),
    totalMemoryBytes: totalmem(),
    oneMinuteLoad: loadavg()[0],
    cpuCount: Math.max(1, cpus().length),
    minimumAvailableMemoryRatio: MIN_AVAILABLE_MEMORY_RATIO,
    maximumNormalizedLoad: MAX_NORMALIZED_SYSTEM_LOAD,
  });
}

function scheduleCampaignPump(delayMs) {
  const dueAt = Date.now() + Math.max(1, delayMs);
  if (campaignPumpTimer && campaignPumpDueAt <= dueAt) return;
  if (campaignPumpTimer) clearTimeout(campaignPumpTimer);
  campaignPumpDueAt = dueAt;
  campaignPumpTimer = setTimeout(() => {
    campaignPumpTimer = null;
    campaignPumpDueAt = 0;
    void pumpCampaignQueue();
  }, Math.max(1, dueAt - Date.now()));
  campaignPumpTimer.unref();
}

async function pumpCampaignQueue() {
  if (campaignPumpRunning) return;
  if (campaignPumpTimer) {
    clearTimeout(campaignPumpTimer);
    campaignPumpTimer = null;
    campaignPumpDueAt = 0;
  }
  campaignPumpRunning = true;
  try {
    while (activeRuns().length < Math.min(activeLimit, MAX_LOCAL_WORKERS)) {
      const leased = lockedPorts();
      const now = Date.now();
      const campaign = [...campaigns.values()].sort((a, b) => a.number - b.number).find(item => item.status === "queued" && item.desiredRunning && Number(item.nextRetryAt ?? 0) <= now && !leased.has(Number(item.config.proxyPort)));
      if (!campaign) break;
      if (nextCampaignStartAt > now) {
        scheduleCampaignPump(nextCampaignStartAt - now);
        break;
      }
      const resourceAdmission = currentResourceAdmission();
      if (!resourceAdmission.allowed) {
        resourceAdmissionBlocks++;
        scheduleCampaignPump(RESOURCE_ADMISSION_RETRY_MS);
        break;
      }
      try {
        const run = await startRun({ ...campaign.config, campaignRecordId: campaign.id });
        campaign.activeRunId = run.id;
        campaign.status = "running";
        campaign.lastError = undefined;
        campaign.retryCount = 0;
        campaign.nextRetryAt = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        campaign.retryCount = Math.min(10, Number(campaign.retryCount ?? 0) + 1);
        campaign.nextRetryAt = Date.now() + Math.min(300_000, 5_000 * (2 ** (campaign.retryCount - 1)));
        campaign.status = "queued";
        campaign.lastError = message;
        process.stderr.write(`${JSON.stringify({ level: "error", event: "campaign.launch_failed", campaignId: campaign.id, retryCount: campaign.retryCount, nextRetryAt: campaign.nextRetryAt, message, ts: new Date().toISOString() })}\n`);
      }
      nextCampaignStartAt = Date.now() + CAMPAIGN_START_GAP_MS;
      persistCampaigns();
      broadcastCampaigns();
      if (CAMPAIGN_START_GAP_MS > 0) {
        scheduleCampaignPump(CAMPAIGN_START_GAP_MS);
        break;
      }
    }
  } finally { campaignPumpRunning = false; }
}

async function reconcileCampaignSchedules() {
  let changed = false;
  for (const campaign of campaigns.values()) {
    const schedule = campaign.config.schedule;
    if (!schedule) continue;
    const window = scheduleWindow(schedule);
    const active = activeRuns().find(run => run.campaignRecordId === campaign.id);
    if (!window.active) {
      if (active) terminateRun(active);
      if (!active && campaign.status !== "queued" && campaign.status !== "scheduled") { campaign.status = "scheduled"; changed = true; }
      if (campaign.desiredRunning) { campaign.desiredRunning = false; changed = true; }
      continue;
    }
    if (!active && campaign.lastStartedWindow !== window.windowKey) {
      campaign.lastStartedWindow = window.windowKey;
      campaign.desiredRunning = true;
      campaign.status = "queued";
      changed = true;
    }
  }
  if (changed) persistCampaigns();
  await pumpCampaignQueue();
}
async function finalizeRun(run, code, errorMessage) {
  if (run.exitCode !== null) return;
  run.exitCode = code;
  if (errorMessage) run.error = errorMessage;
  await captureQueues.get(run.id);
  let capture = null;
  let adsPush = null;
  let meshDelivery = null;
  let syncError;
  if (code === 0 && run.tier === "human" && !run.continuous) {
    try {
      capture = captureExactL4Suffix(run);
      if (capture && run.syncGoogleAds) adsPush = await pushCapturedSuffixToAds(run, capture);
      else if (capture && run.useScriptMesh) meshDelivery = await publishL4CaptureToMesh(run, capture);
    } catch (error) { syncError = error instanceof Error ? error.message : String(error); }
  }
  run.suffixCaptured = capture?.suffix ?? run.suffixCaptured;
  run.adsSyncedAt = adsPush?.at ?? run.adsSyncedAt;
  run.meshQueuedVersion = meshDelivery?.version ?? run.meshQueuedVersion;
  run.meshQueuedAt = meshDelivery ? new Date().toISOString() : run.meshQueuedAt;
  run.syncError = syncError ?? run.syncError;
  const campaign = run.campaignRecordId ? campaigns.get(run.campaignRecordId) : undefined;
  if (campaign) {
    campaign.activeRunId = undefined;
    if (campaign.restartPending) {
      campaign.restartPending = false; campaign.desiredRunning = true; campaign.status = "queued";
    } else if (campaign.desiredRunning && run.continuous) campaign.status = "queued";
    else {
      campaign.desiredRunning = false;
      campaign.status = campaign.config.schedule ? "scheduled" : code === 0 ? "completed" : "stopped";
    }
    campaign.lastError = code === 0 || code === 143 ? undefined : (run.error ?? `Run exited with code ${code}`);
    campaign.updatedAt = new Date().toISOString();
    persistCampaigns();
  }
  persistRuns();
  broadcast("run_ended", { id: run.id, code, capture, adsPush, meshDelivery, syncError, error: errorMessage });
  broadcast("runs", listRuns());
  broadcastCampaigns();
  void pumpCampaignQueue();
}

async function startRun(payload) {
  validate(payload);
  if (payload.authorized !== true) throw new Error("Confirm that you are authorized to test this target");
  if (payload.syncGoogleAds === true && payload.useScriptMesh === true) throw new Error("Choose either direct Google Ads API sync or Rolling Apps Script Mesh delivery");
  if (payload.useScriptMesh === true) {
    assertScriptFleetTarget({
      customerId: payload.customerId,
      campaignId: payload.googleCampaignId,
    });
  }
  const allowUnlistedDev = CONTROL_HOST_IS_LOOPBACK && process.env.NODE_ENV !== "production" && process.env.TAH_ALLOW_UNLISTED_LOCAL_TARGETS === "true";
  if (!targetAllowed(payload.seedUrl) && !allowUnlistedDev) throw new Error("Target is not present in TAH_ALLOWED_TARGETS");
  if (payload.testEnvironment?.mode === "staging" && !stagingTargetAllowed(payload.seedUrl)) throw new Error("Staging mode requires the target in TAH_STAGING_TARGETS");
  const live = activeRuns();
  if (payload.campaignRecordId && live.some(run => run.campaignRecordId === payload.campaignRecordId)) throw new Error("This campaign already has an active journey process");
  const noProxy = process.env.TAH_NO_PROXY === "1";
  const requestedProxyPort = noProxy ? null : Number(payload.proxyPort ?? proxy?.port);
  if (requestedProxyPort !== null && live.some(run => Number(run.proxyPort) === requestedProxyPort)) throw new Error(`Gateway port ${requestedProxyPort} is already leased by another active run`);
  const requestedConcurrency = Number(payload.concurrent ?? 1);
  const requestedRps = payload.loadProfile?.mode === "burst" ? Number(payload.loadProfile.targetRps ?? 0) : 0;
  const permitManaged = run => run.tier === "human" && run.continuous === true;
  const requestedUsesPermits = payload.tier === "human" && payload.continuous === true;
  const totalConcurrency = live.reduce((sum, run) => sum + Number(run.concurrent ?? 1), 0) + requestedConcurrency;
  const totalRps = live.reduce((sum, run) => sum + Number(run.targetRps ?? 0), 0) + requestedRps;
  const effectiveActiveLimit = Math.min(activeLimit, MAX_LOCAL_WORKERS, SHARED_ORCHESTRATOR_ENABLED ? orchestratorWorkers.capacity() : MAX_LOCAL_WORKERS);
  if (live.length >= effectiveActiveLimit) throw new Error(`Per-server active worker limit (${effectiveActiveLimit}) reached`);
  if (!requestedUsesPermits && totalConcurrency > MAX_TOTAL_CONCURRENCY) throw new Error(`Aggregate concurrency limit (${MAX_TOTAL_CONCURRENCY}) exceeded`);
  const aggregateBrowserConcurrency = live.filter(run => run.tier !== "trivial-http" && !permitManaged(run)).reduce((sum, run) => sum + Number(run.concurrent ?? 1), 0) + (payload.tier === "trivial-http" || requestedUsesPermits ? 0 : requestedConcurrency);
  if (aggregateBrowserConcurrency > MAX_BROWSER_CONCURRENCY) throw new Error(`Aggregate browser concurrency limit (${MAX_BROWSER_CONCURRENCY}) exceeded`);
  if (totalRps > MAX_TOTAL_RPS) throw new Error(`Aggregate request rate limit (${MAX_TOTAL_RPS} RPS) exceeded`);
  const id = `run-${Date.now().toString(36)}-${++sequence}`;
  const scenarioId = clean(payload.scenarioId || id, 80).replace(/[^A-Za-z0-9_-]/g, "-");
  const scenarioPath = path.join(SCENARIOS, `${scenarioId}-${id}.yaml`);
  const dashboardPort = Number(process.env.TAH_RUN_DASHBOARD_PORT_START ?? 7500) + sequence - 1;
  mkdirSync(SCENARIOS, { recursive: true });
  const challengeDir = path.join(ROOT, "runs", "challenge-queue", id);
  mkdirSync(challengeDir, { recursive: true });
  writeFileSync(scenarioPath, scenarioYaml({ ...payload, scenarioId }), { encoding: "utf8", mode: 0o600 });
  const env = noProxy
    ? { ...process.env, TAH_RUN_ID: id, TAH_CHALLENGE_DIR: challengeDir }
    : { ...process.env, TAH_RUN_ID: id, TAH_CHALLENGE_DIR: challengeDir, IPROYAL_HOSTNAME: proxy.host, IPROYAL_PORT: String(payload.proxyPort ?? proxy.port), IPROYAL_USER: proxy.user, IPROYAL_PASS: proxy.pass };
  const args = [ORCH, "--scenario", scenarioPath, "--dashboard-port", String(dashboardPort)];
  if (payload.mitm !== true) args.push("--no-mitm");
  else args.push("--mitm-port", String(Number(process.env.TAH_MITM_PORT_START ?? 8188) + (sequence % 50_000)));
  if (payload.concurrent > 1) args.push("--parallel");
  const useShared = SHARED_ORCHESTRATOR_ENABLED && payload.tier === "human" && payload.continuous === true && payload.mitm !== true;
  const run = { id, scenarioId, scenarioPath, challengeDir, dashboardPort, startedAt: Date.now(), mitmEnabled: payload.mitm === true, child: null, pid: null, tier: payload.tier, scheduleId: payload.scheduleId, campaignRecordId: payload.campaignRecordId, proxyPort: requestedProxyPort, continuous: payload.tier === "human" && payload.continuous === true, syncGoogleAds: payload.tier === "human" && payload.syncGoogleAds === true, useScriptMesh: payload.tier === "human" && payload.useScriptMesh === true, concurrent: requestedConcurrency, targetRps: requestedRps, exitCode: null, executionMode: useShared ? "shared" : "dedicated" };
  runs.set(id, run);
  persistRuns();
  if (useShared) {
    try {
      const assignment = await orchestratorWorkers.start({
        runId: id,
        scenarioPath,
        runDir: path.join(ROOT, "runs", id),
        challengeDir,
        creds: noProxy ? { user: "", pass: "" } : { user: proxy.user, pass: proxy.pass },
        proxyGateway: noProxy ? undefined : { hostname: proxy.host, port: Number(payload.proxyPort ?? proxy.port) },
      }, {
        onCapture: capture => queueL4Capture(run, capture),
        onRouteDecision: decision => recordRouteDecision(run, decision),
        onExit: (code, error) => { void finalizeRun(run, code, error); },
      });
      run.workerId = assignment.workerId;
      run.pid = assignment.pid;
      persistRuns();
      broadcast("runs", listRuns());
      return run;
    } catch (error) {
      runs.delete(id);
      persistRuns();
      throw error;
    }
  }
  const child = spawn(process.execPath, args, { env, cwd: ROOT, windowsHide: true, detached: process.platform !== "win32" });
  run.child = child;
  run.pid = child.pid;
  let stdoutBuffer = "";
  child.stdout.on("data", c => {
    stdoutBuffer += c.toString("utf8");
    if (stdoutBuffer.length > 1_000_000) stdoutBuffer = stdoutBuffer.slice(-1_000_000);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("TAH_L4_CAPTURE ")) {
        try { queueL4Capture(run, JSON.parse(line.slice("TAH_L4_CAPTURE ".length))); }
        catch (error) { broadcast("l4_capture", { id, capture: null, syncError: error instanceof Error ? error.message : String(error) }); }
      } else if (line.startsWith("TAH_ROUTE_DECISION ")) {
        try { recordRouteDecision(run, JSON.parse(line.slice("TAH_ROUTE_DECISION ".length))); }
        catch { broadcast("log", { id, stream: "stdout", data: `${line}\n` }); }
      } else if (line) broadcast("log", { id, stream: "stdout", data: `${line}\n` });
    }
  });
  child.stderr.on("data", c => broadcast("log", { id, stream: "stderr", data: c.toString("utf8").slice(0, 16_384) }));
  child.on("exit", code => { void finalizeRun(run, Number(code ?? 99)); });
  child.on("error", error => { void finalizeRun(run, -1, error.message); });
  broadcast("runs", listRuns());
  return run;
}

async function handle(ws, msg) {
  try {
    if (msg.type === "set_proxy_config") {
      broadcast("proxy_checking", { checking: true });
      try { await setProxy(msg.payload ?? {}); broadcast("proxy_status", status()); }
      catch (error) { proxy = null; broadcast("proxy_status", status()); throw error; }
    }
    else if (msg.type === "clear_proxy_config") { proxy = null; clearStoredProxy(); broadcast("proxy_status", status()); }
    else if (msg.type === "get_proxy_config") send(ws, "proxy_status", status());
    else if (msg.type === "create_run") { const run = await startRun(msg.payload ?? {}); send(ws, "run_started", { id: run.id, scenarioId: run.scenarioId }); }
    else if (msg.type === "create_campaign") {
      const campaign = saveCampaign(msg.payload ?? {});
      if (!campaign.config.schedule) { campaign.desiredRunning = true; campaign.status = "queued"; persistCampaigns(); }
      send(ws, "campaign_saved", publicCampaign(campaign));
      broadcastCampaigns();
      void reconcileCampaignSchedules();
      void pumpCampaignQueue();
    }
    else if (msg.type === "set_campaign_fleet") {
      const campaign = await setCampaignFleetEnrollment(msg.payload ?? {});
      send(ws, "campaign_fleet_updated", publicCampaign(campaign));
      broadcastCampaigns();
    }
    else if (msg.type === "update_campaign") {
      const campaign = saveCampaign(msg.payload ?? {}, clean(msg.payload?.id, 120));
      send(ws, "campaign_saved", publicCampaign(campaign));
      broadcastCampaigns();
      void pumpCampaignQueue();
    }
    else if (msg.type === "list_campaigns") { send(ws, "campaigns", listCampaigns()); send(ws, "capacity", { activeLimit, active: activeRuns().length, queued: [...campaigns.values()].filter(campaign => campaign.status === "queued").length, lockedPorts: [...lockedPorts()] }); }
    else if (msg.type === "start_campaign") {
      const campaign = campaigns.get(clean(msg.payload?.id, 120));
      if (!campaign) throw new Error("Campaign was not found");
      if (!campaign.activeRunId) { campaign.desiredRunning = true; campaign.status = "queued"; campaign.lastError = undefined; campaign.retryCount = 0; campaign.nextRetryAt = undefined; persistCampaigns(); }
      broadcastCampaigns();
      void pumpCampaignQueue();
    }
    else if (msg.type === "stop_campaign") {
      const campaign = campaigns.get(clean(msg.payload?.id, 120));
      if (!campaign) throw new Error("Campaign was not found");
      campaign.desiredRunning = false;
      campaign.restartPending = false;
      campaign.status = "stopped";
      const run = activeRuns().find(item => item.campaignRecordId === campaign.id);
      if (run) terminateRun(run);
      persistCampaigns();
      broadcastCampaigns();
    }
    else if (msg.type === "restart_campaign") {
      const campaign = campaigns.get(clean(msg.payload?.id, 120));
      if (!campaign) throw new Error("Campaign was not found");
      const run = activeRuns().find(item => item.campaignRecordId === campaign.id);
      campaign.desiredRunning = true;
      campaign.status = "queued";
      campaign.restartPending = Boolean(run);
      campaign.lastError = undefined;
      campaign.retryCount = 0;
      campaign.nextRetryAt = undefined;
      if (run) terminateRun(run); else void pumpCampaignQueue();
      persistCampaigns();
      broadcastCampaigns();
      send(ws, "campaign_restarted", publicCampaign(campaign));
    }
    else if (msg.type === "delete_campaign") {
      const id = clean(msg.payload?.id, 120);
      const campaign = campaigns.get(id);
      if (!campaign) throw new Error("Campaign was not found");
      const run = activeRuns().find(item => item.campaignRecordId === id);
      if (run) {
        run.useScriptMesh = false;
        persistRuns();
        terminateRun(run);
      }
      await scriptBridgeRequest({ action: "delete-target", campaignRecordId: id });
      campaigns.delete(id);
      persistCampaigns();
      broadcastCampaigns();
    }
    else if (msg.type === "set_active_limit") {
      activeLimit = Math.min(5_000, Math.max(1, Math.trunc(Number(msg.payload?.limit) || 1)));
      persistControlSettings();
      broadcastCampaigns();
      void pumpCampaignQueue();
    }
    else if (msg.type === "create_schedule") { const schedule = saveSchedule(msg.payload ?? {}); broadcast("schedules", [...schedules.values()].map(publicSchedule)); send(ws, "schedule_saved", publicSchedule(schedule)); void runScheduleTick(); }
    else if (msg.type === "list_schedules") send(ws, "schedules", [...schedules.values()].map(publicSchedule));
    else if (msg.type === "remove_schedule") {
      const id = clean(msg.payload?.id, 120);
      const active = activeRuns().find(run => run.scheduleId === id);
      if (active) terminateRun(active);
      const removed = schedules.delete(id);
      persistSchedules();
      broadcast("schedules", [...schedules.values()].map(publicSchedule));
      send(ws, "schedule_removed", { id, ok: removed });
    }
    else if (msg.type === "cancel_run") { const run = runs.get(clean(msg.payload?.id)); send(ws, "run_cancelled", { id: msg.payload?.id, ok: terminateRun(run) }); }
    else if (msg.type === "challenge_action") {
      const run = runs.get(clean(msg.payload?.runId));
      const challengeId = clean(msg.payload?.challengeId, 80);
      const action = clean(msg.payload?.action, 12);
      if (!run || !run.challengeDir) throw new Error("Run challenge queue is unavailable");
      if (!["resume", "skip", "stop"].includes(action)) throw new Error("Invalid challenge action");
      const challenge = readChallenges(run.challengeDir).find(item => item.id === challengeId);
      if (!challenge || challenge.status !== "pending") throw new Error("Challenge is no longer pending");
      writeFileSync(path.join(run.challengeDir, `${challengeId}.command.json`), JSON.stringify({ action, requestedAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
      send(ws, "challenge_action_accepted", { runId: run.id, challengeId, action });
    }
    else if (msg.type === "remove_run") {
      const id = clean(msg.payload?.id);
      const run = runs.get(id);
      if (!run) send(ws, "run_removed", { id, ok: false });
      else if (run.child?.exitCode === null || pidAlive(run.pid)) throw new Error("Stop the active run before dismissing it");
      else { runs.delete(id); persistRuns(); broadcast("runs", listRuns()); send(ws, "run_removed", { id, ok: true }); }
    }
    else if (msg.type === "list_runs") send(ws, "runs", listRuns());
    else if (msg.type === "list_devices") send(ws, "devices", JSON.parse(readFileSync(path.join(ROOT, "packages/profiles/src/devices.json"), "utf8")));
    else send(ws, "error", { message: "Unknown control command" });
  } catch (error) { send(ws, "error", { message: error instanceof Error ? error.message : String(error) }); }
}

const CONTROL_HOST = process.env.CONTROL_HOST ?? "127.0.0.1";
const CONTROL_TOKEN = process.env.CONTROL_TOKEN ?? "";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const CONTROL_HOST_NORMALIZED = CONTROL_HOST.replace(/^\[(.+)\]$/, "$1").toLowerCase();
const CONTROL_HOST_IS_LOOPBACK = LOOPBACK_HOSTS.has(CONTROL_HOST_NORMALIZED);
const INSECURE_LOCAL_CONTROL = CONTROL_HOST_IS_LOOPBACK
  && process.env.NODE_ENV !== "production"
  && ["1", "true"].includes(String(process.env.TAH_ALLOW_INSECURE_LOCAL_DEV ?? "").toLowerCase());
if (!CONTROL_HOST_IS_LOOPBACK && !CONTROL_TOKEN) throw new Error("CONTROL_TOKEN is required for non-loopback control access");
if (!CONTROL_TOKEN && !INSECURE_LOCAL_CONTROL) throw new Error("CONTROL_TOKEN is required unless insecure local development is explicitly enabled");
if (!CONTROL_HOST_IS_LOOPBACK && ALLOWED_TARGETS.length === 0) throw new Error("TAH_ALLOWED_TARGETS is required for non-loopback control access");
const tokenMatches = candidate => {
  if (!CONTROL_TOKEN) return true;
  const expected = Buffer.from(CONTROL_TOKEN);
  const actual = Buffer.from(candidate ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const SESSION_SECRET = process.env.TAH_SESSION_SECRET || process.env.TAH_API_BEARER_TOKEN || CONTROL_TOKEN;
const sessionCookieMatches = cookieHeader => {
  if (!SESSION_SECRET || typeof cookieHeader !== "string" || cookieHeader.length > 16_384) return false;
  const encoded = cookieHeader.split(";").map(value => value.trim()).find(value => value.startsWith("tah_session="))?.slice("tah_session=".length);
  if (!encoded) return false;
  let token;
  try { token = decodeURIComponent(encoded); } catch { return false; }
  return verifySessionToken(token, SESSION_SECRET, "control");
};
const CAPACITY_ESTIMATED_CAMPAIGN_MEMORY_BYTES = Math.max(128, Number(process.env.TAH_CAPACITY_CAMPAIGN_MEMORY_MB) || 512) * 1024 * 1024;
const CAPACITY_ESTIMATED_CAMPAIGN_CPU_PERCENT = Math.min(100, Math.max(5, Number(process.env.TAH_CAPACITY_CAMPAIGN_CPU_PERCENT) || 35));
const CAPACITY_ESTIMATED_SHARED_TASK_MEMORY_BYTES = Math.max(32, Number(process.env.TAH_CAPACITY_SHARED_TASK_MEMORY_MB) || 96) * 1024 * 1024;
const CAPACITY_ESTIMATED_SHARED_TASK_CPU_PERCENT = Math.min(100, Math.max(1, Number(process.env.TAH_CAPACITY_SHARED_TASK_CPU_PERCENT) || 6));
const CAPACITY_TARGET_CPU_PERCENT = Math.min(95, Math.max(40, Number(process.env.TAH_CAPACITY_TARGET_CPU_PERCENT) || 75));
const CAPACITY_MIN_FREE_DISK_RATIO = Math.min(0.5, Math.max(0.05, Number(process.env.TAH_CAPACITY_MIN_FREE_DISK_RATIO) || 0.15));
const CAPACITY_STORAGE_SCAN_FILES = Math.max(1_000, Math.min(100_000, Number(process.env.TAH_CAPACITY_STORAGE_SCAN_FILES) || 25_000));
const CAPACITY_STORAGE_CACHE_MS = Math.max(10_000, Number(process.env.TAH_CAPACITY_STORAGE_CACHE_MS) || 60_000);
let previousSystemCpuSample = null;
let previousControlCpuSample = { at: process.hrtime.bigint(), usage: process.cpuUsage() };
let activeStorageCache = { key: "", measuredAt: 0, byRun: {}, totalBytes: 0, filesVisited: 0, truncated: false };

function systemCpuPercent() {
  const current = cpus().reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((value, time) => value + time, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
  if (!previousSystemCpuSample) {
    previousSystemCpuSample = current;
    return null;
  }
  const idle = current.idle - previousSystemCpuSample.idle;
  const total = current.total - previousSystemCpuSample.total;
  previousSystemCpuSample = current;
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
}

function controlCpuPercent() {
  const at = process.hrtime.bigint();
  const usage = process.cpuUsage();
  const elapsedMicros = Number(at - previousControlCpuSample.at) / 1_000;
  const usedMicros = usage.user + usage.system - previousControlCpuSample.usage.user - previousControlCpuSample.usage.system;
  previousControlCpuSample = { at, usage };
  return elapsedMicros > 0 ? Math.max(0, usedMicros / elapsedMicros * 100) : 0;
}

function readPositiveNumber(filePath) {
  try {
    const value = readFileSync(filePath, "utf8").trim();
    if (!value || value === "max") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch { return null; }
}

function memoryCapacity() {
  const hostTotal = totalmem();
  const cgroupV2Limit = readPositiveNumber("/sys/fs/cgroup/memory.max");
  const cgroupV2Current = readPositiveNumber("/sys/fs/cgroup/memory.current");
  const cgroupV1Limit = readPositiveNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const cgroupV1Current = readPositiveNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const limit = cgroupV2Limit || cgroupV1Limit;
  const current = cgroupV2Current || cgroupV1Current;
  if (limit && current !== null && limit < hostTotal) {
    return { totalBytes: limit, availableBytes: Math.max(0, limit - current), source: "container" };
  }
  return { totalBytes: hostTotal, availableBytes: freemem(), source: "host" };
}

function effectiveCpuCount() {
  const hostCount = Math.max(1, cpus().length);
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota !== "max") {
      const constrained = Number(quota) / Number(period);
      if (Number.isFinite(constrained) && constrained > 0) return Math.max(0.1, Math.min(hostCount, constrained));
    }
  } catch {}
  const quota = readPositiveNumber("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
  const period = readPositiveNumber("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
  return quota && period ? Math.max(0.1, Math.min(hostCount, quota / period)) : hostCount;
}

function diskCapacity() {
  try {
    const value = statfsSync(ROOT, { bigint: true });
    const totalBytes = Number(value.blocks * value.bsize);
    const availableBytes = Number(value.bavail * value.bsize);
    return { totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes), availableRatio: totalBytes > 0 ? availableBytes / totalBytes : 1 };
  } catch {
    return { totalBytes: 0, availableBytes: 0, usedBytes: 0, availableRatio: 1 };
  }
}

function measureActiveRunStorage(active) {
  const key = active.map(run => run.id).sort().join("|");
  if (key === activeStorageCache.key && Date.now() - activeStorageCache.measuredAt < CAPACITY_STORAGE_CACHE_MS) return activeStorageCache;
  const byRun = {};
  let totalBytes = 0;
  let filesVisited = 0;
  let truncated = false;
  for (const run of active) {
    let runBytes = 0;
    const stack = [path.join(ROOT, "runs", run.id)];
    while (stack.length && filesVisited < CAPACITY_STORAGE_SCAN_FILES) {
      const directory = stack.pop();
      let entries = [];
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (filesVisited >= CAPACITY_STORAGE_SCAN_FILES) { truncated = true; break; }
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(entryPath);
        else if (entry.isFile()) {
          filesVisited += 1;
          try { runBytes += statSync(entryPath).size; } catch {}
        }
      }
    }
    byRun[run.id] = runBytes;
    totalBytes += runBytes;
    if (filesVisited >= CAPACITY_STORAGE_SCAN_FILES) { truncated = true; break; }
  }
  activeStorageCache = { key, measuredAt: Date.now(), byRun, totalBytes, filesVisited, truncated };
  return activeStorageCache;
}

function targetHostname(campaign) {
  const raw = campaign?.config?.targetUrl || campaign?.config?.target || campaign?.config?.url || "";
  try { return new URL(raw).hostname; } catch { return ""; }
}

async function capacitySnapshot() {
  const generatedAt = Date.now();
  const cpuList = cpus();
  const effectiveCpus = effectiveCpuCount();
  const systemCpu = systemCpuPercent();
  const controlCpu = controlCpuPercent();
  const memory = memoryCapacity();
  const disk = diskCapacity();
  const active = activeRuns();
  const workerPool = orchestratorWorkers.snapshot();
  const storage = measureActiveRunStorage(active);
  const resourceAdmission = evaluateResourceAdmission({
    availableMemoryBytes: memory.availableBytes,
    totalMemoryBytes: memory.totalBytes,
    oneMinuteLoad: loadavg()[0],
    cpuCount: effectiveCpus,
    minimumAvailableMemoryRatio: MIN_AVAILABLE_MEMORY_RATIO,
    maximumNormalizedLoad: MAX_NORMALIZED_SYSTEM_LOAD,
  });
  const [infrastructure, health] = await Promise.all([
    distributedStore.capacity?.().catch(() => null),
    distributedStore.health().catch(() => ({ postgres: false, redis: false, leader: false })),
  ]);
  const queued = [...campaigns.values()].filter(campaign => campaign.status === "queued");
  const errors = [...campaigns.values()].filter(campaign => campaign.status === "error");
  const hardCeiling = Math.max(0, Math.min(activeLimit, MAX_LOCAL_WORKERS, SHARED_ORCHESTRATOR_ENABLED ? workerPool.taskCapacity : MAX_BROWSER_CONCURRENCY));
  const limitHeadroom = Math.max(0, hardCeiling - active.length);
  const reservedMemory = memory.totalBytes * MIN_AVAILABLE_MEMORY_RATIO;
  const memoryHeadroom = Math.max(0, memory.availableBytes - reservedMemory);
  const plannedTaskMemory = SHARED_ORCHESTRATOR_ENABLED ? CAPACITY_ESTIMATED_SHARED_TASK_MEMORY_BYTES : CAPACITY_ESTIMATED_CAMPAIGN_MEMORY_BYTES;
  const plannedTaskCpu = SHARED_ORCHESTRATOR_ENABLED ? CAPACITY_ESTIMATED_SHARED_TASK_CPU_PERCENT : CAPACITY_ESTIMATED_CAMPAIGN_CPU_PERCENT;
  const additionalByMemory = Math.max(0, Math.floor(memoryHeadroom / plannedTaskMemory));
  const additionalByCpu = systemCpu === null
    ? limitHeadroom
    : Math.max(0, Math.floor(Math.max(0, CAPACITY_TARGET_CPU_PERCENT - systemCpu) * effectiveCpus / plannedTaskCpu));
  const diskBlocked = disk.totalBytes > 0 && disk.availableRatio < CAPACITY_MIN_FREE_DISK_RATIO;
  const safeAdditional = Math.max(0, Math.min(limitHeadroom, additionalByMemory, additionalByCpu, diskBlocked ? 0 : limitHeadroom));
  const memoryUsedRatio = memory.totalBytes > 0 ? 1 - memory.availableBytes / memory.totalBytes : 0;
  const recommendations = [];
  if (diskBlocked) recommendations.push("Increase disk capacity or remove old evidence before starting another campaign.");
  if (memoryUsedRatio >= 0.85) recommendations.push("RAM pressure is critical; stop one or more active campaigns or increase memory.");
  else if (memoryUsedRatio >= 0.7) recommendations.push("RAM headroom is narrowing; add campaigns cautiously.");
  if (systemCpu !== null && systemCpu >= CAPACITY_TARGET_CPU_PERCENT) recommendations.push("CPU is at the planning ceiling; do not add campaigns until load falls.");
  if (activeLimit >= 100 && effectiveCpus < RECOMMENDED_VCPU_FOR_100_BROWSER_CAMPAIGNS) recommendations.push(`The 100 browser-required campaign target needs at least ${RECOMMENDED_VCPU_FOR_100_BROWSER_CAMPAIGNS} effective vCPU; this server exposes ${effectiveCpus.toFixed(1)}.`);
  if (queued.length > 0) recommendations.push(`${queued.length} campaign${queued.length === 1 ? " is" : "s are"} queued; increase workers only when CPU and RAM headroom permit.`);
  if (!health.postgres || !health.redis) recommendations.push("A state service is unhealthy; restore PostgreSQL and Redis before increasing capacity.");
  if (recommendations.length === 0) recommendations.push(`Current headroom supports approximately ${safeAdditional} additional active campaign${safeAdditional === 1 ? "" : "s"} under the configured planning model.`);
  const state = !resourceAdmission.allowed || diskBlocked || !health.postgres || !health.redis
    ? "critical"
    : systemCpu !== null && systemCpu >= 65 || memoryUsedRatio >= 0.7 || queued.length > 0
      ? "warning"
      : "healthy";
  const processMemory = process.memoryUsage();
  const campaignRows = active.map(run => {
    const campaign = campaigns.get(run.campaignRecordId);
    return {
      campaignRecordId: run.campaignRecordId || null,
      campaignNumber: campaign?.number || null,
      campaignName: campaign?.name || run.scenarioId || run.id,
      runId: run.id,
      status: "running",
      tier: run.tier,
      pid: run.child?.pid || run.pid || null,
      startedAt: run.startedAt,
      runtimeMs: Math.max(0, generatedAt - Number(run.startedAt || generatedAt)),
      proxyPort: run.proxyPort || null,
      targetHost: targetHostname(campaign),
      executionMode: run.executionMode || "dedicated",
      workerId: run.workerId || null,
      routeDecision: run.lastRouteDecision || null,
      plannedCpuPercent: run.executionMode === "shared" ? CAPACITY_ESTIMATED_SHARED_TASK_CPU_PERCENT : CAPACITY_ESTIMATED_CAMPAIGN_CPU_PERCENT,
      plannedMemoryBytes: run.executionMode === "shared" ? CAPACITY_ESTIMATED_SHARED_TASK_MEMORY_BYTES : CAPACITY_ESTIMATED_CAMPAIGN_MEMORY_BYTES,
      evidenceBytes: Number(storage.byRun[run.id] || 0),
    };
  });
  return {
    version: 1,
    generatedAt,
    state,
    host: {
      hostname: hostname(),
      platform: platform(),
      architecture: arch(),
      nodeVersion: process.version,
      uptimeSeconds: uptime(),
      logicalCpuCount: cpuList.length,
      effectiveCpuCount: effectiveCpus,
      cpuModel: cpuList[0]?.model || "Unknown CPU",
      memorySource: memory.source,
    },
    load: {
      systemCpuPercent: systemCpu,
      oneMinuteLoad: loadavg()[0],
      normalizedLoad: resourceAdmission.normalizedLoad,
      totalMemoryBytes: memory.totalBytes,
      availableMemoryBytes: memory.availableBytes,
      usedMemoryBytes: Math.max(0, memory.totalBytes - memory.availableBytes),
      memoryUsedRatio,
      disk,
    },
    process: {
      pid: process.pid,
      cpuPercent: controlCpu,
      rssBytes: processMemory.rss,
      heapUsedBytes: processMemory.heapUsed,
      heapTotalBytes: processMemory.heapTotal,
      externalBytes: processMemory.external,
      uptimeSeconds: process.uptime(),
    },
    infrastructure: infrastructure || {
      postgres: { configured: distributedStore.enabled, healthy: Boolean(health.postgres), sizeBytes: 0, connections: 0, maxConnections: 0 },
      redis: { configured: distributedStore.enabled, healthy: Boolean(health.redis), usedMemoryBytes: 0, maxMemoryBytes: 0, keys: 0 },
    },
    services: {
      leader: Boolean(health.leader),
      postgresHealthy: Boolean(health.postgres),
      redisHealthy: Boolean(health.redis),
      proxyConfigured: Boolean(proxy),
      proxyVerified: Boolean(proxy?.verified),
      proxyLocation: proxy?.location || "",
      proxyTimezone: proxy?.timezone || "",
    },
    limits: {
      savedCampaignLimit: MAX_SAVED_CAMPAIGNS,
      activeLimit,
      maxLocalWorkers: MAX_LOCAL_WORKERS,
      maxBrowserConcurrency: MAX_BROWSER_CONCURRENCY,
      maxTotalConcurrency: MAX_TOTAL_CONCURRENCY,
      maxTotalRps: MAX_TOTAL_RPS,
      launchGapMs: CAMPAIGN_START_GAP_MS,
      launchSpreadMs: CAMPAIGN_START_SPREAD_MS,
      sharedOrchestratorEnabled: SHARED_ORCHESTRATOR_ENABLED,
      sharedWorkerProcesses: SHARED_WORKER_PROCESSES,
      sharedWorkerSlots: SHARED_WORKER_SLOTS,
      minimumAvailableMemoryRatio: MIN_AVAILABLE_MEMORY_RATIO,
      maximumNormalizedLoad: MAX_NORMALIZED_SYSTEM_LOAD,
      targetCpuPercent: CAPACITY_TARGET_CPU_PERCENT,
      minimumFreeDiskRatio: CAPACITY_MIN_FREE_DISK_RATIO,
      plannedCampaignMemoryBytes: plannedTaskMemory,
      plannedCampaignCpuPercent: plannedTaskCpu,
    },
    workload: {
      savedCampaigns: campaigns.size,
      activeCampaigns: active.length,
      queuedCampaigns: queued.length,
      errorCampaigns: errors.length,
      lockedGatewayPorts: lockedPorts().size,
      activeEvidenceBytes: storage.totalBytes,
      evidenceFilesVisited: storage.filesVisited,
      evidenceScanTruncated: storage.truncated,
      resourceAdmissionAllowed: resourceAdmission.allowed,
      resourceAdmissionReasons: resourceAdmission.reasons,
      resourceAdmissionBlocks,
    },
    capacity: {
      hardActiveCeiling: hardCeiling,
      safeActiveNow: active.length + safeAdditional,
      safeAdditionalCampaigns: safeAdditional,
      additionalByMemory,
      additionalByCpu,
      limitHeadroom,
      recommendations,
    },
    workerPool,
    routing: {
      since: routeTelemetry.since,
      preflightAttempts: routeTelemetry.preflightAttempts,
      redirectFirstCaptures: routeTelemetry.redirectFirstCaptures,
      browserFallbacks: routeTelemetry.browserFallbacks,
      cachedFallbacks: routeTelemetry.cachedFallbacks,
      fallbackReasons: [...routeTelemetry.fallbackReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    },
    planning: {
      browserRequiredCampaignTarget: 100,
      recommendedVcpu: RECOMMENDED_VCPU_FOR_100_BROWSER_CAMPAIGNS,
      effectiveVcpu: effectiveCpus,
      vcpuReady: effectiveCpus >= RECOMMENDED_VCPU_FOR_100_BROWSER_CAMPAIGNS,
    },
    campaigns: campaignRows,
  };
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/capacity") {
    if (!CONTROL_HOST_IS_LOOPBACK && !tokenMatches(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")) && !sessionCookieMatches(req.headers.cookie)) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, error: "Unauthorized" })); return;
    }
    void capacitySnapshot().then(snapshot => {
      const body = JSON.stringify(snapshot);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
      res.end(body);
    }).catch(error => {
      const body = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Capacity snapshot failed" });
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
      res.end(body);
    });
    return;
  }
  if (req.method === "GET" && req.url === "/metrics") {
    const active = activeRuns().length;
    const queued = [...campaigns.values()].filter(campaign => campaign.status === "queued").length;
    const errors = [...campaigns.values()].filter(campaign => campaign.status === "error").length;
    const adsErrors = [...campaigns.values()].filter(campaign => Boolean(campaign.lastError) && campaign.config?.syncGoogleAds === true).length;
    const resourceAdmission = currentResourceAdmission();
    void (async () => {
      const health = distributedStore.enabled ? await distributedStore.health().catch(() => ({ postgres: false, redis: false })) : { postgres: true, redis: true };
      const metrics = [
        "# TYPE tah_control_leader gauge", "tah_control_leader 1",
        `tah_control_leader_losses_total ${leaderLosses}`,
        `tah_runs_active ${active}`,
        `tah_campaigns_queued ${queued}`,
        `tah_campaigns_error ${errors}`,
        `tah_ads_errors ${adsErrors}`,
        `tah_resource_admission_blocked_total ${resourceAdmissionBlocks}`,
        `tah_unchanged_suffix_deliveries_skipped_total ${unchangedSuffixDeliveriesSkipped}`,
        `tah_campaign_launch_gap_ms ${CAMPAIGN_START_GAP_MS}`,
        `tah_system_available_memory_ratio ${resourceAdmission.memoryRatio}`,
        `tah_system_normalized_load ${resourceAdmission.normalizedLoad}`,
        `tah_postgres_healthy ${health.postgres ? 1 : 0}`,
        `tah_redis_healthy ${health.redis ? 1 : 0}`,
        `tah_proxy_verified ${status().verified ? 1 : 0}`,
      ].join("\n") + "\n";
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
      res.end(metrics);
    })();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    if (!CONTROL_HOST_IS_LOOPBACK && !tokenMatches(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")) && !sessionCookieMatches(req.headers.cookie)) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, error: "Unauthorized" })); return;
    }
    const body = JSON.stringify({ ok: true, service: "control", websocket: process.env.TAH_PUBLIC_WS_URL ?? `ws://${req.headers.host ?? `${CONTROL_HOST}:${PORT}`}`, ...status() });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    res.end(body);
    return;
  }
  res.writeHead(426, { "content-type": "application/json; charset=utf-8", upgrade: "websocket" });
  res.end(JSON.stringify({ ok: false, error: "WebSocket upgrade required", health: "/health" }));
});
const wss = new WebSocketServer({
  server,
  maxPayload: 65536,
  handleProtocols: protocols => protocols.has("tah-control") ? "tah-control" : false,
  verifyClient: ({ origin, req }) => {
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    return ORIGINS.has(origin)
      && protocols.includes("tah-control")
      && (INSECURE_LOCAL_CONTROL || sessionCookieMatches(req.headers.cookie) || tokenMatches(protocols.find(value => value !== "tah-control")));
  },
});
server.listen(PORT, CONTROL_HOST, () => {
  console.log(`control server listening on http://${CONTROL_HOST}:${PORT} and ws://${CONTROL_HOST}:${PORT}`);
  if (proxy && !proxy.verified) {
    const requestedGeo = [...campaigns.values()].find(campaign => campaign.desiredRunning)?.config?.geo
      ?? [...campaigns.values()][0]?.config?.geo
      ?? { country: "US", state: "", city: "" };
    const candidate = proxy;
    void resolveProxyEgress(verificationUrl(candidate, requestedGeo)).then(egress => {
      if (!egress.verified || !egress.ip || !egress.timezone) throw new Error("Residential route verification was incomplete");
      proxy = { ...candidate, verified: true, verifiedAt: Date.now(), requestedGeo, egress };
      broadcast("proxy_status", status());
      console.log(`restored IPRoyal route verified for ${requestedGeo.country || "default geo"}`);
    }).catch(error => {
      console.error("Stored IPRoyal route verification failed:", error instanceof Error ? error.message : String(error));
      broadcast("proxy_status", status());
    });
  }
});
if (distributedStore.enabled) {
  setInterval(async () => {
    try {
      if (!(await distributedStore.renewLeader(leaderLeaseMs))) {
        leaderLosses++;
        console.error("Distributed leader lease was lost; stopping owned runs");
        shutdown();
      }
    } catch (error) {
      console.error("Distributed leader renewal failed:", error instanceof Error ? error.message : String(error));
      shutdown();
    }
  }, Math.max(2_000, Math.floor(leaderLeaseMs / 3))).unref();
}
if (proxy && !proxy.verified) void setProxy({ ...proxy, remember: proxy.stored === true }).then(() => broadcast("proxy_status", status())).catch(error => { proxy = { ...proxy, verified: false, verificationError: error instanceof Error ? error.message : String(error) }; });
setInterval(() => { if (clients.size) broadcast("runs", listRuns()); }, 2_000).unref();
const schedulerIntervalMs = Math.max(5_000, Number(process.env.TAH_SCHEDULER_INTERVAL_MS ?? 30_000));
setInterval(() => { void runScheduleTick(); }, schedulerIntervalMs).unref();
setInterval(() => { void reconcileCampaignSchedules(); }, schedulerIntervalMs).unref();
void runScheduleTick();
void reconcileCampaignSchedules();
wss.on("connection", ws => {
  clients.add(ws); send(ws, "hello", { time: Date.now(), ...status() });
  ws.on("message", raw => { try { void handle(ws, JSON.parse(raw.toString("utf8"))); } catch { send(ws, "error", { message: "Invalid control message" }); } });
  ws.on("close", () => clients.delete(ws));
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const run of activeRuns()) terminateRun(run);
  for (const ws of clients) try { ws.close(1001, "Server shutting down"); } catch { /* already closed */ }
  server.close(() => { void orchestratorWorkers.shutdown().then(() => distributedStore.close()).finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const controlMaintenanceTimer = setInterval(() => {
  for (const [runId] of captureQueues) {
    const run = runs.get(runId);
    if (!run || !["starting", "running", "stopping"].includes(run.status)) captureQueues.delete(runId);
  }
}, Math.max(30_000, Number(process.env.TAH_CONTROL_MAINTENANCE_MS) || 60_000));
controlMaintenanceTimer.unref();

process.once("beforeExit", async () => {
  await distributedStateWriteTail.catch(() => undefined);
});
