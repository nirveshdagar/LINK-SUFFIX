import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

export const SCRIPT_FLEET_CAPACITY = 2_000;
export const SCRIPT_FLEET_DEFAULT_SHARD_ACCOUNTS = 40;
export const SCRIPT_FLEET_MAX_SHARD_ACCOUNTS = 50;

export type ScriptDeliveryStatus = "pending" | "verified" | "failed";

export interface ScriptCampaignRecord {
  id: string;
  number?: number;
  name?: string;
  status?: string;
  latestSuffix?: string;
  lastCapturedAt?: string;
  lastMeshVersion?: number;
  updatedAt?: string;
  config?: {
    syncGoogleAds?: boolean;
    googleAdsDelivery?: "script" | "api";
    useHourlyScript?: boolean;
    customerId?: string;
    googleCampaignId?: string;
    loginCustomerId?: string;
  };
}

export interface ScriptDelivery {
  campaignRecordId: string;
  campaignName: string;
  jobId: string;
  capturedAt: string;
  desiredSuffix: string;
  version?: number;
  shardId?: string;
  status: ScriptDeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  acknowledgedAt?: string;
  observedSuffix?: string;
  error?: string;
  batchId?: string;
  leaseUntil?: string;
  pendingSince?: string;
}

export interface ScriptAppliedValue {
  jobId: string;
  suffix: string;
  version?: number;
  verifiedAt: string;
}

export interface ScriptFleetShard {
  id: string;
  managerCustomerId: string;
  accountIds: string[];
  tokenNonce?: string;
  tokenHash?: string;
  tokenHint?: string;
  tokenRotatedAt?: string;
  lastPollAt?: string;
  lastAckAt?: string;
}

export interface ScriptBridgeState {
  version: 2;
  enabledCampaignIds: string[];
  disabledCampaignIds: string[];
  shards: Record<string, ScriptFleetShard>;
  accountAssignments: Record<string, string>;
  applied: Record<string, ScriptAppliedValue>;
  tokenHash?: string;
  tokenHint?: string;
  tokenRotatedAt?: string;
  lastPollAt?: string;
  lastAckAt?: string;
  supersededCount: number;
  deliveries: Record<string, ScriptDelivery>;
  history: Array<ScriptDelivery & { event: "verified" | "failed" | "stale_ack" }>;
}

export interface ScriptBridgeJob {
  batchId: string;
  jobId: string;
  campaignRecordId: string;
  campaignName: string;
  customerId: string;
  campaignId: string;
  suffix: string;
  capturedAt: string;
  version?: number;
}

export interface ScriptAcknowledgement {
  batchId: string;
  jobId: string;
  campaignRecordId: string;
  status: "verified" | "failed";
  observedSuffix?: string;
  error?: string;
}

const currentDirectory = process.cwd();
const projectRoot = path.basename(currentDirectory).toLowerCase() === "web"
  ? path.resolve(currentDirectory, "..")
  : currentDirectory;
const runsDirectory = path.join(projectRoot, "runs");
const campaignRegistryPath = path.join(runsDirectory, "campaigns.json");
const bridgeStatePath = path.join(runsDirectory, "google-ads-script-bridge.json");
const signingKeyPath = path.join(runsDirectory, ".script-bridge-signing.key");
const historyLimit = 2_000;
let writeTail: Promise<void> = Promise.resolve();
let databasePromise: Promise<Pool | null> | undefined;
let signingKeyPromise: Promise<Buffer> | undefined;

function emptyState(): ScriptBridgeState {
  return {
    version: 2,
    enabledCampaignIds: [],
    disabledCampaignIds: [],
    shards: {},
    accountAssignments: {},
    applied: {},
    supersededCount: 0,
    deliveries: {},
    history: [],
  };
}

