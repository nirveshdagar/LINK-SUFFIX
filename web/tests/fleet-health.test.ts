import test from "node:test";
import assert from "node:assert/strict";
import {
  getCampaignHealth,
  getShardHealth,
  type FleetCampaignHealthInput,
  type FleetShardHealthInput,
} from "../lib/fleet-health.ts";

const now = Date.parse("2026-09-07T14:47:42Z");
const options = { now, staleAfterMs: 75 * 60 * 1000 };
const shard: FleetShardHealthInput = Object.freeze({
  enabled: true, registered: true, campaign_count: 7,
  last_poll_at: "2026-09-07T14:47:40Z", last_ack_at: "2026-09-07T14:41:18Z",
});
const healthy: FleetCampaignHealthInput = Object.freeze({
  enabled: true, delivery_health: "healthy", newest_update_state: "queued",
  latest_job_state: "pending", last_applied_at: "2026-09-07T14:41:18Z",
});
const alertOptions = { ...options, hasActiveAlert: true };

test("one delayed campaign cannot mark every worker in its shard unavailable", () => {
  const campaigns = Array.from({ length: 7 }, (_, index) => index === 6
    ? { ...healthy, delivery_health: "attention", newest_update_state: "delayed" }
    : healthy);
  const states = campaigns.map(campaign => getCampaignHealth(campaign, shard, alertOptions));
  assert.equal(states.filter(state => state.label === "Healthy").length, 6);
  assert.deepEqual(states[6], { label: "Delivery delayed", tone: "attention" });
  assert.equal(states.some(state => state.label === "Worker unavailable"), false);
  assert.deepEqual(getShardHealth(shard, alertOptions), { label: "Attention", tone: "attention" });
});

test("fresh worker remains healthy without aggregate alerts", () => {
  assert.deepEqual(getShardHealth(shard, options), { label: "Healthy", tone: "healthy" });
  assert.deepEqual(getCampaignHealth(healthy, shard, options), { label: "Healthy", tone: "healthy" });
});

test("generic shard error does not claim worker disconnection", () => {
  const state = { ...shard, last_error: "One target mutation failed" };
  assert.deepEqual(getShardHealth(state, options), { label: "Attention", tone: "attention" });
  assert.deepEqual(getCampaignHealth(healthy, state, options), { label: "Healthy", tone: "healthy" });
});

test("missing and unregistered workers remain unavailable even with old successful delivery", () => {
  for (const state of [undefined, { ...shard, registered: false }]) {
    assert.deepEqual(getShardHealth(state, alertOptions), { label: "No worker", tone: "attention" });
    assert.deepEqual(getCampaignHealth(healthy, state, alertOptions), { label: "No shard worker", tone: "attention" });
  }
});

test("paused campaigns and shards do not become failure alerts", () => {
  assert.deepEqual(getCampaignHealth({ ...healthy, enabled: false }, undefined, alertOptions),
    { label: "Paused", tone: "paused" });
  const paused = { ...shard, enabled: false };
  assert.deepEqual(getShardHealth(paused, alertOptions), { label: "Paused", tone: "paused" });
  assert.deepEqual(getCampaignHealth(healthy, paused, alertOptions), { label: "Shard paused", tone: "paused" });
});

test("missing or invalid first heartbeat is waiting, not a healthy or failed worker", () => {
  for (const last_poll_at of [undefined, null, "", "not-a-date"]) {
    const state = { ...shard, last_poll_at };
    assert.deepEqual(getShardHealth(state, alertOptions), { label: "Awaiting first run", tone: "waiting" });
    assert.deepEqual(getCampaignHealth(healthy, state, alertOptions), { label: "Awaiting first worker run", tone: "waiting" });
  }
});

test("genuinely stale polling still marks the worker unavailable with or without alerts", () => {
  const state = { ...shard, last_poll_at: new Date(now - options.staleAfterMs - 1).toISOString() };
  for (const settings of [options, alertOptions]) {
    assert.deepEqual(getShardHealth(state, settings), { label: "Worker stale", tone: "attention" });
    assert.deepEqual(getCampaignHealth(healthy, state, settings), { label: "Worker unavailable", tone: "attention" });
  }
});

test("existing staleness boundary is preserved exactly", () => {
  const state = { ...shard, last_poll_at: new Date(now - options.staleAfterMs).toISOString() };
  assert.equal(getCampaignHealth(healthy, state, options).label, "Healthy");
  assert.equal(getCampaignHealth(healthy, state, { ...options, now: now + 1 }).label, "Worker unavailable");
});

test("first verified delivery is distinct from polling connectivity", () => {
  const state = { ...shard, last_ack_at: null };
  assert.deepEqual(getShardHealth(state, options), { label: "Polling - no verified delivery", tone: "active" });
  assert.equal(getCampaignHealth({ enabled: true }, state, options).label, "Enrolled");
});

test("current campaign errors override historical healthy delivery", () => {
  for (const campaign of [
    { ...healthy, last_error: "Read-back mismatch" },
    { ...healthy, delivery_health: "attention" },
  ]) {
    assert.deepEqual(getCampaignHealth(campaign, shard, options), { label: "Attention", tone: "attention" });
  }
});

test("failed and dead jobs stay visible despite historical success", () => {
  for (const latest_job_state of ["failed", "dead"]) {
    assert.deepEqual(getCampaignHealth({ ...healthy, latest_job_state }, shard, options),
      { label: "Delivery failed", tone: "attention" });
  }
});

test("delayed and retrying updates stay visible despite historical success", () => {
  assert.deepEqual(getCampaignHealth({ ...healthy, newest_update_state: "delayed" }, shard, options),
    { label: "Delivery delayed", tone: "attention" });
  assert.deepEqual(getCampaignHealth({ ...healthy, newest_update_state: "retrying" }, shard, options),
    { label: "Delivery retrying", tone: "attention" });
});

test("unenrolled account readiness remains distinct from disconnected workers", () => {
  assert.equal(getCampaignHealth({ enabled: true, account_readiness: "waiting_for_manifest" }, shard, alertOptions).label,
    "Waiting for worker manifest");
  assert.equal(getCampaignHealth({ enabled: true, account_readiness: "waiting_for_account_poll" }, shard, alertOptions).label,
    "Waiting for account worker");
});

test("ordinary campaign delivery states remain intact", () => {
  for (const [latest_job_state, label] of [["leased", "Delivering"], ["pending", "Waiting"], ["applied", "Verified"]]) {
    assert.equal(getCampaignHealth({ enabled: true, latest_job_state }, shard, alertOptions).label, label);
  }
  assert.equal(getCampaignHealth({ enabled: true }, shard, alertOptions).label, "Enrolled");
});

test("clearing an alert changes the shard summary without changing healthy campaign status", () => {
  assert.equal(getShardHealth(shard, alertOptions).label, "Attention");
  assert.equal(getShardHealth(shard, options).label, "Healthy");
  assert.deepEqual(getCampaignHealth(healthy, shard, alertOptions), getCampaignHealth(healthy, shard, options));
});

test("status calculation does not mutate campaign or shard settings", () => {
  const before = JSON.stringify({ healthy, shard, options });
  for (let i = 0; i < 100; i++) {
    getShardHealth(shard, alertOptions);
    getCampaignHealth(healthy, shard, alertOptions);
  }
  assert.equal(JSON.stringify({ healthy, shard, options }), before);
});
