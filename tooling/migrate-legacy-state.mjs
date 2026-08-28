import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const apply = process.argv.includes("--apply");
const root = process.env.WORKSPACE_ROOT || process.cwd();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

function digits(value) { return String(value || "").replace(/\D/g, ""); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function first(object, keys) { for (const key of keys) if (object?.[key] !== undefined && object[key] !== null && object[key] !== "") return object[key]; return ""; }

const candidates = new Map();
function visit(value, inherited = {}) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) visit(item, inherited); return; }
  const object = value;
  const merged = { ...inherited, ...object };
  const customerId = digits(first(merged, ["googleAdsCustomerId", "customerId", "adsCustomerId"]));
  const googleCampaignId = digits(first(merged, ["googleAdsCampaignId", "googleCampaignId", "campaignGoogleId", "adsCampaignId"]));
  const campaignRecordId = String(first(merged, ["campaignRecordId", "savedCampaignId", "recordId", "id"]));
  if (customerId && googleCampaignId && campaignRecordId) {
    const suffix = String(first(merged, ["exactSuffix", "currentSuffix", "latestSuffix", "suffixCaptured", "desiredSuffix", "finalUrlSuffix", "suffix"]));
    const managerCustomerId = digits(first(merged, ["managerCustomerId", "loginCustomerId", "mccId"]));
    const key = `${managerCustomerId}:${customerId}:${googleCampaignId}`;
    candidates.set(key, {
      campaignRecordId,
      campaignName: String(first(merged, ["campaignName", "name"]) || campaignRecordId),
      managerCustomerId,
      customerId,
      googleCampaignId,
      shardId: String(first(merged, ["shardId", "fleetShardId"]) || "default"),
      suffix,
      version: Number(first(merged, ["lastMeshVersion", "meshQueuedVersion", "version"]) || 1),
    });
  }
  for (const child of Object.values(object)) visit(child, merged);
}

for (const relative of ["web/ads-state.json", "web/control-state.json", ".runtime/control-state.json", ".runtime/script-bridge-state.json"]) {
  try { visit(JSON.parse(await readFile(path.join(root, relative), "utf8"))); } catch { /* optional legacy source */ }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: process.env.TAH_DATABASE_SSL === "1" ? { rejectUnauthorized: process.env.TAH_DATABASE_SSL_REJECT_UNAUTHORIZED !== "0" } : undefined });
try {
  for (const table of ["tah_control_state", "tah_script_bridge_state"]) {
    try {
      const rows = await pool.query(`SELECT to_jsonb(source) AS value FROM ${table} source`);
      for (const row of rows.rows) visit(row.value);
    } catch { /* table or permissions may not exist */ }
  }

  process.stdout.write(`Discovered ${candidates.size} unique Google Ads targets\n`);
  if (!apply) {
    process.stdout.write("Dry run only. Re-run with --apply after reviewing the count.\n");
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const candidate of candidates.values()) {
        const targetId = hash(`${candidate.managerCustomerId}:${candidate.customerId}:${candidate.googleCampaignId}`).slice(0, 40);
        await client.query(
          `INSERT INTO tah_campaign_targets(target_id,campaign_record_id,campaign_name,manager_customer_id,customer_id,google_campaign_id,shard_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (campaign_record_id) DO UPDATE SET campaign_name=EXCLUDED.campaign_name,shard_id=EXCLUDED.shard_id,updated_at=now()`,
          [targetId, candidate.campaignRecordId, candidate.campaignName, candidate.managerCustomerId, candidate.customerId, candidate.googleCampaignId, candidate.shardId],
        );
        if (candidate.suffix || candidate.suffix === "") {
          let capture = await client.query(
            "SELECT capture_id FROM tah_suffix_captures WHERE target_id=$1 AND suffix_hash=$2 ORDER BY captured_at DESC LIMIT 1",
            [targetId, hash(candidate.suffix)],
          );
          if (!capture.rowCount) capture = await client.query(
            `INSERT INTO tah_suffix_captures(target_id,version,exact_suffix,suffix_hash,source_run_id)
             VALUES ($1,$2,$3,$4,'legacy-migration') ON CONFLICT DO NOTHING RETURNING capture_id`,
            [targetId, Number.isSafeInteger(candidate.version) ? candidate.version : 1, candidate.suffix, hash(candidate.suffix)],
          );
          if (capture.rowCount) await client.query("INSERT INTO tah_delivery_jobs(job_id,target_id,capture_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [randomUUID(), targetId, capture.rows[0].capture_id]);
        }
      }
      await client.query(
        `WITH legacy AS (
           SELECT item.key AS campaign_record_id,item.value AS applied
           FROM tah_script_bridge_state source
           CROSS JOIN LATERAL jsonb_each(source.payload->'applied') item
         ), matches AS (
           SELECT j.job_id,j.target_id,c.suffix_hash,COALESCE((legacy.applied->>'verifiedAt')::timestamptz,now()) AS verified_at
           FROM legacy
           JOIN tah_campaign_targets t ON t.campaign_record_id=legacy.campaign_record_id
           JOIN tah_suffix_captures c ON c.target_id=t.target_id AND c.exact_suffix=legacy.applied->>'suffix'
           JOIN tah_delivery_jobs j ON j.capture_id=c.capture_id
         )
         UPDATE tah_delivery_jobs j SET state='applied',applied_at=matches.verified_at,verified_suffix_hash=matches.suffix_hash,
           last_error=NULL,updated_at=now()
         FROM matches WHERE j.job_id=matches.job_id`,
      );
      await client.query(
        `WITH latest AS (
           SELECT DISTINCT ON (target_id) target_id,applied_at,verified_suffix_hash
           FROM tah_delivery_jobs WHERE state='applied' AND applied_at IS NOT NULL
           ORDER BY target_id,applied_at DESC
         )
         UPDATE tah_campaign_targets t SET last_applied_at=latest.applied_at,last_applied_suffix_hash=latest.verified_suffix_hash,updated_at=now()
         FROM latest WHERE latest.target_id=t.target_id`,
      );
      await client.query("COMMIT");
      process.stdout.write(`Migrated ${candidates.size} unique targets\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
} finally { await pool.end(); }
