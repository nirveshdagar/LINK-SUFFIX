import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { createClient } from "redis";
import { createPostgresProxyProviderRepository, createProxyProviderService } from "../server/proxy-provider-store.mjs";
import { createPostgresProxyLeaseRepository, createProxyLeaseCoordinator, createRedisProxyLeaseLock, ProxyLeaseUnavailableError } from "../server/proxy-lease-coordinator.mjs";

const databaseUrl = process.env.TAH_TEST_DATABASE_URL || "";
const redisUrl = process.env.TAH_TEST_REDIS_URL || "";

test("PostgreSQL registry and Redis lease fencing work together", { skip: !databaseUrl || !redisUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  try {
    await redis.flushDb();
    await pool.query("TRUNCATE tah_proxy_health_samples,tah_proxy_circuit_states,tah_proxy_leases,tah_campaign_proxy_policies,tah_proxy_pools,tah_proxy_provider_secrets,tah_proxy_providers RESTART IDENTITY CASCADE");
    const repository = createPostgresProxyProviderRepository(pool);
    const service = createProxyProviderService({ repository, vaultKey: Buffer.alloc(32, 31).toString("base64") });
    await service.saveProvider({
      providerId: "integration-provider", name: "Integration provider", providerType: "universal", enabled: true,
      protocol: "http", gatewayHost: "gate.example.net", gatewayPorts: [12001, 12002], authMode: "username-password",
      usernameTemplate: "{username}-country-{country}", passwordTemplate: "{password}",
      rotationModes: ["sticky-session", "provider-managed"], capabilities: { country: true, state: true, city: true, asn: false, stickySession: true },
    }, { username: "encrypted-user", password: "encrypted-pass" });
    await service.savePool({ poolId: "integration-pool", providerId: "integration-provider", name: "Integration pool", endpointPorts: [12001, 12002], defaultRotationMode: "sticky-session", maxConcurrentPerEndpoint: 1 });
    await service.assignPolicy({ campaignRecordId: "campaign-integration", primaryProviderId: "integration-provider", primaryPoolId: "integration-pool", rotationMode: "sticky-session", fallbackProviderIds: [], geo: { country: "US" } });
    await service.recordHealth({ providerId: "integration-provider", poolId: "integration-pool", healthy: true, proxyLatencyMs: 42, payloadBytes: 512, browserCpuMs: 7, browserMemoryBytes: 4096, databaseLatencyMs: 3, redisLatencyMs: 1 });

    const overview = await service.overview();
    assert.equal(overview.summary.providers, 1);
    assert.equal(overview.summary.assignedCampaigns, 1);
    assert.equal(overview.providers[0].secretConfigured, true);
    assert.doesNotMatch(JSON.stringify(overview), /encrypted-user|encrypted-pass/);

    const coordinator = createProxyLeaseCoordinator({ repository: createPostgresProxyLeaseRepository(pool), lock: createRedisProxyLeaseLock(redis), ownerId: "integration-worker" });
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => coordinator.acquire({
      providerId: "integration-provider", poolId: "integration-pool", campaignId: `campaign-${index}`,
      endpointKeys: ["gate.example.net:12001", "gate.example.net:12002"], sessionId: `session-${index}`,
      rotationMode: "sticky-session", ttlMs: 30_000,
    })));
    const acquired = attempts.filter((item) => item.status === "fulfilled").map((item) => item.value);
    const rejected = attempts.filter((item) => item.status === "rejected");
    assert.equal(acquired.length, 2);
    assert.equal(new Set(acquired.map((item) => item.endpointKey)).size, 2);
    assert.equal(rejected.length, 4);
    assert.ok(rejected.every((item) => item.reason instanceof ProxyLeaseUnavailableError));
    for (const lease of acquired) assert.equal(await coordinator.release(lease), true);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM tah_proxy_leases WHERE state='active'")).rows[0].count, 0);
  } finally {
    await redis.flushDb().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await pool.end();
  }
});
