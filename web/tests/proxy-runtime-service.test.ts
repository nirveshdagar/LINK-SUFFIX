import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProxyProviderRepository, createProxyProviderService } from "../server/proxy-provider-store.mjs";
import { createMemoryProxyLeaseLock, createMemoryProxyLeaseRepository, createProxyLeaseCoordinator } from "../server/proxy-lease-coordinator.mjs";
import { createProxyRuntimeService, ProxyPolicyNotFoundError } from "../server/proxy-runtime-service.mjs";

async function fixture() {
  const repository = createMemoryProxyProviderRepository();
  const providerService = createProxyProviderService({ repository, vaultKey: Buffer.alloc(32, 22).toString("base64") });
  const base = { enabled: true, protocol: "http", authMode: "username-password", usernameTemplate: "{username}", passwordTemplate: "{password}", rotationModes: ["sticky-session"], capabilities: { country: true, state: true, city: true, stickySession: true } };
  await providerService.saveProvider({ ...base, providerId: "primary", name: "Primary", providerType: "universal", gatewayHost: "primary.example.net", gatewayPorts: [10001] }, { username: "u1", password: "p1" });
  await providerService.saveProvider({ ...base, providerId: "fallback", name: "Fallback", providerType: "universal", gatewayHost: "fallback.example.net", gatewayPorts: [11001] }, { username: "u2", password: "p2" });
  await providerService.savePool({ poolId: "primary-pool", providerId: "primary", name: "Primary pool", endpointPorts: [10001], defaultRotationMode: "sticky-session" });
  await providerService.savePool({ poolId: "fallback-pool", providerId: "fallback", name: "Fallback pool", endpointPorts: [11001], defaultRotationMode: "sticky-session" });
  await providerService.assignPolicy({ campaignRecordId: "campaign-000003", primaryProviderId: "primary", primaryPoolId: "primary-pool", rotationMode: "sticky-session", fallbackProviderIds: ["fallback"], geo: { country: "US" } });
  const leaseRepository = createMemoryProxyLeaseRepository();
  const leaseCoordinator = createProxyLeaseCoordinator({ repository: leaseRepository, lock: createMemoryProxyLeaseLock(), ownerId: "runtime-test", idFactory: (() => { let value = 0; return () => `lease-${++value}`; })() });
  leaseCoordinator.repository = leaseRepository;
  const endpointBuilder = async (provider: any, secret: any, request: any) => ({
    url: new URL(`http://${secret.username}:${secret.password}@${provider.gatewayHost}:${request.port}`),
    protocol: provider.protocol,
    providerId: provider.providerId,
    rotationMode: request.rotationMode,
    port: request.port,
    mode: request.rotationMode === "sticky-session" ? "sticky-residential" as const : "rotating-residential" as const,
  });
  return { repository, providerService, runtime: createProxyRuntimeService({ providerService, leaseCoordinator, endpointBuilder }) };
}

test("campaign runtime leases its primary provider and releases it with fencing", async () => {
  const { runtime } = await fixture();
  const lease = await runtime.resolve({ campaignRecordId: "campaign-000003", sessionId: "session-a" });
  assert.equal(lease.providerId, "primary");
  assert.equal(lease.fallbackUsed, false);
  assert.match(lease.proxyUrl, /^http:\/\/u1:p1@primary\.example\.net:10001\/$/);
  assert.ok(await runtime.renew(lease.leaseId, 60_000));
  assert.equal(await runtime.release(lease.leaseId), true);
});

test("open primary circuit selects a configured fallback provider", async () => {
  const { repository, runtime } = await fixture();
  await repository.upsertCircuit({ providerId: "primary", poolId: "primary-pool", endpointKey: "*", state: "open", consecutiveFailures: 5, consecutiveSuccesses: 0, retryAt: new Date(Date.now() + 60_000).toISOString() });
  const lease = await runtime.resolve({ campaignRecordId: "campaign-000003", sessionId: "session-b" });
  assert.equal(lease.providerId, "fallback");
  assert.equal(lease.fallbackUsed, true);
  assert.match(lease.proxyUrl, /fallback\.example\.net:11001/);
});

test("health reporting opens a failing endpoint circuit and records detailed metrics", async () => {
  const { repository, runtime } = await fixture();
  for (let index = 0; index < 5; index++) {
    const lease = await runtime.resolve({ campaignRecordId: "campaign-000003", sessionId: `failure-${index}` });
    const circuit = await runtime.report({ leaseId: lease.leaseId, healthy: false, reason: "timeout", proxyLatencyMs: 900, payloadBytes: 12, browserCpuMs: 4, browserMemoryBytes: 2048, redisLatencyMs: 2 });
    await runtime.release(lease.leaseId);
    if (index === 4) assert.equal(circuit.state, "open");
  }
  const samples = await repository.listHealthSamples() as Array<{ browserMemoryBytes?: number }>;
  assert.equal(samples.length, 5);
  assert.equal(samples.at(-1)?.browserMemoryBytes, 2048);
  const fallback = await runtime.resolve({ campaignRecordId: "campaign-000003", sessionId: "after-quarantine" });
  assert.equal(fallback.providerId, "fallback");
  assert.equal(fallback.fallbackUsed, true);
});

test("campaigns without an enabled policy stay on the compatibility path", async () => {
  const { runtime } = await fixture();
  await assert.rejects(() => runtime.resolve({ campaignRecordId: "unassigned" }), ProxyPolicyNotFoundError);
});
