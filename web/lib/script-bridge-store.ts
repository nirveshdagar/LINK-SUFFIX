import { assertDeliverableSuffix, deliverySuffixIssue } from "@tah/contracts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import pg, { type Pool, type PoolClient } from "pg";

const { Pool: PgPool } = pg;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.TAH_SCRIPT_MAX_ATTEMPTS) || 8);
// A Google Ads manager execution can spend nearly 30 minutes inside one child
// or callback phase. Keep the campaign fenced for longer than that phase so a
// second worker cannot race a Google-owned call that has not returned yet.
const LEASE_MS = Math.max(35 * 60_000, Number(process.env.TAH_SCRIPT_LEASE_MS) || 35 * 60_000);
const MIN_INTERVAL_MS = Math.max(58_000, Number(process.env.TAH_SCRIPT_MIN_DELIVERY_INTERVAL_MS) || 58_000);
const SHARD_CAPACITY = 40;
const MAX_LEASE_JOBS = 200;
const HANDOFF_ALLOWANCE_MS = Math.max(60_000, Number(process.env.TAH_SCRIPT_HANDOFF_ALLOWANCE_MS) || 15 * 60_000);
const SHARD_STALE_MS = Math.max(60_000, Number(process.env.TAH_SCRIPT_SHARD_STALE_MS) || 75 * 60_000);
const ACCOUNT_READY_MS = Math.max(60_000, Number(process.env.TAH_SCRIPT_ACCOUNT_READY_MS) || 75_000);
const SCHEDULE_INTERVAL_MS = Math.max(45 * 60_000, Number(process.env.TAH_SCRIPT_SCHEDULE_INTERVAL_MS) || 60 * 60_000);
const SCHEDULE_TOLERANCE_MS = Math.max(60_000, Number(process.env.TAH_SCRIPT_SCHEDULE_TOLERANCE_MS) || 8 * 60_000);
const HANDOFF_MARGIN_MS = Math.max(60_000, Number(process.env.TAH_SCRIPT_ADAPTIVE_HANDOFF_MARGIN_MS) || 2 * 60_000);
const PHASE_ONE_MAX_MS = Math.min(28 * 60_000, Math.max(60_000, Number(process.env.TAH_SCRIPT_PHASE_ONE_MAX_MS) || 28 * 60_000));
const PHASE_TWO_RESERVE_MAX_MS = Math.max(2 * 60_000, Number(process.env.TAH_SCRIPT_PHASE_TWO_RESERVE_MS) || 10 * 60_000);
const MIN_USEFUL_WINDOW_MS = Math.max(60_000, Number(process.env.TAH_SCRIPT_MIN_USEFUL_WINDOW_MS) || 3 * 60_000);
let pool: Pool | null = null;

export interface BridgeTargetInput {
  campaignRecordId: string;
  campaignName: string;
  managerCustomerId?: string;
  customerId: string;
  googleCampaignId: string;
  shardId?: string;
}

type BridgeCaptureEgress = {
  ip: string;
  country?: string;
  state?: string;
  city?: string;
  timezone?: string;
  asn?: number;
  organization?: string;
  isp?: string;
  intelligenceProvider?: string;
  proxyProvider?: string;
  proxyMode?: string;
  confidence: "stable_session" | "observed_probe" | "direct";
  verified: boolean;
  observedAt: string;
};

function normalizedCaptureEgress(input: unknown): BridgeCaptureEgress | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const ip = String(value.ip || "").trim();
  if (!isIP(ip)) return null;
  const text = (field: string, max: number) => {
    const candidate = String(value[field] || "").trim();
    return candidate ? candidate.slice(0, max) : undefined;
  };
  const countryValue = text("country", 2)?.toUpperCase();
  const country = countryValue && /^[A-Z]{2}$/.test(countryValue) ? countryValue : undefined;
  const asnValue = Number(value.asn);
  const asn = Number.isSafeInteger(asnValue) && asnValue > 0 && asnValue <= 4_294_967_295 ? asnValue : undefined;
  const confidenceValue = String(value.confidence || "observed_probe");
  const confidence = ["stable_session", "observed_probe", "direct"].includes(confidenceValue)
    ? confidenceValue as BridgeCaptureEgress["confidence"]
    : "observed_probe";
  const parsedObservedAt = Date.parse(String(value.observedAt || ""));
  return {
    ip,
    country,
    state: text("state", 120),
    city: text("city", 160),
    timezone: text("timezone", 80),
    asn,
    organization: text("organization", 240),
    isp: text("isp", 240),
    intelligenceProvider: text("intelligenceProvider", 80),
    proxyProvider: text("proxyProvider", 80),
    proxyMode: text("proxyMode", 40),
    confidence,
    verified: value.verified === true,
    observedAt: Number.isFinite(parsedObservedAt) ? new Date(parsedObservedAt).toISOString() : new Date().toISOString(),
  };
}

