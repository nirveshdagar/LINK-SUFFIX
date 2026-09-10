import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.TAH_SHARD_RETIREMENT_TEST_DATABASE_URL;
test("safe shard deletion in an isolated database", { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "loopback test database only");
  assert.equal(url.pathname, "/shard_retirement_test", "dedicated disposable database only");
  process.env.DATABASE_URL = databaseUrl!;
  delete process.env.TAH_DATABASE_SSL;
  const fleet = await import("../lib/script-bridge-store.ts");
  const db = new Pool({ connectionString: databaseUrl });
  const prefix = "retire-test-" + randomUUID().slice(0, 8);
  const manager = "2345678901";
  let ordinal = 0;
  const input = (shardId: string, mcc = manager) => ({
    campaignRecordId: prefix + "-" + (++ordinal), campaignName: "Isolated shard fixture",
    customerId: "1234567890", googleCampaignId: "24" + String(ordinal).padStart(9, "0"),
    managerCustomerId: mcc, shardId,
  });
  const create = (name: string) => fleet.createBridgeShard(prefix + "-" + name, manager);
  const conflict = (error: unknown) => {
    assert.equal((error as { code?: string }).code, "FLEET_SHARD_CONFLICT");
    return true;
  };
  try {
    await t.test("confirmation is exact, deletion is idempotent, and tokens and names stay revoked", async () => {
      const shard = await create("empty");
      await assert.rejects(fleet.deleteBridgeShard(shard.shardId, "wrong"), /confirmation/);
      assert.equal(await fleet.authenticateBridgeShard(shard.shardId, shard.token), true);
      assert.equal((await fleet.deleteBridgeShard(shard.shardId, shard.shardId)).alreadyDeleted, false);
      assert.equal((await fleet.deleteBridgeShard(shard.shardId, shard.shardId)).alreadyDeleted, true);
      assert.equal(await fleet.authenticateBridgeShard(shard.shardId, shard.token), false);
      assert.equal((await fleet.bridgeShardStatus()).some((row) => row.shard_id === shard.shardId), false);
      await assert.rejects(fleet.createBridgeShard(shard.shardId, manager), conflict);
      await assert.rejects(fleet.registerBridgeShard(shard.shardId, randomUUID() + randomUUID(), manager), conflict);
      await assert.rejects(fleet.upsertBridgeTarget(input(shard.shardId)), conflict);
      await assert.rejects(fleet.bridgeShardManifest(shard.shardId, { preview: true }), /disabled/);
      await assert.rejects(fleet.leaseBridgeJobs(shard.shardId, "stale-worker"), conflict);
      const legacyImport: unknown = Reflect.get(fleet, "importLegacyBridgeShard");
      if (typeof legacyImport === "function") assert.equal(await legacyImport(shard.shardId, shard.token), false);
      const audit = await db.query("SELECT details FROM tah_audit_log WHERE action='fleet.shard.deleted' AND resource_id=$1", [shard.shardId]);
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].details.worker_token_revoked, true);
    });

    await t.test("active and paused assignments both prevent deletion", async () => {
      const shard = await create("assigned");
      const campaign = input(shard.shardId);
      await fleet.upsertBridgeTarget(campaign);
      await assert.rejects(fleet.deleteBridgeShard(shard.shardId, shard.shardId), conflict);
      await fleet.setBridgeTargetEnabled(campaign.campaignRecordId, false);
      const status = (await fleet.bridgeShardStatus()).find((row) => row.shard_id === shard.shardId);
      assert.equal(status.campaign_count, 0);
      assert.equal(status.assigned_campaign_count, 1);
      await assert.rejects(fleet.deleteBridgeShard(shard.shardId, shard.shardId), conflict);
      assert.equal(await fleet.authenticateBridgeShard(shard.shardId, shard.token), true);
    });

    await t.test("running executions and recently polling legacy workers prevent deletion", async () => {
      const shard = await create("running");
      await db.query("UPDATE tah_script_shards SET last_execution_started_at=now(),last_execution_status='running',hard_stop_at=now()+interval '20 minutes' WHERE shard_id=$1", [shard.shardId]);
      await assert.rejects(fleet.deleteBridgeShard(shard.shardId, shard.shardId), conflict);
      await db.query("UPDATE tah_script_shards SET last_execution_started_at=NULL,hard_stop_at=NULL,last_poll_at=now() WHERE shard_id=$1", [shard.shardId]);
      await assert.rejects(fleet.deleteBridgeShard(shard.shardId, shard.shardId), conflict);
      await db.query("UPDATE tah_script_shards SET last_poll_at=now()-interval '66 minutes' WHERE shard_id=$1", [shard.shardId]);
      assert.equal((await fleet.deleteBridgeShard(shard.shardId, shard.shardId)).deleted, true);
    });

    await t.test("v12 invocation fences are honored independently of summary state", async () => {
      if (!(await db.query("SELECT to_regclass('tah_fleet_invocations') AS name")).rows[0].name) return;
      const shard = await create("invocation");
      await fleet.bridgeShardManifest(shard.shardId, { adaptive: true, invocationId: randomUUID() });
      await db.query("UPDATE tah_script_shards SET last_execution_status='completed',last_execution_completed_at=now() WHERE shard_id=$1", [shard.shardId]);
      await assert.rejects(fleet.deleteBridgeShard(shard.shardId, shard.shardId), conflict);
      await db.query("UPDATE tah_fleet_invocations SET status='completed',completed_at=now() WHERE shard_id=$1", [shard.shardId]);
      assert.equal((await fleet.deleteBridgeShard(shard.shardId, shard.shardId)).deleted, true);
    });

    await t.test("delivery leases retain their originating shard after a move and history survives deletion", async () => {
      const old = await create("old");
      const next = await create("next");
      const campaign = input(old.shardId);
      const enrollment = await fleet.upsertBridgeTarget(campaign);
      const capture = await fleet.enqueueBridgeCapture({ ...campaign, ...enrollment, exactSuffix: "im_ref=retirement%2Ffixture&empty=", version: Date.now() });
      const leases = await fleet.leaseBridgeJobs(old.shardId, "isolated-worker", 1);
      assert.equal(leases.length, 1);
      const job = (await db.query("SELECT * FROM tah_delivery_jobs WHERE job_id=$1", [leases[0].jobId])).rows[0];
      assert.equal(job.lease_shard_id, old.shardId);
      await fleet.upsertBridgeTarget({ ...campaign, shardId: next.shardId });
      await assert.rejects(fleet.deleteBridgeShard(old.shardId, old.shardId), /active delivery lease/);
      await db.query("UPDATE tah_delivery_jobs SET leased_until=now()-interval '1 second' WHERE job_id=$1", [leases[0].jobId]);
      await db.query("UPDATE tah_script_shards SET last_poll_at=NULL WHERE shard_id=$1", [old.shardId]);
      const before = (await db.query("SELECT * FROM tah_suffix_captures WHERE capture_id=$1", [capture.captureId])).rows;
      assert.equal((await fleet.deleteBridgeShard(old.shardId, old.shardId)).historyPreserved, true);
      assert.deepEqual((await db.query("SELECT * FROM tah_suffix_captures WHERE capture_id=$1", [capture.captureId])).rows, before);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM tah_delivery_jobs WHERE job_id=$1", [leases[0].jobId])).rows[0].n, 1);
      assert.equal(await fleet.authenticateBridgeShard(next.shardId, next.token), true);
    });

    await t.test("automatic enrollment skips a deleted default shard name", async () => {
      const mcc = "3456789012";
      const id = "mcc-" + mcc + "-001";
      await fleet.createBridgeShard(id, mcc);
      await fleet.deleteBridgeShard(id, id);
      const target = await fleet.upsertBridgeTarget(input("default", mcc));
      assert.equal(target.shardId, "mcc-" + mcc + "-002");
    });

    await t.test("concurrent enrollment and deletion cannot leave a campaign on a deleted shard", async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const shard = await create("race-" + attempt);
        const results = await Promise.allSettled([
          fleet.deleteBridgeShard(shard.shardId, shard.shardId),
          fleet.upsertBridgeTarget(input(shard.shardId)),
        ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        const state = (await db.query(
          "SELECT s.deleted_at,count(t.target_id) FILTER(WHERE t.archived_at IS NULL)::int AS assignments FROM tah_script_shards s LEFT JOIN tah_campaign_targets t USING(shard_id) WHERE s.shard_id=$1 GROUP BY s.shard_id", [shard.shardId],
        )).rows[0];
        assert.ok(!state.deleted_at || state.assignments === 0);
      }
    });
    await t.test("current shard alerts clear while historical audit data remains", async () => {
      await db.query("\nCREATE TABLE IF NOT EXISTS tah_health_alerts (\n  fingerprint TEXT PRIMARY KEY,\n  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),\n  status TEXT NOT NULL CHECK (status IN ('observing', 'active', 'acknowledged', 'resolved')),\n  component TEXT NOT NULL,\n  scope TEXT NOT NULL DEFAULT 'system',\n  code TEXT NOT NULL,\n  title TEXT NOT NULL,\n  message TEXT NOT NULL,\n  remediation TEXT NOT NULL DEFAULT '',\n  campaign_record_id TEXT,\n  shard_id TEXT,\n  details JSONB NOT NULL DEFAULT '{}'::jsonb,\n  activation_after_ms INTEGER NOT NULL DEFAULT 0,\n  occurrence_count BIGINT NOT NULL DEFAULT 1,\n  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n  opened_at TIMESTAMPTZ,\n  acknowledged_at TIMESTAMPTZ,\n  acknowledged_by TEXT,\n  resolved_at TIMESTAMPTZ,\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);\nCREATE INDEX IF NOT EXISTS tah_health_alerts_open_idx ON tah_health_alerts (severity, status, last_seen_at DESC) WHERE status <> 'resolved';\nCREATE INDEX IF NOT EXISTS tah_health_alerts_campaign_idx ON tah_health_alerts (campaign_record_id, last_seen_at DESC) WHERE campaign_record_id IS NOT NULL;\nCREATE INDEX IF NOT EXISTS tah_health_alerts_shard_idx ON tah_health_alerts (shard_id, last_seen_at DESC) WHERE shard_id IS NOT NULL;\nCREATE TABLE IF NOT EXISTS tah_component_heartbeats (\n  component_id TEXT PRIMARY KEY,\n  component_type TEXT NOT NULL,\n  state TEXT NOT NULL CHECK (state IN ('healthy', 'warning', 'critical')),\n  message TEXT NOT NULL DEFAULT '',\n  latency_ms INTEGER,\n  details JSONB NOT NULL DEFAULT '{}'::jsonb,\n  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);\nCREATE INDEX IF NOT EXISTS tah_component_heartbeats_state_idx ON tah_component_heartbeats (state, last_seen_at DESC);\nALTER TABLE IF EXISTS tah_natural_click_journey_states\n  ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0;\nALTER TABLE IF EXISTS tah_natural_click_journey_states\n  ADD COLUMN IF NOT EXISTS recovery_action text;\nALTER TABLE IF EXISTS tah_natural_click_journey_states\n  ADD COLUMN IF NOT EXISTS next_recovery_at timestamptz;\nALTER TABLE IF EXISTS tah_natural_click_journey_states\n  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;\n");
      const shard = await create("health");
      await db.query("INSERT INTO tah_health_alerts(fingerprint,severity,status,component,scope,code,title,message,shard_id) VALUES($1,'warning','active',$1,'script-fleet','offline','Fixture','Fixture',$1)", [shard.shardId]);
      await db.query("INSERT INTO tah_component_heartbeats(component_id,component_type,state) VALUES($1,'apps-script-shard','critical')", ["shard:" + shard.shardId]);
      await fleet.deleteBridgeShard(shard.shardId, shard.shardId);
      assert.equal((await db.query("SELECT status FROM tah_health_alerts WHERE fingerprint=$1", [shard.shardId])).rows[0].status, "resolved");
      assert.equal((await db.query("SELECT * FROM tah_component_heartbeats WHERE component_id=$1", ["shard:" + shard.shardId])).rowCount, 0);
    });
  } finally {
    await db.end();
    await fleet.closeBridgeStoreForTests();
  }
});
