import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  acknowledgeBridgeJob,
  bridgeShardManifest,
  bridgeShardStatus,
  closeBridgeStoreForTests,
  enqueueBridgeCapture,
  leaseBridgeJobs,
  queueLatestBridgeCapture,
  registerBridgeShard,
  upsertBridgeTarget,
} from "../lib/script-bridge-store.ts";

const enabled = Boolean(process.env.DATABASE_URL);

test("relational Fleet leases one unique target and verifies the exact suffix", { skip: !enabled }, async () => {
  const suffix = "a=%2f&a=three%20words&empty=";
  const discriminator = String(Date.now()).slice(-8);
  const campaignRecordId = `integration-${randomUUID()}`;
  const managerCustomerId = `1${discriminator}0`;
  const shardId = `mcc-${managerCustomerId}-001`;
  const token = `integration-token-${randomUUID()}`;
  const customerId = `90${discriminator}`;
  const campaignId = `8${discriminator}`;
  const input = { campaignRecordId, campaignName: "Integration campaign", managerCustomerId, customerId, googleCampaignId: campaignId, shardId };
  const { Pool } = pg;
  try {
    await registerBridgeShard(shardId, token);
    await enqueueBridgeCapture({ ...input, exactSuffix: suffix, version: Date.now() });
    await assert.rejects(() => upsertBridgeTarget({ ...input, campaignRecordId: `${campaignRecordId}-duplicate` }), /already owns/i);
    const manifest = await bridgeShardManifest(shardId);
    assert.equal(manifest.managerCustomerId, managerCustomerId);
    assert.deepEqual(manifest.accountIds, [customerId]);
    assert.equal(manifest.campaignCount, 1);
    assert.equal(manifest.capacity, 40);
    assert.equal((await leaseBridgeJobs(shardId, "integration-worker-wrong-account", 10, "9999999999")).length, 0);
    assert.equal((await queueLatestBridgeCapture(campaignRecordId)).state, "pending");
    const jobs = await leaseBridgeJobs(shardId, "integration-worker", 10, customerId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].exactSuffix, suffix);
    const ack = await acknowledgeBridgeJob({ shardId, workerId: "integration-worker", jobId: jobs[0].jobId, leaseToken: jobs[0].leaseToken, ok: true, appliedSuffix: suffix });
    assert.deepEqual(ack, { ok: true, state: "applied" });
    await enqueueBridgeCapture({ ...input, exactSuffix: "new=value", version: Date.now() + 1 });
    assert.equal((await leaseBridgeJobs(shardId, "integration-worker", 10)).length, 0, "58-second server gate must block an immediate second delivery");
    for (let index = 1; index < 40; index++) {
      const assignment = await upsertBridgeTarget({
        ...input,
        campaignRecordId: `${campaignRecordId}-fill-${index}`,
        campaignName: `Integration fill ${index}`,
        customerId: String(7_000_000_000 + index),
        googleCampaignId: String(8_000_000_000 + index),
      });
      assert.equal(assignment.shardId, shardId);
    }
    const overflow = await upsertBridgeTarget({
      ...input,
      campaignRecordId: `${campaignRecordId}-overflow`,
      campaignName: "Integration overflow",
      customerId: "7999999999",
      googleCampaignId: "8999999999",
    });
    assert.equal(overflow.shardId, `mcc-${managerCustomerId}-002`);
    const rolloverStatus = await bridgeShardStatus();
    assert.equal(rolloverStatus.find((item) => item.shard_id === overflow.shardId)?.registered, false);
  } finally {
    await closeBridgeStoreForTests();
    if (process.env.DATABASE_URL) {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query("DELETE FROM tah_campaign_targets WHERE campaign_record_id LIKE 'integration-%'");
      await pool.query("DELETE FROM tah_script_shards WHERE shard_id LIKE $1", [`mcc-${managerCustomerId}-%`]);
      await pool.end();
    }
  }
});