export interface BridgeLease {
  jobId: string;
  leaseToken: string;
  campaignRecordId: string;
  campaignName: string;
  managerCustomerId: string;
  customerId: string;
  campaignId: string;
  exactSuffix: string;
  version: number;
  capturedAt: string;
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function normalizeId(value: string) { return value.replace(/\D/g, ""); }
function targetId(input: BridgeTargetInput) { return digest(`${normalizeId(input.managerCustomerId || "")}:${normalizeId(input.customerId)}:${normalizeId(input.googleCampaignId)}`).slice(0, 40); }

function dateMs(value: unknown) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function schedulePhaseDistance(left: number, right: number) {
  const distance = Math.abs(left - right) % SCHEDULE_INTERVAL_MS;
  return Math.min(distance, SCHEDULE_INTERVAL_MS - distance);
}

function nextScheduleSlot(anchorMs: number, nowMs: number) {
  if (anchorMs <= 0) return nowMs + SCHEDULE_INTERVAL_MS;
  const periods = Math.floor((nowMs - anchorMs) / SCHEDULE_INTERVAL_MS) + 1;
  return anchorMs + Math.max(1, periods) * SCHEDULE_INTERVAL_MS;
}

function adaptiveExecutionWindow(row: Record<string, unknown>, startedAt: Date, invocationId: string) {
  const startedMs = startedAt.getTime();
  const previousStartMs = dateMs(row.last_execution_started_at);
  let anchorMs = dateMs(row.schedule_anchor_at);
  let samples = Math.max(0, Number(row.schedule_sample_count || 0));
  let mode = "learning";

  if (!anchorMs) {
    anchorMs = startedMs;
    samples = 1;
  } else if (schedulePhaseDistance(startedMs, anchorMs) <= SCHEDULE_TOLERANCE_MS) {
    anchorMs = startedMs;
    samples = Math.min(100, samples + 1);
    mode = samples >= 2 ? "scheduled" : "learning";
  } else if (
    previousStartMs > 0
    && startedMs - previousStartMs >= 45 * 60_000
    && schedulePhaseDistance(startedMs, previousStartMs) <= SCHEDULE_TOLERANCE_MS
  ) {
    anchorMs = startedMs;
    samples = 2;
    mode = "schedule-shift";
  } else if (samples < 2) {
    anchorMs = startedMs;
    samples = 1;
  } else {
    mode = "off-cycle";
  }

  const nextExpectedMs = mode === "off-cycle"
    ? nextScheduleSlot(anchorMs, startedMs)
    : startedMs + SCHEDULE_INTERVAL_MS;
  const hardStopMs = Math.max(startedMs, nextExpectedMs - HANDOFF_MARGIN_MS);
  const availableMs = Math.max(0, hardStopMs - startedMs);
  const phaseTwoReserveMs = Math.min(
    PHASE_TWO_RESERVE_MAX_MS,
    Math.max(2 * 60_000, Math.floor(availableMs * 0.35)),
  );
  const shouldYield = availableMs < MIN_USEFUL_WINDOW_MS;
  const phaseOneBudgetMs = shouldYield
    ? 0
    : Math.min(PHASE_ONE_MAX_MS, Math.max(0, availableMs - phaseTwoReserveMs));
  const phaseOneStopMs = startedMs + phaseOneBudgetMs;

  return {
    invocationId,
    startedAt: startedAt.toISOString(),
    phaseOneStopAt: new Date(phaseOneStopMs).toISOString(),
    hardStopAt: new Date(hardStopMs).toISOString(),
    nextExpectedStartAt: new Date(nextExpectedMs).toISOString(),
    handoffMarginMs: HANDOFF_MARGIN_MS,
    phaseOneBudgetMs,
    phaseTwoReserveMs,
    scheduleMode: mode,
    scheduleConfidence: samples >= 2 ? "learned" : "learning",
    scheduleSampleCount: samples,
    scheduleAnchorAt: new Date(anchorMs).toISOString(),
    shouldYield,
  };
}

export function bridgeDatabaseConfigured() { return Boolean(process.env.DATABASE_URL); }

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the production Script Fleet");
  if (pool) return pool;
  pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: Math.max(2, Number(process.env.TAH_SCRIPT_DB_POOL_SIZE) || 10),
    connectionTimeoutMillis: Math.max(2_000, Number(process.env.TAH_DB_CONNECT_TIMEOUT_MS) || 10_000),
    idleTimeoutMillis: 30_000,
    ssl: process.env.TAH_DATABASE_SSL === "1" ? { rejectUnauthorized: process.env.TAH_DATABASE_SSL_REJECT_UNAUTHORIZED !== "0" } : undefined,
  });
  pool.on("error", () => {
    const failed = pool;
    pool = null;
    void failed?.end().catch(() => undefined);
  });
  return pool;
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertBridgeTarget(input: BridgeTargetInput) {
  if (!input.campaignRecordId.trim()) throw new Error("Saved campaign record ID is required");
  const managerCustomerId = normalizeId(input.managerCustomerId || "");
  const customerId = normalizeId(input.customerId);
  const googleCampaignId = normalizeId(input.googleCampaignId);
  const requestedShardId = (input.shardId || "default").trim();
  if (!customerId || !googleCampaignId) throw new Error("Customer ID and Google Ads campaign ID are required");
  if (!/^\d{10}$/.test(managerCustomerId)) throw new Error("A valid 10-digit Google Ads MCC ID is required for Fleet delivery");
  if (!/^\d{10}$/.test(customerId)) throw new Error("A valid 10-digit Google Ads customer ID is required");
  if (!/^\d{8,20}$/.test(googleCampaignId)) throw new Error("A valid Google Ads campaign ID is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(requestedShardId)) throw new Error("Invalid Fleet shard ID");
  const id = targetId(input);
  const shardPrefix = `mcc-${managerCustomerId}-`;
  let assignment = {
    targetId: id,
    shardId: requestedShardId === "default" ? `${shardPrefix}001` : requestedShardId,
  };
  try {
    await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`fleet-manager:${managerCustomerId}`]);
      let assignedShardId = assignment.shardId;
      const occupancy = await client.query(
        `SELECT count(*)::int AS count,
                min(NULLIF(manager_customer_id, '')) AS manager_customer_id,
                count(DISTINCT NULLIF(manager_customer_id, ''))::int AS manager_count
           FROM tah_campaign_targets
          WHERE enabled AND shard_id=$1 AND campaign_record_id<>$2`,
        [assignedShardId, input.campaignRecordId],
      );
      const occupied = Number(occupancy.rows[0]?.count || 0);
      const existingManager = String(occupancy.rows[0]?.manager_customer_id || "");
      const managerCount = Number(occupancy.rows[0]?.manager_count || 0);
      if (managerCount > 1) throw new Error(`Fleet shard ${assignedShardId} contains campaigns from multiple MCC accounts`);
      if (existingManager && existingManager !== managerCustomerId) {
        throw new Error(`Fleet shard ${assignedShardId} belongs to MCC ${existingManager}; select a shard for MCC ${managerCustomerId}`);
      }
      if (occupied >= SHARD_CAPACITY) {
        const available = await client.query(
          `WITH shard_ids AS (
             SELECT shard_id FROM tah_script_shards WHERE shard_id LIKE $3
             UNION
             SELECT shard_id FROM tah_campaign_targets WHERE shard_id LIKE $3
           )
           SELECT ids.shard_id,
                  count(t.target_id) FILTER (WHERE t.enabled AND t.campaign_record_id<>$2)::int AS campaign_count,
                  min(NULLIF(t.manager_customer_id,'')) FILTER (WHERE t.enabled) AS manager_customer_id
             FROM shard_ids ids
             LEFT JOIN tah_campaign_targets t ON t.shard_id=ids.shard_id
            GROUP BY ids.shard_id
           HAVING count(t.target_id) FILTER (WHERE t.enabled AND t.campaign_record_id<>$2) < $4
              AND (min(NULLIF(t.manager_customer_id,'')) FILTER (WHERE t.enabled) IS NULL
                   OR min(NULLIF(t.manager_customer_id,'')) FILTER (WHERE t.enabled)=$1)
            ORDER BY ids.shard_id
            LIMIT 1`,
          [managerCustomerId, input.campaignRecordId, `${shardPrefix}%`, SHARD_CAPACITY],
        );
        if (available.rowCount === 1) {
          assignedShardId = String(available.rows[0].shard_id);
        } else {
          const ids = await client.query(
            `SELECT shard_id FROM tah_script_shards WHERE shard_id LIKE $1
             UNION SELECT shard_id FROM tah_campaign_targets WHERE shard_id LIKE $1`,
            [`${shardPrefix}%`],
          );
          const highest = ids.rows.reduce((current, row) => {
            const match = String(row.shard_id).match(new RegExp(`^${shardPrefix}(\\d+)$`));
            return match ? Math.max(current, Number(match[1])) : current;
          }, 0);
          assignedShardId = `${shardPrefix}${String(highest + 1).padStart(3, "0")}`;
        }
      }
      const conflicts = await client.query(
        `SELECT target_id,campaign_record_id,enabled,archived_at
           FROM tah_campaign_targets
          WHERE target_id=$1 OR campaign_record_id=$2
          FOR UPDATE`,
        [id, input.campaignRecordId],
      );
      const targetOwner = conflicts.rows.find((row) => String(row.target_id) === id);
      const recordOwner = conflicts.rows.find((row) => String(row.campaign_record_id) === input.campaignRecordId);
      if (targetOwner && String(targetOwner.campaign_record_id) !== input.campaignRecordId
          && targetOwner.enabled === true && !targetOwner.archived_at) {
        throw new Error("Another saved campaign already owns this Google Ads target");
      }
      if (recordOwner && String(recordOwner.target_id) !== id) {
        throw new Error("This saved campaign is already assigned to a different Google Ads target; remove it from Fleet first");
      }
      const values = [id, input.campaignRecordId, input.campaignName, managerCustomerId, customerId, googleCampaignId, assignedShardId, MIN_INTERVAL_MS];
      const saved = targetOwner
        ? await client.query(
          `UPDATE tah_campaign_targets SET
             campaign_record_id=$2,
             campaign_name=$3,
             manager_customer_id=$4,
             customer_id=$5,
             google_campaign_id=$6,
             shard_id=$7,
             min_delivery_interval_ms=$8,
             enabled=true,
             archived_at=NULL,
             updated_at=now()
           WHERE target_id=$1
           RETURNING target_id,shard_id`,
          values,
        )
        : await client.query(
          `INSERT INTO tah_campaign_targets
            (target_id, campaign_record_id, campaign_name, manager_customer_id, customer_id, google_campaign_id, shard_id, min_delivery_interval_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING target_id,shard_id`,
          values,
        );
      assignment = { targetId: String(saved.rows[0].target_id), shardId: String(saved.rows[0].shard_id) };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("Another saved campaign already owns this Google Ads target");
    throw error;
  }
  return assignment;
}

