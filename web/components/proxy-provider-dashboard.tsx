"use client";

import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, KeyRound, Megaphone, Network, Play, Plus, Radio, RefreshCw, Route, ShieldCheck, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import AlertRailLink from "./alert-rail-link";
import CapacityRailLink from "./capacity-rail-link";
import ProxyRailLink from "./proxy-rail-link";
import styles from "./proxy-provider-dashboard.module.css";

type Provider = {
  providerId: string; name: string; providerType: string; enabled: boolean; protocol: string; gatewayHost: string; gatewayPorts: number[];
  authMode: string; rotationModes: string[]; secretConfigured: boolean;
  circuit: { state?: string } | null;
  metrics: { samples: number; healthy: boolean | null; successRate: number | null; latencyP95Ms: number | null; payloadBytes: number; browserMemoryBytes: number; databaseLatencyP95Ms: number | null; redisLatencyP95Ms: number | null };
};
type Pool = { poolId: string; providerId: string; name: string; enabled: boolean; endpointPorts: number[]; defaultRotationMode: string; maxConcurrentPerEndpoint: number };
type Policy = { campaignRecordId: string; primaryProviderId: string; primaryPoolId: string; rotationMode: string; fallbackProviderIds: string[]; enabled: boolean };
type Overview = { configured: boolean; migrated: boolean; runtimeEnabled: boolean; providers: Provider[]; pools: Pool[]; policies: Policy[]; summary: { providers: number; enabledProviders: number; pools: number; assignedCampaigns: number; openCircuits: number; unhealthyProviders: number } };
type Campaign = { campaignRecordId?: string; id?: string; campaignName?: string; name?: string; customerId?: string; googleCampaignId?: string };

const EMPTY_SUMMARY = { providers: 0, enabledProviders: 0, pools: 0, assignedCampaigns: 0, openCircuits: 0, unhealthyProviders: 0 };

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(String(payload.error || `HTTP ${response.status}`));
  return payload;
}

function bytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const order = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** order).toFixed(order ? 1 : 0)} ${units[order]}`;
}

function campaignsFrom(payload: unknown): Campaign[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const container = root.campaigns;
  if (Array.isArray(container)) return container as Campaign[];
  if (container && typeof container === "object") {
    const record = container as Record<string, unknown>;
    for (const key of ["items", "campaigns", "targets", "rows"]) if (Array.isArray(record[key])) return record[key] as Campaign[];
  }
  return [];
}

export default function ProxyProviderDashboard() {
  const [overview, setOverview] = useState<Overview>({ configured: false, migrated: false, runtimeEnabled: false, providers: [], pools: [], policies: [], summary: EMPTY_SUMMARY });
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState({ providerId: "", name: "", providerType: "universal", protocol: "http", gatewayHost: "", gatewayPorts: "", authMode: "username-password", usernameTemplate: "{username}", passwordTemplate: "{password}", rotationModes: ["provider-managed"] as string[], username: "", password: "", token: "" });
  const [pool, setPool] = useState({ poolId: "", providerId: "", name: "", endpointPorts: "", defaultRotationMode: "provider-managed", maxConcurrentPerEndpoint: 1 });
  const [policy, setPolicy] = useState({ campaignRecordId: "", primaryProviderId: "", primaryPoolId: "", rotationMode: "provider-managed", fallbackProviderIds: [] as string[] });

  const refresh = useCallback(async () => {
    try {
      const [providerPayload, campaignPayload] = await Promise.all([requestJson("/api/proxy-providers"), fetch("/api/script-bridge?pageSize=500", { cache: "no-store", credentials: "same-origin" }).then((response) => response.json()).catch(() => ({}))]);
      setOverview(providerPayload as Overview);
      setCampaigns(campaignsFrom(campaignPayload));
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Proxy registry is unavailable"); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 15_000); return () => window.clearInterval(timer); }, [refresh]);

  const selectedProvider = overview.providers.find((item) => item.providerId === policy.primaryProviderId);
  const policyPools = overview.pools.filter((item) => item.providerId === policy.primaryProviderId && item.enabled);
  const globalHealthy = !error && overview.summary.openCircuits === 0 && overview.summary.unhealthyProviders === 0;
  const assigned = useMemo(() => new Map(overview.policies.map((item) => [item.campaignRecordId, item])), [overview.policies]);

  async function post(action: string, payload: Record<string, unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await requestJson("/api/proxy-providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      setNotice(success); await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Operation failed"); }
    finally { setBusy(false); }
  }

  return (
    <main className={`control-shell ${styles.shell}`}>
      <aside className="rail">
        <Link className="brand-mark" href="/" aria-label="Traffic Armour home">TA</Link>
        <nav aria-label="Primary navigation">
          <Link className="rail-link" href="/#compose"><Play size={18} /><span>Compose</span></Link>
          <Link className="rail-link" href="/#ads"><Megaphone size={18} /><span>Ads</span></Link>
          <Link className="rail-link" href="/#runs"><Radio size={18} /><span>Runs</span></Link>
          <Link className="rail-link" href="/dashboard"><Activity size={18} /><span>Telemetry</span></Link>
          <ProxyRailLink active />
          <CapacityRailLink />
          <AlertRailLink />
        </nav>
      </aside>
      <div className={`workspace ${styles.workspace}`}>
        <header className={`${styles.hero} ${globalHealthy ? styles.healthy : styles.alert}`}>
          <div><p className="kicker">Residential egress / Provider control</p><h1>Universal proxy fabric.</h1><p>Register any residential rotating provider, isolate credentials, assign campaign pools, and monitor failover without changing campaign code.</p></div>
          <div className={styles.heroState}>{globalHealthy ? <CheckCircle2 /> : <AlertTriangle />}<strong>{globalHealthy ? "CONTROL HEALTHY" : "ATTENTION"}</strong><small>{overview.runtimeEnabled ? "Runtime policy enabled" : "Compatibility mode: current IPRoyal path unchanged"}</small></div>
        </header>

        {(error || notice) && <div className={error ? styles.error : styles.notice}>{error || notice}</div>}
        <section className={styles.stats} aria-label="Proxy fleet summary">
          {[['Providers', overview.summary.providers], ['Enabled', overview.summary.enabledProviders], ['Pools', overview.summary.pools], ['Campaign policies', overview.summary.assignedCampaigns], ['Open circuits', overview.summary.openCircuits]].map(([label, value]) => <article key={String(label)}><small>{label}</small><strong>{value}</strong></article>)}
        </section>

        <section className={styles.providerSection}>
          <div className={styles.sectionHead}><div><p className="kicker">Provider registry</p><h2>Residential gateways</h2></div><button type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} /> Refresh</button></div>
          <div className={styles.providerGrid}>
            {overview.providers.map((item) => {
              const healthy = item.enabled && item.secretConfigured && item.circuit?.state !== "open" && item.metrics.healthy !== false;
              return <article className={styles.providerCard} key={item.providerId} data-health={healthy ? "healthy" : "alert"}>
                <div className={styles.cardTitle}><span className={styles.healthDot} /><div><strong>{item.name}</strong><small>{item.providerId} · {item.providerType}</small></div><em>{healthy ? "HEALTHY" : "CHECK"}</em></div>
                <dl><div><dt>Gateway</dt><dd>{item.protocol}://{item.gatewayHost}:{item.gatewayPorts.join(",")}</dd></div><div><dt>Credentials</dt><dd>{item.secretConfigured ? "Encrypted" : "Missing"}</dd></div><div><dt>24h success</dt><dd>{item.metrics.successRate === null ? "No samples" : `${Math.round(item.metrics.successRate * 100)}%`}</dd></div><div><dt>Latency p95</dt><dd>{item.metrics.latencyP95Ms === null ? "—" : `${item.metrics.latencyP95Ms} ms`}</dd></div><div><dt>Payload</dt><dd>{bytes(item.metrics.payloadBytes)}</dd></div><div><dt>Browser peak</dt><dd>{bytes(item.metrics.browserMemoryBytes)}</dd></div><div><dt>DB / Redis p95</dt><dd>{item.metrics.databaseLatencyP95Ms ?? "—"} / {item.metrics.redisLatencyP95Ms ?? "—"} ms</dd></div></dl>
                <div className={styles.cardActions}><button type="button" disabled={busy} onClick={() => void post("set_provider_enabled", { providerId: item.providerId, enabled: !item.enabled }, item.enabled ? "Provider disabled safely." : "Provider enabled.")}>{item.enabled ? "Disable" : "Enable"}</button>{item.circuit?.state === "open" && <button type="button" disabled={busy} onClick={() => void post("reset_circuit", { providerId: item.providerId }, "Circuit reset; health probes may resume.")}>Reset circuit</button>}</div>
              </article>;
            })}
            {!overview.providers.length && <div className={styles.empty}>No universal providers yet. Existing IPRoyal campaigns continue through the compatibility path.</div>}
          </div>
        </section>

        <section className={styles.formGrid}>
          <form onSubmit={(event) => { event.preventDefault(); void post("save_provider", { provider: { ...provider, gatewayPorts: provider.gatewayPorts.split(","), capabilities: { country: true, state: true, city: true, asn: true, stickySession: true } }, secret: { username: provider.username, password: provider.password, token: provider.token } }, "Provider saved with encrypted credentials."); }}>
            <div className={styles.formTitle}><Plus /><div><p className="kicker">01 / Registry</p><h2>Add any provider</h2></div></div>
            <div className={styles.two}><label>Provider ID<input required value={provider.providerId} onChange={(e) => setProvider({ ...provider, providerId: e.target.value.toLowerCase() })} placeholder="provider-name" /></label><label>Display name<input required value={provider.name} onChange={(e) => setProvider({ ...provider, name: e.target.value })} /></label></div>
            <div className={styles.three}><label>Adapter<select value={provider.providerType} onChange={(e) => setProvider({ ...provider, providerType: e.target.value })}><option value="universal">Universal</option><option value="iproyal">IPRoyal</option><option value="custom">Custom</option></select></label><label>Protocol<select value={provider.protocol} onChange={(e) => setProvider({ ...provider, protocol: e.target.value })}><option>http</option><option>https</option><option>socks5</option></select></label><label>Authentication<select value={provider.authMode} onChange={(e) => setProvider({ ...provider, authMode: e.target.value })}><option value="username-password">Username / password</option><option value="token">Token</option><option value="ip-allowlist">IP allowlist</option></select></label></div>
            <div className={styles.two}><label>Gateway host<input required value={provider.gatewayHost} onChange={(e) => setProvider({ ...provider, gatewayHost: e.target.value })} placeholder="gate.provider.com" /></label><label>Gateway ports<input required value={provider.gatewayPorts} onChange={(e) => setProvider({ ...provider, gatewayPorts: e.target.value })} placeholder="12321,12322" /></label></div>
            <div className={styles.two}><label>Username template<input value={provider.usernameTemplate} onChange={(e) => setProvider({ ...provider, usernameTemplate: e.target.value })} /></label><label>Password template<input value={provider.passwordTemplate} onChange={(e) => setProvider({ ...provider, passwordTemplate: e.target.value })} /></label></div>
            <div className={styles.secret}><KeyRound size={17} /><label>Username<input autoComplete="off" value={provider.username} onChange={(e) => setProvider({ ...provider, username: e.target.value })} /></label><label>Password<input type="password" autoComplete="new-password" value={provider.password} onChange={(e) => setProvider({ ...provider, password: e.target.value })} /></label><label>Token<input type="password" autoComplete="new-password" value={provider.token} onChange={(e) => setProvider({ ...provider, token: e.target.value })} /></label></div>
            <fieldset><legend>Rotation modes</legend>{["per-request", "sticky-session", "port-pool", "provider-managed"].map((mode) => <label key={mode}><input type="checkbox" checked={provider.rotationModes.includes(mode)} onChange={(e) => setProvider({ ...provider, rotationModes: e.target.checked ? [...provider.rotationModes, mode] : provider.rotationModes.filter((item) => item !== mode) })} />{mode}</label>)}</fieldset>
            <button className={styles.primary} type="submit" disabled={busy}><ShieldCheck size={16} /> Save provider securely</button>
          </form>

          <div className={styles.stack}>
            <form onSubmit={(event) => { event.preventDefault(); void post("save_pool", { pool: { ...pool, endpointPorts: pool.endpointPorts.split(",") } }, "Endpoint pool saved."); }}>
              <div className={styles.formTitle}><Network /><div><p className="kicker">02 / Leasing</p><h2>Create endpoint pool</h2></div></div>
              <label>Provider<select required value={pool.providerId} onChange={(e) => setPool({ ...pool, providerId: e.target.value })}><option value="">Select provider</option>{overview.providers.map((item) => <option key={item.providerId} value={item.providerId}>{item.name}</option>)}</select></label>
              <div className={styles.two}><label>Pool ID<input required value={pool.poolId} onChange={(e) => setPool({ ...pool, poolId: e.target.value.toLowerCase() })} /></label><label>Pool name<input required value={pool.name} onChange={(e) => setPool({ ...pool, name: e.target.value })} /></label></div>
              <div className={styles.two}><label>Ports<input required value={pool.endpointPorts} onChange={(e) => setPool({ ...pool, endpointPorts: e.target.value })} /></label><label>Rotation<select value={pool.defaultRotationMode} onChange={(e) => setPool({ ...pool, defaultRotationMode: e.target.value })}>{["per-request", "sticky-session", "port-pool", "provider-managed"].map((mode) => <option key={mode}>{mode}</option>)}</select></label></div>
              <button className={styles.secondary} type="submit" disabled={busy}><Plus size={16} /> Save pool</button>
            </form>

            <form onSubmit={(event) => { event.preventDefault(); void post("assign_policy", { policy }, "Campaign proxy policy assigned."); }}>
              <div className={styles.formTitle}><Route /><div><p className="kicker">03 / Campaign policy</p><h2>Assign provider and failover</h2></div></div>
              <label>Saved campaign<select required value={policy.campaignRecordId} onChange={(e) => setPolicy({ ...policy, campaignRecordId: e.target.value })}><option value="">Select campaign</option>{campaigns.map((item) => { const id = item.campaignRecordId || item.id || ""; return <option key={id} value={id}>{item.campaignName || item.name || id}{assigned.has(id) ? " · assigned" : ""}</option>; })}</select></label>
              <div className={styles.two}><label>Primary provider<select required value={policy.primaryProviderId} onChange={(e) => setPolicy({ ...policy, primaryProviderId: e.target.value, primaryPoolId: "", rotationMode: overview.providers.find((item) => item.providerId === e.target.value)?.rotationModes[0] || "provider-managed" })}><option value="">Select provider</option>{overview.providers.filter((item) => item.enabled).map((item) => <option key={item.providerId} value={item.providerId}>{item.name}</option>)}</select></label><label>Endpoint pool<select required value={policy.primaryPoolId} onChange={(e) => setPolicy({ ...policy, primaryPoolId: e.target.value })}><option value="">Select pool</option>{policyPools.map((item) => <option key={item.poolId} value={item.poolId}>{item.name}</option>)}</select></label></div>
              <label>Rotation mode<select value={policy.rotationMode} onChange={(e) => setPolicy({ ...policy, rotationMode: e.target.value })}>{(selectedProvider?.rotationModes || ["provider-managed"]).map((mode) => <option key={mode}>{mode}</option>)}</select></label>
              <label>Fallback providers<select multiple value={policy.fallbackProviderIds} onChange={(e) => setPolicy({ ...policy, fallbackProviderIds: [...e.target.selectedOptions].map((option) => option.value) })}>{overview.providers.filter((item) => item.enabled && item.providerId !== policy.primaryProviderId).map((item) => <option key={item.providerId} value={item.providerId}>{item.name}</option>)}</select></label>
              <button className={styles.primary} type="submit" disabled={busy}><ShieldCheck size={16} /> Assign campaign policy</button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