function digits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeState(value: unknown): ScriptBridgeState {
  if (!value || typeof value !== "object") return emptyState();
  const candidate = value as Partial<ScriptBridgeState>;
  const shards: Record<string, ScriptFleetShard> = {};
  for (const [id, raw] of Object.entries(candidate.shards ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const shard = raw as Partial<ScriptFleetShard>;
    shards[id] = {
      id,
      managerCustomerId: digits(shard.managerCustomerId),
      accountIds: Array.isArray(shard.accountIds) ? shard.accountIds.map(digits).filter((item) => item.length === 10) : [],
      tokenNonce: typeof shard.tokenNonce === "string" ? shard.tokenNonce : undefined,
      tokenHash: typeof shard.tokenHash === "string" ? shard.tokenHash : undefined,
      tokenHint: typeof shard.tokenHint === "string" ? shard.tokenHint : undefined,
      tokenRotatedAt: typeof shard.tokenRotatedAt === "string" ? shard.tokenRotatedAt : undefined,
      lastPollAt: typeof shard.lastPollAt === "string" ? shard.lastPollAt : undefined,
      lastAckAt: typeof shard.lastAckAt === "string" ? shard.lastAckAt : undefined,
    };
  }
  return {
    version: 2,
    enabledCampaignIds: Array.isArray(candidate.enabledCampaignIds)
      ? candidate.enabledCampaignIds.filter((item): item is string => typeof item === "string").slice(0, SCRIPT_FLEET_CAPACITY)
      : [],
    disabledCampaignIds: Array.isArray(candidate.disabledCampaignIds)
      ? candidate.disabledCampaignIds.filter((item): item is string => typeof item === "string")
      : [],
    shards,
    accountAssignments: candidate.accountAssignments && typeof candidate.accountAssignments === "object"
      ? candidate.accountAssignments as Record<string, string>
      : {},
    applied: candidate.applied && typeof candidate.applied === "object"
      ? candidate.applied as Record<string, ScriptAppliedValue>
      : {},
    tokenHash: typeof candidate.tokenHash === "string" ? candidate.tokenHash : undefined,
    tokenHint: typeof candidate.tokenHint === "string" ? candidate.tokenHint : undefined,
    tokenRotatedAt: typeof candidate.tokenRotatedAt === "string" ? candidate.tokenRotatedAt : undefined,
    lastPollAt: typeof candidate.lastPollAt === "string" ? candidate.lastPollAt : undefined,
    lastAckAt: typeof candidate.lastAckAt === "string" ? candidate.lastAckAt : undefined,
    supersededCount: Number.isFinite(candidate.supersededCount) ? Number(candidate.supersededCount) : 0,
    deliveries: candidate.deliveries && typeof candidate.deliveries === "object"
      ? candidate.deliveries as Record<string, ScriptDelivery>
      : {},
    history: Array.isArray(candidate.history) ? candidate.history.slice(-historyLimit) : [],
  };
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function databasePool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  if (!databasePromise) {
    databasePromise = (async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tah_script_bridge_state (
          id smallint PRIMARY KEY CHECK (id = 1),
          payload jsonb NOT NULL,
          version bigint NOT NULL DEFAULT 1,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      return pool;
    })();
  }
  return databasePromise;
}

export async function readBridgeState(): Promise<ScriptBridgeState> {
  const pool = await databasePool();
  if (pool) {
    const result = await pool.query("SELECT payload FROM tah_script_bridge_state WHERE id = 1");
    return normalizeState(result.rows[0]?.payload);
  }
  return normalizeState(await readJson(bridgeStatePath));
}

async function writeBridgeState(state: ScriptBridgeState) {
  await mkdir(runsDirectory, { recursive: true });
  const temporaryPath = `${bridgeStatePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, bridgeStatePath);
}

export async function updateBridgeState<T>(mutator: (state: ScriptBridgeState) => Promise<T> | T): Promise<T> {
  const pool = await databasePool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO tah_script_bridge_state(id, payload) VALUES (1, $1::jsonb) ON CONFLICT(id) DO NOTHING",
        [JSON.stringify(emptyState())],
      );
      const selected = await client.query("SELECT payload FROM tah_script_bridge_state WHERE id = 1 FOR UPDATE");
      const state = normalizeState(selected.rows[0]?.payload);
      const result = await mutator(state);
      await client.query(
        "UPDATE tah_script_bridge_state SET payload = $1::jsonb, version = version + 1, updated_at = now() WHERE id = 1",
        [JSON.stringify(state)],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const task = writeTail.then(async () => {
    const state = await readBridgeState();
    const result = await mutator(state);
    await writeBridgeState(state);
    return result;
  });
  writeTail = task.then(() => undefined, () => undefined);
  return task;
}

export async function readCampaignRegistry(): Promise<ScriptCampaignRecord[]> {
  const pool = await databasePool();
  if (pool) {
    try {
      const result = await pool.query("SELECT payload FROM tah_control_state WHERE name = 'campaigns'");
      if (Array.isArray(result.rows[0]?.payload)) return result.rows[0].payload as ScriptCampaignRecord[];
    } catch (error) {
      if ((error as { code?: string }).code !== "42P01") throw error;
    }
  }
  const value = await readJson(campaignRegistryPath);
  if (Array.isArray(value)) return value as ScriptCampaignRecord[];
  if (value && typeof value === "object" && Array.isArray((value as { campaigns?: unknown[] }).campaigns)) {
    return (value as { campaigns: ScriptCampaignRecord[] }).campaigns;
  }
  return [];
}

function managerCustomerId(campaign: ScriptCampaignRecord) {
  return digits(campaign.config?.loginCustomerId);
}

function customerId(campaign: ScriptCampaignRecord) {
  return digits(campaign.config?.customerId);
}

function accountKey(campaign: ScriptCampaignRecord) {
  return `${managerCustomerId(campaign)}:${customerId(campaign)}`;
}

function campaignJobId(campaign: ScriptCampaignRecord) {
  const suffix = typeof campaign.latestSuffix === "string" ? campaign.latestSuffix : "";
  const capturedAt = campaign.lastCapturedAt ?? campaign.updatedAt ?? "unknown";
  return createHash("sha256")
    .update(campaign.id)
    .update("\0")
    .update(capturedAt)
    .update("\0")
    .update(suffix)
    .digest("hex");
}

function isScriptCampaign(state: ScriptBridgeState, campaign: ScriptCampaignRecord) {
  if (state.disabledCampaignIds.includes(campaign.id)) return false;
  return state.enabledCampaignIds.includes(campaign.id) || campaign.config?.useHourlyScript === true;
}

export function campaignHasCompleteFleetTarget(campaign: ScriptCampaignRecord) {
  return managerCustomerId(campaign).length === 10
    && customerId(campaign).length === 10
    && /^\d+$/.test(digits(campaign.config?.googleCampaignId));
}

function leaseActive(delivery: ScriptDelivery | undefined, now: number) {
  return Boolean(delivery?.leaseUntil && Date.parse(delivery.leaseUntil) > now && delivery.status === "pending");
}

function normalizedShardSize(value: number) {
  return Math.max(1, Math.min(SCRIPT_FLEET_MAX_SHARD_ACCOUNTS, Math.trunc(value || SCRIPT_FLEET_DEFAULT_SHARD_ACCOUNTS)));
}

function nextShardId(state: ScriptBridgeState, managerId: string) {
  for (let index = 1; index <= SCRIPT_FLEET_CAPACITY; index += 1) {
    const candidate = `mcc-${managerId}-${String(index).padStart(3, "0")}`;
    if (!state.shards[candidate]) return candidate;
  }
  throw new Error(`No shard identifier is available for MCC ${managerId}.`);
}

export function reconcileFleetShards(
  state: ScriptBridgeState,
  campaigns: ScriptCampaignRecord[],
  requestedShardSize = SCRIPT_FLEET_DEFAULT_SHARD_ACCOUNTS,
) {
  const shardSize = normalizedShardSize(requestedShardSize);
  const activeAccounts = new Map<string, { managerId: string; customerId: string }>();
  for (const campaign of campaigns) {
    if (!isScriptCampaign(state, campaign) || !campaignHasCompleteFleetTarget(campaign)) continue;
    activeAccounts.set(accountKey(campaign), { managerId: managerCustomerId(campaign), customerId: customerId(campaign) });
  }
  for (const key of Object.keys(state.accountAssignments)) {
    if (!activeAccounts.has(key)) delete state.accountAssignments[key];
  }
  for (const shard of Object.values(state.shards)) shard.accountIds = [];
  for (const [key, account] of [...activeAccounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    let shardId = state.accountAssignments[key];
    let shard = shardId ? state.shards[shardId] : undefined;
    if (!shard || shard.managerCustomerId !== account.managerId || shard.id === "legacy") {
      shard = Object.values(state.shards)
        .filter((candidate) => candidate.id !== "legacy" && candidate.managerCustomerId === account.managerId && candidate.accountIds.length < shardSize)
        .sort((left, right) => left.accountIds.length - right.accountIds.length || left.id.localeCompare(right.id))[0];
      if (!shard) {
        shardId = nextShardId(state, account.managerId);
        shard = { id: shardId, managerCustomerId: account.managerId, accountIds: [] };
        state.shards[shardId] = shard;
      }
      state.accountAssignments[key] = shard.id;
    }
    if (!shard.accountIds.includes(account.customerId)) shard.accountIds.push(account.customerId);
  }
  for (const shard of Object.values(state.shards)) shard.accountIds.sort();
  return Object.values(state.shards).filter((shard) => shard.id !== "legacy").sort((left, right) => left.id.localeCompare(right.id));
}

export function synchronizeDeliveries(state: ScriptBridgeState, campaigns: ScriptCampaignRecord[], now = Date.now()) {
  const eligibleIds = new Set<string>();
  for (const campaign of campaigns) {
    if (!isScriptCampaign(state, campaign) || !campaignHasCompleteFleetTarget(campaign) || typeof campaign.latestSuffix !== "string") continue;
    eligibleIds.add(campaign.id);
    const jobId = campaignJobId(campaign);
    const existing = state.deliveries[campaign.id];
    if (existing?.jobId === jobId || leaseActive(existing, now)) continue;
    if (existing && existing.status !== "verified") state.supersededCount += 1;
    const capturedAt = campaign.lastCapturedAt ?? campaign.updatedAt ?? new Date(now).toISOString();
    state.deliveries[campaign.id] = {
      campaignRecordId: campaign.id,
      campaignName: campaign.name ?? campaign.id,
      jobId,
      capturedAt,
      desiredSuffix: campaign.latestSuffix,
      version: campaign.lastMeshVersion,
      status: "pending",
      attempts: 0,
      pendingSince: existing && existing.status !== "verified"
        ? existing.pendingSince ?? existing.capturedAt
        : capturedAt,
    };
  }
  for (const campaignId of Object.keys(state.deliveries)) {
    if (!eligibleIds.has(campaignId) && !leaseActive(state.deliveries[campaignId], now)) delete state.deliveries[campaignId];
  }
}

function campaignDeliveryStatus(state: ScriptBridgeState, campaign: ScriptCampaignRecord) {
  if (!isScriptCampaign(state, campaign)) return "not_enrolled";
  if (!campaignHasCompleteFleetTarget(campaign)) return "misconfigured";
  if (typeof campaign.latestSuffix !== "string") return "waiting";
  const applied = state.applied[campaign.id];
  if (applied?.jobId === campaignJobId(campaign) && applied.suffix === campaign.latestSuffix) return "verified";
  return state.deliveries[campaign.id]?.status ?? "pending";
}

export function bridgeSummary(
  state: ScriptBridgeState,
  campaigns: ScriptCampaignRecord[],
  options: { page?: number; pageSize?: number; search?: string; status?: string; shardSize?: number } = {},
) {
  const now = Date.now();
  const activeWorkerWindowMs = 2 * 60_000;
  const handoffGraceWindowMs = Math.max(
    activeWorkerWindowMs,
    Number(process.env.TAH_SCRIPT_FLEET_HANDOFF_GRACE_MS ?? 15 * 60_000) || 15 * 60_000,
  );
  const delayedUpdateWindowMs = Math.max(
    2 * 60_000,
    Number(process.env.TAH_SCRIPT_FLEET_DELAYED_MS ?? handoffGraceWindowMs) || handoffGraceWindowMs,
  );
  const shardSize = normalizedShardSize(options.shardSize ?? SCRIPT_FLEET_DEFAULT_SHARD_ACCOUNTS);
  const shards = reconcileFleetShards(state, campaigns, shardSize);
  const scriptCampaigns = campaigns.filter((campaign) => isScriptCampaign(state, campaign));
  const configuredCampaigns = scriptCampaigns.filter(campaignHasCompleteFleetTarget);
  const search = String(options.search ?? "").trim().toLowerCase();
  const statusFilter = String(options.status ?? "all").replaceAll("-", "_");
  const ageSeconds = (value: string | undefined) => {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 1_000)) : null;
  };
  const shardWorkerState = (shard: ScriptFleetShard | undefined) => {
    if (!shard) return "unassigned";
    if (!shard.tokenNonce && !shard.tokenHash) return "unconfigured";
    const pollAge = ageSeconds(shard.lastPollAt);
    if (pollAge === null) return "waiting";
    if (pollAge * 1_000 <= activeWorkerWindowMs) return "active";
    if (pollAge * 1_000 <= handoffGraceWindowMs) return "handoff";
    return "offline";
  };
  const allRows = campaigns.map((campaign) => {
    const delivery = state.deliveries[campaign.id];
    const applied = state.applied[campaign.id];
    const status = campaignDeliveryStatus(state, campaign);
    const capturedSuffix = typeof campaign.latestSuffix === "string" ? campaign.latestSuffix : "";
    const hasCapturedSuffix = typeof campaign.latestSuffix === "string";
    const latestIsVerified = hasCapturedSuffix
      && applied?.jobId === campaignJobId(campaign)
      && applied.suffix === campaign.latestSuffix;
    const deliveryEligible = status !== "not_enrolled" && status !== "misconfigured";
    const hasPendingUpdate = deliveryEligible && hasCapturedSuffix && !latestIsVerified;
    const pendingStartedAt = hasPendingUpdate
      ? delivery?.pendingSince ?? delivery?.capturedAt ?? campaign.lastCapturedAt
      : undefined;
    const queueAgeSeconds = hasPendingUpdate ? ageSeconds(pendingStartedAt) ?? 0 : 0;
    const leased = hasPendingUpdate && leaseActive(delivery, now);
    const assignedShardId = state.accountAssignments[accountKey(campaign)];
    const workerState = shardWorkerState(state.shards[assignedShardId]);
    let deliveryHealth = status;
    if (status === "verified" || (applied && status === "pending")) deliveryHealth = "healthy";
    if (status === "pending" && !applied) deliveryHealth = "starting";
    if (hasPendingUpdate && queueAgeSeconds * 1_000 > delayedUpdateWindowMs) deliveryHealth = "delayed";
    if (delivery?.status === "failed") deliveryHealth = "failed";
    const updateState = status === "not_enrolled"
      ? "not_enrolled"
      : status === "misconfigured"
        ? "misconfigured"
        : !hasCapturedSuffix
          ? "waiting"
          : latestIsVerified
            ? "current"
            : delivery?.status === "failed"
              ? "retrying"
              : leased
                ? "processing"
                : "queued";
    return {
      id: campaign.id,
      number: campaign.number,
      name: campaign.name ?? campaign.id,
      runStatus: campaign.status ?? "unknown",
      enabled: isScriptCampaign(state, campaign),
      configured: campaignHasCompleteFleetTarget(campaign),
      managerCustomerId: managerCustomerId(campaign),
      customerId: customerId(campaign),
      campaignId: digits(campaign.config?.googleCampaignId),
      shardId: assignedShardId,
      status,
      deliveryStatus: status,
      deliveryHealth,
      updateState,
      hasPendingUpdate,
      leased,
      queueAgeSeconds,
      pendingSince: pendingStartedAt,
      workerState,
      workerPollAgeSeconds: ageSeconds(state.shards[assignedShardId]?.lastPollAt),
      capturedSuffix,
      appliedSuffix: applied?.suffix ?? "",
      capturedVersion: campaign.lastMeshVersion,
      appliedVersion: applied?.version,
      lastCapturedAt: campaign.lastCapturedAt,
      lastAppliedAt: applied?.verifiedAt,
      attempts: delivery?.attempts ?? 0,
      error: delivery?.error,
    };
  });
  const rows = allRows.filter((campaign) => {
    if (statusFilter === "healthy" && campaign.deliveryHealth !== "healthy") return false;
    if (statusFilter === "queued" && !campaign.hasPendingUpdate) return false;
    if (statusFilter === "delayed" && campaign.deliveryHealth !== "delayed") return false;
    if (statusFilter === "failed" && campaign.deliveryHealth !== "failed") return false;
    if (
      !["all", "healthy", "queued", "delayed", "failed"].includes(statusFilter)
      && campaign.status !== statusFilter
    ) return false;
    if (!search) return true;
    return [campaign.name, campaign.id, campaign.managerCustomerId, campaign.customerId, campaign.campaignId, campaign.shardId]
      .some((value) => String(value ?? "").toLowerCase().includes(search));
  });
  const pageSize = Math.max(10, Math.min(100, Math.trunc(options.pageSize ?? 25)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(1, Math.min(pageCount, Math.trunc(options.page ?? 1)));
  const campaignCounts = new Map<string, number>();
  const accountCampaignCounts = new Map<string, number>();
  for (const campaign of configuredCampaigns) {
    const shardId = state.accountAssignments[accountKey(campaign)];
    if (shardId) campaignCounts.set(shardId, (campaignCounts.get(shardId) ?? 0) + 1);
    const key = accountKey(campaign);
    accountCampaignCounts.set(key, (accountCampaignCounts.get(key) ?? 0) + 1);
  }
  const queueAges = allRows
    .filter((item) => item.hasPendingUpdate)
    .map((item) => item.queueAgeSeconds)
    .sort((left, right) => left - right);
  const percentile = (values: number[], value: number) => values.length
    ? values[Math.min(values.length - 1, Math.floor((value / 100) * values.length))]
    : 0;
  const activeShards = shards.filter((shard) => shard.accountIds.length > 0);
  const recentWindowStart = now - 5 * 60_000;
  return {
    configured: shards.some((shard) => Boolean(shard.tokenNonce || shard.tokenHash)) || Boolean(state.tokenHash),
    capacity: SCRIPT_FLEET_CAPACITY,
    shardAccountLimit: shardSize,
    shardCount: shards.filter((shard) => shard.accountIds.length > 0).length,
    lastPollAt: state.lastPollAt,
    lastAckAt: state.lastAckAt,
    campaignCount: scriptCampaigns.length,
    misconfiguredCount: scriptCampaigns.length - configuredCampaigns.length,
    pendingCount: allRows.filter((item) => item.hasPendingUpdate).length,
    queuedCount: allRows.filter((item) => item.updateState === "queued").length,
    processingCount: allRows.filter((item) => item.updateState === "processing").length,
    failedCount: allRows.filter((item) => item.deliveryHealth === "failed").length,
    delayedCount: allRows.filter((item) => item.deliveryHealth === "delayed").length,
    startingCount: allRows.filter((item) => item.deliveryHealth === "starting").length,
    healthyCount: allRows.filter((item) => item.deliveryHealth === "healthy").length,
    verifiedCount: allRows.filter((item) => item.status === "verified").length,
    oldestPendingSeconds: queueAges.at(-1) ?? 0,
    p95PendingSeconds: percentile(queueAges, 95),
    queueSlaSeconds: Math.floor(delayedUpdateWindowMs / 1_000),
    verifiedLast5Minutes: state.history.filter((item) =>
      item.event === "verified" && Date.parse(item.acknowledgedAt ?? "") >= recentWindowStart
    ).length,
    failedLast5Minutes: state.history.filter((item) =>
      item.event === "failed" && Date.parse(item.acknowledgedAt ?? "") >= recentWindowStart
    ).length,
    activeShardCount: activeShards.filter((shard) => shardWorkerState(shard) === "active").length,
    handoffShardCount: activeShards.filter((shard) => shardWorkerState(shard) === "handoff").length,
    offlineShardCount: activeShards.filter((shard) => ["offline", "waiting", "unconfigured"].includes(shardWorkerState(shard))).length,
    largestAccountCampaignCount: Math.max(0, ...accountCampaignCounts.values()),
    supersededCount: state.supersededCount,
    shards: shards.map((shard) => ({
      id: shard.id,
      managerCustomerId: shard.managerCustomerId,
      accountCount: shard.accountIds.length,
      campaignCount: campaignCounts.get(shard.id) ?? 0,
      configured: Boolean(shard.tokenNonce || shard.tokenHash),
      tokenHint: shard.tokenHint,
      tokenRotatedAt: shard.tokenRotatedAt,
      lastPollAt: shard.lastPollAt,
      lastAckAt: shard.lastAckAt,
      workerState: shardWorkerState(shard),
      pollAgeSeconds: ageSeconds(shard.lastPollAt),
      pendingCampaignCount: allRows.filter((campaign) => campaign.shardId === shard.id && campaign.hasPendingUpdate).length,
      delayedCampaignCount: allRows.filter((campaign) => campaign.shardId === shard.id && campaign.deliveryHealth === "delayed").length,
    })),
    availableCampaigns: rows.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, pageCount, total: rows.length },
    history: state.history.slice(-20).reverse().map((item) => ({
      campaignRecordId: item.campaignRecordId,
      campaignName: item.campaignName,
      status: item.status,
      event: item.event,
      acknowledgedAt: item.acknowledgedAt,
      error: item.error,
      shardId: item.shardId,
    })),
  };
}

export function setScriptCampaignEnabled(state: ScriptBridgeState, campaignRecordId: string, enabled: boolean) {
  const selected = new Set(state.enabledCampaignIds);
  const disabled = new Set(state.disabledCampaignIds);
  if (enabled) {
    if (!selected.has(campaignRecordId) && selected.size >= SCRIPT_FLEET_CAPACITY) throw new Error(`Rolling Apps Script Fleet capacity is ${SCRIPT_FLEET_CAPACITY.toLocaleString()} campaigns.`);
    selected.add(campaignRecordId);
    disabled.delete(campaignRecordId);
  } else {
    selected.delete(campaignRecordId);
    disabled.add(campaignRecordId);
  }
  state.enabledCampaignIds = [...selected];
  state.disabledCampaignIds = [...disabled];
  if (!enabled) delete state.deliveries[campaignRecordId];
}

export function setManyScriptCampaignsEnabled(state: ScriptBridgeState, campaignRecordIds: string[], enabled: boolean) {
  const unique = [...new Set(campaignRecordIds)];
  if (enabled) {
    const selected = new Set(state.enabledCampaignIds);
    for (const id of unique) selected.add(id);
    if (selected.size > SCRIPT_FLEET_CAPACITY) throw new Error(`Rolling Apps Script Fleet capacity is ${SCRIPT_FLEET_CAPACITY.toLocaleString()} campaigns.`);
  }
  for (const id of unique) setScriptCampaignEnabled(state, id, enabled);
}

export function issueJobs(
  state: ScriptBridgeState,
  campaigns: ScriptCampaignRecord[],
  shardId: string,
  maximumJobs: number,
  leaseMilliseconds: number,
  shardSize = SCRIPT_FLEET_DEFAULT_SHARD_ACCOUNTS,
  requestedCustomerId?: string,
): ScriptBridgeJob[] {
  const now = Date.now();
  const batchId = randomBytes(12).toString("hex");
  const scopedCustomerId = digits(requestedCustomerId);
  synchronizeDeliveries(state, campaigns, now);
  reconcileFleetShards(state, campaigns, shardSize);
  const byId = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const candidateLimit = Math.max(1, Math.min(500, maximumJobs));
  const eligibleCandidates = Object.values(state.deliveries)
    .filter((delivery) => {
      if (delivery.status === "verified" || leaseActive(delivery, now)) return false;
      const campaign = byId.get(delivery.campaignRecordId);
      if (!campaign) return false;
      if (scopedCustomerId && customerId(campaign) !== scopedCustomerId) {
        return false;
      }
      const lastVerifiedAt = Date.parse(
        state.applied[delivery.campaignRecordId]?.verifiedAt ?? "",
      );
      if (
        Number.isFinite(lastVerifiedAt) &&
        now - lastVerifiedAt < 58_000
      ) {
        return false;
      }
      return shardId === "legacy" || state.accountAssignments[accountKey(campaign)] === shardId;
    })
    .sort((left, right) => Date.parse(left.pendingSince ?? left.capturedAt) - Date.parse(right.pendingSince ?? right.capturedAt));
  const candidates: ScriptDelivery[] = [];
  if (scopedCustomerId) {
    candidates.push(...eligibleCandidates.slice(0, candidateLimit));
  } else {
    const grouped = new Map<string, ScriptDelivery[]>();
    for (const delivery of eligibleCandidates) {
      const campaign = byId.get(delivery.campaignRecordId);
      if (!campaign) continue;
      const key = customerId(campaign);
      const group = grouped.get(key) ?? [];
      group.push(delivery);
      grouped.set(key, group);
    }
    const groups = [...grouped.values()].sort((left, right) =>
      Date.parse(left[0]?.pendingSince ?? left[0]?.capturedAt ?? "")
      - Date.parse(right[0]?.pendingSince ?? right[0]?.capturedAt ?? "")
    );
    let index = 0;
    while (candidates.length < candidateLimit && groups.length > 0) {
      const group = groups[index % groups.length];
      const candidate = group.shift();
      if (candidate) candidates.push(candidate);
      if (!group.length) groups.splice(index % groups.length, 1);
      else index += 1;
    }
  }
  const jobs: ScriptBridgeJob[] = [];
  for (const delivery of candidates) {
    const campaign = byId.get(delivery.campaignRecordId);
    if (!campaign || typeof campaign.latestSuffix !== "string" || campaignJobId(campaign) !== delivery.jobId) continue;
    const targetCustomerId = customerId(campaign);
    const targetCampaignId = digits(campaign.config?.googleCampaignId);
    if (targetCustomerId.length !== 10 || !targetCampaignId) continue;
    delivery.status = "pending";
    delivery.attempts += 1;
    delivery.lastAttemptAt = new Date(now).toISOString();
    delivery.batchId = batchId;
    delivery.shardId = shardId;
    delivery.leaseUntil = new Date(now + leaseMilliseconds).toISOString();
    jobs.push({
      batchId,
      jobId: delivery.jobId,
      campaignRecordId: campaign.id,
      campaignName: campaign.name ?? campaign.id,
      customerId: targetCustomerId,
      campaignId: targetCampaignId,
      suffix: campaign.latestSuffix,
      capturedAt: delivery.capturedAt,
      version: delivery.version,
    });
  }
  const polledAt = new Date(now).toISOString();
  state.lastPollAt = polledAt;
  if (state.shards[shardId]) state.shards[shardId].lastPollAt = polledAt;
  return jobs;
}

export function acknowledgeJobs(state: ScriptBridgeState, shardId: string, results: ScriptAcknowledgement[]) {
  const now = new Date().toISOString();
  let accepted = 0;
  let stale = 0;
  for (const result of results.slice(0, 500)) {
    const delivery = state.deliveries[result.campaignRecordId];
    if (!delivery || delivery.jobId !== result.jobId || delivery.batchId !== result.batchId || (delivery.shardId && delivery.shardId !== shardId)) {
      stale += 1;
      if (delivery) state.history.push({ ...delivery, event: "stale_ack", acknowledgedAt: now });
      continue;
    }
    const exactMatch = result.status === "verified" && result.observedSuffix === delivery.desiredSuffix;
    delivery.status = exactMatch ? "verified" : "failed";
    delivery.acknowledgedAt = now;
    delivery.observedSuffix = typeof result.observedSuffix === "string" ? result.observedSuffix : undefined;
    delivery.error = exactMatch
      ? undefined
      : String(result.error ?? (result.status === "verified" ? "Google Ads read-back did not exactly match the captured suffix." : "Google Ads Script reported a failure")).slice(0, 800);
    delivery.leaseUntil = undefined;
    delivery.batchId = undefined;
    if (exactMatch) {
      state.applied[result.campaignRecordId] = {
        jobId: delivery.jobId,
        suffix: result.observedSuffix as string,
        version: delivery.version,
        verifiedAt: now,
      };
    }
    state.history.push({ ...delivery, event: exactMatch ? "verified" : "failed", acknowledgedAt: now });
    accepted += 1;
  }
  state.history = state.history.slice(-historyLimit);
  state.lastAckAt = now;
  if (state.shards[shardId]) state.shards[shardId].lastAckAt = now;
  return { accepted, stale };
}

async function bridgeSigningKey() {
  if (signingKeyPromise) return signingKeyPromise;
  signingKeyPromise = (async () => {
    const configured = process.env.TAH_SCRIPT_BRIDGE_SIGNING_KEY?.trim();
    if (configured) {
      if (configured.length < 32) throw new Error("TAH_SCRIPT_BRIDGE_SIGNING_KEY must contain at least 32 characters.");
      return createHash("sha256").update(configured, "utf8").digest();
    }
    if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) throw new Error("TAH_SCRIPT_BRIDGE_SIGNING_KEY is required when the fleet runs with PostgreSQL in production.");
    await mkdir(runsDirectory, { recursive: true });
    try {
      const existing = Buffer.from((await readFile(signingKeyPath, "utf8")).trim(), "base64");
      if (existing.length === 32) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const generated = randomBytes(32);
    try {
      await writeFile(signingKeyPath, generated.toString("base64"), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = Buffer.from((await readFile(signingKeyPath, "utf8")).trim(), "base64");
      if (existing.length !== 32) throw new Error("The Script Fleet signing key is invalid.");
      return existing;
    }
  })();
  return signingKeyPromise;
}

async function derivedShardToken(shard: ScriptFleetShard) {
  if (!shard.tokenNonce) throw new Error(`Shard ${shard.id} has no generated credential.`);
  const digest = createHmac("sha256", await bridgeSigningKey())
    .update(shard.id)
    .update("\0")
    .update(shard.tokenNonce)
    .digest("base64url");
  return `tahsf_${digest}`;
}

export async function getOrCreateShardToken(state: ScriptBridgeState, shardId: string, rotate = false) {
  const shard = state.shards[shardId];
  if (!shard || shard.id === "legacy") throw new Error("The selected Script Fleet shard was not found.");
  if (rotate || !shard.tokenNonce) {
    shard.tokenNonce = randomBytes(18).toString("base64url");
    shard.tokenRotatedAt = new Date().toISOString();
  }
  const token = await derivedShardToken(shard);
  shard.tokenHash = createHash("sha256").update(token).digest("hex");
  shard.tokenHint = `${token.slice(0, 11)}...${token.slice(-4)}`;
  return { token, shard };
}

function tokenHashMatches(expectedHex: string | undefined, candidate: string) {
  if (!expectedHex || !candidate) return false;
  const actual = Buffer.from(createHash("sha256").update(candidate).digest("hex"), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function verifyBridgeToken(state: ScriptBridgeState, candidate: string, requestedShardId?: string | null) {
  if (requestedShardId) {
    const shard = state.shards[requestedShardId];
    if (!shard) return false;
    if (shard.tokenNonce) return tokenHashMatches(shard.tokenHash, candidate) && candidate === await derivedShardToken(shard);
    return tokenHashMatches(shard.tokenHash, candidate);
  }
  return tokenHashMatches(state.tokenHash, candidate);
}

export function extractBearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
  return request.headers.get("x-script-bridge-token")?.trim() ?? "";
}

export function buildGoogleAdsManagerScript(endpoint: string, token: string, shardId: string) {
  return `/**
 * Traffic Armour Rolling Apps Script Fleet hourly relay.
 * Install this copy once in MCC ${shardId}, authorize it, and schedule it Hourly.
 * It uses one supported executeInParallel phase with a callback, then continues
 * the server-assigned shard until Google's 60-minute manager-script guard.
 */
const CONFIG = Object.freeze({
  BRIDGE_URL: ${JSON.stringify(endpoint)},
  BRIDGE_TOKEN: ${JSON.stringify(token)},
  SHARD_ID: ${JSON.stringify(shardId)},
  MAX_ACCOUNTS: ${SCRIPT_FLEET_MAX_SHARD_ACCOUNTS},
  WORKER_VERSION: "fleet-hourly-relay-v5",
  MIN_REMAINING_SECONDS: 90,
  ACCOUNT_POLL_MS: 50000,
  IDLE_POLL_MS: 10000,
  POST_BATCH_SLEEP_MS: 50000,
  ERROR_BACKOFF_MS: 10000
});

function main() {
  const executionInfo = AdsApp.getExecutionInfo();
  const preview = executionInfo.isPreview();
  if (preview) {
    bridgeRequest_("get", null, true, "", false);
    Logger.log("Traffic Armour Fleet preview connected for " + CONFIG.SHARD_ID + ". No jobs were leased and no campaign was changed.");
    return;
  }

  const manifest = bridgeRequest_("get", null, false, "", true);
  const accountIds = Array.isArray(manifest.accountIds) ? manifest.accountIds : [];
  if (!accountIds.length) {
    Logger.log("Traffic Armour Fleet " + CONFIG.SHARD_ID + " has no assigned child accounts.");
    return;
  }
  if (accountIds.length > CONFIG.MAX_ACCOUNTS) {
    throw new Error("Shard manifest exceeds the supported 50-account manager-script limit.");
  }

  Logger.log("Traffic Armour Fleet " + CONFIG.SHARD_ID + " hourly relay started for " + accountIds.length + " child account(s) (" + CONFIG.WORKER_VERSION + ").");
  AdsManagerApp.accounts()
    .withIds(accountIds)
    .withLimit(CONFIG.MAX_ACCOUNTS)
    .executeInParallel("bootstrapAccount_", "continueFleetRelay_", "");
}

function bootstrapAccount_() {
  const customerId = String(AdsApp.currentAccount().getCustomerId() || "").replace(/\\D/g, "");
  const executionInfo = AdsApp.getExecutionInfo();
  let completedCycles = 0;
  let total = 0;
  let verified = 0;
  while (executionInfo.getRemainingTime() > CONFIG.MIN_REMAINING_SECONDS) {
    try {
      const response = bridgeRequest_("get", null, false, customerId, false);
      const jobs = Array.isArray(response.jobs) ? response.jobs : [];
      const outcome = executeCurrentAccountBatch_(jobs, customerId);
      completedCycles += 1;
      total += outcome.total;
      verified += outcome.verified;
      sleepWithinDeadline_(CONFIG.ACCOUNT_POLL_MS, executionInfo);
    } catch (error) {
      Logger.log("Traffic Armour Fleet account cycle failed for " + customerId + ": " + safeError_(error));
      sleepWithinDeadline_(CONFIG.ERROR_BACKOFF_MS, executionInfo);
    }
  }
  return JSON.stringify({ customerId: customerId, cycles: completedCycles, total: total, verified: verified });
}

function continueFleetRelay_(executionResults) {
  let bootstrapOk = 0;
  let bootstrapFailed = 0;
  (executionResults || []).forEach(function(result) {
    if (String(result.getStatus()) === "OK") bootstrapOk += 1;
    else bootstrapFailed += 1;
  });
  Logger.log("Traffic Armour Fleet " + CONFIG.SHARD_ID + " bootstrap complete: " + bootstrapOk + " account(s) ready, " + bootstrapFailed + " failed.");
  runContinuousRelay_();
}

function runContinuousRelay_() {
  const executionInfo = AdsApp.getExecutionInfo();
  let completedBatches = 0;
  while (executionInfo.getRemainingTime() > CONFIG.MIN_REMAINING_SECONDS) {
    try {
      const response = bridgeRequest_("get", null, false, "", false);
      const jobs = Array.isArray(response.jobs) ? response.jobs : [];
      if (jobs.length) {
        executeFleetBatch_(jobs);
        completedBatches += 1;
      }
      sleepWithinDeadline_(
        jobs.length ? CONFIG.POST_BATCH_SLEEP_MS : CONFIG.IDLE_POLL_MS,
        executionInfo,
      );
    } catch (error) {
      Logger.log("Traffic Armour Fleet cycle failed: " + safeError_(error));
      sleepWithinDeadline_(CONFIG.ERROR_BACKOFF_MS, executionInfo);
    }
  }
  Logger.log("Traffic Armour Fleet " + CONFIG.SHARD_ID + " completed its hourly relay before Google's 60-minute deadline after " + completedBatches + " callback batch(es). The Hourly schedule starts the next relay.");
}

function executeCurrentAccountBatch_(jobs, customerId) {
  const accountJobs = jobs.filter(function(job) {
    return String(job.customerId || "").replace(/\\D/g, "") === customerId;
  });
  const results = applyAndVerifyBatch_(accountJobs);
  if (results.length) bridgeRequest_("post", { results: results }, false, "", false);
  const verified = results.filter(function(item) { return item.status === "verified"; }).length;
  if (results.length) Logger.log("Traffic Armour Fleet " + CONFIG.SHARD_ID + " account " + customerId + ": " + verified + " verified, " + (results.length - verified) + " failed.");
  return { total: results.length, verified: verified };
}

function executeFleetBatch_(jobs) {
  const groups = {};
  jobs.forEach(function(job) {
    if (!groups[job.customerId]) groups[job.customerId] = [];
    groups[job.customerId].push(job);
  });
  const accountIds = Object.keys(groups);
  if (accountIds.length > CONFIG.MAX_ACCOUNTS) throw new Error("Shard returned more accounts than this worker permits.");
  const accounts = AdsManagerApp.accounts()
    .withIds(accountIds)
    .withLimit(CONFIG.MAX_ACCOUNTS)
    .get();
  const processed = {};
  const results = [];
  while (accounts.hasNext()) {
    const account = accounts.next();
    const customerId = String(account.getCustomerId() || "").replace(/\\D/g, "");
    const accountJobs = Array.isArray(groups[customerId]) ? groups[customerId] : [];
    if (!accountJobs.length) continue;
    processed[customerId] = true;
    AdsManagerApp.select(account);
    Array.prototype.push.apply(results, applyAndVerifyBatch_(accountJobs));
  }
  accountIds.forEach(function(customerId) {
    if (processed[customerId]) return;
    groups[customerId].forEach(function(job) {
      results.push(failedResult_(job, "Child account " + customerId + " is not linked to this MCC"));
    });
  });
  if (results.length) bridgeRequest_("post", { results: results }, false, "", false);
  const verified = results.filter(function(item) { return item.status === "verified"; }).length;
  Logger.log("Traffic Armour Fleet " + CONFIG.SHARD_ID + ": " + verified + " verified, " + (results.length - verified) + " failed.");
}

function sleepWithinDeadline_(milliseconds, executionInfo) {
  const available = Math.max(
    0,
    (executionInfo.getRemainingTime() - CONFIG.MIN_REMAINING_SECONDS) * 1000,
  );
  if (available > 0) Utilities.sleep(Math.min(milliseconds, available));
}

function applyAndVerifyBatch_(jobs) {
  if (!jobs.length) return [];
  const before = readSuffixes_(jobs.map(function(job) { return job.campaignId; }));
  const changes = jobs.filter(function(job) { return before[job.campaignId] !== job.suffix; });
  const mutationErrors = {};
  if (changes.length) {
    const operations = changes.map(function(job) {
      return { campaignOperation: { update: { resourceName: "customers/" + job.customerId + "/campaigns/" + job.campaignId, finalUrlSuffix: job.suffix }, updateMask: "finalUrlSuffix" } };
    });
    const mutationResults = AdsApp.mutateAll(operations, { partialFailure: true });
    mutationResults.forEach(function(result, index) {
      if (!result.isSuccessful()) mutationErrors[changes[index].jobId] = result.getErrorMessages().join("; ");
    });
  }
  const after = readSuffixes_(jobs.map(function(job) { return job.campaignId; }));
  return jobs.map(function(job) {
    if (mutationErrors[job.jobId]) return failedResult_(job, mutationErrors[job.jobId]);
    if (after[job.campaignId] !== job.suffix) {
      return failedResult_(job, "Read-back verification did not exactly match the captured suffix");
    }
    return baseResult_(job, "verified", after[job.campaignId]);
  });
}

function readSuffixes_(campaignIds) {
  const ids = campaignIds.map(function(value) { return String(value || "").replace(/\\D/g, ""); }).filter(Boolean);
  if (!ids.length) return {};
  const rows = AdsApp.search("SELECT campaign.id, campaign.final_url_suffix FROM campaign WHERE campaign.id IN (" + ids.join(",") + ")");
  const suffixes = {};
  while (rows.hasNext()) {
    const row = rows.next();
    suffixes[String(row.campaign.id)] = String(row.campaign.finalUrlSuffix || "");
  }
  return suffixes;
}

function bridgeRequest_(method, payload, preview, customerId, manifest) {
  const separator = CONFIG.BRIDGE_URL.indexOf("?") >= 0 ? "&" : "?";
  let url = CONFIG.BRIDGE_URL + separator + "worker=" + encodeURIComponent(CONFIG.WORKER_VERSION);
  if (preview) url += "&preview=1";
  if (customerId) url += "&customer=" + encodeURIComponent(customerId);
  if (manifest) url += "&manifest=1";
  const options = { method: method, headers: { Authorization: "Bearer " + CONFIG.BRIDGE_TOKEN }, muteHttpExceptions: true };
  if (payload) { options.contentType = "application/json"; options.payload = JSON.stringify(payload); }
  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) throw new Error("Bridge HTTP " + status + ": " + body.slice(0, 300));
  return body ? JSON.parse(body) : {};
}

function baseResult_(job, status, observedSuffix) {
  return { batchId: job.batchId, jobId: job.jobId, campaignRecordId: job.campaignRecordId, status: status, observedSuffix: observedSuffix };
}

function failedResult_(job, error) {
  const result = baseResult_(job, "failed", undefined);
  result.error = String(error || "Unknown script error").slice(0, 800);
  return result;
}

function safeError_(error) {
  return error && error.message ? error.message : String(error || "Unknown script error");
}
`;
}