export async function bridgeTargetReadiness(campaignRecordId: string) {
  const normalizedRecordId = campaignRecordId.trim();
  if (!normalizedRecordId || normalizedRecordId.length > 120) throw new Error("A valid saved campaign record ID is required");
  const result = await getPool().query(
    `SELECT t.target_id,t.shard_id,t.customer_id,t.last_applied_at,
            activity.manifest_seen_at,activity.last_poll_at,
            (activity.last_poll_at IS NOT NULL
              AND activity.last_poll_at>=now()-($2||' milliseconds')::interval) AS account_ready
       FROM tah_campaign_targets t
       LEFT JOIN tah_script_account_activity activity
         ON activity.shard_id=t.shard_id AND activity.customer_id=t.customer_id
      WHERE t.campaign_record_id=$1 AND t.enabled=true AND t.archived_at IS NULL`,
    [normalizedRecordId, ACCOUNT_READY_MS],
  );
  if (result.rowCount !== 1) {
    return {
      found: false,
      ready: false,
      accountReady: false,
      hasDelivered: false,
      state: "not_enrolled",
      freshnessMs: ACCOUNT_READY_MS,
    };
  }
  const row = result.rows[0];
  const accountReady = row.account_ready === true;
  const hasDelivered = Boolean(row.last_applied_at);
  const state = hasDelivered
    ? "established"
    : accountReady
      ? "ready"
      : row.manifest_seen_at
        ? "waiting_for_account_poll"
        : "waiting_for_manifest";
  return {
    found: true,
    targetId: String(row.target_id),
    shardId: String(row.shard_id),
    customerId: String(row.customer_id),
    ready: hasDelivered || accountReady,
    accountReady,
    hasDelivered,
    state,
    manifestSeenAt: row.manifest_seen_at ? new Date(row.manifest_seen_at).toISOString() : null,
    accountLastPollAt: row.last_poll_at ? new Date(row.last_poll_at).toISOString() : null,
    lastDeliveredAt: row.last_applied_at ? new Date(row.last_applied_at).toISOString() : null,
    freshnessMs: ACCOUNT_READY_MS,
  };
}

export async function enqueueBridgeCapture(input: BridgeTargetInput & { exactSuffix: string; version?: number; sourceRunId?: string; egress?: unknown }) {
  assertDeliverableSuffix(input.exactSuffix);
  const { targetId: id, shardId } = await upsertBridgeTarget(input);
  const suffixHash = digest(input.exactSuffix);
  const version = input.version && Number.isSafeInteger(input.version) ? input.version : Date.now();
  const egress = normalizedCaptureEgress(input.egress);
  return await transaction(async (client) => {
    const capture = await client.query(
      `INSERT INTO tah_suffix_captures(target_id,version,exact_suffix,suffix_hash,source_run_id,egress_identity)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (target_id,version) DO UPDATE SET
         exact_suffix=EXCLUDED.exact_suffix,
         suffix_hash=EXCLUDED.suffix_hash,
         egress_identity=COALESCE(EXCLUDED.egress_identity,tah_suffix_captures.egress_identity)
       RETURNING capture_id`,
      [id, version, input.exactSuffix, suffixHash, input.sourceRunId || null, egress ? JSON.stringify(egress) : null],
    );
    await client.query(
      `UPDATE tah_delivery_jobs SET state='superseded',leased_at=NULL,leased_until=NULL,
         lease_token_hash=NULL,worker_id=NULL,updated_at=now()
       WHERE target_id=$1 AND state IN ('pending','failed') AND capture_id <> $2`,
      [id, capture.rows[0].capture_id],
    );
    const jobId = randomUUID();
    const job = await client.query(
      `INSERT INTO tah_delivery_jobs(job_id,target_id,capture_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (target_id,capture_id) DO UPDATE SET state=CASE WHEN tah_delivery_jobs.state='dead' THEN 'pending' ELSE tah_delivery_jobs.state END,updated_at=now()
       RETURNING job_id,state`,
      [jobId, id, capture.rows[0].capture_id],
    );
    return { targetId: id, shardId, captureId: Number(capture.rows[0].capture_id), jobId: String(job.rows[0].job_id), state: String(job.rows[0].state) };
  });
}

