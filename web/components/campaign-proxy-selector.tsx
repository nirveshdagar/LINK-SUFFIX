"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Provider = { providerId: string; name: string; gatewayHost: string; enabled: boolean; authMode: string; secretConfigured: boolean };
type Pool = { poolId: string; providerId: string; name: string; enabled: boolean; endpointPorts: number[] };
type Overview = { runtimeEnabled: boolean; providers: Provider[]; pools: Pool[]; policies: { campaignRecordId: string; primaryPoolId: string; enabled: boolean }[] };
export type CampaignProxyChoice = { poolId: string; providerId: string; label: string; ready: boolean };
export const EMPTY_PROXY_CHOICE: CampaignProxyChoice = { poolId: "", providerId: "iproyal", label: "Loading proxy providers", ready: false };

export default function CampaignProxySelector({ campaignId, initialPoolId, disabled = false, onChange }: {
  campaignId?: string;
  initialPoolId?: string;
  disabled?: boolean;
  onChange: (choice: CampaignProxyChoice, userInitiated: boolean) => void;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    const abort = new AbortController();
    setData(null); setValue(null); setError("");
    callback.current(EMPTY_PROXY_CHOICE, false);
    void fetch("/api/proxy-providers", { credentials: "same-origin", cache: "no-store", signal: abort.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Cannot load saved proxy providers");
        if (abort.signal.aborted) return;
        const overview = result as Overview;
        setData(overview);
        const eligible = overview.pools.filter(pool => pool.enabled && overview.providers.some(provider => provider.providerId === pool.providerId && provider.enabled && (provider.secretConfigured || provider.authMode === "ip-allowlist")));
        const saved = overview.policies.find(policy => policy.campaignRecordId === campaignId && policy.enabled);
        const evomi = eligible.find(pool => overview.providers.some(provider => provider.providerId === pool.providerId && /^(core-residential|premium-residential|rp)\.evomi\.com$|^rp\.evomi-proxy\.com$/i.test(provider.gatewayHost)));
        const selectedId = campaignId ? initialPoolId ?? saved?.primaryPoolId ?? "" : initialPoolId ?? (overview.runtimeEnabled ? evomi?.poolId ?? "" : "");
        const selected = eligible.find(pool => pool.poolId === selectedId);
        const provider = overview.providers.find(item => item.providerId === selected?.providerId);
        setValue(selectedId);
        callback.current({ poolId: selectedId, providerId: provider?.providerId || (selectedId ? "" : "iproyal"), label: provider?.name || (selectedId ? "Unavailable saved provider" : "IPRoyal"), ready: !selectedId || Boolean(selected && overview.runtimeEnabled) }, false);
      })
      .catch(caught => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "Cannot load proxy providers"); });
    return () => abort.abort();
  }, [campaignId, initialPoolId, reload]);

  const eligible = data?.pools.filter(pool => pool.enabled && data.providers.some(provider => provider.providerId === pool.providerId && provider.enabled && (provider.secretConfigured || provider.authMode === "ip-allowlist"))) || [];
  const selected = eligible.find(pool => pool.poolId === value);
  function select(poolId: string) {
    const pool = eligible.find(item => item.poolId === poolId);
    const provider = data?.providers.find(item => item.providerId === pool?.providerId);
    setValue(poolId);
    callback.current({ poolId, providerId: provider?.providerId || (poolId ? "" : "iproyal"), label: provider?.name || "IPRoyal", ready: !poolId || Boolean(pool && data?.runtimeEnabled) }, true);
  }
  return <div style={{ marginBottom: 18 }}>
    <label style={{ display: "grid", gap: 7, fontWeight: 700 }}>Proxy provider
      <select aria-label="Proxy provider" value={value ?? "__loading"} disabled={disabled || (!data && !error)} onChange={event => select(event.target.value)}
        style={{ width: "100%", padding: "12px 13px", border: "1px solid #aab3aa", borderRadius: 7, background: "#fbf8ef", color: "#10251d" }}>
        {value === null && <option value="__loading" disabled>{error ? "Choose a route or retry" : "Loading saved providers..."}</option>}
        <option value="">IPRoyal / existing dedicated gateway</option>
        {value && !eligible.some(pool => pool.poolId === value) && <option value={value} disabled>Unavailable saved pool: {value}</option>}
        {eligible.map(pool => <option key={pool.poolId} value={pool.poolId} disabled={!data?.runtimeEnabled}>{data?.providers.find(provider => provider.providerId === pool.providerId)?.name} / {pool.name}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error} <button type="button" onClick={() => setReload(current => current + 1)}>Retry loading providers</button></p>}
    {selected && <p style={{ fontSize: 13, lineHeight: 1.5 }}>Shared gateway port {selected.endpointPorts.join(", ")}. Each browser journey receives its own provider session, targeted to the country selected below. IP uniqueness is not guaranteed.</p>}
    <p style={{ fontSize: 13, lineHeight: 1.5 }}>{campaignId ? "Save changes saves both the proxy route and country. Stop the campaign before switching provider; existing selections are preserved." : "New campaigns default to EVOMI when configured and to United States (US). Choose another country below. The provider is saved before the campaign is queued."} <Link href="/proxies">Manage provider credentials</Link></p>
    {data && !data.runtimeEnabled && <p role="status">Saved provider routing is disabled on this server. IPRoyal remains available.</p>}
  </div>;
}
