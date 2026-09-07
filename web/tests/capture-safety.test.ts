import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { evaluateCaptureResult } from "@tah/contracts";
import { extractExactQuerySuffix } from "../server/exact-suffix.mjs";
import { enqueueBridgeCapture } from "../lib/script-bridge-store.ts";

const source = readFileSync(new URL("../server/control.mjs", import.meta.url), "utf8");
const start = source.indexOf("function captureExactL4Suffix(");
const end = source.indexOf("\nfunction queueL4Capture(", start);
const code = source.slice(start, end);
const suffix = "im_ref=fresh%2Fclick&sharedid=&x=+&x=%20&im_rewards=";
const url = "https://www.udemy.com/?" + suffix;
const good = { tier: "human", final_verdict: "allow", final_landing_url: url,
  events: [{ url, status: 200, headers: {}, ta_signal: { main_document: "true" } }] };
const bad = { ...good, final_landing_url: "https://trk.udemy.com/?__cf_chl_rt_tk=fixture",
  events: [{ url: "https://trk.udemy.com/", status: 403, headers: { "cf-mitigated": "challenge", "cf-ray": "0123456789abcdef-DEL" }, ta_signal: { main_document: "true" } }] };
function fixture(results = [good]) {
  const campaign: Record<string, any> = { id: "fixture", activeRunId: "run-fixture", desiredRunning: true,
    latestSuffix: "previous=valid", lastCapturedAt: "previous-time", captureHistory: [] };
  const run: Record<string, any> = { id: "run-fixture", campaignRecordId: "fixture", tier: "human", exitCode: null };
  const context = vm.createContext({ campaigns: new Map([["fixture", campaign]]), evaluateCaptureResult,
    extractExactQuerySuffix, captureEgressIdentity: () => undefined, clean: (v: unknown) => String(v),
    noteContinuousRunProgress() {}, persistCampaigns() {}, persistRuns() {}, broadcast() {}, broadcastCampaigns() {},
    existsSync: () => true, readFileSync: (file: unknown) => String(file).endsWith("scenarios.jsonl") ? results.map(r => JSON.stringify(r)).join("\n") : "{}",
    atomicWriteJson() {}, ROOT: "fixture", adsStatePath: "fixture", path, process });
  vm.runInContext(code, context);
  return { campaign, run, context };
}
test("blocked capture preserves historical suffix and freshness and reports Ray ID", () => {
  const f = fixture();
  assert.equal(f.context.persistL4Capture(f.run, bad), null);
  assert.equal(f.campaign.latestSuffix, "previous=valid");
  assert.equal(f.campaign.lastCapturedAt, "previous-time");
  assert.equal(f.campaign.captureHistory.length, 0);
  assert.equal(f.campaign.lastCaptureRejection.diagnostics.rayId, "0123456789abcdef-DEL");
});
test("a later valid capture preserves exact bytes and clears the rejection", () => {
  const f = fixture();
  f.context.persistL4Capture(f.run, bad);
  assert.equal(f.context.persistL4Capture(f.run, good).suffix, suffix);
  assert.equal(f.campaign.latestSuffix, suffix);
  assert.equal(f.campaign.lastCaptureRejection, undefined);
});
test("finalization never replays a stale success after a blocked result", () => {
  const f = fixture([good, bad]);
  assert.equal(f.context.captureExactL4Suffix(f.run), null);
  assert.equal(f.campaign.latestSuffix, "previous=valid");
});
test("a stopped or superseded run cannot overwrite rejection diagnostics", () => {
  const f = fixture();
  f.campaign.activeRunId = "replacement";
  f.context.recordCaptureRejection(f.run, { code: "cloudflare_challenge" });
  assert.equal(f.campaign.lastCaptureRejection, undefined);
});
test("exact extraction blocks challenge values without rewriting ordinary query bytes", () => {
  assert.equal(extractExactQuerySuffix(bad.final_landing_url), null);
  assert.equal(extractExactQuerySuffix(url), suffix);
});
test("invalid suffix is rejected before any database access", async () => {
  await assert.rejects(enqueueBridgeCapture({ campaignRecordId: "fixture", campaignName: "fixture",
    customerId: "1234567890", googleCampaignId: "12345", exactSuffix: "%5F%5Fcf_chl_rt_tk=fixture" }), /Cloudflare/);
});
