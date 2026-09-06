import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { automaticPool, credentialInput, defaultPoolId, leaseEndpointKeys, physicalEndpointKey, buildEvomiEndpoint, requireBrowserSessionId } from "../../web/server/proxy-setup-core.mjs";
import { createProxyRuntimeService } from "../../web/server/proxy-runtime-service.mjs";
import { proxySetupTransaction, saveProviderSetup, saveCampaignProxy } from "../../web/server/proxy-provider-setup.mjs";
import { createMemoryProxyLeaseRepository, createMemoryProxyLeaseLock, createProxyLeaseCoordinator } from "../../web/server/proxy-lease-coordinator.mjs";

const provider = { providerId: "evomi", name: "EVOMI", providerType: "universal", enabled: true, protocol: "http", gatewayHost: "core-residential.evomi.com", gatewayPorts: [1000], authMode: "username-password", usernameTemplate: "{username}", passwordTemplate: "{password}", rotationModes: ["sticky-session"], capabilities: { country: true, state: true, city: true, stickySession: true } };
const secret = { username: "test-user", password: "test-password" };
const request = { campaignId: "campaign-test", sessionId: "browser-session-1", rotationMode: "sticky-session", geo: { country: "US" }, ttlSeconds: 300, port: 1000 };

test("credentials cannot be omitted or hidden in template fields", () => {
  assert.throws(() => credentialInput(provider, {}), /Username and password/);
  assert.throws(() => credentialInput({ ...provider, usernameTemplate: "literal-user" }, secret), /templates/);
  assert.throws(() => credentialInput({ ...provider, passwordTemplate: "literal-secret" }, secret), /templates/);
  assert.deepEqual(credentialInput(provider, { username: "", password: "" }, secret), secret);
  assert.equal(credentialInput({ ...provider, authMode: "ip-allowlist" }), undefined);
});
test("automatic pool is bounded, deterministic and preserves custom pools", () => {
  const pool = automaticPool(provider);
  assert.equal(pool.poolId, "evomi-default");
  assert.equal(pool.config.sessionCapacity, 100);
  assert.equal(pool.maxConcurrentPerEndpoint, 1);
  assert.deepEqual(pool.endpointPorts, [1000]);
  assert.equal(pool.defaultRotationMode, "sticky-session");
  assert.equal(automaticPool(provider, { config: { custom: true } }).config.custom, true);
  assert.ok(defaultPoolId("a".repeat(64)).length <= 64);
  assert.notEqual(defaultPoolId("a".repeat(63) + "b"), defaultPoolId("a".repeat(63) + "c"));
});
test("same gateway has isolated bounded session slots but exclusive pools stay exclusive", () => {
  const pool = automaticPool(provider);
  const keys = leaseEndpointKeys(pool, provider.gatewayHost, "sticky-session", "one");
  assert.equal(new Set(keys).size, 100);
  assert.ok(keys.every(key => physicalEndpointKey(key) === "core-residential.evomi.com:1000"));
  assert.deepEqual(leaseEndpointKeys(pool, provider.gatewayHost, "port-pool"), ["core-residential.evomi.com:1000"]);
  assert.throws(() => leaseEndpointKeys({ ...pool, endpointPorts: Array.from({ length: 60 }, (_, i) => 1000 + i) }, provider.gatewayHost, "sticky-session"), /bounded/);
});
test("100 concurrent campaign leases share one gateway port without sharing a slot", async () => {
  const repository = createMemoryProxyLeaseRepository();
  const coordinator = createProxyLeaseCoordinator({ repository, lock: createMemoryProxyLeaseLock(), ownerId: "test-owner" });
  const pool = automaticPool(provider);
  const acquire = i => coordinator.acquire({ providerId: "evomi", poolId: pool.poolId, campaignId: "test-" + i, sessionId: "session-" + i, rotationMode: "sticky-session", endpointKeys: leaseEndpointKeys(pool, provider.gatewayHost, "sticky-session", "session-" + i), ttlMs: 30000 });
  const leases = await Promise.all(Array.from({ length: 100 }, (_, i) => acquire(i)));
  assert.equal(new Set(leases.map(lease => lease.endpointKey)).size, 100);
  await assert.rejects(acquire(101), /No proxy endpoint/);
  await coordinator.release(leases[0]);
  assert.ok((await acquire(102)).leaseId);
  await Promise.all(leases.slice(1).map(lease => coordinator.release(lease)));
});
test("EVOMI uses an encoded credential, deterministic per-context session and minute lifetime", () => {
  const result = buildEvomiEndpoint(provider, secret, request);
  const password = decodeURIComponent(result.url.password);
  assert.match(password, /^test-password_country-US_session-[a-f0-9]{10}_lifetime-5$/);
  assert.equal(result.sessionId, buildEvomiEndpoint(provider, secret, request).sessionId);
  assert.notEqual(result.sessionId, buildEvomiEndpoint(provider, secret, { ...request, sessionId: "another-context" }).sessionId);
  assert.notEqual(result.sessionId, buildEvomiEndpoint(provider, secret, { ...request, campaignId: "another-campaign" }).sessionId);
  const geo = buildEvomiEndpoint(provider, secret, { ...request, geo: { country: "US", state: "New York", city: "New York" } });
  assert.match(decodeURIComponent(geo.url.password), /_region-new.york_city-new.york_/);
});
test("EVOMI rejects invalid protocol ports, session modes and injected location parameters", () => {
  assert.throws(() => buildEvomiEndpoint(provider, secret, { ...request, rotationMode: "per-request" }), /sticky-session/);
  assert.throws(() => buildEvomiEndpoint(provider, secret, { ...request, sessionId: "" }), /session ID/);
  assert.throws(() => buildEvomiEndpoint(provider, secret, { ...request, ttlSeconds: 86401 }), /duration/);
  assert.throws(() => buildEvomiEndpoint(provider, secret, { ...request, geo: { country: "US", city: "x_session-hijack" } }), /Invalid/);
  assert.throws(() => buildEvomiEndpoint({ ...provider, protocol: "https", gatewayPorts: [1001] }, secret, { ...request, port: 1001 }), /certificate hostname/);
});
test("transaction commits only after work and rolls back on failure", async () => {
  const events = [];
  const pool = { connect: async () => ({ query: async sql => { events.push(sql); return { rows: [] }; }, release: () => events.push("release") }) };
  assert.equal(await proxySetupTransaction(async () => 42, { pool, vaultKey: Buffer.alloc(32) }), 42);
  assert.deepEqual(events, ["BEGIN", "COMMIT", "release"]);
  events.length = 0;
  await assert.rejects(proxySetupTransaction(async () => { throw new Error("secret write failed"); }, { pool, vaultKey: Buffer.alloc(32) }), /secret write failed/);
  assert.deepEqual(events, ["BEGIN", "ROLLBACK", "release"]);
});