export async function queueLatestBridgeCapture(campaignRecordId: string) {
  return await transaction(async (client) => {
    const target = await client.query(
      "SELECT target_id FROM tah_campaign_targets WHERE campaign_record_id=$1 AND enabled=true FOR UPDATE",
      [campaignRecordId],
    );
    if (target.rowCount !== 1) throw new Error("Campaign target was not found or is disabled");
    const targetId = String(target.rows[0].target_id);
    const latest = await client.query(
      "SELECT capture_id FROM tah_suffix_captures WHERE target_id=$1 ORDER BY captured_at DESC,capture_id DESC LIMIT 1",
      [targetId],
    );
    if (latest.rowCount !== 1) return { queued: false, state: "waiting_for_capture" };
    const captureId = Number(latest.rows[0].capture_id);
    await client.query(
      `UPDATE tah_delivery_jobs SET state='superseded',leased_at=NULL,leased_until=NULL,
         lease_token_hash=NULL,worker_id=NULL,updated_at=now()
       WHERE target_id=$1 AND capture_id<>$2 AND state IN ('pending','failed')`,
      [targetId, captureId],
    );
    const job = await client.query(
      `INSERT INTO tah_delivery_jobs(job_id,target_id,capture_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (target_id,capture_id) DO UPDATE SET
         state=CASE WHEN tah_delivery_jobs.state IN ('dead','superseded') THEN 'pending' ELSE tah_delivery_jobs.state END,
         attempt_count=CASE WHEN tah_delivery_jobs.state IN ('dead','superseded') THEN 0 ELSE tah_delivery_jobs.attempt_count END,
         available_at=CASE WHEN tah_delivery_jobs.state IN ('dead','superseded') THEN now() ELSE tah_delivery_jobs.available_at END,
         leased_at=CASE WHEN tah_delivery_jobs.state IN ('dead','superseded') THEN NULL ELSE tah_delivery_jobs.leased_at END,
         leased_until=CASE WHEN tah_delivery_jobs.state IN ('dead','superseded') THEN NULL ELSE tah_delivery_jobs.leased_until END,
         lease_token_hash=CASE WHEN tah_delivery_jobs.state IN ('dead','superseded') THEN NULL ELSE tah_delivery_jobs.lease_token_hash END,
         worker_id=CASE WHEN tah_delivery_jobs.state IN ('dead','superseded') THEN NULL ELSE tah_delivery_jobs.worker_id END,
         last_error=CASE WHEN tah_delivery_jobs.state IN ('dead','superseded') THEN NULL ELSE tah_delivery_jobs.last_error END,
         updated_at=now()
       RETURNING job_id,state`,
      [randomUUID(), targetId, captureId],
    );
    return { queued: true, jobId: String(job.rows[0].job_id), state: String(job.rows[0].state) };
  });
}

export async function registerBridgeShard(shardId: string, rawToken: string) {
  if (!shardId.trim() || rawToken.length < 24) throw new Error("A shard ID and strong token are required");
  await getPool().query(
    `INSERT INTO tah_script_shards(shard_id,token_hash) VALUES ($1,$2)
     ON CONFLICT (shard_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,enabled=true,updated_at=now()`,
    [shardId, digest(rawToken)],
  );
}

export async function authenticateBridgeShard(shardId: string, rawToken: string) {
  if (!rawToken) return false;
  const result = await getPool().query("SELECT enabled,token_hash FROM tah_script_shards WHERE shard_id=$1", [shardId]);
  return result.rowCount === 1 && result.rows[0].enabled === true && result.rows[0].token_hash === digest(rawToken);
}

export async function leaseBridgeJobs(
  shardId: string,
  workerId: string,
  requestedLimit = 25,
  requestedCustomerId = "",
  options: { protocol?: string; hotAdd?: boolean } = {},
): Promise<BridgeLease[]> {
  const limit = Math.max(1, Math.min(MAX_LEASE_JOBS, Math.floor(requestedLimit)));
  const customerId = normalizeId(requestedCustomerId);
  const hotAdd = options.hotAdd === true && !customerId;
  if (customerId && !/^\d{10}$/.test(customerId)) throw new Error("A valid 10-digit customer filter is required");
  return await transaction(async (client) => {
    const missingJobs = await client.query(
      `SELECT t.target_id,latest.capture_id
         FROM tah_campaign_targets t
         JOIN LATERAL (
           SELECT c.capture_id FROM tah_suffix_captures c
           WHERE c.target_id=t.target_id ORDER BY c.captured_at DESC,c.capture_id DESC LIMIT 1
         ) latest ON true
        WHERE t.enabled AND t.shard_id=$1 AND ($2='' OR t.customer_id=$2)
          AND NOT EXISTS (
            SELECT 1 FROM tah_delivery_jobs j
            WHERE j.target_id=t.target_id AND j.capture_id=latest.capture_id
          )`,
      [shardId, customerId],
    );
    for (const row of missingJobs.rows) {
      await client.query(
        `INSERT INTO tah_delivery_jobs(job_id,target_id,capture_id) VALUES ($1,$2,$3)
         ON CONFLICT (target_id,capture_id) DO NOTHING`,
        [randomUUID(), row.target_id, row.capture_id],
      );
    }
    await client.query(
      `UPDATE tah_delivery_jobs j SET state='superseded',leased_at=NULL,leased_until=NULL,
         lease_token_hash=NULL,worker_id=NULL,updated_at=now()
       WHERE j.state IN ('pending','failed')
         AND j.capture_id <> (
           SELECT c.capture_id FROM tah_suffix_captures c
           WHERE c.target_id=j.target_id ORDER BY c.captured_at DESC,c.capture_id DESC LIMIT 1
         )`,
    );
    await client.query(
      `UPDATE tah_delivery_jobs SET
         state=CASE WHEN attempt_count >= $1 THEN 'dead' ELSE 'failed' END,
         available_at=CASE WHEN attempt_count >= $1 THEN available_at ELSE now() + (LEAST(3600,POWER(2,attempt_count)::int*10)||' seconds')::interval END,
         leased_at=NULL,leased_until=NULL,lease_token_hash=NULL,worker_id=NULL,
         last_error=COALESCE(last_error,'Lease expired'),updated_at=now()
       WHERE state='leased' AND leased_until < now()`,
      [MAX_ATTEMPTS],
    );
    const candidates = await client.query(
      `WITH ranked AS MATERIALIZED (
         SELECT j.job_id,j.created_at,
                row_number() OVER (
                  PARTITION BY t.customer_id
                  ORDER BY CASE WHEN t.last_applied_at IS NULL THEN 0 ELSE 1 END,j.created_at,j.job_id
                ) AS account_position
           FROM tah_delivery_jobs j
           JOIN tah_suffix_captures c ON c.capture_id=j.capture_id
           JOIN tah_campaign_targets t ON t.target_id=j.target_id
          WHERE j.state IN ('pending','failed') AND j.available_at<=now() AND j.attempt_count<$1
            AND t.enabled=true AND t.shard_id=$2
            AND ($4='' OR t.customer_id=$4)
            AND j.capture_id=(
              SELECT newest.capture_id FROM tah_suffix_captures newest
              WHERE newest.target_id=j.target_id ORDER BY newest.captured_at DESC,newest.capture_id DESC LIMIT 1
            )
            AND NOT EXISTS (
              SELECT 1 FROM tah_delivery_jobs active
               WHERE active.target_id=j.target_id AND active.state='leased' AND active.job_id<>j.job_id
            )
            AND (t.last_applied_at IS NULL OR t.last_applied_at+(t.min_delivery_interval_ms||' milliseconds')::interval<=now())
       ), locked AS (
         SELECT j.job_id,ranked.account_position,ranked.created_at
           FROM ranked
           JOIN tah_delivery_jobs j ON j.job_id=ranked.job_id
          WHERE j.state IN ('pending','failed')
          ORDER BY ranked.account_position,ranked.created_at,ranked.job_id
          FOR UPDATE OF j SKIP LOCKED
          LIMIT $3
       )
       SELECT j.job_id,j.target_id,j.capture_id,c.exact_suffix,c.version,c.captured_at,
              t.campaign_record_id,t.campaign_name,t.manager_customer_id,t.customer_id,t.google_campaign_id
         FROM locked
         JOIN tah_delivery_jobs j ON j.job_id=locked.job_id
         JOIN tah_suffix_captures c ON c.capture_id=j.capture_id
         JOIN tah_campaign_targets t ON t.target_id=j.target_id
        ORDER BY locked.account_position,locked.created_at,locked.job_id`,
      [MAX_ATTEMPTS, shardId, limit, customerId],
    );
    const leases: BridgeLease[] = [];
    for (const row of candidates.rows) {
      const issue = deliverySuffixIssue(row.exact_suffix);
      if (issue) {
        await client.query("UPDATE tah_delivery_jobs SET state='dead',last_error=$2,leased_at=NULL,leased_until=NULL,lease_token_hash=NULL,worker_id=NULL,updated_at=now() WHERE job_id=$1", [row.job_id, issue]);
        continue;
      }
      const leaseToken = randomBytes(32).toString("base64url");
      await client.query(
        `UPDATE tah_delivery_jobs SET state='leased',attempt_count=attempt_count+1,leased_at=now(),
         leased_until=now()+($2||' milliseconds')::interval,lease_token_hash=$3,worker_id=$4,updated_at=now()
         WHERE job_id=$1`,
        [row.job_id, LEASE_MS, digest(leaseToken), workerId],
      );
      leases.push({
        jobId: String(row.job_id), leaseToken, campaignRecordId: String(row.campaign_record_id), campaignName: String(row.campaign_name),
        managerCustomerId: String(row.manager_customer_id), customerId: String(row.customer_id), campaignId: String(row.google_campaign_id),
        exactSuffix: String(row.exact_suffix), version: Number(row.version), capturedAt: new Date(row.captured_at).toISOString(),
      });
    }
    await client.query("UPDATE tah_script_shards SET last_poll_at=now(),updated_at=now() WHERE shard_id=$1", [shardId]);
    if (customerId) {
      await client.query(
        `INSERT INTO tah_script_account_activity(shard_id,customer_id,last_poll_at,worker_id)
         SELECT $1,$2,now(),$3
          WHERE EXISTS (
            SELECT 1 FROM tah_campaign_targets
             WHERE enabled=true AND archived_at IS NULL AND shard_id=$1 AND customer_id=$2
          )
         ON CONFLICT (shard_id,customer_id) DO UPDATE SET
           last_poll_at=EXCLUDED.last_poll_at,
           worker_id=EXCLUDED.worker_id,
           updated_at=now()`,
        [shardId, customerId, workerId],
      );
    } else if (hotAdd) {
      await client.query(
        `INSERT INTO tah_script_account_activity(shard_id,customer_id,last_poll_at,worker_id)
         SELECT $1,t.customer_id,now(),$2
           FROM tah_campaign_targets t
          WHERE t.enabled=true AND t.archived_at IS NULL AND t.shard_id=$1
          GROUP BY t.customer_id
         ON CONFLICT (shard_id,customer_id) DO UPDATE SET
           last_poll_at=EXCLUDED.last_poll_at,
           worker_id=EXCLUDED.worker_id,
           updated_at=now()`,
        [shardId, workerId],
      );
    }
    return leases;
  });
}

