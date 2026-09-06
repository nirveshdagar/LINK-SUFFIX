import test from "node:test";
import assert from "node:assert/strict";
import { prepareCampaignProxySelection, settleCampaignProxySelection, assertProxySelectionReady } from "../../web/server/campaign-proxy-selection.mjs";
import { buildEvomiEndpoint } from "../../web/server/proxy-setup-core.mjs";

const provider = { providerId: "evomi", name: "EVOMI", providerType: "universal", enabled: true, gatewayHost: "core-residential.evomi.com", gatewayPorts: [1000], protocol: "http", authMode: "username-password" };
const pool = { poolId: "evomi-default", providerId: "evomi", enabled: true, defaultRotationMode: "sticky-session" };
function service(policy = null, overrides = {}) { return { repository: { async getPolicy() { return policy; }, async getPool(id) { return id === pool.poolId ? pool : null; }, async getProvider() { return { ...provider, ...overrides }; } }, async runtimeSecret() { return { username: "fixture", password: "fixture-only" }; } }; }
const payload = { proxyPoolId: pool.poolId, tier: "human", geo: { country: "US" } };
test("new EVOMI campaigns prepare the selected provider and country before launch", async () => {
 const selected = await prepareCampaignProxySelection(payload, null, { service: service(), runtimeEnabled: "1" });
 assert.equal(selected.registry, true); assert.equal(selected.changed, true); assert.equal(selected.payload.proxyProviderId, "evomi"); assert.equal(selected.assignment.geo.country, "US");
});
for (const country of ["US", "GB", "CA", "IN", "DE"]) test("EVOMI encodes chosen country " + country + " for a fresh session", () => {
 const endpoint = buildEvomiEndpoint(provider, { username: "fixture", password: "fixture-only" }, { geo: { country }, sessionId: "fixture001", campaignId: "campaign-fixture", rotationMode: "sticky-session", port: 1000, ttlSeconds: 1800 });
 assert.match(decodeURIComponent(endpoint.url.password), new RegExp("_country-" + country + "_session-"));
});
test("country, runtime, unsupported tier and disabled provider fail closed", async () => {
 await assert.rejects(prepareCampaignProxySelection({ ...payload, geo: {} }, null, { service: service(), runtimeEnabled: "1" }), /country/);
 await assert.rejects(prepareCampaignProxySelection(payload, null, { service: service(), runtimeEnabled: "0" }), /runtime/);
 await assert.rejects(prepareCampaignProxySelection({ ...payload, tier: "headless" }, null, { service: service(), runtimeEnabled: "1" }), /continuous/);
 await assert.rejects(prepareCampaignProxySelection(payload, null, { service: service(null, { enabled: false }), runtimeEnabled: "1" }), /enabled/);
});
test("changing provider of a running campaign is refused; its saved provider is not replaced", async () => {
 await assert.rejects(prepareCampaignProxySelection(payload, { id: "campaign-1", status: "running", desiredRunning: true }, { service: service(), runtimeEnabled: "1" }), /Stop/);
 const selected = await prepareCampaignProxySelection(payload, { id: "campaign-1", status: "running", desiredRunning: true }, { service: service({ enabled: true, primaryPoolId: pool.poolId }), runtimeEnabled: "1" });
 assert.equal(selected.changed, false);
});
test("country change does not silently switch an existing EVOMI provider", async () => {
 const selected = await prepareCampaignProxySelection({ ...payload, geo: { country: "CA" } }, { id: "campaign-1", status: "stopped" }, { service: service({ enabled: true, primaryPoolId: pool.poolId }), runtimeEnabled: "1" });
 assert.equal(selected.changed, false); assert.equal(selected.payload.geo.country, "CA");
});
test("assignment only occurs after a durable stopped draft; successful save releases the gate", async () => {
 const campaign = { id: "campaign-1", status: "scheduled", desiredRunning: false };
 const events = [];
 await settleCampaignProxySelection(campaign, { changed: true, assignment: { enabled: true } }, {
   async persist() { events.push(campaign.proxySelectionPending ? "blocked" : "ready"); },
   async assign(input) { assert.equal(campaign.status, "stopped"); assert.equal(campaign.desiredRunning, false); assert.equal(input.campaignRecordId, campaign.id); assert.throws(() => assertProxySelectionReady(campaign)); events.push("assign"); }
 });
 assert.deepEqual(events, ["blocked", "assign", "ready"]); assert.equal(campaign.status, "scheduled"); assert.doesNotThrow(() => assertProxySelectionReady(campaign));
});
test("failed assignment leaves a stopped, retryable campaign and never releases the start gate", async () => {
 const campaign = { id: "campaign-1", status: "scheduled", desiredRunning: false };
 await assert.rejects(settleCampaignProxySelection(campaign, { changed: true, assignment: {} }, { async persist() {}, async assign() { throw Error("fixture database failure"); } }), /remains stopped/);
 assert.equal(campaign.status, "stopped"); assert.equal(campaign.desiredRunning, false); assert.throws(() => assertProxySelectionReady(campaign), /Save changes/);
});
test("failed first durable write never invokes the provider assignment", async () => {
 const campaign = { id: "campaign-1", status: "stopped", desiredRunning: false };
 let assigned = false;
 await assert.rejects(settleCampaignProxySelection(campaign, { changed: true, assignment: {} }, { async persist() { throw Error("fixture persistence failure"); }, async assign() { assigned = true; } }));
 assert.equal(assigned, false); assert.throws(() => assertProxySelectionReady(campaign));
});
test("failed final durable write restores the start gate", async () => {
 const campaign = { id: "campaign-1", status: "stopped", desiredRunning: false }; let writes = 0;
 await assert.rejects(settleCampaignProxySelection(campaign, { changed: true, assignment: {} }, { async persist() { if (++writes === 2) throw Error("fixture final write failure"); }, async assign() {} }), /remains stopped/);
 assert.equal(campaign.proxySelectionPending, true); assert.equal(campaign.desiredRunning, false);
});
test("legacy campaigns remain explicitly selectable without an automatic EVOMI migration", async () => {
 const selected = await prepareCampaignProxySelection({ proxyPoolId: "", tier: "human", geo: { country: "US" } }, null);
 assert.equal(selected.registry, false); assert.equal(selected.changed, false); assert.equal(selected.payload.proxyProviderId, "iproyal");
 assert.equal(await prepareCampaignProxySelection({ tier: "human" }, null), null);
});
