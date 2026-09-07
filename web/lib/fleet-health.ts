export type FleetHealth = {
  label: string;
  tone: "healthy" | "attention" | "paused" | "waiting" | "active";
};

export type FleetShardHealthInput = {
  enabled: boolean;
  registered?: boolean;
  campaign_count?: number | string | null;
  last_poll_at?: string | null;
  last_ack_at?: string | null;
  last_error?: string | null;
};

export type FleetCampaignHealthInput = {
  enabled: boolean;
  delivery_health?: string;
  newest_update_state?: string;
  latest_job_state?: string | null;
  last_error?: string | null;
  last_applied_at?: string | null;
  account_readiness?: string;
};

type HealthOptions = {
  now: number;
  staleAfterMs: number;
  hasActiveAlert?: boolean;
};

function workerConnection(shard: FleetShardHealthInput | undefined, options: HealthOptions) {
  if (!shard || shard.registered === false) return "missing";
  if (!shard.enabled) return "paused";
  const lastPoll = Date.parse(String(shard.last_poll_at || ""));
  if (!Number.isFinite(lastPoll)) return "unseen";
  if (options.now - lastPoll > options.staleAfterMs) return "stale";
  return "connected";
}

export function getShardHealth(
  shard: FleetShardHealthInput | undefined,
  options: HealthOptions,
): FleetHealth {
  switch (workerConnection(shard, options)) {
    case "missing": return { label: "No worker", tone: "attention" };
    case "paused": return { label: "Paused", tone: "paused" };
    case "unseen": return { label: "Awaiting first run", tone: "waiting" };
    case "stale": return { label: "Worker stale", tone: "attention" };
  }
  // An alert can belong to a campaign in this shard. It is not proof of lost contact.
  if (options.hasActiveAlert || shard?.last_error) return { label: "Attention", tone: "attention" };
  if (Number(shard?.campaign_count || 0) > 0 && !shard?.last_ack_at) {
    return { label: "Polling - no verified delivery", tone: "active" };
  }
  return { label: "Healthy", tone: "healthy" };
}

export function getCampaignHealth(
  campaign: FleetCampaignHealthInput,
  shard: FleetShardHealthInput | undefined,
  options: HealthOptions,
): FleetHealth {
  if (!campaign.enabled) return { label: "Paused", tone: "paused" };
  // Connectivity is independent of aggregate shard alert severity.
  switch (workerConnection(shard, options)) {
    case "missing": return { label: "No shard worker", tone: "attention" };
    case "paused": return { label: "Shard paused", tone: "paused" };
    case "unseen": return { label: "Awaiting first worker run", tone: "waiting" };
    case "stale": return { label: "Worker unavailable", tone: "attention" };
  }
  // A previous successful delivery must not hide a current failure or delayed update.
  if (campaign.newest_update_state === "delayed") return { label: "Delivery delayed", tone: "attention" };
  if (campaign.latest_job_state === "dead" || campaign.latest_job_state === "failed") {
    return { label: "Delivery failed", tone: "attention" };
  }
  if (campaign.newest_update_state === "retrying") return { label: "Delivery retrying", tone: "attention" };
  if (campaign.delivery_health === "attention" || campaign.last_error) {
    return { label: "Attention", tone: "attention" };
  }
  if (campaign.delivery_health === "healthy") return { label: "Healthy", tone: "healthy" };
  if (!campaign.last_applied_at && campaign.account_readiness === "waiting_for_manifest") {
    return { label: "Waiting for worker manifest", tone: "waiting" };
  }
  if (!campaign.last_applied_at && campaign.account_readiness === "waiting_for_account_poll") {
    return { label: "Waiting for account worker", tone: "waiting" };
  }
  if (campaign.latest_job_state === "leased") return { label: "Delivering", tone: "active" };
  if (campaign.latest_job_state === "pending") return { label: "Waiting", tone: "waiting" };
  if (campaign.latest_job_state === "applied") return { label: "Verified", tone: "healthy" };
  return { label: "Enrolled", tone: "waiting" };
}