export async function bridgeShardManifest(
  shardId: string,
  options: { invocationId?: string; protocol?: string; preview?: boolean; adaptive?: boolean } = {},
) {
  const normalizedShardId = shardId.trim();
  if (!normalizedShardId) throw new Error("shardId is required");
  return transaction(async (client) => {
    await client.query("SELECT shard_id FROM tah_script_shards WHERE shard_id=$1 FOR UPDATE", [normalizedShardId]);
    const result = await client.query(
      `SELECT s.shard_id,s.enabled,
              s.last_execution_started_at,s.schedule_anchor_at,s.schedule_sample_count,
              count(t.target_id) FILTER (WHERE t.enabled AND t.archived_at IS NULL)::int AS campaign_count,
              COALESCE(array_agg(DISTINCT t.customer_id ORDER BY t.customer_id)
                FILTER (WHERE t.enabled AND t.archived_at IS NULL),'{}'::text[]) AS account_ids,
              COALESCE(array_agg(DISTINCT t.manager_customer_id ORDER BY t.manager_customer_id)
                FILTER (WHERE t.enabled AND t.archived_at IS NULL AND t.manager_customer_id<>''),'{}'::text[]) AS manager_ids
         FROM tah_script_shards s
         LEFT JOIN tah_campaign_targets t ON t.shard_id=s.shard_id
        WHERE s.shard_id=$1
        GROUP BY s.shard_id,s.enabled,s.last_execution_started_at,s.schedule_anchor_at,s.schedule_sample_count`,
      [normalizedShardId],
    );
    const row = result.rows[0];
    if (!row || !row.enabled) throw new Error("Fleet shard was not found or is disabled");
    const managerIds = Array.isArray(row.manager_ids) ? row.manager_ids.map(String) : [];
    const accountIds = Array.isArray(row.account_ids) ? row.account_ids.map(String) : [];
    if (managerIds.length > 1) throw new Error(`Fleet shard ${normalizedShardId} contains campaigns from multiple MCC accounts`);
    let executionWindow: ReturnType<typeof adaptiveExecutionWindow> | null = null;
    if (!options.preview) {
      await client.query(
        `INSERT INTO tah_script_account_activity(shard_id,customer_id,manifest_seen_at)
         SELECT $1,account_id,now() FROM unnest($2::text[]) AS account_id
         ON CONFLICT (shard_id,customer_id) DO UPDATE SET manifest_seen_at=EXCLUDED.manifest_seen_at,updated_at=now()`,
        [normalizedShardId, accountIds],
      );
      await client.query(
        `DELETE FROM tah_script_account_activity
          WHERE shard_id=$1 AND NOT (customer_id=ANY($2::text[]))`,
        [normalizedShardId, accountIds],
      );
    }
    if (!options.preview && options.adaptive) {
      const startedAt = new Date();
      const invocationId = String(options.invocationId || randomUUID()).slice(0, 200);
      executionWindow = adaptiveExecutionWindow(row, startedAt, invocationId);
      await client.query(
        `UPDATE tah_script_shards SET
           previous_execution_started_at=last_execution_started_at,
           last_execution_started_at=$2,
           last_execution_completed_at=NULL,
           last_invocation_id=$3,
           last_execution_status='running',
           schedule_anchor_at=$4,
           schedule_sample_count=$5,
           expected_next_start_at=$6,
           phase_one_stop_at=$7,
           hard_stop_at=$8,
           handoff_margin_ms=$9,
           updated_at=now()
         WHERE shard_id=$1`,
        [
          normalizedShardId,
          executionWindow.startedAt,
          invocationId,
          executionWindow.scheduleAnchorAt,
          executionWindow.scheduleSampleCount,
          executionWindow.nextExpectedStartAt,
          executionWindow.phaseOneStopAt,
          executionWindow.hardStopAt,
          executionWindow.handoffMarginMs,
        ],
      );
    }
    return {
      protocol: options.protocol || "fleet-callback-resilient-relay-v10",
      shardId: normalizedShardId,
      managerCustomerId: String(managerIds[0] || ""),
      accountIds,
      campaignCount: Number(row.campaign_count || 0),
      capacity: SHARD_CAPACITY,
      executionWindow,
    };
  });
}

