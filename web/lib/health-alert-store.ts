import { Pool } from "pg";
import { readBridgeState, readCampaignRegistry } from "./google-ads-script-bridge";

export type HealthSeverity = "warning" | "critical";
export type HealthAlertStatus = "observing" | "active" | "acknowledged" | "resolved";
export type HealthState = "healthy" | "warning" | "critical";

type JsonRecord = Record<string, unknown>;

interface AlertCandidate {
  fingerprint: string;
  severity: HealthSeverity;
  component: string;
  scope: string;
  code: string;
  title: string;
  message: string;
  remediation: string;
  campaignRecordId?: string;
  shardId?: string;
  activationAfterMs: number;
  details: JsonRecord;
}

interface ComponentHeartbeat {
  componentId: string;
  componentType: string;
  state: HealthState;
  message: string;
  latencyMs?: number;
  details?: JsonRecord;
}

export interface HealthAlertRecord {
  fingerprint: string;
  severity: HealthSeverity;
  status: HealthAlertStatus;
  component: string;
  scope: string;
  code: string;
  title: string;
  message: string;
  remediation: string;
  campaignRecordId?: string;
  shardId?: string;
  details: JsonRecord;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  openedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
}

export interface ComponentHeartbeatRecord {
  componentId: string;
  componentType: string;
  state: HealthState;
  message: string;
  latencyMs?: number;
  details: JsonRecord;
  lastSeenAt: string;
  stale: boolean;
}

export interface HealthReport {
  generatedAt: string;
  state: HealthState;
  summary: {
    open: number;
    critical: number;
    warning: number;
    acknowledged: number;
    observing: number;
    resolved24h: number;
  };
  alerts: HealthAlertRecord[];
  heartbeats: ComponentHeartbeatRecord[];
}

const globalHealth = globalThis as typeof globalThis & {
  __tahHealthPool?: Pool;
  __tahHealthSchema?: Promise<void>;
  __tahHealthEvaluation?: Promise<HealthReport>;
  __tahHealthEvaluatedAt?: number;
  __tahHealthLastReport?: HealthReport;
};

const HEALTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS tah_health_alerts (
  fingerprint TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('observing', 'active', 'acknowledged', 'resolved')),
  component TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'system',
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  remediation TEXT NOT NULL DEFAULT '',
  campaign_record_id TEXT,
  shard_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  activation_after_ms INTEGER NOT NULL DEFAULT 0,
  occurrence_count BIGINT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tah_health_alerts_open_idx ON tah_health_alerts (severity, status, last_seen_at DESC) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS tah_health_alerts_campaign_idx ON tah_health_alerts (campaign_record_id, last_seen_at DESC) WHERE campaign_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tah_health_alerts_shard_idx ON tah_health_alerts (shard_id, last_seen_at DESC) WHERE shard_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS tah_component_heartbeats (
  component_id TEXT PRIMARY KEY,
  component_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'warning', 'critical')),
  message TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tah_component_heartbeats_state_idx ON tah_component_heartbeats (state, last_seen_at DESC);
