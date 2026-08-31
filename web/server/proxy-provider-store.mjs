import { Pool } from "pg";
import { decryptProxySecret, encryptProxySecret } from "./proxy-secret-vault.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const PROVIDER_TYPES = new Set(["iproyal", "universal", "custom"]);
const PROTOCOLS = new Set(["http", "https", "socks5"]);
const AUTH_MODES = new Set(["username-password", "token", "ip-allowlist"]);
const ROTATION_MODES = new Set(["per-request", "sticky-session", "port-pool", "provider-managed"]);
const MAX_HEALTH_SAMPLES = 2_000;

function text(value, field, max = 256, required = true) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} is too long`);
  return result;
}

function identifier(value, field) {
  const result = text(value, field, 64).toLowerCase();
  if (!ID_PATTERN.test(result)) throw new Error(`${field} must contain only lowercase letters, numbers, dots, underscores, or hyphens`);
  return result;
}

function enumValue(value, field, allowed) {
  const result = text(value, field, 64).toLowerCase();
  if (!allowed.has(result)) throw new Error(`${field} is not supported`);
  return result;
}

function host(value) {
  const result = text(value, "gatewayHost", 253).toLowerCase().replace(/\.$/, "");
  if (/[/\\@\s]/.test(result) || result.includes(":")) throw new Error("gatewayHost must be a hostname or IPv4 address without a scheme, path, or port");
  try {
    const parsed = new URL(`http://${result}`);
    if (parsed.hostname !== result || !parsed.hostname) throw new Error("invalid");
  } catch {
    throw new Error("gatewayHost is invalid");
  }
  return result;
}

function ports(value, field = "gatewayPorts") {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  const result = [...new Set(source.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1 && item <= 65535))];
  if (!result.length || result.length > 5_000) throw new Error(`${field} must contain between 1 and 5,000 valid ports`);
  return result;
}

