import { Pool } from "pg";
import { createClient } from "redis";
import { configuredProxyProviderService } from "./proxy-provider-store.mjs";
import { createPostgresProxyLeaseRepository, createProxyLeaseCoordinator, createRedisProxyLeaseLock, ProxyLeaseUnavailableError } from "./proxy-lease-coordinator.mjs";

const DEFAULT_LEASE_TTL_MS = 180_000;
const FAILURE_THRESHOLD = 5;
const RECOVERY_SUCCESSES = 2;
const OPEN_DURATION_MS = 60_000;

export class ProxyPolicyNotFoundError extends Error {
  constructor(message = "Campaign has no enabled universal proxy policy") {
    super(message);
    this.name = "ProxyPolicyNotFoundError";
  }
}

export class ProxyRuntimeUnavailableError extends Error {
  constructor(message = "No healthy proxy provider is available") {
    super(message);
    this.name = "ProxyRuntimeUnavailableError";
  }
}

function providerDefinition(provider) {
  const capabilities = provider.capabilities || {};
  return {
    id: provider.providerId,
    name: provider.name,
    kind: provider.providerType,
    enabled: provider.enabled,
    protocol: provider.protocol,
    host: provider.gatewayHost,
    ports: provider.gatewayPorts,
    authMode: provider.authMode,
    usernameTemplate: provider.usernameTemplate,
    passwordTemplate: provider.passwordTemplate,
    rotationModes: provider.rotationModes,
    capabilities: {
      country: capabilities.country !== false,
      state: capabilities.state === true,
      city: capabilities.city === true,
      asn: capabilities.asn === true,
      stickySession: capabilities.stickySession !== false,
      maximumSessionSeconds: Number(capabilities.maximumSessionSeconds) || 86_400,
    },
  };
}

async function defaultEndpointBuilder(provider, secret, request) {
  const adapters = await import("@tah/proxy");
  const adapter = provider.providerType === "iproyal" ? adapters.ipRoyalProviderAdapter : adapters.universalResidentialAdapter;
  return adapter.buildEndpoint(providerDefinition(provider), secret, request);
}

function endpointPort(endpointKey) {
  const value = Number(String(endpointKey).slice(String(endpointKey).lastIndexOf(":") + 1));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new ProxyRuntimeUnavailableError("Leased proxy endpoint has an invalid port");
  return value;
}