`;

const SHARD_POLL_WARNING_MS = Math.max(60_000, Number(process.env.TAH_SHARD_POLL_WARNING_MS) || 5 * 60_000);
const SHARD_POLL_CRITICAL_MS = Math.max(
  SHARD_POLL_WARNING_MS + 60_000,
  Number(process.env.TAH_SHARD_POLL_CRITICAL_MS) || 15 * 60_000,
);

function databasePool() {
  if (!globalHealth.__tahHealthPool) {
    const connectionString = process.env.TAH_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
    if (!connectionString) throw new Error("TAH_DATABASE_URL or DATABASE_URL is required for health alerts");
    globalHealth.__tahHealthPool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000 });
  }
  return globalHealth.__tahHealthPool;
}

async function ensureHealthSchema() {
  if (!globalHealth.__tahHealthSchema) {
    globalHealth.__tahHealthSchema = databasePool().query(HEALTH_SCHEMA).then(() => undefined);
  }
  return globalHealth.__tahHealthSchema;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(record).filter((item) => Object.keys(item).length > 0);
  if (value && typeof value === "object") return Object.values(value).map(record).filter((item) => Object.keys(item).length > 0);
  return [];
}

function textValue(value: unknown, ...keys: string[]) {
  const source = record(value);
  for (const key of keys) {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return "";
}

function booleanValue(value: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") return candidate;
    if (candidate === "true" || candidate === 1) return true;
    if (candidate === "false" || candidate === 0) return false;
  }
  return undefined;
}

function numberValue(value: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const candidate = Number(value[key]);
    if (Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function findValue(root: unknown, keys: string[], depth = 0): unknown {
  if (!root || typeof root !== "object" || depth > 6) return undefined;
  const current = root as JsonRecord;
  for (const key of keys) if (key in current) return current[key];
  for (const child of Object.values(current)) {
    if (!child || typeof child !== "object") continue;
    const found = findValue(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findNumber(root: unknown, keys: string[]) {
  const value = Number(findValue(root, keys));
  return Number.isFinite(value) ? value : undefined;
}

function findBoolean(root: unknown, keys: string[]) {
  const value = findValue(root, keys);
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1) return true;
  if (value === "false" || value === 0) return false;
  return undefined;
}

function timestampMs(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return value;
    if (value > 1_000_000_000) return value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampMs(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function ageMs(value: unknown, now: number) {
  const timestamp = timestampMs(value);
  return timestamp ? Math.max(0, now - timestamp) : Number.POSITIVE_INFINITY;
}

function newest(items: JsonRecord[], keys: string[]) {
  return [...items].sort((left, right) => {
    const leftTime = keys.reduce((value, key) => value || timestampMs(left[key]), 0);
    const rightTime = keys.reduce((value, key) => value || timestampMs(right[key]), 0);
    return rightTime - leftTime;
  })[0];
}

function severityState(candidates: AlertCandidate[]): HealthState {
  if (candidates.some((item) => item.severity === "critical")) return "critical";
  if (candidates.length) return "warning";
  return "healthy";
}

async function readControlCapacity() {
  const base = process.env.TAH_CONTROL_INTERNAL_URL?.trim() || "http://127.0.0.1:3101";
  const token = process.env.CONTROL_TOKEN?.trim() || "";
  const response = await fetch(new URL("/capacity", base.endsWith("/") ? base : `${base}/`), {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
    headers: token ? { authorization: `Bearer ${token}`, "x-control-token": token } : undefined,
  });
  if (!response.ok) throw new Error(`Control capacity returned HTTP ${response.status}`);
  return record(await response.json());
}

async function readRelationalShardHealth() {
  try {
    const result = await databasePool().query(`
      SELECT
        s.shard_id AS "shardId",
        s.enabled,
        GREATEST(s.last_poll_at, MAX(a.last_poll_at)) AS "lastPollAt",
        s.last_ack_at AS "lastAcknowledgedAt",
        s.last_error AS "lastError",
        s.created_at AS "createdAt",
        s.updated_at AS "updatedAt",
        COUNT(a.customer_id)::int AS "accountCount",
        MAX(a.manifest_seen_at) AS "lastManifestSeenAt",
        'relational-v8'::text AS "heartbeatSource"
      FROM tah_script_shards s
      LEFT JOIN tah_script_account_activity a ON a.shard_id = s.shard_id
      GROUP BY s.shard_id, s.enabled, s.last_poll_at, s.last_ack_at, s.last_error, s.created_at, s.updated_at
      ORDER BY s.shard_id
    `);
    return result.rows.map((item) => record(item));
  } catch (error) {
    const code = record(error).code;
    if (code === "42P01") return [];
    throw error;
  }
}

function addCandidate(target: Map<string, AlertCandidate>, candidate: AlertCandidate) {
  const previous = target.get(candidate.fingerprint);
  if (!previous || (previous.severity === "warning" && candidate.severity === "critical")) target.set(candidate.fingerprint, candidate);
}

async function persistEvaluation(candidates: AlertCandidate[], heartbeats: ComponentHeartbeat[]) {
  await ensureHealthSchema();
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    for (const candidate of candidates) {
      await client.query(
        `INSERT INTO tah_health_alerts (
           fingerprint, severity, status, component, scope, code, title, message, remediation,
           campaign_record_id, shard_id, details, activation_after_ms, opened_at
         ) VALUES (
           $1, $2, CASE WHEN $12 = 0 THEN 'active' ELSE 'observing' END, $3, $4, $5, $6, $7, $8,
           $9, $10, $11::jsonb, $12, CASE WHEN $12 = 0 THEN NOW() ELSE NULL END
         )
         ON CONFLICT (fingerprint) DO UPDATE SET
           severity = EXCLUDED.severity,
           component = EXCLUDED.component,
           scope = EXCLUDED.scope,
           code = EXCLUDED.code,
           title = EXCLUDED.title,
           message = EXCLUDED.message,
           remediation = EXCLUDED.remediation,
           campaign_record_id = EXCLUDED.campaign_record_id,
           shard_id = EXCLUDED.shard_id,
           details = EXCLUDED.details,
           activation_after_ms = EXCLUDED.activation_after_ms,
           occurrence_count = CASE WHEN tah_health_alerts.status = 'resolved' THEN 1 ELSE tah_health_alerts.occurrence_count + 1 END,
           first_seen_at = CASE WHEN tah_health_alerts.status = 'resolved' THEN NOW() ELSE tah_health_alerts.first_seen_at END,
           last_seen_at = NOW(),
           opened_at = CASE
             WHEN tah_health_alerts.status = 'resolved' AND EXCLUDED.activation_after_ms = 0 THEN NOW()
             WHEN tah_health_alerts.status = 'observing' AND NOW() - tah_health_alerts.first_seen_at >= make_interval(secs => EXCLUDED.activation_after_ms / 1000.0) THEN NOW()
             ELSE tah_health_alerts.opened_at
           END,
           status = CASE
             WHEN tah_health_alerts.status = 'acknowledged' THEN 'acknowledged'
             WHEN tah_health_alerts.status = 'resolved' THEN CASE WHEN EXCLUDED.activation_after_ms = 0 THEN 'active' ELSE 'observing' END
             WHEN tah_health_alerts.status = 'observing' AND NOW() - tah_health_alerts.first_seen_at >= make_interval(secs => EXCLUDED.activation_after_ms / 1000.0) THEN 'active'
             ELSE tah_health_alerts.status
           END,
           acknowledged_at = CASE WHEN tah_health_alerts.status = 'resolved' THEN NULL ELSE tah_health_alerts.acknowledged_at END,
           acknowledged_by = CASE WHEN tah_health_alerts.status = 'resolved' THEN NULL ELSE tah_health_alerts.acknowledged_by END,
           resolved_at = NULL,
           updated_at = NOW()`,
        [
          candidate.fingerprint, candidate.severity, candidate.component, candidate.scope, candidate.code,
          candidate.title, candidate.message, candidate.remediation, candidate.campaignRecordId || null,
          candidate.shardId || null, JSON.stringify(candidate.details), candidate.activationAfterMs,
        ],
      );
    }

    const fingerprints = candidates.map((item) => item.fingerprint);
    await client.query(
      `UPDATE tah_health_alerts
       SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
       WHERE status <> 'resolved' AND NOT (fingerprint = ANY($1::text[]))`,
      [fingerprints],
    );

    if (heartbeats.length) {
      await client.query(
        `INSERT INTO tah_component_heartbeats (component_id, component_type, state, message, latency_ms, details)
         SELECT component_id, component_type, state, message, latency_ms, details
         FROM jsonb_to_recordset($1::jsonb) AS x(
           component_id text, component_type text, state text, message text, latency_ms integer, details jsonb
         )
         ON CONFLICT (component_id) DO UPDATE SET
           component_type = EXCLUDED.component_type,
           state = EXCLUDED.state,
           message = EXCLUDED.message,
           latency_ms = EXCLUDED.latency_ms,
           details = EXCLUDED.details,
           last_seen_at = NOW(),
           updated_at = NOW()`,
        [JSON.stringify(heartbeats.map((item) => ({
          component_id: item.componentId,
          component_type: item.componentType,
          state: item.state,
          message: item.message,
          latency_ms: item.latencyMs ?? null,
          details: item.details ?? {},
        })))],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function evaluateHealth(source: string) {
  const startedAt = Date.now();
  await ensureHealthSchema();
  const candidateMap = new Map<string, AlertCandidate>();
  const heartbeats: ComponentHeartbeat[] = [];
  const [capacityResult, bridgeResult, registryResult, relationalShardsResult] = await Promise.allSettled([
    readControlCapacity(),
    readBridgeState(),
    readCampaignRegistry(),
    readRelationalShardHealth(),
  ]);

  const now = Date.now();
  const capacity = capacityResult.status === "fulfilled" ? capacityResult.value : {};
  const bridge = bridgeResult.status === "fulfilled" ? record(bridgeResult.value) : {};
  const registry = registryResult.status === "fulfilled" ? registryResult.value.map((item) => record(item)) : [];

  if (capacityResult.status === "rejected") {
    addCandidate(candidateMap, {
      fingerprint: "system:control-unreachable", severity: "critical", component: "control", scope: "infrastructure",
      code: "control_unreachable", title: "Control service is unreachable",
      message: capacityResult.reason instanceof Error ? capacityResult.reason.message : "The control capacity endpoint did not respond.",
      remediation: "Check the control container, its database/Redis dependencies, and the internal CONTROL_TOKEN.",
      activationAfterMs: 30_000, details: {},
    });
  }
  heartbeats.push({
    componentId: "control", componentType: "service",
    state: capacityResult.status === "fulfilled" ? "healthy" : "critical",
    message: capacityResult.status === "fulfilled" ? "Control capacity endpoint responded." : "Control capacity endpoint failed.",
    latencyMs: Date.now() - startedAt,
  });

  if (bridgeResult.status === "rejected" || registryResult.status === "rejected") {
    addCandidate(candidateMap, {
      fingerprint: "system:fleet-state-unavailable", severity: "critical", component: "script-fleet", scope: "delivery",
      code: "fleet_state_unavailable", title: "Rolling Apps Script Fleet state is unavailable",
      message: "The health evaluator could not read the Fleet state or campaign registry.",
      remediation: "Check PostgreSQL connectivity and the Script Fleet state store before changing any campaign.",
      activationAfterMs: 30_000, details: {},
    });
  }

  const postgresHealthy = findBoolean(capacity, ["postgresHealthy", "databaseHealthy", "postgresUp"]);
  const redisHealthy = findBoolean(capacity, ["redisHealthy", "redisUp"]);
  const leaderHealthy = findBoolean(capacity, ["leaderHealthy", "leaderActive", "isLeader"]);
  for (const [id, healthy, title, remediation] of [
    ["postgres", postgresHealthy, "PostgreSQL is unhealthy", "Restore database connectivity and verify storage health."],
    ["redis", redisHealthy, "Redis is unhealthy", "Restore Redis connectivity and verify memory/eviction state."],
    ["leader", leaderHealthy, "Distributed leader is missing", "Check Redis fencing and ensure exactly one control leader owns the lease."],
  ] as const) {
    if (healthy === false) addCandidate(candidateMap, {
      fingerprint: `system:${id}-unhealthy`, severity: "critical", component: id, scope: "infrastructure",
      code: `${id}_unhealthy`, title, message: `${id} reported an unhealthy state.`, remediation,
      activationAfterMs: id === "postgres" ? 15_000 : 30_000, details: {},
    });
    if (healthy !== undefined) heartbeats.push({
      componentId: id, componentType: "dependency", state: healthy ? "healthy" : "critical",
      message: healthy ? `${id} is healthy.` : `${id} is unhealthy.`,
    });
  }

  const cpuPercent = findNumber(capacity, ["cpuPercent", "cpuUsagePercent", "hostCpuPercent"]);
  const memoryPercent = findNumber(capacity, ["memoryPercent", "memoryUsedPercent", "hostMemoryPercent"]);
  const diskFreePercent = findNumber(capacity, ["diskFreePercent", "freeDiskPercent"]);
  const activeWorkers = findNumber(capacity, ["activeWorkers", "browserWorkersActive"]);
  const workerLimit = findNumber(capacity, ["workerLimit", "browserWorkerLimit", "maxWorkers"]);
  const queuedWorkers = findNumber(capacity, ["queuedCampaigns", "queuedWorkers", "browserQueueDepth"]);

  if (cpuPercent !== undefined && cpuPercent >= 95) addCandidate(candidateMap, {
    fingerprint: "capacity:cpu-sustained", severity: "critical", component: "host", scope: "capacity",
    code: "cpu_sustained", title: "CPU capacity is critically saturated",
    message: `CPU usage is ${cpuPercent.toFixed(1)}%.`, remediation: "Reduce active browser campaigns or increase vCPU capacity.",
    activationAfterMs: 120_000, details: { cpuPercent },
  });
  if (memoryPercent !== undefined && memoryPercent >= 92) addCandidate(candidateMap, {
    fingerprint: "capacity:memory-sustained", severity: "critical", component: "host", scope: "capacity",
    code: "memory_sustained", title: "Memory capacity is critically saturated",
    message: `Memory usage is ${memoryPercent.toFixed(1)}%.`, remediation: "Reduce browser concurrency or increase memory before the OOM killer intervenes.",
    activationAfterMs: 120_000, details: { memoryPercent },
  });
  if (diskFreePercent !== undefined && diskFreePercent <= 8) addCandidate(candidateMap, {
    fingerprint: "capacity:disk-low", severity: diskFreePercent <= 5 ? "critical" : "warning", component: "host", scope: "capacity",
    code: "disk_low", title: "Server disk space is low",
    message: `Only ${diskFreePercent.toFixed(1)}% disk space remains.`, remediation: "Clear expired evidence/logs or expand the disk before writes fail.",
    activationAfterMs: 0, details: { diskFreePercent },
  });
  if (activeWorkers !== undefined && workerLimit !== undefined && queuedWorkers !== undefined && workerLimit > 0 && activeWorkers >= workerLimit && queuedWorkers > 0) {
    addCandidate(candidateMap, {
      fingerprint: "capacity:browser-pool-saturated", severity: "warning", component: "browser-pool", scope: "capacity",
      code: "browser_pool_saturated", title: "Browser pool is saturated",
      message: `${activeWorkers}/${workerLimit} workers are active with ${queuedWorkers} campaigns waiting.`,
      remediation: "Keep journeys staggered; raise browser capacity only after confirming CPU and memory headroom.",
      activationAfterMs: 300_000, details: { activeWorkers, workerLimit, queuedWorkers },
    });
  }
  heartbeats.push({
    componentId: "host-capacity", componentType: "capacity",
    state: severityState([...candidateMap.values()].filter((item) => item.scope === "capacity")),
    message: "Host pressure is evaluated with sustained critical thresholds.",
    details: { cpuPercent, memoryPercent, diskFreePercent, activeWorkers, workerLimit, queuedWorkers },
  });

  const capacityCampaigns = records(findValue(capacity, ["campaigns", "campaignRows"]));
  const registryById = new Map(registry.map((item) => [textValue(item, "id", "campaignRecordId", "recordId"), item]));
  const campaignRows = capacityCampaigns.length ? capacityCampaigns : registry;

  for (const campaign of campaignRows) {
    const id = textValue(campaign, "id", "campaignRecordId", "recordId");
    if (!id) continue;
    const registryCampaign = registryById.get(id) || {};
    const combined = { ...registryCampaign, ...campaign };
    const config = { ...record(registryCampaign.config), ...record(campaign.config) };
    const name = textValue(combined, "name", "campaignName") || id;
    const status = textValue(combined, "status", "runStatus").toLowerCase();
    const desiredRunning = booleanValue(combined, "desiredRunning", "shouldRun") ?? false;
    const lastCapturedAt = combined.lastCapturedAt ?? combined.last_capture_at;
    const lastError = textValue(combined, "lastError", "error");
    const campaignCandidates: AlertCandidate[] = [];
    const addCampaign = (candidate: AlertCandidate) => { campaignCandidates.push(candidate); addCandidate(candidateMap, candidate); };

    if (desiredRunning && !["running", "queued", "starting", "scheduled", "retrying"].includes(status)) addCampaign({
      fingerprint: `campaign:${id}:unexpected-stop`, severity: "critical", component: name, scope: "campaign",
      code: "campaign_unexpected_stop", title: `${name} is not running`,
      message: `The campaign is expected to run but reports “${status || "unknown"}”.`,
      remediation: "Inspect its last run error and gateway assignment; restart only after the cause is understood.",
      campaignRecordId: id, activationAfterMs: 30_000, details: { status, lastError },
    });
    if (desiredRunning && status === "running" && ageMs(lastCapturedAt, now) > 180_000) addCampaign({
      fingerprint: `campaign:${id}:capture-stale`, severity: "warning", component: name, scope: "capture",
      code: "capture_stale", title: `${name} has stopped capturing suffixes`,
      message: lastCapturedAt ? "No new suffix has been captured for more than three minutes." : "No suffix has been captured within three minutes of starting.",
      remediation: "Inspect redirect-first/fallback telemetry, target reachability, proxy health, and the browser journey error.",
      campaignRecordId: id, activationAfterMs: 0, details: { lastCapturedAt: lastCapturedAt || null, lastError },
    });
    if (desiredRunning && ["error", "failed", "fatal"].includes(status)) addCampaign({
      fingerprint: `campaign:${id}:run-failed`, severity: "critical", component: name, scope: "campaign",
      code: "campaign_failed", title: `${name} run failed`, message: lastError || "The campaign entered a failed state.",
      remediation: "Open run telemetry and fix the recorded error before restarting.",
      campaignRecordId: id, activationAfterMs: 0, details: { status, lastError },
    });
    heartbeats.push({
      componentId: `campaign:${id}`, componentType: "campaign", state: severityState(campaignCandidates),
      message: campaignCandidates.length ? campaignCandidates[0].message : `${name} has no detected campaign-level fault.`,
      details: { campaignRecordId: id, name, status, desiredRunning, lastCapturedAt: lastCapturedAt || null, useScriptMesh: Boolean(config.useScriptMesh) },
    });
  }

  const deliveries = records(bridge.deliveries ?? bridge.deliveryByCampaign ?? bridge.campaignDeliveries);
  const jobs = records(bridge.jobs ?? bridge.deliveryJobs ?? bridge.queue);
  const legacyShards = records(bridge.shards ?? bridge.fleetShards ?? bridge.workers);
  const relationalShards = relationalShardsResult.status === "fulfilled" ? relationalShardsResult.value : [];
  const mergedShards = new Map<string, JsonRecord>();
  for (const item of legacyShards) {
    const shardId = textValue(item, "id", "shardId");
    if (shardId) mergedShards.set(shardId, item);
  }
  for (const item of relationalShards) {
    const shardId = textValue(item, "id", "shardId");
    if (shardId) mergedShards.set(shardId, { ...mergedShards.get(shardId), ...item });
  }
  const shards = [...mergedShards.values()];
  const deliveriesByCampaign = new Map<string, JsonRecord[]>();
  for (const item of [...deliveries, ...jobs]) {
    const campaignId = textValue(item, "campaignRecordId", "campaignId", "recordId");
    if (!campaignId) continue;
    const current = deliveriesByCampaign.get(campaignId) || [];
    current.push(item);
    deliveriesByCampaign.set(campaignId, current);
  }
  const shardById = new Map(shards.map((item) => [textValue(item, "id", "shardId"), item]));
  const enrolled = registry.filter((campaign) => {
    const config = record(campaign.config);
    const id = textValue(campaign, "id", "campaignRecordId", "recordId");
    return Boolean(config.useScriptMesh ?? campaign.useScriptMesh) || deliveriesByCampaign.has(id);
  });
  const shardCampaigns = new Map<string, number>();

  for (const campaign of enrolled) {
    const id = textValue(campaign, "id", "campaignRecordId", "recordId");
    if (!id) continue;
    const config = record(campaign.config);
    const name = textValue(campaign, "name", "campaignName") || id;
    const shardId = textValue(campaign, "scriptFleetShardId", "shardId") || textValue(config, "scriptFleetShardId", "shardId");
    const latestSuffix = textValue(campaign, "latestSuffix", "suffix");
    const capturedAt = campaign.lastCapturedAt ?? campaign.last_capture_at;
    const campaignDeliveries = deliveriesByCampaign.get(id) || [];
    const delivery = newest(campaignDeliveries, ["updatedAt", "verifiedAt", "appliedAt", "leasedAt", "queuedAt", "createdAt", "version"]);
    const deliveryStatus = delivery ? textValue(delivery, "status", "state", "deliveryStatus", "jobStatus").toLowerCase() : "";
    const queuedAt = delivery && (delivery.queuedAt ?? delivery.createdAt ?? delivery.version);
    const deliveryAge = queuedAt ? ageMs(queuedAt, now) : ageMs(capturedAt, now);
    const deliveryCandidates: AlertCandidate[] = [];
    const addDelivery = (candidate: AlertCandidate) => { deliveryCandidates.push(candidate); addCandidate(candidateMap, candidate); };

    if (!shardId) addDelivery({
      fingerprint: `delivery:${id}:unassigned`, severity: "critical", component: name, scope: "delivery",
      code: "fleet_unassigned", title: `${name} has no Fleet shard`,
      message: "The campaign is enrolled for Apps Script delivery but has no assigned shard.",
      remediation: "Assign the campaign to a shard before expecting Google Ads delivery.",
      campaignRecordId: id, activationAfterMs: 0, details: {},
    });
    if (shardId) shardCampaigns.set(shardId, (shardCampaigns.get(shardId) || 0) + 1);
    if (latestSuffix && !delivery && ageMs(capturedAt, now) > 60_000) addDelivery({
      fingerprint: `delivery:${id}:not-queued`, severity: "critical", component: name, scope: "delivery",
      code: "suffix_not_queued", title: `${name} suffix was not queued`,
      message: "A suffix was captured, but no Fleet delivery record exists after the 58-second gate.",
      remediation: "Inspect Fleet enrollment and queue synchronization; do not recapture or edit the suffix manually.",
      campaignRecordId: id, shardId: shardId || undefined, activationAfterMs: 0, details: { capturedAt: capturedAt || null },
    });
    if (["failed", "dead", "dead_letter", "rejected"].includes(deliveryStatus)) addDelivery({
      fingerprint: `delivery:${id}:failed`, severity: "critical", component: name, scope: "delivery",
      code: "delivery_failed", title: `${name} Google Ads delivery failed`,
      message: textValue(delivery, "lastError", "error", "message") || `Fleet delivery is ${deliveryStatus}.`,
      remediation: "Inspect the shard script logs, child-account access, campaign ID, and immutable lease acknowledgement.",
      campaignRecordId: id, shardId: shardId || undefined, activationAfterMs: 0, details: { deliveryStatus },
    });
    if (["pending", "queued", "leased", "processing", "retrying"].includes(deliveryStatus) && deliveryAge > 180_000) addDelivery({
      fingerprint: `delivery:${id}:delayed`, severity: deliveryAge > 600_000 ? "critical" : "warning", component: name, scope: "delivery",
      code: "delivery_delayed", title: `${name} suffix delivery is delayed`,
      message: `The newest suffix has remained ${deliveryStatus} for ${Math.floor(deliveryAge / 60_000)} minutes.`,
      remediation: "Check shard polling, lease acknowledgements, and Google Ads script execution history.",
      campaignRecordId: id, shardId: shardId || undefined, activationAfterMs: 0, details: { deliveryStatus, deliveryAgeMs: deliveryAge },
    });
    const expectedHash = textValue(delivery, "suffixHash", "queuedSuffixHash", "expectedSuffixHash");
    const verifiedHash = textValue(delivery, "verifiedSuffixHash", "appliedSuffixHash", "lastAppliedSuffixHash");
    const verifiedSuffix = textValue(delivery, "verifiedSuffix", "appliedSuffix", "readBackSuffix");
    if ((expectedHash && verifiedHash && expectedHash !== verifiedHash) || (latestSuffix && verifiedSuffix && latestSuffix !== verifiedSuffix)) addDelivery({
      fingerprint: `delivery:${id}:mismatch`, severity: "critical", component: name, scope: "delivery",
      code: "suffix_mismatch", title: `${name} suffix read-back does not match`,
      message: "Google Ads read-back differs from the exact immutable suffix that was leased.",
      remediation: "Stop delivery for this target and inspect the mutation/read-back result before acknowledging another version.",
      campaignRecordId: id, shardId: shardId || undefined, activationAfterMs: 0,
      details: { expectedHash: expectedHash || null, verifiedHash: verifiedHash || null },
    });
    heartbeats.push({
      componentId: `delivery:${id}`, componentType: "campaign-delivery", state: severityState(deliveryCandidates),
      message: deliveryCandidates.length ? deliveryCandidates[0].message : `${name} delivery has no detected fault.`,
      details: { campaignRecordId: id, name, shardId: shardId || null, deliveryStatus: deliveryStatus || "waiting_for_capture" },
    });
  }

  for (const [shardId, campaignCount] of shardCampaigns) {
    const shard = shardById.get(shardId) || {};
    const lastPollAt = shard.lastPollAt ?? shard.last_poll_at ?? shard.lastHeartbeatAt;
    const lastAckAt = shard.lastAcknowledgementAt ?? shard.lastAcknowledgedAt ?? shard.lastAckAt;
    const createdAt = shard.createdAt ?? shard.updatedAt;
    const pollAge = lastPollAt ? ageMs(lastPollAt, now) : ageMs(createdAt, now);
    const shardCandidates: AlertCandidate[] = [];
    if (pollAge > SHARD_POLL_WARNING_MS) {
      const critical = pollAge > SHARD_POLL_CRITICAL_MS;
      const candidate: AlertCandidate = {
        fingerprint: `shard:${shardId}:poll-stale`, severity: critical ? "critical" : "warning", component: shardId, scope: "script-fleet",
        code: critical ? "apps_script_stopped" : "apps_script_poll_delayed",
        title: critical ? `${shardId} Apps Script stopped polling` : `${shardId} Apps Script contact is delayed`,
        message: lastPollAt
          ? `No shard poll has arrived for ${Math.floor(pollAge / 60_000)} minutes.`
          : "This assigned shard has never polled the bridge.",
        remediation: critical
          ? "Check Google Ads Scripts execution history, authorization, hourly schedule, and the generated shard worker version immediately."
          : "Watch the next execution window; if contact does not resume, inspect the Google Ads script schedule and execution history.",
        shardId,
        activationAfterMs: 0,
        details: {
          campaignCount,
          lastPollAt: lastPollAt || null,
          lastAckAt: lastAckAt || null,
          heartbeatSource: textValue(shard, "heartbeatSource") || "legacy-fallback",
          warningAfterMs: SHARD_POLL_WARNING_MS,
          criticalAfterMs: SHARD_POLL_CRITICAL_MS,
          nextEvaluationWithinMs: 15_000,
        },
      };
      shardCandidates.push(candidate);
      addCandidate(candidateMap, candidate);
    }
    heartbeats.push({
      componentId: `shard:${shardId}`, componentType: "apps-script-shard", state: severityState(shardCandidates),
      message: shardCandidates.length ? shardCandidates[0].message : `${shardId} is polling normally.`,
      details: {
        shardId,
        campaignCount,
        lastPollAt: lastPollAt || null,
        lastAckAt: lastAckAt || null,
        heartbeatSource: textValue(shard, "heartbeatSource") || "legacy-fallback",
        accountCount: numberValue(shard, "accountCount"),
      },
    });
  }

  const candidates = [...candidateMap.values()];
  heartbeats.push({
    componentId: "script-fleet", componentType: "delivery",
    state: severityState(candidates.filter((item) => item.scope === "delivery" || item.scope === "script-fleet")),
    message: `${enrolled.length} enrolled campaign(s) and ${shardCampaigns.size} shard(s) evaluated.`,
    details: { enrolledCampaigns: enrolled.length, shards: shardCampaigns.size },
  });
  heartbeats.push({
    componentId: "alert-evaluator", componentType: "watchdog", state: "healthy",
    message: `Health evaluation completed from ${source}.`, latencyMs: Date.now() - startedAt,
    details: { source, candidates: candidates.length },
  });

  await persistEvaluation(candidates, heartbeats);
  return listHealthAlerts({ summaryOnly: true });
}

export async function evaluateHealthAlerts(options: { force?: boolean; source?: string } = {}) {
  const now = Date.now();
  if (!options.force && now - (globalHealth.__tahHealthEvaluatedAt || 0) < 10_000) {
    if (globalHealth.__tahHealthEvaluation) return globalHealth.__tahHealthEvaluation;
    if (globalHealth.__tahHealthLastReport) return globalHealth.__tahHealthLastReport;
  }
  const evaluation = evaluateHealth(options.source || "api-fallback");
  globalHealth.__tahHealthEvaluation = evaluation;
  globalHealth.__tahHealthEvaluatedAt = now;
  try {
    const report = await evaluation;
    globalHealth.__tahHealthLastReport = report;
    return report;
  } finally {
    if (globalHealth.__tahHealthEvaluation === evaluation) globalHealth.__tahHealthEvaluation = undefined;
  }
}

function alertRow(row: JsonRecord): HealthAlertRecord {
  return {
    fingerprint: String(row.fingerprint), severity: row.severity as HealthSeverity, status: row.status as HealthAlertStatus,
    component: String(row.component), scope: String(row.scope), code: String(row.code), title: String(row.title),
    message: String(row.message), remediation: String(row.remediation || ""),
    campaignRecordId: row.campaign_record_id ? String(row.campaign_record_id) : undefined,
    shardId: row.shard_id ? String(row.shard_id) : undefined, details: record(row.details),
    occurrenceCount: Number(row.occurrence_count || 0), firstSeenAt: new Date(String(row.first_seen_at)).toISOString(),
    lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
    openedAt: row.opened_at ? new Date(String(row.opened_at)).toISOString() : undefined,
    acknowledgedAt: row.acknowledged_at ? new Date(String(row.acknowledged_at)).toISOString() : undefined,
    acknowledgedBy: row.acknowledged_by ? String(row.acknowledged_by) : undefined,
    resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)).toISOString() : undefined,
  };
}

export async function listHealthAlerts(options: { summaryOnly?: boolean; includeResolved?: boolean } = {}): Promise<HealthReport> {
  await ensureHealthSchema();
  const [summaryResult, alertResult, heartbeatResult] = await Promise.all([
    databasePool().query(`SELECT
      COUNT(*) FILTER (WHERE status IN ('active', 'acknowledged'))::int AS open,
      COUNT(*) FILTER (WHERE severity = 'critical' AND status IN ('active', 'acknowledged'))::int AS critical,
      COUNT(*) FILTER (WHERE severity = 'warning' AND status IN ('active', 'acknowledged'))::int AS warning,
      COUNT(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
      COUNT(*) FILTER (WHERE status = 'observing')::int AS observing,
      COUNT(*) FILTER (WHERE status = 'resolved' AND resolved_at >= NOW() - INTERVAL '24 hours')::int AS resolved_24h
      FROM tah_health_alerts`),
    options.summaryOnly
      ? Promise.resolve({ rows: [] as JsonRecord[] })
      : databasePool().query(
        `SELECT * FROM tah_health_alerts
         WHERE status <> 'resolved' OR ($1::boolean AND resolved_at >= NOW() - INTERVAL '24 hours')
         ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
                  CASE status WHEN 'active' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'observing' THEN 2 ELSE 3 END,
                  last_seen_at DESC LIMIT 500`,
        [Boolean(options.includeResolved)],
      ),
    options.summaryOnly
      ? Promise.resolve({ rows: [] as JsonRecord[] })
      : databasePool().query(`SELECT * FROM tah_component_heartbeats ORDER BY CASE state WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT 500`),
  ]);
  const counts = record(summaryResult.rows[0]);
  const summary = {
    open: Number(counts.open || 0), critical: Number(counts.critical || 0), warning: Number(counts.warning || 0),
    acknowledged: Number(counts.acknowledged || 0), observing: Number(counts.observing || 0), resolved24h: Number(counts.resolved_24h || 0),
  };
  const heartbeats = heartbeatResult.rows.map((rowValue) => {
    const row = record(rowValue);
    const lastSeenAt = new Date(String(row.last_seen_at)).toISOString();
    const stale = Date.now() - Date.parse(lastSeenAt) > 60_000;
    return {
      componentId: String(row.component_id), componentType: String(row.component_type),
      state: (stale ? "critical" : row.state) as HealthState,
      message: stale ? "Heartbeat has not advanced for more than 60 seconds." : String(row.message || ""),
      latencyMs: row.latency_ms === null ? undefined : Number(row.latency_ms), details: record(row.details), lastSeenAt, stale,
    } satisfies ComponentHeartbeatRecord;
  });
  const state: HealthState = summary.critical > 0 ? "critical" : summary.warning > 0 ? "warning" : "healthy";
  return { generatedAt: new Date().toISOString(), state, summary, alerts: alertResult.rows.map((rowValue) => alertRow(record(rowValue))), heartbeats };
}

export async function acknowledgeHealthAlert(fingerprint: string, actor = "operator") {
  await ensureHealthSchema();
  const result = await databasePool().query(
    `UPDATE tah_health_alerts SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2, updated_at = NOW()
     WHERE fingerprint = $1 AND status = 'active' RETURNING *`,
    [fingerprint, actor],
  );
  return result.rows[0] ? alertRow(record(result.rows[0])) : null;
}

export async function resolveHealthAlert(fingerprint: string) {
  await ensureHealthSchema();
  const result = await databasePool().query(
    `UPDATE tah_health_alerts SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
     WHERE fingerprint = $1 AND status <> 'resolved' RETURNING *`,
    [fingerprint],
  );
  return result.rows[0] ? alertRow(record(result.rows[0])) : null;
}