function stringList(value, field, allowed, max = 16) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  const result = [...new Set(source.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (!result.length || result.length > max || result.some((item) => !allowed.has(item))) throw new Error(`${field} contains an unsupported value`);
  return result;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function normalizeProvider(input, existing = {}) {
  const providerId = identifier(input?.providerId ?? existing.providerId, "providerId");
  const providerType = enumValue(input?.providerType ?? existing.providerType ?? "universal", "providerType", PROVIDER_TYPES);
  const protocol = enumValue(input?.protocol ?? existing.protocol ?? "http", "protocol", PROTOCOLS);
  const authMode = enumValue(input?.authMode ?? existing.authMode ?? "username-password", "authMode", AUTH_MODES);
  const rotationModes = stringList(input?.rotationModes ?? existing.rotationModes ?? ["provider-managed"], "rotationModes", ROTATION_MODES);
  return {
    providerId,
    name: text(input?.name ?? existing.name ?? providerId, "name", 120),
    providerType,
    enabled: input?.enabled === undefined ? existing.enabled !== false : input.enabled === true,
    protocol,
    gatewayHost: host(input?.gatewayHost ?? existing.gatewayHost),
    gatewayPorts: ports(input?.gatewayPorts ?? existing.gatewayPorts),
    authMode,
    usernameTemplate: text(input?.usernameTemplate ?? existing.usernameTemplate ?? "{username}", "usernameTemplate", 512, false),
    passwordTemplate: text(input?.passwordTemplate ?? existing.passwordTemplate ?? "{password}", "passwordTemplate", 512, false),
    rotationModes,
    capabilities: plainObject(input?.capabilities ?? existing.capabilities),
    healthConfig: plainObject(input?.healthConfig ?? existing.healthConfig),
    createdAt: existing.createdAt || iso(),
    updatedAt: iso(),
  };
}

function normalizePool(input, existing = {}) {
  const poolId = identifier(input?.poolId ?? existing.poolId, "poolId");
  const providerId = identifier(input?.providerId ?? existing.providerId, "providerId");
  return {
    poolId,
    providerId,
    name: text(input?.name ?? existing.name ?? poolId, "name", 120),
    enabled: input?.enabled === undefined ? existing.enabled !== false : input.enabled === true,
    endpointPorts: ports(input?.endpointPorts ?? existing.endpointPorts, "endpointPorts"),
    defaultRotationMode: enumValue(input?.defaultRotationMode ?? existing.defaultRotationMode ?? "provider-managed", "defaultRotationMode", ROTATION_MODES),
    maxConcurrentPerEndpoint: Math.max(1, Math.min(100, Number(input?.maxConcurrentPerEndpoint ?? existing.maxConcurrentPerEndpoint ?? 1) || 1)),
    config: plainObject(input?.config ?? existing.config),
    createdAt: existing.createdAt || iso(),
    updatedAt: iso(),
  };
}

function normalizePolicy(input, existing = {}) {
  const fallbackProviderIds = [...new Set((Array.isArray(input?.fallbackProviderIds) ? input.fallbackProviderIds : existing.fallbackProviderIds || [])
    .map((item) => identifier(item, "fallbackProviderId")))];
  const primaryProviderId = identifier(input?.primaryProviderId ?? existing.primaryProviderId, "primaryProviderId");
  if (fallbackProviderIds.includes(primaryProviderId)) throw new Error("A fallback provider must differ from the primary provider");
  return {
    campaignRecordId: text(input?.campaignRecordId ?? existing.campaignRecordId, "campaignRecordId", 160),
    primaryProviderId,
    primaryPoolId: identifier(input?.primaryPoolId ?? existing.primaryPoolId, "primaryPoolId"),
    rotationMode: enumValue(input?.rotationMode ?? existing.rotationMode ?? "provider-managed", "rotationMode", ROTATION_MODES),
    fallbackProviderIds,
    stickyTtlSeconds: Math.max(60, Math.min(86_400, Number(input?.stickyTtlSeconds ?? existing.stickyTtlSeconds ?? 1_800) || 1_800)),
    geo: plainObject(input?.geo ?? existing.geo),
    enabled: input?.enabled === undefined ? existing.enabled !== false : input.enabled === true,
    createdAt: existing.createdAt || iso(),
    updatedAt: iso(),
  };
}

function summarizeSamples(samples) {
  if (!samples.length) return { samples: 0, healthy: null, successRate: null, latencyP95Ms: null, payloadBytes: 0, browserCpuMs: 0, browserMemoryBytes: 0, databaseLatencyP95Ms: null, redisLatencyP95Ms: null, lastObservedAt: null };
  const percentile = (values, ratio) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
  };
  const latest = [...samples].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  return {
    samples: samples.length,
    healthy: latest.healthy,
    successRate: samples.filter((item) => item.healthy).length / samples.length,
    latencyP95Ms: percentile(samples.map((item) => item.proxyLatencyMs), 0.95),
    payloadBytes: samples.reduce((total, item) => total + (Number(item.payloadBytes) || 0), 0),
    browserCpuMs: samples.reduce((total, item) => total + (Number(item.browserCpuMs) || 0), 0),
    browserMemoryBytes: Math.max(0, ...samples.map((item) => Number(item.browserMemoryBytes) || 0)),
    databaseLatencyP95Ms: percentile(samples.map((item) => item.databaseLatencyMs), 0.95),
    redisLatencyP95Ms: percentile(samples.map((item) => item.redisLatencyMs), 0.95),
    lastObservedAt: latest.observedAt,
  };
}

function publicProvider(provider, secretConfigured, circuits, samples) {
  return {
    ...provider,
    secretConfigured,
    circuit: circuits.find((item) => item.providerId === provider.providerId) || null,
    metrics: summarizeSamples(samples.filter((item) => item.providerId === provider.providerId)),
  };
}

export function createMemoryProxyProviderRepository() {
  const state = {
    providers: new Map(), secrets: new Map(), pools: new Map(), policies: new Map(), circuits: new Map(), samples: [],
  };
  return {
    async status() { return { configured: true, migrated: true }; },
    async listProviders() { return [...state.providers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); },
    async getProvider(id) { return state.providers.get(id) || null; },
    async upsertProvider(provider) { state.providers.set(provider.providerId, structuredClone(provider)); return structuredClone(provider); },
    async setProviderEnabled(id, enabled) { const current = state.providers.get(id); if (!current) return null; return this.upsertProvider({ ...current, enabled, updatedAt: iso() }); },
    async setSecretEnvelope(id, envelope) { state.secrets.set(id, structuredClone(envelope)); },
    async getSecretEnvelope(id) { return state.secrets.has(id) ? structuredClone(state.secrets.get(id)) : null; },
    async secretProviderIds() { return [...state.secrets.keys()]; },
    async listPools() { return [...state.pools.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); },
    async getPool(id) { return state.pools.get(id) || null; },
    async upsertPool(pool) { state.pools.set(pool.poolId, structuredClone(pool)); return structuredClone(pool); },
    async listPolicies() { return [...state.policies.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); },
    async getPolicy(id) { return state.policies.get(id) || null; },
    async upsertPolicy(policy) { state.policies.set(policy.campaignRecordId, structuredClone(policy)); return structuredClone(policy); },
    async listCircuits() { return [...state.circuits.values()]; },
    async upsertCircuit(circuit) { const key = `${circuit.providerId}:${circuit.poolId || "*"}:${circuit.endpointKey || "*"}`; state.circuits.set(key, structuredClone(circuit)); return structuredClone(circuit); },
    async resetCircuit(providerId, poolId = "*") { for (const [key, value] of state.circuits) if (value.providerId === providerId && (poolId === "*" || value.poolId === poolId)) state.circuits.delete(key); },
    async listHealthSamples() { return structuredClone(state.samples); },
    async recordHealth(sample) { state.samples.push(structuredClone(sample)); if (state.samples.length > MAX_HEALTH_SAMPLES) state.samples.splice(0, state.samples.length - MAX_HEALTH_SAMPLES); },
  };
}

function providerFromRow(row) {
  return {
    providerId: row.provider_id, name: row.name, providerType: row.provider_type, enabled: row.enabled,
    protocol: row.protocol, gatewayHost: row.gateway_host, gatewayPorts: row.gateway_ports,
    authMode: row.auth_mode, usernameTemplate: row.username_template || "", passwordTemplate: row.password_template || "",
    rotationModes: row.rotation_modes, capabilities: row.capabilities || {}, healthConfig: row.health_config || {},
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function poolFromRow(row) {
  return {
    poolId: row.pool_id, providerId: row.provider_id, name: row.name, enabled: row.enabled,
    endpointPorts: row.endpoint_ports, defaultRotationMode: row.default_rotation_mode,
    maxConcurrentPerEndpoint: row.max_concurrent_per_endpoint, config: row.config || {},
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function policyFromRow(row) {
  return {
    campaignRecordId: row.campaign_record_id, primaryProviderId: row.primary_provider_id, primaryPoolId: row.primary_pool_id,
    rotationMode: row.rotation_mode, fallbackProviderIds: row.fallback_provider_ids || [], stickyTtlSeconds: row.sticky_ttl_seconds,
    geo: row.geo || {}, enabled: row.enabled, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function createPostgresProxyProviderRepository(pool) {
  if (!pool?.query) throw new Error("A PostgreSQL pool is required");
  return {
    async status() {
      const result = await pool.query("SELECT to_regclass('public.tah_proxy_providers') AS providers, to_regclass('public.tah_proxy_leases') AS leases");
      return { configured: true, migrated: Boolean(result.rows[0]?.providers && result.rows[0]?.leases) };
    },
    async listProviders() { const result = await pool.query("SELECT * FROM tah_proxy_providers ORDER BY created_at, provider_id"); return result.rows.map(providerFromRow); },
    async getProvider(id) { const result = await pool.query("SELECT * FROM tah_proxy_providers WHERE provider_id = $1", [id]); return result.rows[0] ? providerFromRow(result.rows[0]) : null; },
    async upsertProvider(provider) {
      const result = await pool.query(`INSERT INTO tah_proxy_providers
        (provider_id,name,provider_type,enabled,protocol,gateway_host,gateway_ports,auth_mode,username_template,password_template,rotation_modes,capabilities,health_config,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (provider_id) DO UPDATE SET name=EXCLUDED.name,provider_type=EXCLUDED.provider_type,enabled=EXCLUDED.enabled,protocol=EXCLUDED.protocol,gateway_host=EXCLUDED.gateway_host,gateway_ports=EXCLUDED.gateway_ports,auth_mode=EXCLUDED.auth_mode,username_template=EXCLUDED.username_template,password_template=EXCLUDED.password_template,rotation_modes=EXCLUDED.rotation_modes,capabilities=EXCLUDED.capabilities,health_config=EXCLUDED.health_config,updated_at=EXCLUDED.updated_at RETURNING *`,
      [provider.providerId,provider.name,provider.providerType,provider.enabled,provider.protocol,provider.gatewayHost,provider.gatewayPorts,provider.authMode,provider.usernameTemplate,provider.passwordTemplate,provider.rotationModes,provider.capabilities,provider.healthConfig,provider.createdAt,provider.updatedAt]);
      return providerFromRow(result.rows[0]);
    },
    async setProviderEnabled(id, enabled) { const result = await pool.query("UPDATE tah_proxy_providers SET enabled=$2,updated_at=now() WHERE provider_id=$1 RETURNING *", [id, enabled]); return result.rows[0] ? providerFromRow(result.rows[0]) : null; },
    async setSecretEnvelope(id, envelope) { await pool.query(`INSERT INTO tah_proxy_provider_secrets (provider_id,key_id,secret_envelope,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (provider_id) DO UPDATE SET key_id=EXCLUDED.key_id,secret_envelope=EXCLUDED.secret_envelope,updated_at=now()`, [id, envelope.keyId, envelope]); },
    async getSecretEnvelope(id) { const result = await pool.query("SELECT secret_envelope FROM tah_proxy_provider_secrets WHERE provider_id=$1", [id]); return result.rows[0]?.secret_envelope || null; },
    async secretProviderIds() { const result = await pool.query("SELECT provider_id FROM tah_proxy_provider_secrets"); return result.rows.map((row) => row.provider_id); },
    async listPools() { const result = await pool.query("SELECT * FROM tah_proxy_pools ORDER BY created_at,pool_id"); return result.rows.map(poolFromRow); },
    async getPool(id) { const result = await pool.query("SELECT * FROM tah_proxy_pools WHERE pool_id=$1", [id]); return result.rows[0] ? poolFromRow(result.rows[0]) : null; },
    async upsertPool(item) { const result = await pool.query(`INSERT INTO tah_proxy_pools (pool_id,provider_id,name,enabled,endpoint_ports,default_rotation_mode,max_concurrent_per_endpoint,config,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (pool_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,name=EXCLUDED.name,enabled=EXCLUDED.enabled,endpoint_ports=EXCLUDED.endpoint_ports,default_rotation_mode=EXCLUDED.default_rotation_mode,max_concurrent_per_endpoint=EXCLUDED.max_concurrent_per_endpoint,config=EXCLUDED.config,updated_at=EXCLUDED.updated_at RETURNING *`, [item.poolId,item.providerId,item.name,item.enabled,item.endpointPorts,item.defaultRotationMode,item.maxConcurrentPerEndpoint,item.config,item.createdAt,item.updatedAt]); return poolFromRow(result.rows[0]); },
    async listPolicies() { const result = await pool.query("SELECT * FROM tah_campaign_proxy_policies ORDER BY created_at,campaign_record_id"); return result.rows.map(policyFromRow); },
    async getPolicy(id) { const result = await pool.query("SELECT * FROM tah_campaign_proxy_policies WHERE campaign_record_id=$1", [id]); return result.rows[0] ? policyFromRow(result.rows[0]) : null; },
    async upsertPolicy(item) { const result = await pool.query(`INSERT INTO tah_campaign_proxy_policies (campaign_record_id,primary_provider_id,primary_pool_id,rotation_mode,fallback_provider_ids,sticky_ttl_seconds,geo,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (campaign_record_id) DO UPDATE SET primary_provider_id=EXCLUDED.primary_provider_id,primary_pool_id=EXCLUDED.primary_pool_id,rotation_mode=EXCLUDED.rotation_mode,fallback_provider_ids=EXCLUDED.fallback_provider_ids,sticky_ttl_seconds=EXCLUDED.sticky_ttl_seconds,geo=EXCLUDED.geo,enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at RETURNING *`, [item.campaignRecordId,item.primaryProviderId,item.primaryPoolId,item.rotationMode,item.fallbackProviderIds,item.stickyTtlSeconds,item.geo,item.enabled,item.createdAt,item.updatedAt]); return policyFromRow(result.rows[0]); },
    async listCircuits() { const result = await pool.query("SELECT provider_id AS \"providerId\",pool_id AS \"poolId\",endpoint_key AS \"endpointKey\",state,consecutive_failures AS \"consecutiveFailures\",consecutive_successes AS \"consecutiveSuccesses\",opened_at AS \"openedAt\",retry_at AS \"retryAt\",updated_at AS \"updatedAt\" FROM tah_proxy_circuit_states"); return result.rows; },
    async upsertCircuit(item) { await pool.query(`INSERT INTO tah_proxy_circuit_states (provider_id,pool_id,endpoint_key,state,consecutive_failures,consecutive_successes,opened_at,retry_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT (provider_id,pool_id,endpoint_key) DO UPDATE SET state=EXCLUDED.state,consecutive_failures=EXCLUDED.consecutive_failures,consecutive_successes=EXCLUDED.consecutive_successes,opened_at=EXCLUDED.opened_at,retry_at=EXCLUDED.retry_at,updated_at=now()`, [item.providerId,item.poolId || "*",item.endpointKey || "*",item.state,item.consecutiveFailures || 0,item.consecutiveSuccesses || 0,item.openedAt || null,item.retryAt || null]); return item; },
    async resetCircuit(providerId, poolId = "*") { await pool.query(poolId === "*" ? "DELETE FROM tah_proxy_circuit_states WHERE provider_id=$1" : "DELETE FROM tah_proxy_circuit_states WHERE provider_id=$1 AND pool_id=$2", poolId === "*" ? [providerId] : [providerId,poolId]); },
    async listHealthSamples() { const result = await pool.query(`SELECT provider_id AS "providerId",pool_id AS "poolId",endpoint_key AS "endpointKey",healthy,reason,proxy_latency_ms AS "proxyLatencyMs",payload_bytes AS "payloadBytes",browser_cpu_ms AS "browserCpuMs",browser_memory_bytes AS "browserMemoryBytes",database_latency_ms AS "databaseLatencyMs",redis_latency_ms AS "redisLatencyMs",observed_at AS "observedAt" FROM tah_proxy_health_samples WHERE observed_at > now() - interval '24 hours' ORDER BY observed_at DESC LIMIT $1`, [MAX_HEALTH_SAMPLES]); return result.rows.map((row) => ({ ...row, observedAt: new Date(row.observedAt).toISOString() })); },
    async recordHealth(item) { await pool.query(`INSERT INTO tah_proxy_health_samples (provider_id,pool_id,endpoint_key,healthy,reason,proxy_latency_ms,payload_bytes,browser_cpu_ms,browser_memory_bytes,database_latency_ms,redis_latency_ms,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [item.providerId,item.poolId || null,item.endpointKey || null,item.healthy,item.reason || null,item.proxyLatencyMs ?? null,item.payloadBytes || 0,item.browserCpuMs || 0,item.browserMemoryBytes || 0,item.databaseLatencyMs ?? null,item.redisLatencyMs ?? null,item.observedAt || iso()]); },
  };
}

export function createProxyProviderService({ repository, vaultKey, keyId = "primary" }) {
  if (!repository) throw new Error("A proxy provider repository is required");
  return {
    async status() { return repository.status(); },
    async overview() {
      const [status, providers, pools, policies, circuits, samples, secretIds] = await Promise.all([repository.status(), repository.listProviders(), repository.listPools(), repository.listPolicies(), repository.listCircuits(), repository.listHealthSamples(), repository.secretProviderIds()]);
      const secretSet = new Set(secretIds);
      return {
        ...status,
        providers: providers.map((provider) => publicProvider(provider, secretSet.has(provider.providerId), circuits, samples)),
        pools,
        policies,
        summary: {
          providers: providers.length,
          enabledProviders: providers.filter((item) => item.enabled).length,
          pools: pools.length,
          assignedCampaigns: policies.filter((item) => item.enabled).length,
          openCircuits: circuits.filter((item) => item.state === "open").length,
          unhealthyProviders: providers.filter((provider) => summarizeSamples(samples.filter((item) => item.providerId === provider.providerId)).healthy === false).length,
        },
      };
    },
    async saveProvider(input, secret) {
      const existing = input?.providerId ? await repository.getProvider(String(input.providerId).toLowerCase()) : null;
      const provider = normalizeProvider(input, existing || {});
      await repository.upsertProvider(provider);
      if (secret && Object.values(secret).some((value) => String(value || "").length)) await this.saveSecret(provider.providerId, secret);
      return publicProvider(provider, Boolean(await repository.getSecretEnvelope(provider.providerId)), await repository.listCircuits(), await repository.listHealthSamples());
    },
    async saveSecret(providerId, secret) {
      const id = identifier(providerId, "providerId");
      if (!await repository.getProvider(id)) throw new Error("Provider not found");
      if (!vaultKey) throw new Error("TAH_PROXY_VAULT_KEY is required before credentials can be stored");
      const clean = plainObject(secret);
      if (!Object.keys(clean).length) throw new Error("At least one credential value is required");
      const envelope = encryptProxySecret(clean, vaultKey, keyId);
      await repository.setSecretEnvelope(id, envelope);
      return { providerId: id, secretConfigured: true, keyId: envelope.keyId };
    },
    async runtimeSecret(providerId) {
      if (!vaultKey) throw new Error("TAH_PROXY_VAULT_KEY is required");
      const envelope = await repository.getSecretEnvelope(identifier(providerId, "providerId"));
      if (!envelope) throw new Error("Provider credentials are not configured");
      return decryptProxySecret(envelope, vaultKey);
    },
    async savePool(input) {
      const existing = input?.poolId ? await repository.getPool(String(input.poolId).toLowerCase()) : null;
      const item = normalizePool(input, existing || {});
      const provider = await repository.getProvider(item.providerId);
      if (!provider) throw new Error("Provider not found");
      if (!provider.rotationModes.includes(item.defaultRotationMode)) throw new Error("Pool rotation mode is not supported by its provider");
      return repository.upsertPool(item);
    },
    async assignPolicy(input) {
      const existing = input?.campaignRecordId ? await repository.getPolicy(String(input.campaignRecordId)) : null;
      const item = normalizePolicy(input, existing || {});
      const [provider, pool] = await Promise.all([repository.getProvider(item.primaryProviderId), repository.getPool(item.primaryPoolId)]);
      if (!provider || !pool || pool.providerId !== provider.providerId) throw new Error("Primary provider and pool do not match");
      if (!provider.rotationModes.includes(item.rotationMode)) throw new Error("Campaign rotation mode is not supported by its provider");
      for (const fallbackId of item.fallbackProviderIds) if (!await repository.getProvider(fallbackId)) throw new Error(`Fallback provider ${fallbackId} was not found`);
      return repository.upsertPolicy(item);
    },
    async setProviderEnabled(providerId, enabled) {
      const result = await repository.setProviderEnabled(identifier(providerId, "providerId"), enabled === true);
      if (!result) throw new Error("Provider not found");
      return result;
    },
    async resetCircuit(providerId, poolId) { await repository.resetCircuit(identifier(providerId, "providerId"), poolId ? identifier(poolId, "poolId") : "*"); },
    async recordHealth(input) {
      const providerId = identifier(input?.providerId, "providerId");
      if (!await repository.getProvider(providerId)) throw new Error("Provider not found");
      await repository.recordHealth({
        providerId, poolId: input?.poolId ? identifier(input.poolId, "poolId") : null, endpointKey: text(input?.endpointKey, "endpointKey", 320, false) || null,
        healthy: input?.healthy === true, reason: text(input?.reason, "reason", 500, false) || null,
        proxyLatencyMs: Number.isFinite(Number(input?.proxyLatencyMs)) ? Number(input.proxyLatencyMs) : null,
        payloadBytes: Math.max(0, Number(input?.payloadBytes) || 0), browserCpuMs: Math.max(0, Number(input?.browserCpuMs) || 0), browserMemoryBytes: Math.max(0, Number(input?.browserMemoryBytes) || 0),
        databaseLatencyMs: Number.isFinite(Number(input?.databaseLatencyMs)) ? Number(input.databaseLatencyMs) : null,
        redisLatencyMs: Number.isFinite(Number(input?.redisLatencyMs)) ? Number(input.redisLatencyMs) : null, observedAt: iso(),
      });
    },
    repository,
  };
}

const shared = globalThis.__tahProxyProviderState || (globalThis.__tahProxyProviderState = {});

export async function configuredProxyProviderService() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) return null;
  if (!shared.pool) shared.pool = new Pool({ connectionString: databaseUrl, max: Math.max(1, Math.min(10, Number(process.env.TAH_PROXY_DB_POOL_MAX) || 4)), application_name: "tah-proxy-registry" });
  if (!shared.repository) shared.repository = createPostgresProxyProviderRepository(shared.pool);
  const vaultKey = String(process.env.TAH_PROXY_VAULT_KEY || "").trim() || null;
  return createProxyProviderService({ repository: shared.repository, vaultKey, keyId: String(process.env.TAH_PROXY_VAULT_KEY_ID || "primary") });
}
