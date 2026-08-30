"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type BridgeSummary = {
  campaigns?: number;
  pending?: number;
  leased?: number;
  applied?: number;
  dead?: number;
  unassigned?: number;
  updates_in_flight?: number;
  delayed?: number;
  oldest_queue_age_ms?: number;
  p95_delay_ms?: number;
  throughput_last_15m?: number;
  active_shards?: number;
  offline_shards?: number;
  ready_accounts?: number;
  waiting_accounts?: number;
  largest_account_batch?: number;
};

type BridgeShard = {
  shard_id: string;
  manager_customer_id?: string | null;
  enabled: boolean;
  registered?: boolean;
  campaign_count?: number;
  capacity?: number;
  last_poll_at?: string | null;
  last_ack_at?: string | null;
  last_error?: string | null;
};

type BridgeCampaign = {
  target_id: string;
  campaign_record_id: string;
  campaign_name: string;
  manager_customer_id: string;
  customer_id: string;
  google_campaign_id: string;
  shard_id: string;
  enabled: boolean;
  latest_version?: number | null;
  exact_suffix?: string | null;
  captured_at?: string | null;
  latest_job_state?: string | null;
  attempt_count?: number | null;
  last_error?: string | null;
  applied_at?: string | null;
  last_applied_at?: string | null;
  last_applied_suffix?: string | null;
  account_manifest_seen_at?: string | null;
  account_last_poll_at?: string | null;
  account_ready?: boolean;
  account_readiness?: "established" | "ready" | "waiting_for_account_poll" | "waiting_for_manifest";
  delivery_health?: "healthy" | "attention" | "awaiting";
  newest_update_state?: "queued" | "processing" | "current" | "retrying" | "delayed" | "waiting";
  queue_age_ms?: number | string | null;
};

type SavedFleetCampaign = {
  id: string;
  number: number;
  name: string;
  status: string;
  config: {
    customerId?: string;
    googleCampaignId?: string;
    loginCustomerId?: string;
    useScriptMesh?: boolean;
    scriptFleetShardId?: string;
  };
};

type BridgeResponse = {
  configured: boolean;
  error?: string;
  summary?: BridgeSummary;
  campaigns?: { page: number; pageSize: number; total: number; items: BridgeCampaign[] };
  shards?: BridgeShard[];
};

type ScriptBridgeProps = {
  campaigns?: SavedFleetCampaign[];
  controlConnected?: boolean;
  onSetFleetCampaign?: (campaignRecordId: string, enabled: boolean, shardId: string) => boolean;
};

type HealthState = {
  label: string;
  tone: "healthy" | "active" | "waiting" | "attention" | "paused";
};

const SHARD_CAPACITY = 40;
const SHARD_STALE_AFTER_MS = 75 * 60 * 1000;
const SHARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const normalizedId = (value?: string) => String(value || "").replace(/\D/g, "");
const hasCompleteTarget = (campaign: SavedFleetCampaign) =>
  /^\d{10}$/.test(normalizedId(campaign.config.loginCustomerId))
  && /^\d{10}$/.test(normalizedId(campaign.config.customerId))
  && /^\d{8,20}$/.test(normalizedId(campaign.config.googleCampaignId));

function formatTimestamp(value?: string | null) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Unknown";
}

