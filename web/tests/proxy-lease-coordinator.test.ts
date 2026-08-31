import assert from "node:assert/strict";
import test from "node:test";
import {
  ProxyLeaseUnavailableError,
  createMemoryProxyLeaseLock,
  createMemoryProxyLeaseRepository,
  createProxyLeaseCoordinator,
} from "../server/proxy-lease-coordinator.mjs";

test("distributed proxy coordinator gives each concurrent campaign one unique endpoint", async () => {
  let sequence = 0;
  const repository = createMemoryProxyLeaseRepository();
  const lock = createMemoryProxyLeaseLock();
  const coordinator = createProxyLeaseCoordinator({ repository, lock, ownerId: "worker-a", idFactory: () => `lease-${++sequence}` });
  const endpointKeys = Array.from({ length: 10 }, (_, index) => `gateway.example:${12_000 + index}`);
  const attempts = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => coordinator.acquire({
    providerId: "provider-1", poolId: "pool-1", campaignId: `campaign-${index}`, rotationMode: "port-pool", endpointKeys, ttlMs: 60_000,
  })));
  const leases = attempts.filter((item): item is PromiseFulfilledResult<any> => item.status === "fulfilled").map((item) => item.value);
  assert.equal(leases.length, endpointKeys.length);
  assert.equal(new Set(leases.map((lease) => lease.endpointKey)).size, endpointKeys.length);
  assert.equal(attempts.filter((item) => item.status === "rejected" && item.reason instanceof ProxyLeaseUnavailableError).length, 90);
});

test("expired endpoint is reusable with a higher fencing token", async () => {
  let now = 1_000;
  let sequence = 0;
  const repository = createMemoryProxyLeaseRepository({ now: () => now });
  const lock = createMemoryProxyLeaseLock({ now: () => now });
  const coordinator = createProxyLeaseCoordinator({ repository, lock, ownerId: "worker-a", idFactory: () => `lease-${++sequence}` });
  const request = { providerId: "provider-1", poolId: "pool-1", campaignId: "campaign-1", rotationMode: "sticky-session", endpointKeys: ["gateway:12321"], ttlMs: 10_000 };
  const first = await coordinator.acquire(request);
  now += 10_001;
  await coordinator.reapExpired();
  const second = await coordinator.acquire({ ...request, campaignId: "campaign-2" });
  assert.equal(second.endpointKey, first.endpointKey);
  assert.ok(second.fencingToken > first.fencingToken);
  assert.equal(await coordinator.renew(first, 20_000), null);
});

test("stale workers cannot release a lease owned by another coordinator", async () => {
  const repository = createMemoryProxyLeaseRepository();
  const lock = createMemoryProxyLeaseLock();
  const firstCoordinator = createProxyLeaseCoordinator({ repository, lock, ownerId: "worker-a", idFactory: () => "lease-a" });
  const otherCoordinator = createProxyLeaseCoordinator({ repository, lock, ownerId: "worker-b", idFactory: () => "lease-b" });
  const lease = await firstCoordinator.acquire({ providerId: "provider-1", poolId: "pool-1", campaignId: "campaign-1", rotationMode: "port-pool", endpointKeys: ["gateway:12321"], ttlMs: 60_000 });
  assert.equal(await otherCoordinator.release(lease), false);
  assert.equal(await firstCoordinator.release(lease), true);
});
