import assert from "node:assert/strict";
import test from "node:test";

import { planCapacity } from "../lib/capacity-planner.ts";

test("current capacity distinguishes managed queue from 500-way browser parallelism", () => {
  const plan = planCapacity({ tunnelMode: "quick" });

  assert.equal(plan.input.campaigns, 500);
  assert.equal(plan.browser.admittedConcurrentCampaigns, 8);
  assert.equal(plan.browser.queuedCampaigns, 492);
  assert.equal(plan.browser.workerShortfall, 492);
  assert.equal(plan.browser.gatewayPortShortfall, 396);
  assert.equal(plan.browser.trueParallelReady, false);
  assert.equal(plan.managedQueueReady, true);
});

test("500-campaign Fleet model uses worst-case 58-second arrivals and safe headroom", () => {
  const plan = planCapacity();

  assert.equal(plan.fleet.baseShardCount, 13);
  assert.equal(plan.fleet.configuredShardCount, 13);
  assert.equal(plan.fleet.recommendedShardCount, 18);
  assert.equal(plan.fleet.recommendedCampaignsPerShard, 28);
  assert.ok(Math.abs(plan.fleet.arrivalRatePerSecond - 8.6207) < 0.0001);
  assert.ok(Math.abs(plan.fleet.effectiveServiceRatePerSecond - 9.7067) < 0.0001);
  assert.ok(Math.abs(plan.fleet.utilization - 0.8881) < 0.0001);
  assert.equal(plan.fleet.stableForNewestValue, true);
  assert.equal(plan.fleet.safetyHeadroomReady, false);
  assert.equal(plan.fleet.everyCaptureMathematicallyPossible, false);
});

test("measured production-sized configuration passes every modeled gate", () => {
  const plan = planCapacity({
    browserWorkers: 500,
    dedicatedGatewayPorts: 500,
    configuredShardCount: 18,
    fleetActiveSecondsPerHour: 3_600,
    tunnelMode: "named",
    measuredBrowserMemoryMb: 140,
    availableMemoryMb: 128_000,
    availableNetworkMbps: 1_000,
    measuredDatabaseWritesPerSecond: 100,
    soakTestHours: 72,
  });

  assert.equal(plan.browser.trueParallelReady, true);
  assert.equal(plan.fleet.safetyHeadroomReady, true);
  assert.equal(plan.fleet.googleFanoutReady, true);
  assert.equal(plan.fleet.shardExecutionQuotaReady, true);
  assert.equal(plan.infrastructure.memoryMeasuredAndReady, true);
  assert.equal(plan.infrastructure.networkMeasuredAndReady, true);
  assert.equal(plan.infrastructure.databaseMeasuredAndReady, true);
  assert.equal(plan.productionReadyForLatestValue, true);
  assert.equal(plan.productionReadyForEveryCapture, true);
});

test("capacity gate rejects shard fan-out above the Google planning limit", () => {
  const plan = planCapacity({ campaignsPerShard: 51, configuredShardCount: 10 });

  assert.equal(plan.fleet.googleFanoutReady, false);
  assert.equal(plan.fleet.stableForNewestValue, false);
});

test("capacity gate rejects a misleading utilization target", () => {
  assert.throws(
    () => planCapacity({ targetMaxUtilization: 1 }),
    /targetMaxUtilization must be greater than 0 and less than 1/,
  );
});
