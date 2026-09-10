"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getCampaignHealth, getShardHealth } from "../lib/fleet-health";
import { normalizeFleetManagerId } from "../lib/fleet-shard-config";

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

type CaptureEgress = {
  ip?: string;
  country?: string;
  state?: string;
  city?: string;
  timezone?: string;
  asn?: number;
  organization?: string;
  isp?: string;
  intelligenceProvider?: string;
  proxyProvider?: string;
  proxyMode?: string;
  confidence?: "stable_session" | "observed_probe" | "direct";
  verified?: boolean;
  observedAt?: string;
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
  capture_egress?: CaptureEgress | null;
  previous_capture_egress?: CaptureEgress | null;
};

type SavedFleetCampaign = {
  latestSuffix?: string;
  lastCapturedAt?: string;
  latestCaptureEvidence?: { kind: string; capturedAt: string; runId: string };
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

type FleetAlert = {
  status: "observing" | "active" | "acknowledged" | "resolved";
  campaignRecordId?: string;
  shardId?: string;
};

type FleetAlertReport = {
  alerts?: FleetAlert[];
  error?: string;
};

type FleetIndicatorState = "checking" | "healthy" | "issue";

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
const VERIFIED_SUFFIX_VISIBLE_MS = 7_000;
const SHARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const normalizedId = (value?: string) => String(value || "").replace(/\D/g, "");
const hasCompleteTarget = (campaign: SavedFleetCampaign) =>
  /^\d{10}$/.test(normalizedId(campaign.config.loginCustomerId))
  && /^\d{10}$/.test(normalizedId(campaign.config.customerId))
  && /^\d{8,20}$/.test(normalizedId(campaign.config.googleCampaignId));

function shardColorOrdinal(shardId: string) {
  const sequence = shardId.match(/(?:^|[-_.:])(\d+)$/);
  if (sequence) {
    const ordinal = Number(sequence[1]);
    if (Number.isSafeInteger(ordinal) && ordinal > 0) return ordinal;
  }

  let hash = 2166136261;
  for (const character of shardId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) + 1;
}

function shardVisualStyle(shardId: string): CSSProperties {
  const ordinal = shardColorOrdinal(shardId);
  const palettePosition = ((ordinal - 1) * 82.123 + 73) % 215;
  const hue = Math.round(palettePosition < 60 ? palettePosition : palettePosition + 145);
  const saturation = 36 + ((ordinal * 5) % 11);
  return {
    "--fleet-shard-surface": `hsl(${hue} ${saturation}% 95%)`,
    "--fleet-shard-surface-strong": `hsl(${hue} ${saturation}% 90%)`,
    "--fleet-shard-border": `hsl(${hue} 30% 68%)`,
    "--fleet-shard-accent": `hsl(${hue} 62% 32%)`,
  } as CSSProperties;
}

function campaignCreationOrdinal(campaign: BridgeCampaign) {
  const match = campaign.campaign_record_id.match(/(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareCampaignCreationOrder(left: BridgeCampaign, right: BridgeCampaign) {
  const ordinalDifference = campaignCreationOrdinal(left) - campaignCreationOrdinal(right);
  if (ordinalDifference !== 0) return ordinalDifference;
  if (left.campaign_record_id !== right.campaign_record_id) {
    return left.campaign_record_id < right.campaign_record_id ? -1 : 1;
  }
  if (left.target_id === right.target_id) return 0;
  return left.target_id < right.target_id ? -1 : 1;
}

function CaptureRouteIdentity({ current, previous }: { current?: CaptureEgress | null; previous?: CaptureEgress | null }) {
  if (!current?.ip) {
    return <div className="fleet-egress-card is-unknown"><strong>Capture route unavailable</strong><small>The next capture will record its proxy exit.</small></div>;
  }
  const location = [current.country, current.state, current.city, current.timezone].filter(Boolean).join(" · ") || "Location unavailable";
  const company = current.organization || current.isp || "Network owner unavailable";
  const asn = current.asn ? `AS${current.asn}` : "ASN unavailable";
  const changed = Boolean(previous?.ip && previous.ip !== current.ip);
  const same = Boolean(previous?.ip && previous.ip === current.ip);
  const routeLabel = changed
    ? `Rotated from ${previous?.ip}`
    : same && current.confidence === "stable_session"
      ? "Same sticky exit"
      : same
        ? "No rotation observed"
        : "First recorded exit";
  const confidenceLabel = current.confidence === "stable_session"
    ? "Session IP verified"
    : current.confidence === "direct"
      ? "Direct connection"
      : "Proxy probe only";
  return (
    <div className={"fleet-egress-card " + (changed || current.confidence === "stable_session" ? "is-verified" : "is-observed")}>
      <div><strong>{current.ip}</strong><span>{asn}</span></div>
      <small>{location}</small>
      <small>Company · {company}</small>
      <small>{current.proxyProvider || "Proxy"} · {confidenceLabel}</small>
      <small>{routeLabel}</small>
      <small className="fleet-egress-source">Geo estimate · {current.intelligenceProvider || "provider unavailable"}</small>
    </div>
  );
}

function FleetAlertIndicator({ state, title }: { state: FleetIndicatorState; title: string }) {
  const isIssue = state === "issue";
  const isHealthy = state === "healthy";
  const color = isIssue ? "#ff321f" : isHealthy ? "#20c878" : "#a7a195";
  const label = isIssue ? "ISSUE" : isHealthy ? "CLEAR" : "CHECK";
  return (
    <span
      role="status"
      aria-label={title}
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", flex: "0 0 auto" }}
    >
      <i
        aria-hidden="true"
        style={{
          width: "0.62rem",
          height: "0.62rem",
          borderRadius: "999px",
          background: color,
          boxShadow: isIssue
            ? "0 0 0 3px rgba(255,50,31,.2), 0 0 14px rgba(255,50,31,.95)"
            : isHealthy
              ? "0 0 0 3px rgba(32,200,120,.14), 0 0 9px rgba(32,200,120,.55)"
              : "none",
        }}
      />
      <small style={{ color, fontSize: "0.6rem", fontWeight: 800, letterSpacing: "0.08em" }}>{label}</small>
    </span>
  );
}

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

function TransientVerifiedSuffix({ campaign }: { campaign: BridgeCampaign }) {
  const isCurrentExactMatch = campaign.exact_suffix != null
    && campaign.last_applied_suffix != null
    && campaign.exact_suffix === campaign.last_applied_suffix
    && campaign.latest_job_state === "applied"
    && Boolean(campaign.applied_at);
  const matchKey = isCurrentExactMatch
    ? `${campaign.applied_at}\u0000${campaign.last_applied_suffix}`
    : "";
  const [visibleMatchKey, setVisibleMatchKey] = useState("");

  useEffect(() => {
    if (!matchKey) {
      setVisibleMatchKey("");
      return;
    }

    setVisibleMatchKey(matchKey);
    const timer = window.setTimeout(() => {
      setVisibleMatchKey((current) => current === matchKey ? "" : current);
    }, VERIFIED_SUFFIX_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [matchKey]);

  if (visibleMatchKey === matchKey && isCurrentExactMatch) {
    return (
      <>
        <code>{campaign.last_applied_suffix || "(empty suffix)"}</code>
        <small>Exact match verified {formatTimestamp(campaign.applied_at)}</small>
      </>
    );
  }

  const waitingMessage = campaign.exact_suffix == null
    ? "Waiting for browser capture"
    : campaign.latest_job_state === "pending"
      ? "Waiting for this captured suffix"
      : campaign.latest_job_state === "leased"
        ? "Applying this captured suffix"
        : isCurrentExactMatch
          ? "Waiting for the next exact match"
          : "Google Ads value does not match this capture yet";

  return (
    <>
      <span className="fleet-cell-empty">{waitingMessage}</span>
      <small>Only the exact current match appears here for 7 seconds</small>
    </>
  );
}

function shardHealth(shard?: BridgeShard, hasActiveAlert = false): HealthState {
  return getShardHealth(shard, { now: Date.now(), staleAfterMs: SHARD_STALE_AFTER_MS, hasActiveAlert });
}

function targetHealth(campaign: BridgeCampaign, shard?: BridgeShard, hasShardAlert = false): HealthState {
  return getCampaignHealth(campaign, shard, {
    now: Date.now(), staleAfterMs: SHARD_STALE_AFTER_MS, hasActiveAlert: hasShardAlert,
  });
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
  const [draftShardManagers, setDraftShardManagers] = useState<Record<string, string>>({});
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [generatedScript, setGeneratedScript] = useState("");
  const [generatedForShard, setGeneratedForShard] = useState("");
  const [generating, setGenerating] = useState(false);
  const [actionCampaignId, setActionCampaignId] = useState("");
  const [fleetAlerts, setFleetAlerts] = useState<FleetAlert[] | null>(null);
  const [fleetAlertsUnavailable, setFleetAlertsUnavailable] = useState(false);
  const fleetRefreshSequence = useRef(0);
  const fleetMembershipSignature = useMemo(() => savedCampaigns
    .map((campaign) => `${campaign.id}:${campaign.config?.useScriptMesh === true ? "1" : "0"}:${campaign.config?.scriptFleetShardId || ""}`)
    .sort()
    .join("|"), [savedCampaigns]);
  const previousFleetMembershipSignature = useRef(fleetMembershipSignature);

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

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const loadFleetAlerts = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/alerts", { cache: "no-store", credentials: "same-origin" });
        const body = await response.json() as FleetAlertReport;
        if (!response.ok) throw new Error(body.error || `Alert status failed (${response.status})`);
        if (active) {
          setFleetAlerts((body.alerts || []).filter((alert) => alert.status !== "resolved"));
          setFleetAlertsUnavailable(false);
        }
      } catch {
        if (active) setFleetAlertsUnavailable(true);
      } finally {
        inFlight = false;
      }
    };
    void loadFleetAlerts();
    const timer = window.setInterval(loadFleetAlerts, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const fleetAlertIndex = useMemo(() => {
    const campaignIds = new Set<string>();
    const shardIds = new Set<string>();
    for (const alert of fleetAlerts || []) {
      if (alert.campaignRecordId) campaignIds.add(alert.campaignRecordId);
      if (alert.shardId) shardIds.add(alert.shardId);
    }
    return { campaignIds, shardIds };
  }, [fleetAlerts]);

  const refresh = useCallback(async (signal?: AbortSignal, silent = false) => {
    const requestSequence = ++fleetRefreshSequence.current;
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
      if (signal?.aborted || requestSequence !== fleetRefreshSequence.current) return null;
      setStatus(body);
      setError("");
      return body;
    } catch (nextError) {
      if ((nextError as { name?: string }).name !== "AbortError" && requestSequence === fleetRefreshSequence.current) {
        setError(nextError instanceof Error ? nextError.message : "Fleet status failed");
      }
      return null;
    } finally {
      if (!signal?.aborted && requestSequence === fleetRefreshSequence.current) setLoading(false);
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

  useEffect(() => {
    if (previousFleetMembershipSignature.current === fleetMembershipSignature) return;
    previousFleetMembershipSignature.current = fleetMembershipSignature;
    void refresh(undefined, true);
  }, [fleetMembershipSignature, refresh]);

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
          manager_customer_id: campaign.manager_customer_id,
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
    const preferred = shardOptions.find((shard) => shard.registered && shardHealth(shard, fleetAlertIndex.shardIds.has(shard.shard_id)).tone === "healthy")
      || shardOptions.find((shard) => shard.registered)
      || shardOptions[0];
    if (preferred) setSelectedShardId(preferred.shard_id);
  }, [fleetAlertIndex, selectedShardId, shardOptions]);

  const selectedShard = shardOptions.find((shard) => shard.shard_id === selectedShardId);
  const selectedShardManager = selectedShard?.manager_customer_id || draftShardManagers[selectedShardId] || "";
  const selectedManagerValid = /^[0-9\s-]+$/.test(selectedShardManager) && /^\d{10}$/.test(normalizedId(selectedShardManager));
  const selectedShardHasAlert = Boolean(selectedShard && fleetAlertIndex.shardIds.has(selectedShard.shard_id));
  const selectedShardCount = Number(selectedShard?.campaign_count || 0);
  const selectedShardCapacity = Number(selectedShard?.capacity || SHARD_CAPACITY);
  const selectedShardFull = selectedShardCount >= selectedShardCapacity;

  async function generateWorker() {
    const shardId = selectedShardId.trim();
    if (!SHARD_ID_PATTERN.test(shardId)) {
      setError("Choose a valid shard ID before generating its worker.");
      return;
    }
    let managerCustomerId: string;
    try {
      managerCustomerId = normalizeFleetManagerId(selectedShardManager);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Enter a valid MCC ID.");
      return;
    }
    if (newShardId.trim()) {
      setError("Click Use new shard first, or clear the custom shard name before generating.");
      return;
    }
    if (selectedShard?.registered && !window.confirm("Regenerate " + shardId + " for MCC " + managerCustomerId + "? This rotates its token and the installed copy must be replaced.")) return;
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
          managerCustomerId,
        }),
      });
      const body = await response.json() as { script?: string; error?: string };
      if (!response.ok || !body.script) throw new Error(body.error || "Worker generation failed");
      setGeneratedScript(body.script);
      setGeneratedForShard(shardId);
      setNotice("Adaptive two-phase v9 worker generated for " + shardId + ". Copy it into the matching MCC and schedule it Hourly.");
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
    if (shardOptions.some((shard) => shard.shard_id === value)) {
      setError("That shard name already exists. Select it above or choose a unique name.");
      return;
    }
    if (!SHARD_ID_PATTERN.test(value)) {
      setError("Shard IDs must start with a letter or number and use only letters, numbers, period, underscore, colon, or hyphen.");
      return;
    }
    setSelectedShardId(value);
    setNewShardId("");
    setError("");
    setNotice("Shard " + value + " is selected. Enter its MCC ID below, then generate its worker.");
  }

  async function requestFleetUpdate(campaign: SavedFleetCampaign, enabled: boolean) {
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
    const confirmationDelays = [200, 400, 800, 1_200, 2_000, 3_000];
    for (const delay of confirmationDelays) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      const snapshot = await refresh(undefined, true);
      const assigned = snapshot?.campaigns?.items?.find((item) => item.campaign_record_id === campaign.id);
      const confirmed = enabled ? assigned?.shard_id === nextShardId : !assigned;
      if (confirmed) {
        setNotice(enabled
          ? `${campaign.name} is assigned to shard ${nextShardId}.`
          : `${campaign.name} was permanently deleted from Fleet delivery.`);
        setActionCampaignId("");
        return;
      }
    }
    setActionCampaignId("");
    setError(`Fleet accepted the request for ${campaign.name}, but the dashboard did not confirm it within 8 seconds. Automatic refresh is continuing.`);
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
    && activeRegisteredShards.every((shard) => shardHealth(shard, fleetAlertIndex.shardIds.has(shard.shard_id)).tone === "healthy");
  const workerAttention = activeRegisteredShards.some((shard) => shardHealth(shard, fleetAlertIndex.shardIds.has(shard.shard_id)).tone === "attention");
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
  const visibleSavedCampaigns = matchingSavedCampaigns;

  return (
    <section className="bridge-panel fleet-console" aria-labelledby="fleet-title">
      <header className="bridge-heading fleet-console-heading">
        <div>
          <p className="eyebrow">Relational delivery channel</p>
          <h2 id="fleet-title">Rolling Apps Script Fleet</h2>
          <p>One live console for captured suffixes, verified Google Ads delivery, campaign health, shard assignment, and the adaptive two-phase v9 Fleet workers.</p>
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
          const health = shardHealth(shard, fleetAlertIndex.shardIds.has(shard.shard_id));
          const count = Number(shard.campaign_count || 0);
          const capacity = Number(shard.capacity || SHARD_CAPACITY);
          return (
            <button
              className={"fleet-shard-tab has-shard-tone " + (selectedShardId === shard.shard_id ? "is-selected" : "")}
              type="button"
              key={shard.shard_id}
              style={shardVisualStyle(shard.shard_id)}
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
              {[...targetItems].sort(compareCampaignCreationOrder).map((campaign) => {
                const shard = shardOptions.find((item) => item.shard_id === campaign.shard_id);
                const savedCampaign = savedCampaigns.find((item) => item.id === campaign.campaign_record_id);
                const busy = actionCampaignId === campaign.campaign_record_id;
                const hasCampaignAlert = fleetAlertIndex.campaignIds.has(campaign.campaign_record_id);
                const hasShardAlert = fleetAlertIndex.shardIds.has(campaign.shard_id);
                const health = targetHealth(campaign, shard, hasShardAlert);
                const rowShardHealth = shardHealth(shard, hasShardAlert);
                const hasFleetAlert = hasCampaignAlert || hasShardAlert;
                const indicatorState: FleetIndicatorState = fleetAlertsUnavailable
                  ? "issue"
                  : fleetAlerts === null
                    ? "checking"
                    : hasFleetAlert
                      ? "issue"
                      : "healthy";
                const indicatorTitle = fleetAlertsUnavailable
                  ? "Alert status is unavailable; campaign health cannot be confirmed."
                  : hasCampaignAlert && hasShardAlert
                    ? "This campaign and its Apps Script shard have active alerts."
                    : hasCampaignAlert
                      ? "This campaign has an active alert."
                      : hasShardAlert
                        ? `Shard ${campaign.shard_id} has an active alert affecting this campaign.`
                        : fleetAlerts === null
                          ? "Checking campaign and shard alerts."
                          : "No active campaign or shard alert.";
                return (
                  <tr
                    className="fleet-shard-row"
                    data-shard-id={campaign.shard_id}
                    key={campaign.target_id}
                    style={shardVisualStyle(campaign.shard_id)}
                  >
                    <td className="fleet-campaign-cell">
                      <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", flexWrap: "wrap" }}>
                        <FleetAlertIndicator state={indicatorState} title={indicatorTitle} />
                        <strong>{campaign.campaign_name}</strong>
                      </div>
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
                      {savedCampaign?.latestCaptureEvidence?.kind === "redirect-only"
                        && savedCampaign.latestSuffix === campaign.exact_suffix
                        && savedCampaign.latestCaptureEvidence.capturedAt === savedCampaign.lastCapturedAt
                        && Date.parse(savedCampaign.lastCapturedAt || "") === Date.parse(campaign.captured_at || "")
                        && <small style={{ color: "#111", fontWeight: 700 }}>Redirect verified; destination not visited</small>}
                      {campaign.exact_suffix != null && <CaptureRouteIdentity current={campaign.capture_egress} previous={campaign.previous_capture_egress} />}
                    </td>
                    <td className="fleet-suffix-cell fleet-inserted-cell">
                      <TransientVerifiedSuffix campaign={campaign} />
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
                      <div className="fleet-shard-identity">
                        <i aria-hidden="true" />
                        <strong>{campaign.shard_id}</strong>
                      </div>
                      <small>{Number(shard?.campaign_count || 0)} / {Number(shard?.capacity || SHARD_CAPACITY)} campaigns</small>
                      <span className={"health-chip is-" + rowShardHealth.tone}>{rowShardHealth.label}</span>
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
            <select id="fleet-selected-shard" value={selectedShardId} disabled={generating} onChange={(event) => { setSelectedShardId(event.target.value); setNewShardId(""); }}>
              {shardOptions.length === 0 && <option value="">No shard selected</option>}
              {shardOptions.map((shard) => <option key={shard.shard_id} value={shard.shard_id}>{shard.shard_id} · {Number(shard.campaign_count || 0)}/{Number(shard.capacity || SHARD_CAPACITY)}</option>)}
            </select>
            <small>Create a custom shard and enter its MCC in the worker setup beside this panel.</small>
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
          </div>
        </section>

        <section className="fleet-script-card" aria-labelledby="fleet-script-title">
          <header><p className="eyebrow">Selected shard worker</p><h3 id="fleet-script-title">Generate the v11 two-phase resilient shard script</h3><p>Choose the exact shard below before generating. Child accounts maintain the first adaptive 28-minute phase, then the manager callback continues delivery until the two-minute protected hourly handoff. It can service at most 40 assigned campaigns.</p></header>

          <div className="fleet-worker-shard-picker">
            <label htmlFor="fleet-worker-shard">Shard to generate</label>
            <select id="fleet-worker-shard" value={selectedShardId} disabled={generating} onChange={(event) => { setSelectedShardId(event.target.value); setNewShardId(""); }}>
              {shardOptions.length === 0 && <option value="">No shard selected</option>}
              {shardOptions.map((shard) => (
                <option key={shard.shard_id} value={shard.shard_id}>
                  {shard.shard_id} · {Number(shard.campaign_count || 0)}/{Number(shard.capacity || SHARD_CAPACITY)} campaigns · {shardHealth(shard, fleetAlertIndex.shardIds.has(shard.shard_id)).label}
                </option>
              ))}
            </select>
            <small>Choose an existing shard, or create one with your own name below. Existing shards are not renamed.</small>
          </div>

          <div className="fleet-worker-shard-picker">
            <label htmlFor="fleet-new-shard">New custom shard name</label>
            <input id="fleet-new-shard" value={newShardId} onChange={(event) => setNewShardId(event.target.value)} placeholder="For example: us-retail-01" maxLength={80} disabled={generating} />
            <button type="button" onClick={chooseNewShard} disabled={generating || !newShardId.trim()}>Use new shard</button>
            <small>Use 1-80 letters, numbers, periods, underscores, colons or hyphens. The name does not determine the MCC.</small>
          </div>

          <div className="fleet-worker-shard-picker">
            <label htmlFor="fleet-manager-id">Google Ads manager (MCC) account ID</label>
            <input id="fleet-manager-id" value={selectedShardManager}
              onChange={(event) => setDraftShardManagers((current) => ({ ...current, [selectedShardId]: event.target.value }))}
              placeholder="Enter the 10-digit MCC ID" inputMode="tel" maxLength={20}
              readOnly={Boolean(selectedShard?.manager_customer_id)} disabled={generating || !selectedShardId}
              aria-describedby="fleet-manager-help" />
            <small id="fleet-manager-help">{selectedShard?.manager_customer_id
              ? "This shard is bound to this MCC. For a different MCC, create a new shard; existing campaigns and workers stay unchanged."
              : "Enter the manager account where this script will run, not the child customer or campaign ID. Hyphens and spaces are accepted. One MCC per shard."}</small>
          </div>

          <div className="fleet-script-shard">
            <div><span>Shard ID</span><strong>{selectedShardId || "Not selected"}</strong><small>MCC {selectedShardManager || "not entered"}</small></div>
            <span className={"health-chip is-" + shardHealth(selectedShard, selectedShardHasAlert).tone}>{shardHealth(selectedShard, selectedShardHasAlert).label}</span>
          </div>

          <label htmlFor="fleet-public-url">Public HTTPS base URL</label>
          <input id="fleet-public-url" value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="https://traffic.example.com" inputMode="url" />
          <button className="bridge-primary-action" type="button" onClick={generateWorker} disabled={generating || !publicBaseUrl.trim() || !selectedShardId || !selectedManagerValid || Boolean(newShardId.trim())}>
            {generating ? "Generating v11 resilient worker..." : selectedShard?.registered ? "Rotate token and regenerate v11 resilient worker" : "Generate v11 resilient worker for selected shard"}
          </button>
          <p className="fleet-script-warning">Install this v11 copy once for two-phase execution, callback recovery, adaptive handoff, durable delivery, and hot-add support. Generating again rotates the secret and immediately invalidates the older installed copy for this shard.</p>

          {generatedScript && generatedForShard === selectedShardId ? (
            <div className="fleet-script-output">
              <div><strong>{generatedForShard} · fleet-two-phase-resilient-relay-v11</strong><button type="button" onClick={copyWorker}>Copy script</button><button className="bridge-secondary-action" type="button" onClick={() => setGeneratedScript("")}>Hide</button></div>
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
