import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

const baseUrl = process.env.TAH_SHARD_RETIREMENT_HTTP_BASE_URL;
test("shard retirement over the real HTTP API in a disposable release canary", { skip: !baseUrl }, async () => {
  const origin = new URL(baseUrl);
  assert.equal(origin.protocol, "http:");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "HTTP canary must be loopback");
  assert.equal(process.env.TAH_SHARD_RETIREMENT_DISPOSABLE_CANARY, "1", "explicit disposable canary opt-in required");
  const connectionString = process.env.DATABASE_URL;
  const database = new URL(connectionString);
  assert.equal(database.pathname, "/shard_retirement_test", "dedicated disposable database required");
  assert.ok(["127.0.0.1", "localhost", "[::1]", "tah-shard-retirement-canary-db"].includes(database.hostname), "only the isolated canary database is allowed");
  const token = process.env.TAH_API_BEARER_TOKEN;
  assert.ok(token && token.length >= 24, "explicit canary control token required");
  const db = new Pool({ connectionString });
  const base = new URL("/api/script-bridge", origin).href;
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
  const prefix = "retirement-http-" + randomUUID().slice(0, 8);
  const customerId = String(1000000000 + parseInt(randomUUID().replaceAll("-", "").slice(0, 7), 16));
  async function post(body, authenticated = true) {
    const response = await fetch(base, {
      method: "POST", headers: authenticated ? headers : { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function jobs(shardId, workerToken, protocol, method = "GET", action = "poll") {
    const input = { shardId, protocol, contract: "relational-lease-v2", manifest: "1", preview: "1", action };
    const url = base + "/jobs" + (method === "GET" ? "?" + new URLSearchParams(input) : "");
    const response = await fetch(url, {
      method, headers: { authorization: "Bearer " + workerToken, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    const config = { action: "generate-worker", shardId: prefix + "-empty", managerCustomerId: "234-567-8901", publicBaseUrl: "https://canary.example.invalid" };
    const created = await post(config);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const protocol = created.body.script.includes("fleet-two-phase-fenced-relay-v12")
      ? "fleet-two-phase-fenced-relay-v12" : "fleet-two-phase-resilient-relay-v11";
    assert.ok(created.body.script.includes(protocol));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM tah_script_shards WHERE shard_id=$1", [config.shardId])).rows[0].n, 1, "HTTP service and fixture database must match");
    assert.equal((await jobs(config.shardId, created.body.token, protocol)).status, 200, "valid worker can preview before deletion");
    const remove = { action: "delete-shard", shardId: config.shardId, confirmedShardId: config.shardId };
    const unauthenticated = await post(remove, false);
    assert.ok([401, 403].includes(unauthenticated.status));
    assert.equal((await post({ ...remove, confirmedShardId: "wrong" })).status, 400);
    const deleted = await post(remove);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.historyPreserved, true);
    assert.equal((await post(config)).status, 409, "deleted names cannot be registered again");
    assert.equal((await post(remove)).body.alreadyDeleted, true);

    const rejected = await jobs(config.shardId, created.body.token, protocol);
    assert.equal(rejected.status, 401, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, /Invalid shard credentials/);
    for (const action of ["poll", "window", "complete", "renew", "ack"]) {
      const response = await jobs(config.shardId, created.body.token, protocol, "POST", action);
      assert.equal(response.status, 401, action + ": " + JSON.stringify(response.body));
    }
    const outdated = await fetch(base + "/jobs?shardId=" + encodeURIComponent(config.shardId), {
      headers: { authorization: "Bearer " + created.body.token }, signal: AbortSignal.timeout(15000),
    });
    assert.equal(outdated.status, 409, "missing worker protocol/contract is a protocol conflict, not an authentication test");

    const status = await fetch(base, { headers, signal: AbortSignal.timeout(15000) });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).shards.some((shard) => shard.shard_id === config.shardId), false);
    const assigned = await post({ ...config, shardId: prefix + "-assigned" });
    assert.equal(assigned.status, 200);
    const enrollment = { action: "register-target", campaignRecordId: prefix + "-campaign", campaignName: "Disposable shard fixture",
      customerId, googleCampaignId: "24" + customerId, managerCustomerId: "2345678901", shardId: prefix + "-assigned" };
    assert.equal((await post(enrollment)).status, 201);
    const block = { ...remove, shardId: enrollment.shardId, confirmedShardId: enrollment.shardId };
    assert.equal((await post(block)).status, 409);
    assert.equal((await post({ action: "set-enabled", campaignRecordId: enrollment.campaignRecordId, enabled: false })).status, 200);
    assert.equal((await post(block)).status, 409, "paused assignments also block deletion");
    const paused = await fetch(base, { headers, signal: AbortSignal.timeout(15000) });
    assert.equal((await paused.json()).shards.find((shard) => shard.shard_id === enrollment.shardId).assigned_campaign_count, 1);
    const running = await post({ ...config, shardId: prefix + "-running" });
    assert.equal(running.status, 200);
    await db.query("UPDATE tah_script_shards SET last_execution_started_at=now(),last_execution_status='running',hard_stop_at=now()+interval '15 minutes' WHERE shard_id=$1", [prefix + "-running"]);
    assert.equal((await post({ ...remove, shardId: prefix + "-running", confirmedShardId: prefix + "-running" })).status, 409);
    console.log("PASS: real worker requests receive 401 after deletion; protocol conflicts remain 409; assignment and execution guards pass.");
  } finally {
    await db.end();
  }
});
