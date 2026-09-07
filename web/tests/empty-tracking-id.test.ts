import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { evaluateCaptureResult } from "@tah/contracts";
import { extractExactQuerySuffix } from "../server/exact-suffix.mjs";
import { enqueueBridgeCapture } from "../lib/script-bridge-store.ts";

test("incomplete captures cannot enter the relational Fleet queue", async () => {
  for (const exactSuffix of ["irclickid=&irgwc=1", "im_ref=&sharedid="]) {
    await assert.rejects(enqueueBridgeCapture({
      campaignRecordId: "isolated-empty-id-fixture", campaignName: "Isolated fixture",
      managerCustomerId: "1010804078", customerId: "1591447937",
      googleCampaignId: "24180134137", shardId: "isolated-fixture", exactSuffix,
      // The newer local contract validates enrollment before checking suffix bytes.
      ...{ enrollmentGeneration: "isolated-empty-id-fixture-generation" },
    }), /empty tracking identifier/);
  }
});

test("an HTTP 200 with an empty ID cannot overwrite historical suffix or advance freshness", () => {
  const source = readFileSync(new URL("../server/control.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function persistL4Capture(");
  const end = source.indexOf("\nfunction queueL4Capture(", start);
  assert.ok(start >= 0 && end > start);
  const campaign = { id: "fixture", activeRunId: "run-fixture", desiredRunning: true,
    latestSuffix: "irclickid=historical%2Fvalid&sharedid=", lastCapturedAt: "2026-09-07T14:36:00.000Z",
    captureHistory: [{ suffix: "irclickid=historical%2Fvalid&sharedid=" }] };
  const before = JSON.stringify(campaign);
  const rejections: unknown[] = [];
  let writes = 0;
  const context = vm.createContext({
    evaluateCaptureResult, recordCaptureRejection: (_run: unknown, rejection: unknown) => rejections.push(rejection),
    campaigns: new Map([["fixture", campaign]]), captureEgressIdentity: () => null, extractExactQuerySuffix,
    readFileSync: () => "{}", persistCampaigns: () => writes++, atomicWriteJson: () => writes++,
    adsStatePath: "isolated-fixture", path, process,
  });
  vm.runInContext(source.slice(start, end), context);
  const url = "https://merchant.example/?irclickid=&irgwc=1";
  const result = context.persistL4Capture({ id: "run-fixture", campaignRecordId: "fixture" }, {
    tier: "human", final_landing_url: url, final_verdict: "allow",
    events: [{ url, status: 200, headers: {}, ta_signal: { main_document: "true" } }],
  });
  assert.equal(result, null);
  assert.equal(writes, 0);
  assert.equal(JSON.stringify(campaign), before);
  assert.equal((rejections[0] as { code: string }).code, "empty_tracking_identifier");
  assert.equal(extractExactQuerySuffix(url), null);
});
