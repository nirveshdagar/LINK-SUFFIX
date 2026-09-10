import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { normalizeFleetManagerId, normalizeFleetShardId } from "../lib/fleet-shard-config.ts";
import { buildRelationalFleetV11Worker } from "../lib/relational-fleet-worker.ts";

test("any valid MCC is accepted without depending on the shard name", () => {
  for (const value of ["2345678901", "234-567-8901", " 234 567 8901 "]) assert.equal(normalizeFleetManagerId(value), "2345678901");
  for (const name of ["us-retail-01", "Team_A:Europe.2", "another-manager"]) assert.equal(normalizeFleetShardId(name), name);
  assert.equal(normalizeFleetManagerId("0000000001"), "0000000001");
});
test("invalid MCC and script-injection shard names are rejected", () => {
  for (const value of ["", "1234", "12345678901", "MCC2345678901", "234/567/8901"]) assert.throws(() => normalizeFleetManagerId(value), /MCC/);
  for (const value of ["", "../escape", "x*/ throw 1", "space here", "x".repeat(81)]) {
    assert.throws(() => buildRelationalFleetV11Worker("https://example.invalid/jobs", "test-token", value, "2345678901"), /shard/i);
  }
  assert.throws(() => buildRelationalFleetV11Worker("https://example.invalid/jobs", "test-token", "custom", "bad"), /MCC/);
});
test("generated worker keeps custom shard identity and formatted MCC", () => {
  const context = vm.createContext({});
  vm.runInContext(buildRelationalFleetV11Worker("https://example.invalid/jobs", "test-token", "Team_A:Europe.2", "234-567-8901"), context);
  assert.equal(vm.runInContext("CONFIG.SHARD_ID", context), "Team_A:Europe.2");
  assert.equal(vm.runInContext("CONFIG.MANAGER_CUSTOMER_ID", context), "2345678901");
});
test("wrong MCC stops before heartbeat, preview, network access or mutation", () => {
  let requests = 0;
  const context = vm.createContext({
    AdsApp: { currentAccount: () => ({ getCustomerId: () => "987-654-3210" }) },
    UrlFetchApp: { fetch: () => { requests++; throw new Error("must not call"); } },
  });
  vm.runInContext(buildRelationalFleetV11Worker("https://example.invalid/jobs", "test-token", "my-shard", "2345678901"), context);
  assert.throws(() => vm.runInContext("main()", context), /for MCC 2345678901.*9876543210/);
  assert.equal(requests, 0);
});
test("correct MCC can preview without leasing a campaign", () => {
  const context = vm.createContext({
    AdsApp: {
      currentAccount: () => ({ getCustomerId: () => "234-567-8901" }),
      getExecutionInfo: () => ({ isPreview: () => true }),
    },
    Utilities: { getUuid: () => "test-invocation" },
    Logger: { log() {} },
  });
  vm.runInContext(buildRelationalFleetV11Worker("https://example.invalid/jobs", "test-token", "my-shard", "2345678901"), context);
  vm.runInContext('fetchManifest_ = function () { return {campaignCount:0, accountIds:[], managerCustomerId:"2345678901"}; }; main();', context);
});
test("legacy three-argument generator stays compatible", () => {
  const context = vm.createContext({});
  vm.runInContext(buildRelationalFleetV11Worker("https://example.invalid/jobs", "test-token", "legacy-shard"), context);
  assert.equal(vm.runInContext("CONFIG.MANAGER_CUSTOMER_ID", context), "");
});