const testUrl = process.env.PROXY_SETUP_TEST_DATABASE_URL;
test("isolated PostgreSQL: atomic save, credential failure rollback, auto pool and campaign policy", { skip: !testUrl }, async () => {
  const target = new URL(testUrl);
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.pathname, "/proxy_setup_test");
  const pool = new Pool({ connectionString: testUrl, max: 3, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  const options = { pool, vaultKey: Buffer.alloc(32, 7), keyId: "isolated-test" };
  try {
    await pool.query(await readFile(new URL("../../migrations/006_universal_proxy_registry.sql", import.meta.url), "utf8"));
    await pool.query("CREATE TABLE tah_control_state(name text PRIMARY KEY,payload jsonb NOT NULL)");
    await pool.query("INSERT INTO tah_control_state(name,payload) VALUES($1,$2)", ["campaigns", JSON.stringify([{ id: "campaign-test", status: "stopped", desiredRunning: false, config: { tier: "human", continuous: true, mitm: false } }])]);
    await assert.rejects(saveProviderSetup({ ...provider, providerId: "missing-secret" }, {}, options), /Username and password/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tah_proxy_providers")).rows[0].n, 0);
    const saved = await saveProviderSetup(provider, secret, options);
    assert.equal(saved.provider.secretConfigured, true);
    assert.equal(saved.pool.config.sessionCapacity, 100);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tah_proxy_pools")).rows[0].n, 1);
    await saveProviderSetup(provider, {}, options);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tah_proxy_pools")).rows[0].n, 1);
    await pool.query("ALTER TABLE tah_proxy_provider_secrets ADD CONSTRAINT injected_failure CHECK(provider_id <> 'fail-secret')");
    await assert.rejects(saveProviderSetup({ ...provider, providerId: "fail-secret" }, secret, options));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tah_proxy_providers WHERE provider_id='fail-secret'")).rows[0].n, 0);
    await saveCampaignProxy({ campaignRecordId: "campaign-test", primaryProviderId: "evomi", primaryPoolId: "evomi-default" }, options);
    assert.equal((await pool.query("SELECT enabled FROM tah_campaign_proxy_policies")).rows[0].enabled, true);
    await pool.query("UPDATE tah_control_state SET payload=jsonb_set(payload, '{0,status}', '\"running\"') WHERE name='campaigns'");
    await assert.rejects(saveCampaignProxy({ campaignRecordId: "campaign-test", enabled: false }, options), /Stop the campaign/);
    assert.equal((await pool.query("SELECT enabled FROM tah_campaign_proxy_policies")).rows[0].enabled, true);
    await pool.query("UPDATE tah_control_state SET payload=jsonb_set(payload, '{0,status}', '\"stopped\"') WHERE name='campaigns'");
    await saveCampaignProxy({ campaignRecordId: "campaign-test", enabled: false }, options);
    assert.equal((await pool.query("SELECT enabled FROM tah_campaign_proxy_policies")).rows[0].enabled, false);
    await assert.rejects(saveCampaignProxy({ campaignRecordId: "does-not-exist", enabled: false }, options), /not found/);
  } finally { await pool.end(); }
});

test("IPRoyal session templates and custom pool flags never enable shared gateway slots", () => {
  const iproyal = { ...provider, providerId: "iproyal", providerType: "iproyal", gatewayHost: "geo.iproyal.com", gatewayPorts: [11200], passwordTemplate: "{password}_session-{sessionId}" };
  const pool = automaticPool(iproyal);
  assert.equal(pool.config.sessionSharedGateway, false);
  assert.deepEqual(leaseEndpointKeys(pool, iproyal.gatewayHost, "sticky-session", "browser-1"), ["geo.iproyal.com:11200"]);
  assert.deepEqual(leaseEndpointKeys({ ...pool, config: { sessionSharedGateway: true, sessionCapacity: 100 } }, iproyal.gatewayHost, "sticky-session", "browser-2"), ["geo.iproyal.com:11200"]);
});
test("missing browser session is rejected before allocating a registry endpoint", async () => {
  for (const value of [undefined, null, "", " ", 12, "x".repeat(129)]) assert.throws(() => requireBrowserSessionId(value), /browser session ID/);
  assert.equal(requireBrowserSessionId("context-01234567"), "context-01234567");
  let allocated = 0;
  const runtime = createProxyRuntimeService({
    providerService: { repository: { getPolicy: async () => ({ enabled: true }) } },
    leaseCoordinator: { acquire: async () => { allocated++; } },
  });
  await assert.rejects(runtime.resolve({ campaignRecordId: "campaign-test" }), /browser session ID/);
  assert.equal(allocated, 0);
});