function formatDuration(value?: number | string | null) {
  const milliseconds = Math.max(0, Number(value || 0));
  if (!Number.isFinite(milliseconds) || milliseconds < 1_000) return "0s";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shardHealth(shard?: BridgeShard): HealthState {
  if (!shard || shard.registered === false) return { label: "No worker", tone: "attention" };
  if (!shard.enabled) return { label: "Paused", tone: "paused" };
  if (shard.last_error) return { label: "Attention", tone: "attention" };
  const lastPoll = Date.parse(String(shard.last_poll_at || ""));
  if (!Number.isFinite(lastPoll)) return { label: "Awaiting first run", tone: "waiting" };
  if (Date.now() - lastPoll > SHARD_STALE_AFTER_MS) return { label: "Worker stale", tone: "attention" };
  if (Number(shard.campaign_count || 0) > 0 && !shard.last_ack_at) return { label: "Polling · no verified delivery", tone: "active" };
  return { label: "Healthy", tone: "healthy" };
}

function targetHealth(campaign: BridgeCampaign, shard?: BridgeShard): HealthState {
  if (!campaign.enabled) return { label: "Paused", tone: "paused" };
  if (!shard || shard.registered === false) return { label: "No shard worker", tone: "attention" };
  if (campaign.delivery_health === "healthy") return { label: "Healthy", tone: "healthy" };
  if (!campaign.last_applied_at && campaign.account_readiness === "waiting_for_manifest") {
    return { label: "Waiting for worker manifest", tone: "waiting" };
  }
  if (!campaign.last_applied_at && campaign.account_readiness === "waiting_for_account_poll") {
    return { label: "Waiting for account worker", tone: "waiting" };
  }
  if (campaign.last_error || campaign.latest_job_state === "dead" || campaign.latest_job_state === "failed") {
    return { label: "Attention", tone: "attention" };
  }
  const worker = shardHealth(shard);
  if (worker.tone === "attention") return { label: "Worker unavailable", tone: "attention" };
  if (worker.tone === "paused") return { label: "Shard paused", tone: "paused" };
  if (campaign.latest_job_state === "leased") return { label: "Delivering", tone: "active" };
  if (campaign.latest_job_state === "pending") return { label: "Waiting", tone: "waiting" };
  if (campaign.latest_job_state === "applied") return { label: "Verified", tone: "healthy" };
  return { label: "Enrolled", tone: "waiting" };
}

export function ScriptBridge({
  campaigns: savedCampaigns = [],
  controlConnected = false,
  onSetFleetCampaign,
}: ScriptBridgeProps = {}) {
  const [status, setStatus] = useState<BridgeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [campaignQuery, setCampaignQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedShardId, setSelectedShardId] = useState("");
  const [newShardId, setNewShardId] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [generatedScript, setGeneratedScript] = useState("");
  const [generatedForShard, setGeneratedForShard] = useState("");
  const [generating, setGenerating] = useState(false);
  const [actionCampaignId, setActionCampaignId] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (window.location.protocol === "https:" && !publicBaseUrl) setPublicBaseUrl(window.location.origin);
  }, [publicBaseUrl]);

  const refresh = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (debouncedQuery) params.set("q", debouncedQuery);
      const response = await fetch("/api/script-bridge?" + params.toString(), {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const body = await response.json() as BridgeResponse;
      if (!response.ok) throw new Error(body.error || "Fleet status failed (" + response.status + ")");
      setStatus(body);
      setError("");
    } catch (nextError) {
      if ((nextError as { name?: string }).name !== "AbortError") {
        setError(nextError instanceof Error ? nextError.message : "Fleet status failed");
      }
    } finally {
      if (!signal?.aborted && !silent) setLoading(false);
    }
  }, [debouncedQuery, page]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal, true), 5_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const targetItems = status?.campaigns?.items || [];
  const shardOptions = useMemo(() => {
    const byId = new Map<string, BridgeShard>();
    for (const shard of status?.shards || []) {
      byId.set(shard.shard_id, {
        ...shard,
        registered: shard.registered !== false,
        campaign_count: Number(shard.campaign_count || 0),
        capacity: Number(shard.capacity || SHARD_CAPACITY),
      });
    }
    for (const campaign of targetItems) {
      if (!byId.has(campaign.shard_id)) {
        byId.set(campaign.shard_id, {
          shard_id: campaign.shard_id,
          enabled: false,
          registered: false,
          campaign_count: targetItems.filter((item) => item.enabled && item.shard_id === campaign.shard_id).length,
          capacity: SHARD_CAPACITY,
        });
      }
    }
    if (selectedShardId && !byId.has(selectedShardId)) {
      byId.set(selectedShardId, {
        shard_id: selectedShardId,
        enabled: false,
        registered: false,
        campaign_count: 0,
        capacity: SHARD_CAPACITY,
      });
    }
    return Array.from(byId.values()).sort((left, right) => left.shard_id.localeCompare(right.shard_id));
  }, [selectedShardId, status?.shards, targetItems]);

  useEffect(() => {
    if (selectedShardId && shardOptions.some((shard) => shard.shard_id === selectedShardId)) return;
    const preferred = shardOptions.find((shard) => shard.registered && shardHealth(shard).tone === "healthy")
      || shardOptions.find((shard) => shard.registered)
      || shardOptions[0];
    if (preferred) setSelectedShardId(preferred.shard_id);
  }, [selectedShardId, shardOptions]);

  const selectedShard = shardOptions.find((shard) => shard.shard_id === selectedShardId);
  const selectedShardCount = Number(selectedShard?.campaign_count || 0);
  const selectedShardCapacity = Number(selectedShard?.capacity || SHARD_CAPACITY);
  const selectedShardFull = selectedShardCount >= selectedShardCapacity;

  async function generateWorker() {
    const shardId = selectedShardId.trim();
    if (!SHARD_ID_PATTERN.test(shardId)) {
      setError("Choose a valid shard ID before generating its worker.");
      return;
    }
    setGenerating(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/script-bridge", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate-worker",
          publicBaseUrl: publicBaseUrl.trim(),
          shardId,
        }),
      });
      const body = await response.json() as { script?: string; error?: string };
      if (!response.ok || !body.script) throw new Error(body.error || "Worker generation failed");
      setGeneratedScript(body.script);
      setGeneratedForShard(shardId);
      setNotice("Durable two-phase v8 worker generated for " + shardId + ". Copy it into the matching MCC and schedule it Hourly.");
      void refresh(undefined, true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Worker generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function copyWorker() {
    if (!generatedScript) return;
    await navigator.clipboard.writeText(generatedScript);
    setNotice("The complete " + generatedForShard + " worker script was copied.");
  }

  function chooseNewShard() {
    const value = newShardId.trim();
    if (!SHARD_ID_PATTERN.test(value)) {
      setError("Shard IDs must start with a letter or number and use only letters, numbers, period, underscore, colon, or hyphen.");
      return;
    }
    setSelectedShardId(value);
    setNewShardId("");
    setError("");
    setNotice("Shard " + value + " is selected. Generate its worker before production delivery.");
  }

  function requestFleetUpdate(campaign: SavedFleetCampaign, enabled: boolean) {
    const nextShardId = selectedShardId.trim();
    setError("");
    setNotice("");
    if (!enabled && !window.confirm(`Permanently delete ${campaign.name} from Fleet? Its captured suffixes and delivery-job history will also be deleted.`)) return;
    if (enabled && !hasCompleteTarget(campaign)) {
      setError("Add a valid 10-digit MCC ID, 10-digit customer ID, and Google Ads campaign ID to this saved campaign first.");
      return;
    }
    if (enabled && !SHARD_ID_PATTERN.test(nextShardId)) {
      setError("Select a valid shard before adding or moving a campaign.");
      return;
    }
    if (!controlConnected || !onSetFleetCampaign) {
      setError("The control server must be connected before Fleet enrollment can change.");
      return;
    }
    setActionCampaignId(campaign.id);
    if (!onSetFleetCampaign(campaign.id, enabled, nextShardId || "default")) {
      setActionCampaignId("");
      setError("The control server did not accept the enrollment request.");
      return;
    }
    setNotice(campaign.name + (enabled
      ? " is being assigned to shard " + nextShardId + "."
      : " is being permanently deleted from Fleet delivery."));
    window.setTimeout(() => {
      setActionCampaignId("");
      void refresh(undefined, true);
    }, 1200);
  }

  async function deleteFleetTarget(campaign: BridgeCampaign) {
    if (!window.confirm(`Permanently delete ${campaign.campaign_name} from Fleet? Its captured suffixes and delivery-job history will also be deleted.`)) return;
    setActionCampaignId(campaign.campaign_record_id);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/script-bridge", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete-target", targetId: campaign.target_id }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Fleet deletion failed");
      setNotice(`${campaign.campaign_name} and its Fleet delivery history were permanently deleted.`);
      await refresh(undefined, true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Fleet deletion failed");
    } finally {
      setActionCampaignId("");
    }
  }

  const summary = status?.summary;
  const fleetCampaigns = status?.campaigns;
  const totalPages = Math.max(1, Math.ceil((fleetCampaigns?.total || 0) / (fleetCampaigns?.pageSize || 25)));
  const activeRegisteredShards = shardOptions.filter((shard) => shard.registered && shard.enabled);
  const everyActiveShardHealthy = activeRegisteredShards.length > 0
    && activeRegisteredShards.every((shard) => shardHealth(shard).tone === "healthy");
  const workerAttention = activeRegisteredShards.some((shard) => shardHealth(shard).tone === "attention");
  const deliveryActive = Number(summary?.pending || 0) + Number(summary?.leased || 0) > 0;
  const unassigned = Number(summary?.unassigned || 0);
  const healthy = status?.configured === true
    && !loading
    && !error
    && Number(summary?.dead || 0) === 0
    && unassigned === 0
    && !deliveryActive
    && everyActiveShardHealthy;
  const overallLabel = loading
    ? "Checking"
    : error || Number(summary?.dead || 0) > 0
      ? "Attention required"
      : unassigned > 0
        ? "Shard mismatch"
        : activeRegisteredShards.length === 0
          ? "Worker required"
          : workerAttention
            ? "Worker attention"
            : deliveryActive
              ? "Delivery active"
              : everyActiveShardHealthy
                ? "Healthy"
                : "Awaiting verified delivery";
  const overallTone = healthy ? "is-healthy" : error || Number(summary?.dead || 0) > 0 || unassigned > 0 || workerAttention ? "is-error" : "is-loading";
  const normalizedCampaignQuery = campaignQuery.trim().toLowerCase();
  const matchingSavedCampaigns = savedCampaigns.filter((campaign) => {
    if (!normalizedCampaignQuery) return true;
    return [campaign.name, campaign.id, campaign.number, campaign.config.customerId, campaign.config.googleCampaignId]
      .some((value) => String(value || "").toLowerCase().includes(normalizedCampaignQuery));
  });
  const visibleSavedCampaigns = matchingSavedCampaigns.slice(0, 10);

  return (
    <section className="bridge-panel fleet-console" aria-labelledby="fleet-title">
      <header className="bridge-heading fleet-console-heading">
        <div>
          <p className="eyebrow">Relational delivery channel</p>
          <h2 id="fleet-title">Rolling Apps Script Fleet</h2>
          <p>One live console for captured suffixes, verified Google Ads delivery, campaign health, shard assignment, and the durable two-phase v8 Fleet workers.</p>
        </div>
        <span className={"bridge-health " + overallTone}>{overallLabel}</span>
      </header>

      <div className="bridge-metrics" aria-label="Fleet totals">
        {[
          ["Campaigns", Number(summary?.campaigns || 0).toLocaleString()],
          ["Updates in flight", Number(summary?.updates_in_flight || 0).toLocaleString()],
          ["Delayed", Number(summary?.delayed || 0).toLocaleString()],
          ["Oldest queue age", formatDuration(summary?.oldest_queue_age_ms)],
          ["p95 delivery delay", formatDuration(summary?.p95_delay_ms)],
          ["Applied · last 15m", Number(summary?.throughput_last_15m || 0).toLocaleString()],
          ["Active shards", Number(summary?.active_shards || 0).toLocaleString()],
          ["Offline shards", Number(summary?.offline_shards || 0).toLocaleString()],
          ["Ready account workers", Number(summary?.ready_accounts || 0).toLocaleString()],
          ["Accounts awaiting worker", Number(summary?.waiting_accounts || 0).toLocaleString()],
          ["Largest account batch", Number(summary?.largest_account_batch || 0).toLocaleString()],
          ["Pending", Number(summary?.pending || 0).toLocaleString()],
          ["Processing", Number(summary?.leased || 0).toLocaleString()],
          ["Dead letter", Number(summary?.dead || 0).toLocaleString()],
        ].map(([label, value]) => (
          <div key={String(label)}><span>{label}</span><strong>{loading ? "-" : value}</strong></div>
        ))}
      </div>

      <div className="fleet-shard-strip" aria-label="Fleet shards">
        {shardOptions.length === 0 && <p className="bridge-empty">No shard exists yet. Enter a shard ID below and generate its worker.</p>}
        {shardOptions.map((shard) => {
          const health = shardHealth(shard);
          const count = Number(shard.campaign_count || 0);
          const capacity = Number(shard.capacity || SHARD_CAPACITY);
          return (
            <button
              className={"fleet-shard-tab " + (selectedShardId === shard.shard_id ? "is-selected" : "")}
              type="button"
              key={shard.shard_id}
              onClick={() => setSelectedShardId(shard.shard_id)}
            >
              <span><strong>{shard.shard_id}</strong><small>{count} / {capacity} campaigns</small></span>
              <span className={"health-chip is-" + health.tone}>{health.label}</span>
              <i aria-hidden="true"><b style={{ width: Math.min(100, (count / capacity) * 100) + "%" }} /></i>
            </button>
          );
        })}
      </div>

      <section className="fleet-matrix" aria-labelledby="fleet-matrix-title">
        <div className="fleet-table-toolbar">
          <div><p className="eyebrow">All-in-one campaign view</p><h3 id="fleet-matrix-title">Campaign delivery matrix</h3></div>
          <label htmlFor="fleet-search">Find a campaign</label>
          <input id="fleet-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, number, customer, or campaign ID" />
          <button type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button>
        </div>

        <div className="fleet-table-scroll" aria-busy={loading}>
          <table className="fleet-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Suffix captured</th>
                <th>Suffix inserted in Google Ads</th>
                  <th>Delivery health / newest update</th>
                <th>Shard ID</th>
              </tr>
            </thead>
            <tbody>
              {!loading && !targetItems.length && (
                <tr><td colSpan={5}><p className="bridge-empty">No Fleet campaign matches this view.</p></td></tr>
              )}
              {targetItems.map((campaign) => {
                const shard = shardOptions.find((item) => item.shard_id === campaign.shard_id);
                const health = targetHealth(campaign, shard);
                const savedCampaign = savedCampaigns.find((item) => item.id === campaign.campaign_record_id);
                const busy = actionCampaignId === campaign.campaign_record_id;
                const hasVerifiedDelivery = campaign.last_applied_suffix != null && Boolean(campaign.last_applied_at);
                return (
                  <tr key={campaign.target_id}>
                    <td className="fleet-campaign-cell">
                      <strong>{campaign.campaign_name}</strong>
                      <small>{campaign.campaign_record_id}</small>
                      <dl>
                        <div><dt>Campaign</dt><dd>{campaign.google_campaign_id}</dd></div>
                        <div><dt>Customer</dt><dd>{campaign.customer_id}</dd></div>
                        <div><dt>Manager</dt><dd>{campaign.manager_customer_id || "Direct"}</dd></div>
                      </dl>
                    </td>
                    <td className="fleet-suffix-cell">
                      {campaign.exact_suffix != null
                        ? <code>{campaign.exact_suffix || "(empty suffix)"}</code>
                        : <span className="fleet-cell-empty">No capture yet</span>}
                      <small>{campaign.captured_at ? "Captured " + formatTimestamp(campaign.captured_at) : "Waiting for browser capture"}</small>
                      <small>Version {campaign.latest_version || "-"}</small>
                    </td>
                    <td className="fleet-suffix-cell fleet-inserted-cell">
                      {hasVerifiedDelivery
                        ? <code>{campaign.last_applied_suffix || "(empty suffix)"}</code>
                        : <span className="fleet-cell-empty">{!campaign.exact_suffix && !campaign.account_ready ? "Journey held until account worker is ready" : campaign.latest_job_state === "pending" ? "Awaiting worker" : campaign.latest_job_state === "leased" ? "Being applied" : "Not verified yet"}</span>}
                      <small>{hasVerifiedDelivery ? "Verified " + formatTimestamp(campaign.last_applied_at) : "Exact value appears only after acknowledgement"}</small>
                    </td>
                    <td className="fleet-health-cell">
                      <span className={"health-chip is-" + health.tone}>{health.label}</span>
                      <small>Account worker · {campaign.account_readiness === "established" ? "Delivery established" : campaign.account_ready ? "Ready" : campaign.account_readiness === "waiting_for_account_poll" ? "Waiting for customer poll" : "Waiting for next manifest"}</small>
                      <small>Account poll · {formatTimestamp(campaign.account_last_poll_at)}</small>
                      <small>Newest update · {String(campaign.newest_update_state || "waiting").replace(/^./, (value) => value.toUpperCase())}</small>
                      {Number(campaign.queue_age_ms || 0) > 0 && <small>Queue age · {formatDuration(campaign.queue_age_ms)}</small>}
                      <small>Attempts {campaign.attempt_count || 0}</small>
                      {campaign.last_error && <p>{campaign.last_error}</p>}
                    </td>
                    <td className="fleet-shard-cell">
                      <strong>{campaign.shard_id}</strong>
                      <small>{Number(shard?.campaign_count || 0)} / {Number(shard?.capacity || SHARD_CAPACITY)} campaigns</small>
                      <span className={"health-chip is-" + shardHealth(shard).tone}>{shardHealth(shard).label}</span>
                      <button className="bridge-inline-action" type="button" disabled={busy || Boolean(savedCampaign && !controlConnected)} onClick={() => savedCampaign ? requestFleetUpdate(savedCampaign, false) : void deleteFleetTarget(campaign)}>
                        {busy ? "Deleting..." : "Delete from Fleet"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <nav className="bridge-pagination" aria-label="Fleet campaign pages">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button>
          <span>Page {page} of {totalPages} · {(fleetCampaigns?.total || 0).toLocaleString()} campaigns</span>
          <button type="button" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}>Next</button>
        </nav>
      </section>

      <div className="fleet-bottom-grid">
        <section className="fleet-config-card" aria-labelledby="fleet-add-title">
          <header><p className="eyebrow">Campaign assignment</p><h3 id="fleet-add-title">Add campaigns to a shard</h3><p>Select one shard, then add or move saved campaigns into its 40-campaign capacity.</p></header>

          <div className="fleet-shard-picker">
            <label htmlFor="fleet-selected-shard">Selected shard</label>
            <select id="fleet-selected-shard" value={selectedShardId} onChange={(event) => setSelectedShardId(event.target.value)}>
              {shardOptions.length === 0 && <option value="">No shard selected</option>}
              {shardOptions.map((shard) => <option key={shard.shard_id} value={shard.shard_id}>{shard.shard_id} · {Number(shard.campaign_count || 0)}/{Number(shard.capacity || SHARD_CAPACITY)}</option>)}
            </select>
            <div>
              <input aria-label="New shard ID" value={newShardId} onChange={(event) => setNewShardId(event.target.value)} placeholder="New shard ID" />
              <button type="button" onClick={chooseNewShard} disabled={!newShardId.trim()}>Use new shard</button>
            </div>
          </div>

          <div className="fleet-capacity-card">
            <div><span>Selected shard capacity</span><strong>{selectedShardCount} / {selectedShardCapacity}</strong></div>
            <i aria-hidden="true"><b style={{ width: Math.min(100, (selectedShardCount / selectedShardCapacity) * 100) + "%" }} /></i>
            <small>{selectedShardFull ? "This shard is full." : (selectedShardCapacity - selectedShardCount) + " campaign places remain."}</small>
          </div>

          <div className="fleet-campaign-picker">
            <label htmlFor="fleet-campaign-search">Select saved campaigns</label>
            <input id="fleet-campaign-search" type="search" value={campaignQuery} onChange={(event) => setCampaignQuery(event.target.value)} placeholder="Name, number, customer, or campaign ID" />
            <div>
              {visibleSavedCampaigns.length === 0 && <p className="bridge-empty">No saved campaign matches this search.</p>}
              {visibleSavedCampaigns.map((campaign) => {
                const complete = hasCompleteTarget(campaign);
                const enrolled = campaign.config.useScriptMesh === true;
                const currentShard = campaign.config.scriptFleetShardId || "default";
                const inSelectedShard = enrolled && currentShard === selectedShardId;
                const busy = actionCampaignId === campaign.id;
                return (
                  <article key={campaign.id}>
                    <div>
                      <strong>{String(campaign.number).padStart(3, "0")} · {campaign.name}</strong>
                      <small>{complete ? normalizedId(campaign.config.loginCustomerId) + " / " + normalizedId(campaign.config.customerId) + " / " + normalizedId(campaign.config.googleCampaignId) : "MCC, customer, and campaign IDs required"}</small>
                    </div>
                    <span className={"health-chip " + (inSelectedShard ? "is-healthy" : enrolled ? "is-active" : complete ? "is-waiting" : "is-attention")}>{inSelectedShard ? "In this shard" : enrolled ? currentShard : complete ? "Available" : "Incomplete"}</span>
                    <div>
                      {enrolled && <button className="bridge-secondary-action" type="button" disabled={busy || !controlConnected} onClick={() => requestFleetUpdate(campaign, false)}>{busy ? "Deleting..." : "Delete from Fleet"}</button>}
                      {!inSelectedShard && <button type="button" disabled={busy || !complete || !controlConnected || !selectedShardId} onClick={() => requestFleetUpdate(campaign, true)}>{busy ? "Saving..." : enrolled ? "Move to shard" : selectedShardFull ? "Add to next shard" : "Add to shard"}</button>}
                    </div>
                  </article>
                );
              })}
            </div>
            {matchingSavedCampaigns.length > visibleSavedCampaigns.length && <small>Refine the search to reach the other {(matchingSavedCampaigns.length - visibleSavedCampaigns.length).toLocaleString()} campaigns.</small>}
          </div>
        </section>

        <section className="fleet-script-card" aria-labelledby="fleet-script-title">
          <header><p className="eyebrow">Selected shard worker</p><h3 id="fleet-script-title">Generate the v8 durable two-phase shard script</h3><p>Choose the exact shard below before generating. The script belongs only to that shard and MCC, preserves V5's stable pacing, renews delivery leases, and discovers newly added campaigns during the active hour. It can service at most 40 assigned campaigns.</p></header>

          <div className="fleet-worker-shard-picker">
            <label htmlFor="fleet-worker-shard">Shard to generate</label>
            <select id="fleet-worker-shard" value={selectedShardId} onChange={(event) => setSelectedShardId(event.target.value)}>
              {shardOptions.length === 0 && <option value="">No shard selected</option>}
              {shardOptions.map((shard) => (
                <option key={shard.shard_id} value={shard.shard_id}>
                  {shard.shard_id} · {Number(shard.campaign_count || 0)}/{Number(shard.capacity || SHARD_CAPACITY)} campaigns · {shardHealth(shard).label}
                </option>
              ))}
            </select>
            <small>New shards appear here automatically. Select the new shard before generating or rotating its worker.</small>
          </div>

          <div className="fleet-script-shard">
            <div><span>Shard ID</span><strong>{selectedShardId || "Not selected"}</strong><small>MCC {selectedShard?.manager_customer_id || "assigned by the first campaign"}</small></div>
            <span className={"health-chip is-" + shardHealth(selectedShard).tone}>{shardHealth(selectedShard).label}</span>
          </div>

          <label htmlFor="fleet-public-url">Public HTTPS base URL</label>
          <input id="fleet-public-url" value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="https://traffic.example.com" inputMode="url" />
          <button className="bridge-primary-action" type="button" onClick={generateWorker} disabled={generating || !publicBaseUrl.trim() || !selectedShardId}>
            {generating ? "Generating v8 durable worker..." : selectedShard?.registered ? "Rotate token and regenerate v8 durable worker" : "Generate v8 durable worker for selected shard"}
          </button>
          <p className="fleet-script-warning">Install this v8 copy once for durable delivery and hot-add support. Generating again rotates the secret and immediately invalidates the older installed copy for this shard.</p>

          {generatedScript && generatedForShard === selectedShardId ? (
            <div className="fleet-script-output">
              <div><strong>{generatedForShard} · fleet-two-phase-durable-relay-v8</strong><button type="button" onClick={copyWorker}>Copy script</button><button className="bridge-secondary-action" type="button" onClick={() => setGeneratedScript("")}>Hide</button></div>
              <textarea readOnly value={generatedScript} aria-label={generatedForShard + " Google Ads worker script"} spellCheck={false} />
            </div>
          ) : (
            <div className="fleet-script-placeholder">The complete Apps Script for <strong>{selectedShardId || "the selected shard"}</strong> will appear here.</div>
          )}

          {selectedShard && (
            <dl className="fleet-worker-telemetry">
              <div><dt>Last poll</dt><dd>{formatTimestamp(selectedShard.last_poll_at)}</dd></div>
              <div><dt>Last acknowledgement</dt><dd>{formatTimestamp(selectedShard.last_ack_at)}</dd></div>
              <div><dt>Campaign load</dt><dd>{selectedShardCount} / {selectedShardCapacity}</dd></div>
            </dl>
          )}
        </section>
      </div>

      {notice && <p className="bridge-notice" role="status">{notice}</p>}
      {error && <p className="bridge-error" role="alert">{error}</p>}
      {!status?.configured && !loading && !error && <p className="bridge-error">DATABASE_URL is required before the production Fleet can operate.</p>}
    </section>
  );
}
