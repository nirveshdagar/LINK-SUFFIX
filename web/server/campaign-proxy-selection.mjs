import { configuredProxyProviderService } from "./proxy-provider-store.mjs";
import { saveCampaignProxy } from "./proxy-provider-setup.mjs";

export function assertProxySelectionReady(campaign) {
  if (campaign?.proxySelectionPending) throw new Error("Proxy selection is not complete. Open campaign Edit and Save changes again before starting.");
}

export async function prepareCampaignProxySelection(payload, existing, options = {}) {
  if (typeof payload.proxyPoolId !== "string") return null;
  const poolId = payload.proxyPoolId.trim();
  if (poolId && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(poolId)) throw new Error("Invalid proxy pool selection");
  const registry = Boolean(poolId);
  if (registry && !["1", "true"].includes(String(options.runtimeEnabled ?? process.env.TAH_UNIVERSAL_PROXY_ENABLED).toLowerCase())) throw new Error("Enable the Provider Registry runtime before selecting EVOMI or another saved provider");
  if (registry && (payload.tier !== "human" || payload.mitm === true)) throw new Error("Saved proxy pools require continuous browser journeys without MITM");
  if (registry && !/^[A-Z]{2}$/.test(String(payload.geo?.country || ""))) throw new Error("Select a two-letter country for the proxy route");
  const service = options.service || ((registry || (existing && process.env.DATABASE_URL)) ? await configuredProxyProviderService() : null);
  if (registry && !service) throw new Error("Proxy provider storage is unavailable");
  const policy = service && existing ? await service.repository.getPolicy(existing.id) : null;
  const currentPoolId = policy?.enabled ? policy.primaryPoolId : "";
  const pool = registry ? await service.repository.getPool(poolId) : null;
  const provider = pool ? await service.repository.getProvider(pool.providerId) : null;
  if (registry && (!pool?.enabled || !provider?.enabled)) throw new Error("Select an enabled provider and its matching pool");
  if (registry && provider.authMode !== "ip-allowlist") await service.runtimeSecret(provider.providerId);
  const changed = poolId !== currentPoolId || existing?.proxySelectionPending === true;
  if (changed && existing && (existing.status !== "stopped" || existing.desiredRunning === true || existing.activeRunId)) throw new Error("Stop the campaign and wait for its active run to finish before switching proxy provider");
  return {
    registry, changed,
    payload: { ...payload, proxyPoolId: poolId, proxyProviderMode: registry ? "registry" : "legacy", proxyProviderId: provider?.providerId || "iproyal" },
    assignment: {
      enabled: registry, primaryProviderId: provider?.providerId, primaryPoolId: pool?.poolId,
      rotationMode: pool?.defaultRotationMode,
      stickyTtlSeconds: provider?.providerType === "iproyal" ? 3600 : 1800,
      fallbackProviderIds: [], geo: { ...payload.geo },
    },
  };
}

// Persist a non-runnable draft first. A crash or failed assignment must never
// launch a campaign through its previous provider or an unassigned legacy route.
export async function settleCampaignProxySelection(campaign, selection, { persist, assign = saveCampaignProxy }) {
  if (!selection?.changed) return;
  const settledStatus = campaign.status;
  campaign.proxySelectionPending = true;
  campaign.status = "stopped";
  campaign.desiredRunning = false;
  await persist();
  try {
    await assign({ ...selection.assignment, campaignRecordId: campaign.id });
    campaign.proxySelectionPending = false;
    campaign.status = settledStatus;
    campaign.lastError = undefined;
    await persist();
  } catch (error) {
    campaign.proxySelectionPending = true;
    campaign.status = "stopped";
    campaign.desiredRunning = false;
    campaign.lastError = "Proxy selection could not be completed. Open Edit and Save changes again.";
    await persist().catch(() => undefined);
    throw new Error("Campaign " + campaign.id + " remains stopped: " + (error instanceof Error ? error.message : "proxy selection failed"));
  }
}
