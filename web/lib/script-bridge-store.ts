import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";

const { Pool: PgPool } = pg;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.TAH_SCRIPT_MAX_ATTEMPTS) || 8);
const LEASE_MS = Math.max(30_000, Number(process.env.TAH_SCRIPT_LEASE_MS) || 4 * 60_000);
const MIN_INTERVAL_MS = Math.max(58_000, Number(process.env.TAH_SCRIPT_MIN_DELIVERY_INTERVAL_MS) || 58_000);
const SHARD_CAPACITY = 40;
const MAX_LEASE_JOBS = 200;
const HANDOFF_ALLOWANCE_MS = Math.max(60_000, Number(process.env.TAH_SCRIPT_HANDOFF_ALLOWANCE_MS) || 15 * 60_000);
const SHARD_STALE_MS = Math.max(60_000, Number(process.env.TAH_SCRIPT_SHARD_STALE_MS) || 75 * 60_000);
let pool: Pool | null = null;

export interface BridgeTargetInput {
  campaignRecordId: string;
  campaignName: string;
  managerCustomerId?: string;
  customerId: string;
  googleCampaignId: string;
  shardId?: string;
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
      const saved = await client.query(
        `INSERT INTO tah_campaign_targets
          (target_id, campaign_record_id, campaign_name, manager_customer_id, customer_id, google_campaign_id, shard_id, min_delivery_interval_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (campaign_record_id) DO UPDATE SET
           campaign_name=EXCLUDED.campaign_name,
           manager_customer_id=EXCLUDED.manager_customer_id,
           customer_id=EXCLUDED.customer_id,
           google_campaign_id=EXCLUDED.google_campaign_id,
           shard_id=EXCLUDED.shard_id,
           enabled=true,
           archived_at=NULL,
           updated_at=now()
         RETURNING target_id,shard_id`,
        [id, input.campaignRecordId, input.campaignName, managerCustomerId, customerId, googleCampaignId, assignedShardId, MIN_INTERVAL_MS],
      );
      assignment = { targetId: String(saved.rows[0].target_id), shardId: String(saved.rows[0].shard_id) };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("Another saved campaign already owns this Google Ads target");
    throw error;
  }
  return assignment;
}

