import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProxyProviderRepository, createProxyProviderService } from "../server/proxy-provider-store.mjs";

const key = Buffer.alloc(32, 19).toString("base64");

function provider(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "universal-one",
    name: "Universal residential",
    providerType: "universal",
    enabled: true,
    protocol: "http",
    gatewayHost: "gate.example.net",
    gatewayPorts: [12321, 12322],
    authMode: "username-password",
    usernameTemplate: "{username}-country-{country}-session-{sessionId}",
    passwordTemplate: "{password}",
    rotationModes: ["sticky-session", "provider-managed"],
    capabilities: { country: true, state: true, city: true, asn: false, stickySession: true },
    ...overrides,
  };
}

test("provider credentials are encrypted and never appear in control-plane responses", async () => {
  const repository = createMemoryProxyProviderRepository();
  const service = createProxyProviderService({ repository, vaultKey: key });
  await service.saveProvider(provider(), { username: "private-user", password: "private-password" });
  const overview = await service.overview();
  assert.equal(overview.providers[0].secretConfigured, true);
  assert.doesNotMatch(JSON.stringify(overview), /private-user|private-password/);
  assert.deepEqual(await service.runtimeSecret("universal-one"), { username: "private-user", password: "private-password" });
});

test("provider pools and campaign failover policies remain relationally consistent", async () => {
  const repository = createMemoryProxyProviderRepository();
  const service = createProxyProviderService({ repository, vaultKey: key });
  await service.saveProvider(provider());
  await service.saveProvider(provider({ providerId: "fallback-two", name: "Fallback", gatewayHost: "fallback.example.net" }));
  await service.savePool({ poolId: "universal-us", providerId: "universal-one", name: "US residential", endpointPorts: [12321, 12322], defaultRotationMode: "sticky-session", maxConcurrentPerEndpoint: 1 });
  const policy = await service.assignPolicy({ campaignRecordId: "campaign-000003", primaryProviderId: "universal-one", primaryPoolId: "universal-us", rotationMode: "sticky-session", fallbackProviderIds: ["fallback-two"], stickyTtlSeconds: 1800, geo: { country: "US" } });
  assert.equal(policy.primaryPoolId, "universal-us");
  assert.deepEqual(policy.fallbackProviderIds, ["fallback-two"]);
  await assert.rejects(() => service.assignPolicy({ ...policy, primaryProviderId: "fallback-two", fallbackProviderIds: [] }), /do not match/);
});

test("provider validation rejects malformed gateways, ports, and rotation modes", async () => {
  const service = createProxyProviderService({ repository: createMemoryProxyProviderRepository(), vaultKey: key });
  await assert.rejects(() => service.saveProvider(provider({ gatewayHost: "https://gate.example.net/path" })), /hostname or IPv4/);
  await assert.rejects(() => service.saveProvider(provider({ gatewayPorts: [0, 70000] })), /valid ports/);
  await assert.rejects(() => service.saveProvider(provider({ rotationModes: ["invented"] })), /unsupported/);
});

test("health summaries expose proxy, payload, browser, database, and Redis pressure", async () => {
  const service = createProxyProviderService({ repository: createMemoryProxyProviderRepository(), vaultKey: key });
  await service.saveProvider(provider());
  await service.recordHealth({ providerId: "universal-one", healthy: true, proxyLatencyMs: 80, payloadBytes: 500, browserCpuMs: 20, browserMemoryBytes: 1_000, databaseLatencyMs: 4, redisLatencyMs: 2 });
  await service.recordHealth({ providerId: "universal-one", healthy: false, reason: "timeout", proxyLatencyMs: 800, payloadBytes: 200, browserCpuMs: 35, browserMemoryBytes: 2_000, databaseLatencyMs: 12, redisLatencyMs: 8 });
  const metrics = (await service.overview()).providers[0].metrics;
  assert.equal(metrics.samples, 2);
  assert.equal(metrics.successRate, 0.5);
  assert.equal(metrics.latencyP95Ms, 800);
  assert.equal(metrics.payloadBytes, 700);
  assert.equal(metrics.browserMemoryBytes, 2_000);
  assert.equal(metrics.databaseLatencyP95Ms, 12);
  assert.equal(metrics.redisLatencyP95Ms, 8);
});