export async function bridgeActiveExecutionWindow(shardId: string) {
  const normalizedShardId = shardId.trim();
  if (!normalizedShardId) throw new Error("shardId is required");
  const result = await getPool().query(
    `SELECT shard_id,enabled,last_invocation_id,last_execution_started_at,
            phase_one_stop_at,hard_stop_at,expected_next_start_at,handoff_margin_ms,
            schedule_anchor_at,schedule_sample_count,last_execution_status
       FROM tah_script_shards WHERE shard_id=$1`,
    [normalizedShardId],
  );
  const row = result.rows[0];
  if (!row || !row.enabled) throw new Error("Fleet shard was not found or is disabled");
  if (!row.last_invocation_id || !row.phase_one_stop_at || !row.hard_stop_at) {
    throw new Error("Fleet shard has no recoverable execution window");
  }
  const hardStopMs = new Date(row.hard_stop_at).getTime();
  return {
    invocationId: String(row.last_invocation_id),
    executionWindow: {
      invocationId: String(row.last_invocation_id),
      startedAt: row.last_execution_started_at ? new Date(row.last_execution_started_at).toISOString() : null,
      phaseOneStopAt: new Date(row.phase_one_stop_at).toISOString(),
      hardStopAt: new Date(row.hard_stop_at).toISOString(),
      nextExpectedStartAt: row.expected_next_start_at ? new Date(row.expected_next_start_at).toISOString() : null,
      handoffMarginMs: Number(row.handoff_margin_ms || HANDOFF_MARGIN_MS),
      scheduleMode: "recovered",
      scheduleConfidence: Number(row.schedule_sample_count || 0) >= 2 ? "learned" : "learning",
      scheduleSampleCount: Number(row.schedule_sample_count || 0),
      scheduleAnchorAt: row.schedule_anchor_at ? new Date(row.schedule_anchor_at).toISOString() : null,
      shouldYield: !Number.isFinite(hardStopMs) || Date.now() >= hardStopMs,
    },
  };
}

export async function completeBridgeInvocation(input: {
  shardId: string;
  invocationId: string;
  status: string;
}) {
  const status = ["completed", "yielded", "empty", "failed"].includes(input.status)
    ? input.status
    : "completed";
  const result = await getPool().query(
    `UPDATE tah_script_shards SET
       last_execution_completed_at=now(),last_execution_status=$3,updated_at=now()
     WHERE shard_id=$1 AND last_invocation_id=$2
     RETURNING shard_id`,
    [input.shardId, input.invocationId, status],
  );
  return { recorded: result.rowCount === 1 };
}

export async function acknowledgeBridgeJob(input: { shardId: string; workerId: string; jobId: string; leaseToken: string; ok: boolean; appliedSuffix?: string; error?: string }) {
  if (input.ok) assertDeliverableSuffix(input.appliedSuffix);
  return await transaction(async (client) => {
    const result = await client.query(
      `SELECT j.*,c.exact_suffix,c.suffix_hash FROM tah_delivery_jobs j
       JOIN tah_suffix_captures c ON c.capture_id=j.capture_id
       JOIN tah_campaign_targets t ON t.target_id=j.target_id
       WHERE j.job_id=$1 AND t.shard_id=$2 FOR UPDATE`,
      [input.jobId, input.shardId],
    );
    if (result.rowCount !== 1) {
      return { ok: false, state: "stale" as const, reason: "Delivery job no longer exists" };
    }
    const row = result.rows[0];
    if (row.worker_id !== input.workerId || row.lease_token_hash !== digest(input.leaseToken)) {
      return { ok: false, state: "stale" as const, reason: "Delivery lease has been reassigned" };
    }
    if (row.state === "applied") {
      const alreadyVerified = row.verified_suffix_hash === row.suffix_hash;
      if (alreadyVerified) {
        await client.query("UPDATE tah_script_shards SET last_ack_at=now(),last_error=NULL,updated_at=now() WHERE shard_id=$1", [input.shardId]);
        return { ok: true, state: "applied" as const, idempotent: true };
      }
      return { ok: false, state: "conflict" as const, reason: "Applied job is missing exact verification evidence" };
    }
    if (row.state !== "leased") {
      return { ok: false, state: "stale" as const, reason: `Delivery job is ${String(row.state)}` };
    }
    const exactMatch = input.ok && typeof input.appliedSuffix === "string" && digest(input.appliedSuffix) === row.suffix_hash;
    if (exactMatch) {
      await client.query(
        `UPDATE tah_delivery_jobs SET state='applied',applied_at=now(),verified_suffix_hash=$2,last_error=NULL,
         leased_at=NULL,leased_until=NULL,updated_at=now() WHERE job_id=$1`,
        [input.jobId, row.suffix_hash],
      );
      await client.query("UPDATE tah_campaign_targets SET last_applied_at=now(),last_applied_suffix_hash=$2,updated_at=now() WHERE target_id=$1", [row.target_id, row.suffix_hash]);
    } else {
      const dead = Number(row.attempt_count) >= MAX_ATTEMPTS;
      const delaySeconds = Math.min(3_600, 10 * (2 ** Math.max(0, Number(row.attempt_count) - 1)));
      await client.query(
        `UPDATE tah_delivery_jobs SET state=$2,available_at=now()+($3||' seconds')::interval,last_error=$4,
         leased_at=NULL,leased_until=NULL,lease_token_hash=NULL,updated_at=now() WHERE job_id=$1`,
        [input.jobId, dead ? "dead" : "failed", delaySeconds, (input.error || "Google Ads verification did not return the exact suffix").slice(0, 2_000)],
      );
    }
    await client.query("UPDATE tah_script_shards SET last_ack_at=now(),last_error=$2,updated_at=now() WHERE shard_id=$1", [input.shardId, exactMatch ? null : input.error || "Verification mismatch"]);
    return { ok: exactMatch, state: exactMatch ? "applied" : Number(row.attempt_count) >= MAX_ATTEMPTS ? "dead" : "failed" };
  });
}

export async function renewBridgeLeases(input: {
  shardId: string;
  workerId: string;
  leases: Array<{ jobId: string; leaseToken: string }>;
}) {
  const leases = input.leases.slice(0, MAX_LEASE_JOBS);
  return await transaction(async (client) => {
    const renewedJobIds: string[] = [];
    const staleJobIds: string[] = [];
    for (const lease of leases) {
      const result = await client.query(
        `UPDATE tah_delivery_jobs j
            SET leased_until=now()+($5||' milliseconds')::interval,updated_at=now()
           FROM tah_campaign_targets t
          WHERE j.job_id=$1 AND j.target_id=t.target_id AND t.shard_id=$2
            AND j.state='leased' AND j.worker_id=$3 AND j.lease_token_hash=$4
          RETURNING j.job_id`,
        [lease.jobId, input.shardId, input.workerId, digest(lease.leaseToken), LEASE_MS],
      );
      if (result.rowCount === 1) renewedJobIds.push(String(result.rows[0].job_id));
      else staleJobIds.push(lease.jobId);
    }
    await client.query("UPDATE tah_script_shards SET last_poll_at=now(),updated_at=now() WHERE shard_id=$1", [input.shardId]);
    return { renewedJobIds, staleJobIds, leaseDurationMs: LEASE_MS };
  });
}

