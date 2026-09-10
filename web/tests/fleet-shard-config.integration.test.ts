import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.TAH_MCC_SHARD_TEST_DATABASE_URL;
test("MCC ownership and worker generation in an isolated database", { skip: !databaseUrl }, async (t) => {
  const url = new URL(databaseUrl!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "loopback test database only");
  assert.equal(url.pathname, "/mcc_shard_test", "dedicated database only; never production or staging");
  process.env.DATABASE_URL = databaseUrl!;
  delete process.env.TAH_DATABASE_SSL;
  const fleet = await import("../lib/script-bridge-store.ts");
  const db = new Pool({ connectionString: databaseUrl });
  const prefix = "mcc-test-" + randomUUID().slice(0, 8);
  const manager = "2345678901";
  const other = "9876543210";
  const input = (suffix: string, shardId: string, mcc = manager) => ({
    campaignRecordId: prefix + "-" + suffix, campaignName: "Isolated MCC fixture",
    customerId: "1234567890", googleCampaignId: "24" + String(suffix.charCodeAt(0)).padStart(9, "0"),
    managerCustomerId: mcc, shardId,
  });
  try {
    await t.test("empty custom shard retains explicit MCC and appears in status and manifest", async () => {
      const shard = await fleet.createBridgeShard(prefix + "-empty", "234-567-8901");
      assert.equal(shard.managerCustomerId, manager);
      assert.equal(await fleet.authenticateBridgeShard(shard.shardId, shard.token), true);
      assert.equal((await fleet.bridgeShardStatus()).find((row) => row.shard_id === shard.shardId)?.manager_customer_id, manager);
      assert.equal((await fleet.bridgeShardManifest(shard.shardId, { preview: true })).managerCustomerId, manager);
      await assert.rejects(fleet.createBridgeShard(shard.shardId, other), /different MCC/);
      await assert.rejects(fleet.createBridgeShard(shard.shardId, "invalid"), /MCC/);
      assert.equal(await fleet.authenticateBridgeShard(shard.shardId, shard.token), true, "rejected changes do not rotate the token");
      await assert.rejects(fleet.upsertBridgeTarget(input("a", shard.shardId, other)), /different MCC/);
    });
    await t.test("ownership survives paused and removed targets without changing historical suffixes", async () => {
      const shard = await fleet.createBridgeShard(prefix + "-history", manager);
      const target = await fleet.upsertBridgeTarget(input("b", shard.shardId));
      const before = await db.query("SELECT * FROM tah_campaign_targets WHERE target_id=$1", [target.targetId]);
      await db.query("INSERT INTO tah_suffix_captures(target_id,version,exact_suffix,suffix_hash" +
        (before.rows[0].enrollment_generation ? ",enrollment_generation,campaign_record_id,customer_id,google_campaign_id,manager_customer_id" : "") +
        ") VALUES($1,1,'im_ref=exact%2F&empty=','fixture'" +
        (before.rows[0].enrollment_generation ? ",$2,$3,$4,$5,$6" : "") + ")",
        before.rows[0].enrollment_generation ? [target.targetId, before.rows[0].enrollment_generation, before.rows[0].campaign_record_id, before.rows[0].customer_id, before.rows[0].google_campaign_id, manager] : [target.targetId]);
      await fleet.setBridgeTargetEnabled(input("b", shard.shardId).campaignRecordId, false);
      await assert.rejects(fleet.upsertBridgeTarget(input("c", shard.shardId, other)), /different MCC/);
      await fleet.setBridgeTargetEnabled(input("b", shard.shardId).campaignRecordId, true);
      const regenerated = await fleet.createBridgeShard(shard.shardId, manager);
      assert.equal(await fleet.authenticateBridgeShard(shard.shardId, regenerated.token), true);
      assert.equal(await fleet.authenticateBridgeShard(shard.shardId, shard.token), false);
      assert.equal((await db.query("SELECT exact_suffix FROM tah_suffix_captures WHERE target_id=$1", [target.targetId])).rows[0].exact_suffix, "im_ref=exact%2F&empty=");
      await fleet.deleteBridgeTarget({ campaignRecordId: input("b", shard.shardId).campaignRecordId });
      await assert.rejects(fleet.createBridgeShard(shard.shardId, other), /different MCC/);
    });
    await t.test("simultaneous MCC registrations have exactly one owner", async () => {
      const results = await Promise.allSettled([
        fleet.createBridgeShard(prefix + "-race", manager),
        fleet.createBridgeShard(prefix + "-race", other),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const winner = results.find((result) => result.status === "fulfilled");
      if (winner?.status === "fulfilled") assert.equal(await fleet.authenticateBridgeShard(winner.value.shardId, winner.value.token), true);
    });
    await t.test("enrollment racing with a different MCC's registration cannot mix ownership", async () => {
      const shard = prefix + "-enrollment-race";
      await Promise.allSettled([
        fleet.upsertBridgeTarget(input("d", shard)),
        fleet.createBridgeShard(shard, other),
      ]);
      const ownership = (await db.query("SELECT manager_customer_id FROM tah_fleet_shard_managers WHERE shard_id=$1", [shard])).rows[0];
      assert.ok(ownership);
      const targets = await db.query("SELECT manager_customer_id FROM tah_campaign_targets WHERE shard_id=$1", [shard]);
      assert.ok(targets.rows.every((row) => row.manager_customer_id === ownership.manager_customer_id));
    });
    await t.test("legacy registration can infer an already enrolled MCC", async () => {
      const shardId = prefix + "-legacy";
      await fleet.upsertBridgeTarget(input("e", shardId));
      await fleet.registerBridgeShard(shardId, randomUUID() + randomUUID());
      assert.equal((await fleet.bridgeShardManifest(shardId, { preview: true })).managerCustomerId, manager);
    });
  } finally {
    await db.end();
    await fleet.closeBridgeStoreForTests();
  }
});
