import { Pool } from "pg";
import { createPostgresProxyProviderRepository } from "./proxy-provider-store.mjs";

export function registryRunRequired(policy, payload, options) {
  if (!policy?.enabled) return false;
  if (!options.runtimeEnabled) throw new Error("The saved proxy requires universal proxy runtime to be enabled");
  if (options.noProxy) throw new Error("The saved proxy cannot run while direct networking is enabled");
  if (!options.sharedEnabled || payload.tier !== "human" || payload.continuous !== true || payload.mitm === true) {
    throw new Error("The saved proxy requires continuous shared-browser mode without MITM");
  }
  return true;
}

export function legacyRunPort(payload, { registry = false, direct = false, fallbackPort } = {}) {
  if (registry || direct) return null;
  const port = Number(payload.proxyPort ?? fallbackPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Select a valid dedicated gateway port");
  return port;
}

export function assertLegacyPortAvailable(port, runs) {
  if (port !== null && runs.some(run => Number(run.proxyPort) === port)) {
    throw new Error("Gateway port " + port + " is already leased by another active run");
  }
}

export function selectQueuedCampaign(campaigns, leased, registryIds, now) {
  return [...campaigns].sort((a, b) => a.number - b.number).find(item =>
    item.status === "queued" && item.desiredRunning && Number(item.nextRetryAt ?? 0) <= now &&
    (registryIds.has(item.id) || !leased.has(Number(item.config.proxyPort))));
}

export function createCampaignProxyAdmission({ databaseUrl, pool: suppliedPool } = {}) {
  let pool = suppliedPool;
  let repository;
  function database() {
    if (!pool && databaseUrl) pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: "tah-proxy-admission" });
    if (pool) repository ||= createPostgresProxyProviderRepository(pool);
    return pool;
  }
  return {
    async policyFor(campaignRecordId) {
      if (!campaignRecordId || !database()) return null;
      const policy = await repository.getPolicy(String(campaignRecordId));
      return policy?.enabled ? policy : null;
    },
    async registryCampaignIds() {
      if (!database()) return new Set();
      const result = await pool.query("SELECT campaign_record_id FROM tah_campaign_proxy_policies WHERE enabled = true");
      return new Set(result.rows.map(row => row.campaign_record_id));
    },
  };
}
