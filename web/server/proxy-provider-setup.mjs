import { Pool } from "pg";
import { createPostgresProxyProviderRepository, createProxyProviderService } from "./proxy-provider-store.mjs";
import { automaticPool, credentialInput, defaultPoolId, isEvomi } from "./proxy-setup-core.mjs";

let sharedPool;
function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return sharedPool ||= new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: "tah-proxy-setup" });
}

export async function proxySetupTransaction(work, options = {}) {
  const pool = options.pool || database();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const repository = createPostgresProxyProviderRepository(client);
    const service = createProxyProviderService({
      repository,
      vaultKey: options.vaultKey || process.env.TAH_PROXY_VAULT_KEY,
      keyId: options.keyId || process.env.TAH_PROXY_VAULT_KEY_ID || "primary",
    });
    const result = await work(service, client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function saveProviderSetup(input, supplied, options = {}) {
  return proxySetupTransaction(async (service, client) => {
    const id = String(input?.providerId || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new Error("Invalid provider ID");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["proxy-setup:" + id]);
    const existing = await service.repository.getProvider(id);
    const provider = { ...existing, ...input, providerId: id };
    let previous = {};
    if (await service.repository.getSecretEnvelope(id)) previous = await service.runtimeSecret(id);
    const secret = credentialInput(provider, supplied, previous);
    if (isEvomi(provider)) {
      provider.rotationModes = ["sticky-session"];
      provider.capabilities = { country: true, state: true, city: true, asn: false, stickySession: true, maximumSessionSeconds: 86400 };
      provider.usernameTemplate = "{username}";
      provider.passwordTemplate = "{password}";
    }
    const saved = await service.saveProvider(provider, secret);
    const poolId = defaultPoolId(id);
    const currentPool = await service.repository.getPool(poolId);
    if (currentPool && currentPool.providerId !== id) throw new Error("Automatic pool belongs to a different provider");
    const next = automaticPool(saved, currentPool);
    const pool = next === currentPool ? currentPool : await service.savePool(next);
    return { provider: saved, pool };
  }, options);
}

export async function saveCampaignProxy(input, options = {}) {
  return proxySetupTransaction(async (service, client) => {
    const campaignRecordId = String(input?.campaignRecordId || "").trim();
    if (!campaignRecordId) throw new Error("campaignRecordId is required");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["campaign-proxy:" + campaignRecordId]);
    const campaigns = await client.query("SELECT payload FROM tah_control_state WHERE name=$1", ["campaigns"]);
    const campaign = Array.isArray(campaigns.rows[0]?.payload) ? campaigns.rows[0].payload.find(item => item.id === campaignRecordId) : null;
    if (!campaign) throw new Error("Saved campaign was not found");
    if (campaign.status !== "stopped" || campaign.desiredRunning === true || campaign.activeRunId) throw new Error("Stop the campaign and wait for its active run to finish before changing proxy selection");
    if (input.enabled === false) {
      await client.query("UPDATE tah_campaign_proxy_policies SET enabled=false,updated_at=now() WHERE campaign_record_id=$1", [campaignRecordId]);
      return { campaignRecordId, enabled: false };
    }
    if (campaign.config?.tier !== "human" || campaign.config?.continuous !== true || campaign.config?.mitm === true) throw new Error("Saved proxy selection requires continuous browser mode without MITM");
    const provider = await service.repository.getProvider(String(input.primaryProviderId || ""));
    const pool = await service.repository.getPool(String(input.primaryPoolId || ""));
    if (!provider?.enabled || !pool?.enabled || pool.providerId !== provider.providerId) throw new Error("Select an enabled provider and its matching pool");
    if (provider.authMode !== "ip-allowlist") await service.runtimeSecret(provider.providerId);
    const existing = await service.repository.getPolicy(campaignRecordId);
    return service.assignPolicy({
      ...existing, ...input, campaignRecordId, enabled: true,
      primaryProviderId: provider.providerId, primaryPoolId: pool.poolId,
      rotationMode: input.rotationMode || pool.defaultRotationMode,
      fallbackProviderIds: (input.fallbackProviderIds || existing?.fallbackProviderIds || []).filter(id => id !== provider.providerId),
      stickyTtlSeconds: input.stickyTtlSeconds || existing?.stickyTtlSeconds || 1800,
      geo: input.geo || existing?.geo || {},
    });
  }, options);
}