export async function bridgeStoreSummary() {
  const result = await getPool().query(
    `WITH latest_capture AS (
       SELECT DISTINCT ON (target_id) target_id,capture_id
       FROM tah_suffix_captures ORDER BY target_id,captured_at DESC,capture_id DESC
     ), current_jobs AS (
       SELECT j.*,t.customer_id,t.shard_id
       FROM tah_delivery_jobs j
       JOIN tah_campaign_targets t USING (target_id)
       JOIN latest_capture l ON l.target_id=j.target_id AND l.capture_id=j.capture_id
       WHERE t.enabled
      ), assigned_shards AS (
        SELECT DISTINCT shard_id FROM tah_campaign_targets WHERE enabled
      ), assigned_accounts AS (
        SELECT DISTINCT shard_id,customer_id FROM tah_campaign_targets WHERE enabled AND archived_at IS NULL
      )
     SELECT
      (SELECT count(*)::int FROM tah_campaign_targets WHERE enabled) AS campaigns,
      (SELECT count(*)::int FROM current_jobs WHERE state IN ('pending','failed')) AS pending,
      (SELECT count(*)::int FROM current_jobs WHERE state='leased') AS leased,
      (SELECT count(*)::int FROM current_jobs WHERE state='applied') AS applied,
      (SELECT count(*)::int FROM current_jobs WHERE state='dead') AS dead,
      (SELECT count(*)::int FROM current_jobs WHERE state IN ('pending','failed','leased')) AS updates_in_flight,
      (SELECT count(*)::int FROM current_jobs WHERE state IN ('pending','failed','leased') AND created_at<=now()-(${HANDOFF_ALLOWANCE_MS}||' milliseconds')::interval) AS delayed,
      COALESCE((SELECT (EXTRACT(EPOCH FROM (now()-min(created_at)))*1000)::bigint FROM current_jobs WHERE state IN ('pending','failed','leased')),0) AS oldest_queue_age_ms,
      COALESCE((SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (j.applied_at-j.created_at))*1000)::bigint
        FROM tah_delivery_jobs j JOIN tah_campaign_targets t USING (target_id)
        WHERE t.enabled AND j.state='applied' AND j.applied_at>=now()-interval '24 hours'),0) AS p95_delay_ms,
      (SELECT count(*)::int FROM tah_delivery_jobs j JOIN tah_campaign_targets t USING (target_id)
        WHERE t.enabled AND j.state='applied' AND j.applied_at>=now()-interval '15 minutes') AS throughput_last_15m,
      (SELECT count(*)::int FROM assigned_shards a JOIN tah_script_shards s USING (shard_id)
        WHERE s.enabled AND s.last_poll_at>=now()-(${SHARD_STALE_MS}||' milliseconds')::interval) AS active_shards,
       (SELECT count(*)::int FROM assigned_shards a LEFT JOIN tah_script_shards s USING (shard_id)
         WHERE s.shard_id IS NULL OR NOT s.enabled OR s.last_poll_at IS NULL OR s.last_poll_at<now()-(${SHARD_STALE_MS}||' milliseconds')::interval) AS offline_shards,
       (SELECT count(*)::int FROM assigned_accounts account
         JOIN tah_script_account_activity activity USING (shard_id,customer_id)
         WHERE activity.last_poll_at>=now()-(${ACCOUNT_READY_MS}||' milliseconds')::interval) AS ready_accounts,
       (SELECT count(*)::int FROM assigned_accounts account
         LEFT JOIN tah_script_account_activity activity USING (shard_id,customer_id)
         WHERE activity.last_poll_at IS NULL OR activity.last_poll_at<now()-(${ACCOUNT_READY_MS}||' milliseconds')::interval) AS waiting_accounts,
      COALESCE((SELECT max(batch_size)::int FROM (
        SELECT customer_id,count(*)::int AS batch_size FROM current_jobs
        WHERE state IN ('pending','failed','leased') GROUP BY customer_id
      ) batches),0) AS largest_account_batch,
      (SELECT count(*)::int
         FROM tah_campaign_targets t
         LEFT JOIN tah_script_shards s ON s.shard_id=t.shard_id AND s.enabled
        WHERE t.enabled AND s.shard_id IS NULL) AS unassigned,
      (SELECT min(created_at) FROM current_jobs WHERE state IN ('pending','failed')) AS oldest_pending_at`,
  );
  return result.rows[0];
}

export async function createBridgeShard(shardId: string) {
  const token = randomBytes(36).toString("base64url");
  await registerBridgeShard(shardId, token);
  return { shardId, token };
}