export async function enqueueBridgeCapture(input: BridgeTargetInput & { exactSuffix: string; version?: number; sourceRunId?: string }) {
  const { targetId: id, shardId } = await upsertBridgeTarget(input);
  const suffixHash = digest(input.exactSuffix);
  const version = input.version && Number.isSafeInteger(input.version) ? input.version : Date.now();
  return await transaction(async (client) => {
    const capture = await client.query(
      `INSERT INTO tah_suffix_captures(target_id,version,exact_suffix,suffix_hash,source_run_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (target_id,version) DO UPDATE SET exact_suffix=EXCLUDED.exact_suffix,suffix_hash=EXCLUDED.suffix_hash
       RETURNING capture_id`,
      [id, version, input.exactSuffix, suffixHash, input.sourceRunId || null],
    );
    await client.query(
      `UPDATE tah_delivery_jobs SET state='superseded',leased_at=NULL,leased_until=NULL,
         lease_token_hash=NULL,worker_id=NULL,updated_at=now()
       WHERE target_id=$1 AND state IN ('pending','failed','leased') AND capture_id <> $2`,
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
       WHERE target_id=$1 AND capture_id<>$2 AND state IN ('pending','failed','leased')`,
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
): Promise<BridgeLease[]> {
  const limit = Math.max(1, Math.min(MAX_LEASE_JOBS, Math.floor(requestedLimit)));
  const customerId = normalizeId(requestedCustomerId);
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
       WHERE j.state IN ('pending','failed','leased')
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
                row_number() OVER (PARTITION BY t.customer_id ORDER BY j.created_at,j.job_id) AS account_position
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
    return leases;
  });
}

export async function bridgeShardManifest(shardId: string) {
  const normalizedShardId = shardId.trim();
  if (!normalizedShardId) throw new Error("shardId is required");
  const result = await getPool().query(
    `SELECT s.shard_id,s.enabled,
            count(t.target_id) FILTER (WHERE t.enabled)::int AS campaign_count,
            COALESCE(array_agg(DISTINCT t.customer_id ORDER BY t.customer_id) FILTER (WHERE t.enabled),'{}'::text[]) AS account_ids,
            COALESCE(array_agg(DISTINCT t.manager_customer_id ORDER BY t.manager_customer_id)
              FILTER (WHERE t.enabled AND t.manager_customer_id<>''),'{}'::text[]) AS manager_ids
       FROM tah_script_shards s
       LEFT JOIN tah_campaign_targets t ON t.shard_id=s.shard_id
      WHERE s.shard_id=$1
      GROUP BY s.shard_id,s.enabled`,
    [normalizedShardId],
  );
  const row = result.rows[0];
  if (!row || !row.enabled) throw new Error("Fleet shard was not found or is disabled");
  const managerIds = Array.isArray(row.manager_ids) ? row.manager_ids : [];
  if (managerIds.length > 1) throw new Error(`Fleet shard ${normalizedShardId} contains campaigns from multiple MCC accounts`);
  return {
    protocol: "fleet-hourly-relay-v5",
    shardId: normalizedShardId,
    managerCustomerId: String(managerIds[0] || ""),
    accountIds: Array.isArray(row.account_ids) ? row.account_ids : [],
    campaignCount: Number(row.campaign_count || 0),
    capacity: SHARD_CAPACITY,
  };
}

export async function acknowledgeBridgeJob(input: { shardId: string; workerId: string; jobId: string; leaseToken: string; ok: boolean; appliedSuffix?: string; error?: string }) {
  return await transaction(async (client) => {
    const result = await client.query(
      `SELECT j.*,c.exact_suffix,c.suffix_hash FROM tah_delivery_jobs j
       JOIN tah_suffix_captures c ON c.capture_id=j.capture_id
       JOIN tah_campaign_targets t ON t.target_id=j.target_id
       WHERE j.job_id=$1 AND j.state='leased' AND j.worker_id=$2 AND t.shard_id=$3 FOR UPDATE`,
      [input.jobId, input.workerId, input.shardId],
    );
    if (result.rowCount !== 1 || result.rows[0].lease_token_hash !== digest(input.leaseToken) || new Date(result.rows[0].leased_until).getTime() < Date.now()) {
      throw new Error("Lease is invalid or expired");
    }
    const row = result.rows[0];
    const exactMatch = input.ok && typeof input.appliedSuffix === "string" && digest(input.appliedSuffix) === row.suffix_hash;
    if (exactMatch) {
      await client.query(
        `UPDATE tah_delivery_jobs SET state='applied',applied_at=now(),verified_suffix_hash=$2,last_error=NULL,
         leased_at=NULL,leased_until=NULL,lease_token_hash=NULL,updated_at=now() WHERE job_id=$1`,
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
            latest.version AS latest_version,latest.exact_suffix,latest.captured_at,
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
       SELECT capture_id,version,exact_suffix,captured_at FROM tah_suffix_captures
       WHERE target_id=t.target_id ORDER BY captured_at DESC LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT state,attempt_count,last_error,applied_at,created_at FROM tah_delivery_jobs
       WHERE target_id=t.target_id AND capture_id=latest.capture_id ORDER BY created_at DESC LIMIT 1
     ) job ON true
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

export async function setBridgeTargetArchived(targetIdValue: string, archived: boolean) {
  const id = targetIdValue.trim();
  if (!/^[a-f0-9]{40}$/i.test(id)) throw new Error("A valid Fleet target ID is required");
  return transaction(async (client) => {
    const current = await client.query(
      `SELECT target_id,campaign_record_id,campaign_name,manager_customer_id,shard_id,enabled,archived_at
         FROM tah_campaign_targets WHERE target_id=$1 FOR UPDATE`,
      [id],
    );
    if (current.rowCount !== 1) throw new Error("Campaign target was not found");
    const target = current.rows[0];
    if (!archived) {
      const occupancy = await client.query(
        `SELECT count(*)::int AS count,
                min(NULLIF(manager_customer_id,'')) AS manager_customer_id,
                count(DISTINCT NULLIF(manager_customer_id,''))::int AS manager_count
           FROM tah_campaign_targets
          WHERE enabled AND archived_at IS NULL AND shard_id=$1 AND target_id<>$2`,
        [target.shard_id, id],
      );
      const occupied = Number(occupancy.rows[0]?.count || 0);
      const existingManager = String(occupancy.rows[0]?.manager_customer_id || "");
      const managerCount = Number(occupancy.rows[0]?.manager_count || 0);
      if (managerCount > 1 || (existingManager && existingManager !== String(target.manager_customer_id || ""))) {
        throw new Error(`Fleet shard ${target.shard_id} belongs to another MCC account`);
      }
      if (occupied >= SHARD_CAPACITY) throw new Error(`Fleet shard ${target.shard_id} is full`);
    }
    const updated = await client.query(
      `UPDATE tah_campaign_targets
          SET enabled=NOT $2,
              archived_at=CASE WHEN $2 THEN COALESCE(archived_at,now()) ELSE NULL END,
              updated_at=now()
        WHERE target_id=$1
        RETURNING target_id,campaign_record_id,campaign_name,shard_id,enabled,archived_at`,
      [id, archived],
    );
    if (archived) {
      await client.query(
        `UPDATE tah_delivery_jobs SET state='superseded',leased_at=NULL,leased_until=NULL,
           lease_token_hash=NULL,worker_id=NULL,updated_at=now()
         WHERE target_id=$1 AND state IN ('pending','failed','leased')`,
        [id],
      );
    }
    await client.query(
      `INSERT INTO tah_audit_log(actor_id,action,resource_type,resource_id,details)
       VALUES ('dashboard-session',$1,'fleet_target',$2,
               jsonb_build_object('campaign_record_id',$3::text,'campaign_name',$4::text,'shard_id',$5::text,'history_preserved',true))`,
      [archived ? "fleet.target.archived" : "fleet.target.restored", id, target.campaign_record_id, target.campaign_name, target.shard_id],
    );
    return updated.rows[0];
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
            (count(t.target_id) FILTER (WHERE t.enabled AND t.archived_at IS NULL))::int AS campaign_count,
            min(NULLIF(t.manager_customer_id,'')) FILTER (WHERE t.enabled AND t.archived_at IS NULL) AS manager_customer_id,
            ${SHARD_CAPACITY}::int AS capacity
       FROM shard_ids ids
       LEFT JOIN tah_script_shards s ON s.shard_id=ids.shard_id
       LEFT JOIN tah_campaign_targets t ON t.shard_id=ids.shard_id
      GROUP BY ids.shard_id,s.shard_id,s.enabled,s.last_poll_at,s.last_ack_at,s.last_error,s.updated_at
      ORDER BY ids.shard_id`,
  );
  return result.rows;
}

export async function closeBridgeStoreForTests() {
  const current = pool;
  pool = null;
  await current?.end();
}
