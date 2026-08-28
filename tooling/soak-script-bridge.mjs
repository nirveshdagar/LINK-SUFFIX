import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  acknowledgeBridgeJob,
  closeBridgeStoreForTests,
  enqueueBridgeCapture,
  leaseBridgeJobs,
  registerBridgeShard,
  upsertBridgeTarget,
} from "../web/lib/script-bridge-store.ts";

const count = Math.min(5_000, Math.max(1, Number(process.env.TAH_SOAK_CAMPAIGNS || 2_000)));
const concurrency = Math.min(50, Math.max(1, Number(process.env.TAH_SOAK_CONCURRENCY || 20)));
const runKey = `soak-${randomUUID()}`;
const shardId = `${runKey}-shard`;
const workerId = `${runKey}-worker`;
const token = randomBytes(32).toString("base64url");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

const indexes = Array.from({ length: count }, (_, index) => index);
const startedAt = Date.now();
let leasedCount = 0;
const leasedIds = new Set();

try {
  await registerBridgeShard(shardId, token);
  await mapLimit(indexes, concurrency, async (index) => {
    const suffix = `campaign=${index}&nonce=${runKey}`;
    const target = {
      campaignRecordId: `${runKey}-campaign-${index}`,
      campaignName: `Soak campaign ${index}`,
      managerCustomerId: "9000000000",
      customerId: String(7000000000 + index),
      googleCampaignId: String(20_000_000_000 + index),
      shardId,
    };
    await upsertBridgeTarget(target);
    await enqueueBridgeCapture({
      ...target,
      exactSuffix: suffix,
      version: Date.now() * 10_000 + index,
      sourceRunId: runKey,
    });
  });

  for (;;) {
    const jobs = await leaseBridgeJobs(shardId, workerId, 100);
    if (!jobs.length) break;
    for (const job of jobs) {
      if (leasedIds.has(job.jobId)) throw new Error(`Job ${job.jobId} was leased more than once`);
      leasedIds.add(job.jobId);
      if (!job.exactSuffix.endsWith(`nonce=${runKey}`)) throw new Error("Leased suffix changed during persistence");
      await acknowledgeBridgeJob({
        shardId,
        workerId,
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        ok: true,
        appliedSuffix: job.exactSuffix,
      });
      leasedCount++;
    }
  }

  if (leasedCount !== count) throw new Error(`Expected ${count} acknowledgements, received ${leasedCount}`);
  const state = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE job.state = 'applied')::int AS applied,
       COUNT(DISTINCT job.job_id)::int AS unique_jobs,
       COUNT(*) FILTER (WHERE capture.exact_suffix <> ('campaign=' || split_part(target.campaign_record_id, '-campaign-', 2) || '&nonce=' || $1))::int AS altered
     FROM tah_campaign_targets target
     JOIN tah_suffix_captures capture ON capture.target_id = target.target_id
     JOIN tah_delivery_jobs job ON job.capture_id = capture.capture_id
     WHERE target.campaign_record_id LIKE $2`,
    [runKey, `${runKey}-campaign-%`],
  );
  const row = state.rows[0];
  if (row.applied !== count || row.unique_jobs !== count || row.altered !== 0) {
    throw new Error(`Soak verification failed: ${JSON.stringify(row)}`);
  }
  console.log(JSON.stringify({
    campaigns: count,
    applied: row.applied,
    duplicateLeases: leasedCount - leasedIds.size,
    alteredSuffixes: row.altered,
    elapsedMs: Date.now() - startedAt,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  }));
} finally {
  await pool.query(
    `DELETE FROM tah_delivery_jobs WHERE target_id IN (SELECT target_id FROM tah_campaign_targets WHERE campaign_record_id LIKE $1)`,
    [`${runKey}-campaign-%`],
  ).catch(() => {});
  await pool.query(
    `DELETE FROM tah_suffix_captures WHERE target_id IN (SELECT target_id FROM tah_campaign_targets WHERE campaign_record_id LIKE $1)`,
    [`${runKey}-campaign-%`],
  ).catch(() => {});
  await pool.query("DELETE FROM tah_campaign_targets WHERE campaign_record_id LIKE $1", [`${runKey}-campaign-%`]).catch(() => {});
  await pool.query("DELETE FROM tah_script_shards WHERE shard_id = $1", [shardId]).catch(() => {});
  await pool.end();
  await closeBridgeStoreForTests();
}