export async function listBridgeTargets(options: { query?: string; page?: number; pageSize?: number } = {}) {
  const pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize || 25)));
  const page = Math.max(1, Math.floor(options.page || 1));
  const query = options.query?.trim() || "";
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const result = await getPool().query(
    `SELECT t.target_id,t.campaign_record_id,t.campaign_name,t.manager_customer_id,t.customer_id,t.google_campaign_id,
            t.shard_id,t.enabled,t.last_applied_at,t.updated_at,
            activity.manifest_seen_at AS account_manifest_seen_at,
            activity.last_poll_at AS account_last_poll_at,
            (activity.last_poll_at IS NOT NULL
              AND activity.last_poll_at>=now()-(${ACCOUNT_READY_MS}||' milliseconds')::interval) AS account_ready,
            CASE
              WHEN t.last_applied_at IS NOT NULL THEN 'established'
              WHEN activity.last_poll_at IS NOT NULL
                AND activity.last_poll_at>=now()-(${ACCOUNT_READY_MS}||' milliseconds')::interval THEN 'ready'
              WHEN activity.manifest_seen_at IS NOT NULL THEN 'waiting_for_account_poll'
              ELSE 'waiting_for_manifest'
            END AS account_readiness,
            latest.version AS latest_version,latest.exact_suffix,latest.captured_at,
            latest.egress_identity AS capture_egress,
            (SELECT prior.egress_identity
               FROM tah_suffix_captures prior
              WHERE prior.target_id=t.target_id
                AND prior.capture_id<>latest.capture_id
                AND prior.egress_identity IS NOT NULL
              ORDER BY prior.captured_at DESC,prior.capture_id DESC LIMIT 1
            ) AS previous_capture_egress,
            (SELECT applied_capture.exact_suffix
               FROM tah_suffix_captures applied_capture
              WHERE applied_capture.target_id=t.target_id
                AND applied_capture.suffix_hash=t.last_applied_suffix_hash
              ORDER BY applied_capture.captured_at DESC,applied_capture.capture_id DESC LIMIT 1
            ) AS last_applied_suffix,
            job.state AS latest_job_state,job.attempt_count,job.last_error,job.applied_at,job.created_at AS latest_job_created_at,
            CASE WHEN t.last_applied_at IS NOT NULL THEN 'healthy' WHEN job.state='dead' THEN 'attention' ELSE 'awaiting' END AS delivery_health,
            CASE
              WHEN job.state='applied' THEN 'current'
              WHEN job.state IN ('pending','failed','leased') AND job.created_at<=now()-(${HANDOFF_ALLOWANCE_MS}||' milliseconds')::interval THEN 'delayed'
              WHEN job.state='leased' THEN 'processing'
              WHEN job.state='failed' THEN 'retrying'
              WHEN job.state='pending' THEN 'queued'
              ELSE 'waiting'
            END AS newest_update_state,
            CASE WHEN job.state IN ('pending','failed','leased') THEN (EXTRACT(EPOCH FROM (now()-job.created_at))*1000)::bigint ELSE 0 END AS queue_age_ms,
            count(*) OVER()::int AS total
     FROM tah_campaign_targets t
     LEFT JOIN LATERAL (
       SELECT capture_id,version,exact_suffix,captured_at,egress_identity FROM tah_suffix_captures
       WHERE target_id=t.target_id ORDER BY captured_at DESC LIMIT 1
     ) latest ON true
      LEFT JOIN LATERAL (
        SELECT state,attempt_count,last_error,applied_at,created_at FROM tah_delivery_jobs
        WHERE target_id=t.target_id AND capture_id=latest.capture_id ORDER BY created_at DESC LIMIT 1
      ) job ON true
      LEFT JOIN tah_script_account_activity activity
        ON activity.shard_id=t.shard_id AND activity.customer_id=t.customer_id
     WHERE t.enabled AND t.archived_at IS NULL AND ($1='' OR t.campaign_name ILIKE $2 ESCAPE '\\' OR t.campaign_record_id ILIKE $2 ESCAPE '\\'
            OR t.customer_id ILIKE $2 ESCAPE '\\' OR t.google_campaign_id ILIKE $2 ESCAPE '\\')
     ORDER BY t.updated_at DESC
     LIMIT $3 OFFSET $4`,
    [query, pattern, pageSize, (page - 1) * pageSize],
  );
  return { page, pageSize, total: Number(result.rows[0]?.total || 0), items: result.rows.map(({ total: _total, ...row }) => row) };
}

export async function setBridgeTargetEnabled(campaignRecordId: string, enabled: boolean) {
  await transaction(async (client) => {
    const result = await client.query(
      "UPDATE tah_campaign_targets SET enabled=$2,updated_at=now() WHERE campaign_record_id=$1 AND archived_at IS NULL RETURNING target_id",
      [campaignRecordId, enabled],
    );
    if (result.rowCount !== 1) throw new Error("Campaign target was not found");
    if (!enabled) {
      await client.query(
        `UPDATE tah_delivery_jobs SET state='superseded',leased_at=NULL,leased_until=NULL,
           lease_token_hash=NULL,worker_id=NULL,updated_at=now()
         WHERE target_id=$1 AND state IN ('pending','failed','leased')`,
        [result.rows[0].target_id],
      );
    }
  });
}

export async function deleteBridgeTarget(input: { targetId?: string; campaignRecordId?: string }) {
  const targetIdValue = String(input.targetId || "").trim();
  const campaignRecordId = String(input.campaignRecordId || "").trim();
  if (targetIdValue && !/^[a-f0-9]{40}$/i.test(targetIdValue)) throw new Error("A valid Fleet target ID is required");
  if (!targetIdValue && !campaignRecordId) throw new Error("A Fleet target ID or saved campaign record ID is required");
  if (campaignRecordId.length > 120) throw new Error("Invalid saved campaign record ID");
  return transaction(async (client) => {
    const selector = targetIdValue ? "target_id=$1" : "campaign_record_id=$1";
    const selectorValue = targetIdValue || campaignRecordId;
    const current = await client.query(
      `SELECT target_id,campaign_record_id,campaign_name,manager_customer_id,shard_id,enabled,archived_at
         FROM tah_campaign_targets WHERE ${selector} FOR UPDATE`,
      [selectorValue],
    );
    if (current.rowCount !== 1) return { deleted: false, target: null };
    const target = current.rows[0];
    await client.query(
      `INSERT INTO tah_audit_log(actor_id,action,resource_type,resource_id,details)
       VALUES ('dashboard-session','fleet.target.deleted','fleet_target',$1,
               jsonb_build_object('campaign_record_id',$2::text,'campaign_name',$3::text,'shard_id',$4::text,
                                  'history_preserved',false,'captures_and_jobs_deleted',true))`,
      [target.target_id, target.campaign_record_id, target.campaign_name, target.shard_id],
    );
    await client.query("DELETE FROM tah_campaign_targets WHERE target_id=$1", [target.target_id]);
    return { deleted: true, target };
  });
}

export async function bridgeShardStatus() {
  const result = await getPool().query(
    `WITH shard_ids AS (
       SELECT shard_id FROM tah_script_shards
       UNION
       SELECT shard_id FROM tah_campaign_targets WHERE enabled AND archived_at IS NULL
     )
     SELECT ids.shard_id,
            COALESCE(s.enabled,false) AS enabled,
            (s.shard_id IS NOT NULL) AS registered,
            s.last_poll_at,s.last_ack_at,s.last_error,s.updated_at,
            s.last_execution_started_at,s.last_execution_completed_at,s.last_execution_status,
            s.expected_next_start_at,s.phase_one_stop_at,s.hard_stop_at,s.handoff_margin_ms,
            s.schedule_anchor_at,s.schedule_sample_count,s.last_invocation_id,
            (count(t.target_id) FILTER (WHERE t.enabled AND t.archived_at IS NULL))::int AS campaign_count,
            min(NULLIF(t.manager_customer_id,'')) FILTER (WHERE t.enabled AND t.archived_at IS NULL) AS manager_customer_id,
            ${SHARD_CAPACITY}::int AS capacity
       FROM shard_ids ids
       LEFT JOIN tah_script_shards s ON s.shard_id=ids.shard_id
       LEFT JOIN tah_campaign_targets t ON t.shard_id=ids.shard_id
      GROUP BY ids.shard_id,s.shard_id,s.enabled,s.last_poll_at,s.last_ack_at,s.last_error,s.updated_at,
               s.last_execution_started_at,s.last_execution_completed_at,s.last_execution_status,
               s.expected_next_start_at,s.phase_one_stop_at,s.hard_stop_at,s.handoff_margin_ms,
               s.schedule_anchor_at,s.schedule_sample_count,s.last_invocation_id
      ORDER BY ids.shard_id`,
  );
  return result.rows;
}

export async function closeBridgeStoreForTests() {
  const current = pool;
  pool = null;
  await current?.end();
}
