import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { registryRunRequired, legacyRunPort, assertLegacyPortAvailable, selectQueuedCampaign, createCampaignProxyAdmission } from "../../web/server/campaign-proxy-admission.mjs";

const mode = { runtimeEnabled: true, sharedEnabled: true, noProxy: false };
const browser = { tier: "human", continuous: true, mitm: false, proxyPort: 11200 };
test("registry campaigns share a gateway without consuming a legacy port", () => {
  const runs = [{ proxyPort: 11200 }];
  for (let i = 0; i < 100; i++) {
    assert.equal(registryRunRequired({ enabled: true }, browser, mode), true);
    const port = legacyRunPort(browser, { registry: true });
    assert.equal(port, null);
    assert.doesNotThrow(() => assertLegacyPortAvailable(port, runs));
    runs.push({ proxyPort: port });
  }
  assert.throws(() => assertLegacyPortAvailable(legacyRunPort(browser), runs), /already leased/);
  assert.doesNotThrow(() => assertLegacyPortAvailable(11201, runs));
});
test("queue skips occupied legacy ports but admits registry campaigns on the same saved port", () => {
  const campaigns = [
    { id: "legacy", number: 1, status: "queued", desiredRunning: true, config: { proxyPort: 11200 } },
    { id: "evomi", number: 2, status: "queued", desiredRunning: true, config: { proxyPort: 11200 } },
    { id: "stopped", number: 3, status: "stopped", desiredRunning: false, config: { proxyPort: 11201 } },
  ];
  assert.equal(selectQueuedCampaign(campaigns, new Set([11200]), new Set(["evomi"]), 100).id, "evomi");
  assert.equal(selectQueuedCampaign(campaigns, new Set([11200]), new Set(), 100), undefined);
  campaigns[1].nextRetryAt = 200;
  assert.equal(selectQueuedCampaign(campaigns, new Set([11200]), new Set(["evomi"]), 100), undefined);
});
test("registry selection cannot fall back when runtime or shared execution is disabled", () => {
  assert.equal(registryRunRequired(null, browser, mode), false);
  assert.throws(() => registryRunRequired({ enabled: true }, browser, { ...mode, runtimeEnabled: false }), /runtime/);
  assert.throws(() => registryRunRequired({ enabled: true }, browser, { ...mode, sharedEnabled: false }), /shared-browser/);
  assert.throws(() => registryRunRequired({ enabled: true }, browser, { ...mode, noProxy: true }), /direct/);
  assert.throws(() => registryRunRequired({ enabled: true }, { ...browser, continuous: false }, mode), /shared-browser/);
  assert.throws(() => legacyRunPort({ proxyPort: 0 }), /valid dedicated/);
});
test("admission without a database preserves legacy-only installations", async () => {
  const admission = createCampaignProxyAdmission();
  assert.equal(await admission.policyFor("campaign-1"), null);
  assert.deepEqual(await admission.registryCampaignIds(), new Set());
});
test("actual control connects queue, validation and worker required-route guard", async () => {
  const source = await readFile(new URL("../../web/server/control.mjs", import.meta.url), "utf8");
  assert.match(source, /selectQueuedCampaign\(\[\.\.\.campaigns\.values\(\)\]\.filter\(item => !item\.proxySelectionPending\), leased, registryCampaignIds, now\)/);
  assert.match(source, /assertProxySelectionReady\(campaigns\.get\(payload\.campaignRecordId\)\)/);
  assert.match(source, /validate\(payload, \{ registry: registryProxyRequired \}\)/);
  assert.match(source, /registryProxyRequired,\s+creds: noProxy \|\| registryProxyRequired/);
  assert.match(source, /const campaign = await saveCampaign\(/);
});

test("registry scenarios use the saved campaign ID for runtime policy lookup", async () => {
  const source = await readFile(new URL("../../web/server/control.mjs", import.meta.url), "utf8");
  assert.match(source, /scenarioYaml\(\{ \.\.\.payload, scenarioId: registryProxyRequired \? payload.campaignRecordId : scenarioId \}\)/);
});
