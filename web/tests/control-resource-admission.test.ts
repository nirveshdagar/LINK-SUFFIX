import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCampaignLaunchGapMs,
  evaluateResourceAdmission,
} from "../server/resource-admission.mjs";

test("campaign launches are distributed across the 58-second window", () => {
  assert.equal(computeCampaignLaunchGapMs(20, 58_000), 2_900);
  assert.equal(computeCampaignLaunchGapMs(100, 58_000), 580);
});

test("resource admission fails closed under memory or CPU pressure", () => {
  assert.equal(evaluateResourceAdmission({
    availableMemoryBytes: 20,
    totalMemoryBytes: 100,
    oneMinuteLoad: 4,
    cpuCount: 8,
  }).allowed, true);
  assert.deepEqual(evaluateResourceAdmission({
    availableMemoryBytes: 10,
    totalMemoryBytes: 100,
    oneMinuteLoad: 12,
    cpuCount: 8,
  }).reasons, ["memory", "load"]);
});
