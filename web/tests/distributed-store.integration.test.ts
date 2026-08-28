import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createDistributedControlStore } from "../server/distributed-store.mjs";

test("fenced control leadership rejects a stale writer", { skip: !process.env.DATABASE_URL }, async () => {
  const key = `integration-${randomUUID()}`;
  const leaseName = `${key}-lease`;
  const stateName = `${key}-state`;
  const documentName = `${key}-campaigns`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const common = { databaseUrl: process.env.DATABASE_URL, redisUrl: process.env.REDIS_URL, leaseName, stateName };
  const first = await createDistributedControlStore({ ...common, instanceId: `${key}-first` });
  const second = await createDistributedControlStore({ ...common, instanceId: `${key}-second` });
  try {
    assert.equal(await first.acquireLeader(30_000), true);
    assert.equal(await second.acquireLeader(30_000), false);
    await first.saveState(documentName, [{ owner: "first" }]);
    await pool.query("UPDATE tah_leader_leases SET expires_at = NOW() - INTERVAL '1 second' WHERE lease_name = $1", [leaseName]);
    assert.equal(await second.acquireLeader(30_000), true);
    await second.saveState(documentName, [{ owner: "second" }]);
    await assert.rejects(() => first.saveState(documentName, [{ owner: "stale" }]), /leadership was lost/i);
    assert.deepEqual(await second.loadState(documentName), [{ owner: "second" }]);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
    await pool.query("DELETE FROM tah_control_state WHERE name = ANY($1)", [[stateName, documentName]]).catch(() => {});
    await pool.query("DELETE FROM tah_leader_leases WHERE lease_name = $1", [leaseName]).catch(() => {});
    await pool.end();
  }
});