function circuitBlocks(circuit, now) {
  if (!circuit || circuit.state !== "open") return false;
  const retryAt = Date.parse(String(circuit.retryAt || ""));
  return !Number.isFinite(retryAt) || retryAt > now;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createProxyRuntimeService({ providerService, leaseCoordinator, endpointBuilder = defaultEndpointBuilder, now = Date.now }) {
  if (!providerService || !leaseCoordinator) throw new Error("Proxy runtime requires provider and lease services");
  const repository = providerService.repository;

  return {
    async resolve(input) {
      const campaignRecordId = String(input?.campaignRecordId || "").trim();
      if (!campaignRecordId) throw new ProxyPolicyNotFoundError("campaignRecordId is required");
      const policy = await repository.getPolicy(campaignRecordId);
      if (!policy?.enabled) throw new ProxyPolicyNotFoundError();
      const [providers, pools, circuits] = await Promise.all([repository.listProviders(), repository.listPools(), repository.listCircuits()]);
      const providerMap = new Map(providers.map((provider) => [provider.providerId, provider]));
      const candidates = [policy.primaryProviderId, ...policy.fallbackProviderIds];
      const failures = [];

      for (const providerId of candidates) {
        const provider = providerMap.get(providerId);
        if (!provider?.enabled) { failures.push(`${providerId}: disabled or missing`); continue; }
        const providerPools = pools.filter((pool) => pool.providerId === providerId && pool.enabled);
        const pool = providerId === policy.primaryProviderId
          ? providerPools.find((item) => item.poolId === policy.primaryPoolId)
          : providerPools[0];
        if (!pool) { failures.push(`${providerId}: no enabled pool`); continue; }
        const checkedAt = now();
        const circuit = circuits.find((item) => item.providerId === providerId && item.poolId === pool.poolId && (item.endpointKey === "*" || !item.endpointKey));
        if (circuitBlocks(circuit, checkedAt)) { failures.push(`${providerId}: pool circuit open`); continue; }

        let lease;
        try {
          const endpointKeys = pool.endpointPorts
            .map((port) => `${provider.gatewayHost}:${port}`)
            .filter((endpointKey) => !circuitBlocks(circuits.find((item) => item.providerId === providerId && item.poolId === pool.poolId && item.endpointKey === endpointKey), checkedAt));
          if (!endpointKeys.length) { failures.push(`${providerId}: every endpoint circuit is open`); continue; }
          lease = await leaseCoordinator.acquire({
            providerId, poolId: pool.poolId, campaignId: campaignRecordId, endpointKeys,
            sessionId: String(input?.sessionId || campaignRecordId), rotationMode: policy.rotationMode,
            ttlMs: Math.max(30_000, Math.min(300_000, Number(input?.leaseTtlMs) || DEFAULT_LEASE_TTL_MS)),
            metadata: { source: "universal-proxy-runtime" },
          });
          const secret = await providerService.runtimeSecret(providerId);
          const endpoint = await endpointBuilder(provider, secret, {
            geo: { ...policy.geo, ...(input?.geo || {}) },
            asn: input?.asn ? String(input.asn) : undefined,
            rotationMode: policy.rotationMode,
            sessionId: String(input?.sessionId || campaignRecordId),
            ttlSeconds: policy.stickyTtlSeconds,
            port: endpointPort(lease.endpointKey),
          });
          return {
            leaseId: lease.leaseId, fencingToken: lease.fencingToken, providerId, poolId: pool.poolId,
            endpointKey: lease.endpointKey, proxyUrl: endpoint.url.toString(), protocol: endpoint.protocol,
            rotationMode: policy.rotationMode, leaseTtlMs: Math.max(30_000, lease.expiresAt - now()),
            fallbackUsed: providerId !== policy.primaryProviderId,
          };
        } catch (error) {
          if (lease) await leaseCoordinator.release(lease, "released").catch(() => undefined);
          failures.push(`${providerId}: ${errorText(error)}`);
          if (!(error instanceof ProxyLeaseUnavailableError)) continue;
        }
      }
      throw new ProxyRuntimeUnavailableError(`No proxy provider could serve ${campaignRecordId}: ${failures.join("; ")}`);
    },

    async renew(leaseId, ttlMs = DEFAULT_LEASE_TTL_MS) {
      const lease = await repository.getLease?.(leaseId) || await leaseCoordinator.repository?.get?.(leaseId);
      if (!lease) return null;
      return leaseCoordinator.renew(lease, ttlMs);
    },

    async release(leaseId, state = "released") {
      const lease = await repository.getLease?.(leaseId) || await leaseCoordinator.repository?.get?.(leaseId);
      if (!lease) return false;
      return leaseCoordinator.release(lease, state);
    },

    async report(input) {
      const lookupStarted = now();
      const lease = await repository.getLease?.(String(input?.leaseId || "")) || await leaseCoordinator.repository?.get?.(String(input?.leaseId || ""));
      if (!lease) throw new ProxyRuntimeUnavailableError("Proxy lease was not found for health reporting");
      const databaseLatencyMs = Math.max(0, now() - lookupStarted);
      const healthy = input?.healthy === true;
      await providerService.recordHealth({
        providerId: lease.providerId, poolId: lease.poolId, endpointKey: lease.endpointKey, healthy,
        reason: healthy ? "" : String(input?.reason || "proxy journey failed"), proxyLatencyMs: input?.proxyLatencyMs,
        payloadBytes: input?.payloadBytes, browserCpuMs: input?.browserCpuMs, browserMemoryBytes: input?.browserMemoryBytes,
        databaseLatencyMs, redisLatencyMs: input?.redisLatencyMs,
      });
      const circuits = await repository.listCircuits();
      const current = circuits.find((item) => item.providerId === lease.providerId && item.poolId === lease.poolId && item.endpointKey === lease.endpointKey) || {
        providerId: lease.providerId, poolId: lease.poolId, endpointKey: lease.endpointKey, state: "closed", consecutiveFailures: 0, consecutiveSuccesses: 0,
      };
      let next;
      if (healthy) {
        const successes = Number(current.consecutiveSuccesses || 0) + 1;
        const recovered = current.state === "closed" || successes >= RECOVERY_SUCCESSES;
        next = { ...current, state: recovered ? "closed" : "half-open", consecutiveFailures: 0, consecutiveSuccesses: recovered ? 0 : successes, openedAt: null, retryAt: null };
      } else {
        const failures = Number(current.consecutiveFailures || 0) + 1;
        const open = failures >= FAILURE_THRESHOLD;
        next = { ...current, state: open ? "open" : "closed", consecutiveFailures: failures, consecutiveSuccesses: 0, openedAt: open ? new Date(now()).toISOString() : current.openedAt || null, retryAt: open ? new Date(now() + OPEN_DURATION_MS).toISOString() : null };
      }
      await repository.upsertCircuit(next);
      return next;
    },
    repository,
    leaseCoordinator,
  };
}

const shared = globalThis.__tahProxyRuntimeState || (globalThis.__tahProxyRuntimeState = {});

export async function configuredProxyRuntimeService() {
  if (!["1", "true"].includes(String(process.env.TAH_UNIVERSAL_PROXY_ENABLED || "").toLowerCase())) return null;
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  const redisUrl = String(process.env.REDIS_URL || "").trim();
  if (!databaseUrl || !redisUrl) throw new ProxyRuntimeUnavailableError("DATABASE_URL and REDIS_URL are required for universal proxy runtime");
  if (shared.runtime) return shared.runtime;
  const providerService = await configuredProxyProviderService();
  if (!providerService || !(await providerService.status()).migrated) throw new ProxyRuntimeUnavailableError("Universal proxy migration 006 is required");
  shared.pool ||= new Pool({ connectionString: databaseUrl, max: Math.max(1, Math.min(8, Number(process.env.TAH_PROXY_LEASE_DB_POOL_MAX) || 4)), application_name: "tah-proxy-runtime" });
  if (!shared.redis) {
    shared.redis = createClient({ url: redisUrl });
    shared.redis.on("error", () => undefined);
    await shared.redis.connect();
  }
  const leaseRepository = createPostgresProxyLeaseRepository(shared.pool);
  const leaseCoordinator = createProxyLeaseCoordinator({ repository: leaseRepository, lock: createRedisProxyLeaseLock(shared.redis), ownerId: `proxy-runtime-${process.pid}` });
  // Expose the repository explicitly so renew/report/release can retrieve the
  // fenced lease without relying on caller-supplied lease fields.
  leaseCoordinator.repository = leaseRepository;
  shared.runtime = createProxyRuntimeService({ providerService, leaseCoordinator });
  return shared.runtime;
}
