"use client";
import { ScriptBridge } from "./script-bridge";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check, CircleStop, Globe2, KeyRound, Laptop, MapPin, Megaphone, Play, Radio, RefreshCw, Router, ShieldCheck, Smartphone, TerminalSquare, Users } from "lucide-react";
import AdsIntegration from "@/components/ads-integration";

type Tier = "trivial-http" | "headless" | "stealth" | "human";
import { MAJOR_CITIES, WORLD_COUNTRIES } from "@/lib/world-locations";
type ProxyMode = "rotating-residential" | "sticky-residential";
type ExpectedVerdict = "allow" | "challenge" | "block";
interface Geo { country: string; state?: string; city?: string; tz?: string }
interface Device { id: string; family: string; locale: string; touch: boolean }
const DEFAULT_DEVICE: Device = { id: "desktop-windows-chrome", family: "chrome", locale: "en-US", touch: false };
interface ChallengeInfo { id: string; status: string; vendor: string; challengeType: string; referenceId?: string; url: string; detectedAt: string; timeoutAt: string; screenshotPath?: string; lastError?: string; redirects?: Array<{ from: string; to: string; status: number }> }
interface RunInfo { id: string; scenarioId: string; startedAt: number; alive: boolean; exitCode?: number | null; dashboardPort?: number; challenges?: ChallengeInfo[] }
interface ScheduleInfo { id: string; scenarioId: string; timezone: string; startTime: string; stopTime: string; days: number[]; enabled: boolean; lastStartedWindow?: string; lastError?: string }
  interface CampaignInfo { id: string; number: number; name: string; status: string; activeRunId?: string; latestSuffix?: string; lastCapturedAt?: string; lastMeshVersion?: number; lastMeshQueuedAt?: string; lastError?: string; config: { seedUrl: string; proxyPort: number; customerId?: string; googleCampaignId?: string; loginCustomerId?: string; syncGoogleAds?: boolean; useScriptMesh?: boolean; scriptFleetShardId?: string } }
interface ProxyIdentity { egressIp?: string; timezone?: string; location?: string }
interface LocationState { code: string; name: string }
type SignatureName = "cloudflare" | "hcaptcha" | "datadome" | "perimeterx" | "akamai" | "kasada" | "shape" | "fingerprintjs" | "generic";
const SIGNATURES: SignatureName[] = ["cloudflare", "hcaptcha", "datadome", "perimeterx", "akamai", "kasada", "shape", "fingerprintjs", "generic"];

const TIERS = [
  { id: "trivial-http" as Tier, code: "L1", title: "Raw HTTP", copy: "Fast protocol and edge-policy probe.", icon: Radio },
  { id: "headless" as Tier, code: "L2", title: "Browser", copy: "Chromium with coherent device identity.", icon: Laptop },
  { id: "stealth" as Tier, code: "L3", title: "Stealth", copy: "Hardened browser fingerprint profile.", icon: ShieldCheck },
  { id: "human" as Tier, code: "L4", title: "Journey", copy: "Headed, multi-page human simulation.", icon: Users },
];
const PRESETS: Array<{ label: string; geo: Geo }> = [
  { label: "Los Angeles", geo: { country: "US", state: "CA", city: "Los Angeles", tz: "America/Los_Angeles" } },
  { label: "New York", geo: { country: "US", state: "NY", city: "New York", tz: "America/New_York" } },
  { label: "London", geo: { country: "GB", city: "London", tz: "Europe/London" } },
  { label: "Berlin", geo: { country: "DE", city: "Berlin", tz: "Europe/Berlin" } },
  { label: "Mumbai", geo: { country: "IN", state: "MH", city: "Mumbai", tz: "Asia/Kolkata" } },
  { label: "Tokyo", geo: { country: "JP", city: "Tokyo", tz: "Asia/Tokyo" } },
  { label: "Sao Paulo", geo: { country: "BR", state: "SP", city: "SaoPaulo", tz: "America/Sao_Paulo" } },
];
const CONTROL_PORT = process.env.NEXT_PUBLIC_CONTROL_WS_PORT ?? "3101";
const IPROYAL_PORTS = [
  12321,
  ...Array.from({ length: 51 }, (_, index) => 11200 + index),
  32325,
  ...Array.from({ length: 51 }, (_, index) => 51200 + index),
];
const INTERNATIONAL_TIMEZONES = (() => {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  return [...new Set(["UTC", ...(intl.supportedValuesOf?.("timeZone") ?? ["Asia/Kolkata", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"])])];
})();
const timezoneLabel = (timezone: string) => {
  try {
    const zoneName = new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts().find((part) => part.type === "timeZoneName")?.value ?? "UTC";
    return `${timezone} (${zoneName.replace("GMT", "UTC")})`;
  } catch { return timezone; }
};
const WEEKDAYS = [
  { value: 1, label: "Mon" }, { value: 2, label: "Tue" }, { value: 3, label: "Wed" },
  { value: 4, label: "Thu" }, { value: 5, label: "Fri" }, { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
const weekdaySummary = (days: number[]) => WEEKDAYS.filter((day) => days.includes(day.value)).map((day) => day.label).join(", ");

export default function ControlPanel() {
  const wsRef = useRef<WebSocket | null>(null);
  const challengeAlertsEnabledRef = useRef(false);
  const seenChallengeIdsRef = useRef(new Set<string>());
  const [connected, setConnected] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [proxyConfigured, setProxyConfigured] = useState(false);
  const [proxyVerifying, setProxyVerifying] = useState(false);
  const [proxyIdentity, setProxyIdentity] = useState<ProxyIdentity>({});
  const [proxyHost, setProxyHost] = useState("geo.iproyal.com");
  const [proxyPort, setProxyPort] = useState(12321);
  const [proxyUser, setProxyUser] = useState("");
  const [proxyPass, setProxyPass] = useState("");
  const [rememberProxy, setRememberProxy] = useState(true);
  const [url, setUrl] = useState("https://example.com/");
  const [campaign, setCampaign] = useState("homepage-baseline");
  const [tier, setTier] = useState<Tier>("human");
  const [proxyMode, setProxyMode] = useState<ProxyMode>("rotating-residential");
  const [expectedVerdict, setExpectedVerdict] = useState<ExpectedVerdict>("allow");
  const [geo, setGeo] = useState<Geo>({ country: "US", state: "", city: "" });
  const [stateCode, setStateCode] = useState("");
  const [locationStates, setLocationStates] = useState<LocationState[]>([]);
  const [locationCities, setLocationCities] = useState<string[]>([]);
  const [repeats, setRepeats] = useState(10);
  const [concurrent, setConcurrent] = useState(4);
  const [burstMode, setBurstMode] = useState(false);
  const [targetRps, setTargetRps] = useState(500);
  const [burstDuration, setBurstDuration] = useState(2);
  const [rampSeconds, setRampSeconds] = useState(0);
  const [requestCeiling, setRequestCeiling] = useState(1000);
  const [burstAuthorized, setBurstAuthorized] = useState(false);
  const [visibleBrowser, setVisibleBrowser] = useState(false);
  const [followExternalRedirects, setFollowExternalRedirects] = useState(true);
  const [challengeAlertsEnabled, setChallengeAlertsEnabled] = useState(false);
  const [stagingMode, setStagingMode] = useState(false);
  const [fingerprintMode, setFingerprintMode] = useState<"balanced" | "hardened">("hardened");
  const [tlsCapture, setTlsCapture] = useState(false);
  const [challengeSignatures, setChallengeSignatures] = useState<SignatureName[]>(SIGNATURES);
  const [devices, setDevices] = useState<Device[]>([DEFAULT_DEVICE]);
  const [devicePool, setDevicePool] = useState<string[]>([DEFAULT_DEVICE.id]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [schedules, setSchedules] = useState<ScheduleInfo[]>([]);
  const [savedCampaigns, setSavedCampaigns] = useState<CampaignInfo[]>([]);
  const [activeLimit, setActiveLimit] = useState(500);
  const [lockedPorts, setLockedPorts] = useState<number[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [syncGoogleAds, setSyncGoogleAds] = useState(false);
  const [useScriptMesh, setUseScriptMesh] = useState(false);
  const [dailySchedule, setDailySchedule] = useState(false);
  const [runCustomerId, setRunCustomerId] = useState("");
  const [runGoogleCampaignId, setRunGoogleCampaignId] = useState("");
  const [runLoginCustomerId, setRunLoginCustomerId] = useState("");
  const [scheduleTimezone, setScheduleTimezone] = useState("Asia/Kolkata");
  const [scheduleStartTime, setScheduleStartTime] = useState("09:00");
  const [scheduleStopTime, setScheduleStopTime] = useState("22:00");
  const [scheduleDays, setScheduleDays] = useState<number[]>(WEEKDAYS.map((day) => day.value));
  const [notice, setNotice] = useState("");
  const [controlToken, setControlToken] = useState("");
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignPage, setCampaignPage] = useState(1);
  const campaignPageSize = 50;
  const normalizedCampaignSearch = campaignSearch.trim().toLowerCase();
  const filteredSavedCampaigns = normalizedCampaignSearch
    ? savedCampaigns.filter((item) => [item.name, item.id, item.number, item.config.seedUrl, item.config.customerId, item.config.googleCampaignId]
      .some((value) => String(value ?? "").toLowerCase().includes(normalizedCampaignSearch)))
    : savedCampaigns;
  const campaignPageCount = Math.max(1, Math.ceil(filteredSavedCampaigns.length / campaignPageSize));
  const visibleCampaignPage = Math.min(campaignPage, campaignPageCount);
  const visibleSavedCampaigns = filteredSavedCampaigns.slice((visibleCampaignPage - 1) * campaignPageSize, visibleCampaignPage * campaignPageSize);


  const send = (message: unknown) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify(message));
    return true;
  };

  useEffect(() => {
    setMounted(true);
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const connect = () => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(((window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") ? `${scheme}://${window.location.hostname}:${CONTROL_PORT}` : `${scheme}://${window.location.host}/control-ws`), ["tah-control"]);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setLog([]);
        ws.send(JSON.stringify({ type: "list_devices" }));
        ws.send(JSON.stringify({ type: "list_runs" }));
        ws.send(JSON.stringify({ type: "list_schedules" }));
        ws.send(JSON.stringify({ type: "list_campaigns" }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!disposed) retry = setTimeout(connect, 1800);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.type === "hello" || msg.type === "proxy_status") {
            setProxyConfigured(Boolean(msg.payload?.configured));
            setProxyVerifying(false);
            setProxyIdentity({ egressIp: msg.payload?.egressIp, timezone: msg.payload?.timezone, location: msg.payload?.location });
            if (msg.payload?.configured) {
              setProxyPass("");
              setNotice(`Residential route verified: ${msg.payload.egressIp ?? "exit IP"} · ${msg.payload.timezone ?? "timezone"}`);
            }
            if (msg.payload?.host) setProxyHost(msg.payload.host);
            setProxyPort(msg.payload?.port || 12321);
          }
          if (msg.type === "proxy_checking") { setProxyVerifying(true); setProxyConfigured(false); setNotice("Testing authenticated IPRoyal egress and timezone…"); }
          if (msg.type === "devices") {
            const received = Array.isArray(msg.payload) ? msg.payload as Device[] : [];
            const next = received.length ? received : [DEFAULT_DEVICE];
            setDevices(next);
            setDevicePool((current) => current.length === 1 && current[0] === DEFAULT_DEVICE.id
              ? next.map((device) => device.id)
              : current.length ? current : next.map((device) => device.id));
          }
          if (msg.type === "runs") {
            const nextRuns = msg.payload as RunInfo[];
            setRuns(nextRuns);
            for (const run of nextRuns) for (const challenge of run.challenges ?? []) {
              if (challenge.status !== "pending" || seenChallengeIdsRef.current.has(challenge.id)) continue;
              seenChallengeIdsRef.current.add(challenge.id);
              setNotice(`${challenge.vendor} challenge detected in ${run.scenarioId}. The browser session is preserved and waiting for genuine clearance.`);
              if (challengeAlertsEnabledRef.current && typeof Notification !== "undefined" && Notification.permission === "granted") {
                new Notification("Traffic Armour challenge detected", { body: `${challenge.vendor} · ${run.scenarioId} · session preserved` });
              }
            }
          }
          if (msg.type === "schedules") setSchedules(msg.payload as ScheduleInfo[]);
          if (msg.type === "campaigns") setSavedCampaigns(msg.payload as CampaignInfo[]);
          if (msg.type === "campaign_fleet_updated") { setNotice(String(msg.payload.name) + (msg.payload.config?.useScriptMesh ? " added to" : " removed from") + " the Rolling Apps Script Fleet."); send({ type: "list_campaigns" }); }
          if (msg.type === "capacity") { setActiveLimit(msg.payload?.activeLimit ?? 500); setLockedPorts(msg.payload?.lockedPorts ?? []); }
          if (msg.type === "campaign_saved") { setNotice(`Campaign ${String(msg.payload.number).padStart(3, "0")} saved and ${msg.payload.config?.schedule ? "scheduled" : "queued"}.`); send({ type: "list_campaigns" }); }
          if (msg.type === "run_started") { setNotice(`Run ${msg.payload.scenarioId} launched.`); send({ type: "list_runs" }); }
          if (msg.type === "schedule_saved") setNotice(`Daily L4 schedule saved: ${msg.payload.startTime}–${msg.payload.stopTime} ${msg.payload.timezone}.`);
          if (msg.type === "schedule_removed") setNotice(msg.payload?.ok ? "Daily L4 schedule removed." : "Schedule was already removed.");
          if (msg.type === "l4_capture") {
            if (msg.payload?.meshDelivery) setNotice(`Journey captured and exact suffix queued for the Apps Script worker as version ${msg.payload.meshDelivery.version}.`);
            else if (msg.payload?.adsPush) setNotice(`Journey captured and exact suffix synced to Google Ads: ${msg.payload.capture?.suffix ?? ""}`);
            else if (msg.payload?.capture && msg.payload?.syncError) setNotice(`Journey captured, but Google Ads sync failed: ${msg.payload.syncError}`);
            else if (msg.payload?.capture) setNotice(`Journey captured: ${msg.payload.capture.suffix}. Campaign is continuing.`);
            else if (msg.payload?.syncError) setNotice(`Journey finished without a captured suffix: ${msg.payload.syncError}`);
            ws.send(JSON.stringify({ type: "list_campaigns" }));
          }
          if (msg.type === "run_ended") {
            send({ type: "list_runs" });
            if (msg.payload?.meshDelivery) setNotice(`Exact L4 suffix queued for the Apps Script worker as version ${msg.payload.meshDelivery.version}.`);
            else if (msg.payload?.adsPush) setNotice(`Exact L4 suffix captured and synced to Google Ads campaign: ${msg.payload.capture?.suffix ?? ""}`);
            else if (msg.payload?.capture && msg.payload?.syncError) setNotice(`Exact L4 suffix captured, but Google Ads sync failed: ${msg.payload.syncError}`);
            else if (msg.payload?.capture) setNotice(`Exact L4 suffix captured: ${msg.payload.capture.suffix}`);
            else if (msg.payload?.code === 0) setNotice("L4 run completed, but the final landing URL contained no query suffix.");
          }
          if (msg.type === "run_cancelled" || msg.type === "challenge_action_accepted") send({ type: "list_runs" });
          if (msg.type === "log") {
            const stream = msg.payload?.stream ?? msg.stream ?? "stdout";
            const data = msg.payload?.data ?? msg.data ?? "";
            setLog((current) => [...current.slice(-149), `[${stream}] ${String(data).trim()}`]);
          }
          if (msg.type === "error") { setProxyVerifying(false); setNotice(msg.payload?.message ?? "Control server error"); }
        } catch { setNotice("Received an unreadable control-server message."); }
      };
    };
    connect();
    return () => { disposed = true; if (retry) clearTimeout(retry); wsRef.current?.close(); };
  }, []);

  const browserTier = tier !== "trivial-http";
  const selectedCountry = WORLD_COUNTRIES.find((country) => country.code === geo.country);
  const citySuggestions = locationCities.length ? locationCities : MAJOR_CITIES[geo.country] ?? [];
  useEffect(() => {
    let active = true;
    setLocationStates([]);
    setLocationCities([]);
    void fetch(`/api/locations?country=${encodeURIComponent(geo.country)}`)
      .then((response) => response.ok ? response.json() : { states: [] })
      .then((payload) => {
        if (!active) return;
        const states = Array.isArray(payload.states) ? payload.states as LocationState[] : [];
        setLocationStates(states);
        if (geo.state) setStateCode(states.find((item) => item.name.toLowerCase() === geo.state?.toLowerCase() || item.code === geo.state)?.code ?? "");
      })
      .catch(() => { if (active) setLocationStates([]); });
    return () => { active = false; };
  }, [geo.country]);
  useEffect(() => {
    let active = true;
    setLocationCities([]);
    if (!stateCode) return () => { active = false; };
    void fetch(`/api/locations?country=${encodeURIComponent(geo.country)}&state=${encodeURIComponent(stateCode)}`)
      .then((response) => response.ok ? response.json() : { cities: [] })
      .then((payload) => { if (active) setLocationCities(Array.isArray(payload.cities) ? payload.cities : []); })
      .catch(() => { if (active) setLocationCities([]); });
    return () => { active = false; };
  }, [geo.country, stateCode]);
  useEffect(() => { if (browserTier) setProxyMode("sticky-residential"); }, [browserTier]);
  useEffect(() => { if (lockedPorts.includes(proxyPort)) setProxyPort(IPROYAL_PORTS.find((port) => !lockedPorts.includes(port)) ?? proxyPort); }, [lockedPorts, proxyPort]);
  const validUrl = useMemo(() => { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; } }, [url]);
  const capturedCampaigns = useMemo(() => savedCampaigns
    .filter((item) => Boolean(item.latestSuffix))
    .sort((left, right) => Date.parse(right.lastCapturedAt ?? "") - Date.parse(left.lastCapturedAt ?? ""))
    .map((item) => ({
      campaignRecordId: item.id,
      campaignNumber: item.number,
      campaignName: item.name,
      runStatus: item.status,
      suffix: item.latestSuffix ?? "",
      capturedAt: item.lastCapturedAt,
      customerId: item.config.customerId,
      googleAdsCampaignId: item.config.googleCampaignId,
      managerCustomerId: item.config.loginCustomerId,
      meshVersion: item.lastMeshVersion,
      meshQueuedAt: item.lastMeshQueuedAt,
      delivery: item.config.useScriptMesh ? "mesh" as const : item.config.syncGoogleAds ? "direct" as const : "capture" as const,
    })), [savedCampaigns]);
  const burstRequests = Math.min(requestCeiling, Math.max(1, Math.floor(targetRps * (burstDuration - rampSeconds / 2))));
  const ready = connected && proxyConfigured && validUrl && authorized && (!browserTier || devicePool.length > 0) && (!burstMode || burstAuthorized) && (tier !== "human" || (!syncGoogleAds && !useScriptMesh) || Boolean(runCustomerId.trim() && runGoogleCampaignId.trim()));
  const projectedRequests = tier === "trivial-http" ? (burstMode ? burstRequests : repeats * concurrent) : repeats;
  const targetHost = validUrl ? new URL(url).hostname : "invalid target";

  const start = () => {
    setNotice("");
    send({ type: "create_campaign", payload: {
      scenarioId: campaign.trim() || `campaign-${Date.now().toString(36)}`,
      tier, seedUrl: url, proxyMode, expectedVerdict, authorized, continuous: tier === "human", syncGoogleAds: tier === "human" && syncGoogleAds, useScriptMesh: tier === "human" && useScriptMesh,
      proxyPort, customerId: runCustomerId, googleCampaignId: runGoogleCampaignId, loginCustomerId: runLoginCustomerId,
      geo: { country: geo.country.toUpperCase(), state: geo.state?.trim() || undefined, city: geo.city?.trim() || undefined },
      repeats: tier === "human" ? 1 : Number(repeats), concurrent: tier === "human" ? 1 : Math.min(100, Math.max(1, Math.trunc(Number(concurrent) || 1))),
      loadProfile: tier === "trivial-http" && burstMode ? { mode: "burst", targetRps, durationSeconds: burstDuration, rampSeconds, maxRequests: requestCeiling } : undefined,
      devicePool: browserTier ? devicePool : [],
      fingerprintMode: browserTier ? fingerprintMode : undefined,
      mitm: tier === "trivial-http" && tlsCapture,
      challengeSignatures,
      testEnvironment: { mode: stagingMode ? "staging" : "production" },
      session: tier === "human" ? { pages: { min: 1, max: 1 }, internalLinkProbability: 0, headless: !visibleBrowser, followExternalRedirects, challengeHandling: { enabled: false, persistent: false, timeoutSeconds: 300, onTimeout: "stop" as const } } : undefined,
      schedule: dailySchedule && tier === "human" ? { timezone: scheduleTimezone, startTime: scheduleStartTime, stopTime: scheduleStopTime, days: scheduleDays } : undefined,
    } });
  };
  const saveProxy = () => {
    setProxyVerifying(true);
    setNotice("Testing authenticated IPRoyal egress and timezone…");
    send({ type: "set_proxy_config", payload: {
      host: proxyHost, port: Number(proxyPort), user: proxyUser, pass: proxyPass, remember: rememberProxy,
      geo: { country: geo.country.toUpperCase(), state: geo.state?.trim() || undefined, city: geo.city?.trim() || undefined },
    } });
  };

  return (
    <main className="control-shell">
      <aside className="rail">
        <div className="brand-mark">TA</div>
        <nav aria-label="Primary navigation">
          <a className="rail-link active" href="#compose" aria-label="Compose traffic run" title="Compose"><Router size={18} /><span>Compose</span></a>
          <a className="rail-link" href="#ads" aria-label="Google Ads operations" title="Ads"><Megaphone size={18} /><span>Ads</span></a>
          <a className="rail-link" href="#runs" aria-label="Run operations" title="Runs"><Activity size={18} /><span>Runs</span></a>
          <Link className="rail-link" href="/dashboard" aria-label="Telemetry dashboard" title="Telemetry"><TerminalSquare size={18} /><span>Telemetry</span></Link>
        </nav>
        <div className="rail-foot">v0.1</div>
      </aside>

      <div className="workspace">
        <header className="masthead">
          <div><p className="kicker">Traffic Armour / Control Plane</p><h1>Launch traffic with intent.</h1><p className="lede">Build an authorized geo-targeted test, route it through residential egress, and watch the policy response.</p></div>
          <div className="system-state"><span className={connected ? "state-dot online" : "state-dot"} /><div><b>{connected ? "Control online" : "Control offline"}</b><small>{mounted ? ((window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") ? `${window.location.hostname}:${CONTROL_PORT}` : `${window.location.host}/control-ws`) : "control service"}</small></div></div>
        </header>

        <section className="control-auth" aria-label="Remote control authentication">
          <label>Control access token<input type="password" autoComplete="off" value={controlToken} onChange={(event) => setControlToken(event.target.value)} placeholder="Only required for remote deployments" /></label>
<button type="button" onClick={async () => {
  try {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: controlToken }),
    });
    if (!response.ok) throw new Error("The access token was rejected.");
    setControlToken("");
    window.location.reload();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "Unable to establish a secure session.");
  }
}}>Apply token</button>
        </section>

        <section id="compose" className="compose-grid">
          <div className="composer">
            <Section number="01" title="Destination" copy="The property you are authorized to test." />
            <label className="url-field"><Globe2 size={22} /><input aria-label="Target URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-site.com/landing-page" /><span className={validUrl ? "valid" : "invalid"}>{validUrl ? <Check size={16} /> : "URL"}</span></label>
            <div className="field-row two"><Field label="Campaign name"><input value={campaign} onChange={(event) => setCampaign(event.target.value)} /></Field><Field label="Expected response"><select value={expectedVerdict} onChange={(event) => setExpectedVerdict(event.target.value as ExpectedVerdict)}><option value="allow">Allow</option><option value="challenge">Challenge</option><option value="block">Block</option></select></Field></div>

            <div className="rule" /><Section number="02" title="Execution profile" copy="Choose how closely the session should resemble a person." />
            <div className="tier-grid">{TIERS.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={tier === item.id ? "tier-card selected" : "tier-card"} onClick={() => setTier(item.id)}><span className="tier-top"><em>{item.code}</em><Icon size={19} /></span><b>{item.title}</b><small>{item.copy}</small></button>; })}</div>

            <div className="rule" /><Section number="03" title="Residential egress" copy="Country, state and city are encoded into the provider route." />
            <div className="proxy-vault"><div className="proxy-vault-title"><KeyRound size={19} /><div><b>IPRoyal connection</b><small>Credentials can be encrypted locally and automatically restored after refreshes or backend restarts.</small></div><span className={proxyConfigured ? "vault-status ready" : "vault-status"}>{proxyVerifying ? "VERIFYING" : proxyConfigured ? "VERIFIED" : "REQUIRED"}</span></div><div className="field-row two"><Field label="Gateway host or IP"><input value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} /></Field><Field label="Gateway port"><select value={proxyPort} onChange={(event) => setProxyPort(Number(event.target.value))}>{IPROYAL_PORTS.filter((port) => !lockedPorts.includes(port)).map((port) => <option key={port} value={port}>{port}</option>)}</select></Field></div><div className="field-row two"><Field label="IPRoyal username"><input autoComplete="username" value={proxyUser} onChange={(event) => setProxyUser(event.target.value)} /></Field><Field label="IPRoyal base password"><input type="password" autoComplete="new-password" value={proxyPass} onChange={(event) => setProxyPass(event.target.value)} /></Field></div><label className="authorization"><input type="checkbox" checked={rememberProxy} onChange={(event) => setRememberProxy(event.target.checked)} /><span>Remember IPRoyal credentials on this machine using encrypted local storage.</span></label>{proxyConfigured && <div className="credential-note">Verified exit {proxyIdentity.egressIp} · {proxyIdentity.timezone}{proxyIdentity.location ? ` · ${proxyIdentity.location}` : ""}</div>}<button type="button" className="save-proxy" disabled={!connected || !proxyUser || !proxyPass || proxyVerifying} onClick={saveProxy}>{proxyVerifying ? "Verifying authenticated route…" : "Verify IPRoyal with backend"}</button></div>
            <div className="preset-row">{PRESETS.map((preset) => <button type="button" key={preset.label} onClick={() => { setGeo(preset.geo); setStateCode(""); }} className={geo.city === preset.geo.city ? "preset active" : "preset"}>{preset.label}</button>)}</div>
            <div className="field-row three"><Field label="Country"><select value={geo.country} onChange={(event) => { setGeo({ country: event.target.value, state: "", city: "" }); setStateCode(""); }}>{WORLD_COUNTRIES.map((country) => <option key={country.code} value={country.code}>{country.name} ({country.code})</option>)}</select></Field><Field label="State / region (optional)"><select value={stateCode} onChange={(event) => { const code = event.target.value; const state = locationStates.find((item) => item.code === code); setStateCode(code); setGeo({ ...geo, state: state?.name ?? "", city: "" }); }}><option value="">Any state / region</option>{locationStates.map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}</select></Field><Field label="City (optional)"><select value={geo.city ?? ""} onChange={(event) => setGeo({ ...geo, city: event.target.value })}><option value="">Any city</option>{citySuggestions.map((city) => <option key={city} value={city}>{city}</option>)}</select></Field></div>
            <div className="credential-note">IPRoyal route: {selectedCountry?.name ?? geo.country}{geo.state ? ` / ${geo.state}` : ""}{geo.city ? ` / ${geo.city}` : ""}. Leave state and city blank for random country-wide residential exits. Timezone is resolved from the actual exit IP.</div>
            <div className="mode-row"><Mode selected={proxyMode === "rotating-residential"} disabled={browserTier} onClick={() => setProxyMode("rotating-residential")} icon={<RefreshCw size={18} />} title="Per-request rotation" copy={browserTier ? "Raw HTTP only" : "Fresh egress per request"} /><Mode selected={proxyMode === "sticky-residential"} onClick={() => setProxyMode("sticky-residential")} icon={<MapPin size={18} />} title={browserTier ? "One IP per browser" : "Sticky session"} copy={browserTier ? "New residential session each journey" : "Retain one network identity"} /></div>

            <div className="rule" /><Section number="04" title="Volume & identity" copy={tier === "human" ? "L4 runs continuously, one browser journey at a time, until you press Stop. The campaign retains one sticky proxy session and one coherent browser/device identity across unattended retries." : browserTier ? "Set total browser sessions and how many may run at once. Each session receives one device identity, timezone, and sticky residential IP." : "Set request repeats and maximum concurrent execution for the raw HTTP probe."} />
            {tier === "human" ? <div className="projection"><span>Campaign lifecycle</span><b>Continuous · minimum 58s per update · manual stop</b></div> : <div className="field-row three"><Field label={browserTier ? "Independent browser sessions" : "Repeats"}><input type="number" min={1} max={10000} value={repeats} onChange={(event) => setRepeats(Number(event.target.value))} /></Field><Field label="Concurrency (1–100)"><input type="number" min={1} max={100} step={1} value={concurrent} onChange={(event) => { const value = event.currentTarget.valueAsNumber; setConcurrent(Number.isFinite(value) ? Math.min(100, Math.max(1, Math.trunc(value))) : 1); }} /></Field><div className="projection"><span>{browserTier ? "Sessions / running at once" : "Projected requests"}</span><b>{browserTier ? `${projectedRequests.toLocaleString()} / ${Math.min(concurrent, repeats)}` : projectedRequests.toLocaleString()}</b></div></div>}
            {tier === "trivial-http" && <><label className="authorization"><input type="checkbox" checked={burstMode} onChange={(event) => { setBurstMode(event.target.checked); setBurstAuthorized(false); }} /><span>Enable guarded burst load test with precise request pacing.</span></label>{burstMode && <><div className="field-row three"><Field label="Target requests / second"><input type="number" min={1} max={500} value={targetRps} onChange={(event) => setTargetRps(Math.min(500, Math.max(1, Math.trunc(event.currentTarget.valueAsNumber || 1))))} /></Field><Field label="Duration (seconds)"><input type="number" min={1} max={60} value={burstDuration} onChange={(event) => { const value = Math.min(60, Math.max(1, Math.trunc(event.currentTarget.valueAsNumber || 1))); setBurstDuration(value); setRampSeconds((current) => Math.min(current, value)); }} /></Field><Field label="Ramp-up (seconds)"><input type="number" min={0} max={burstDuration} value={rampSeconds} onChange={(event) => setRampSeconds(Math.min(burstDuration, Math.max(0, Math.trunc(event.currentTarget.valueAsNumber || 0))))} /></Field></div><div className="field-row two"><Field label="Hard request ceiling"><input type="number" min={1} max={10000} value={requestCeiling} onChange={(event) => setRequestCeiling(Math.min(10000, Math.max(1, Math.trunc(event.currentTarget.valueAsNumber || 1))))} /></Field><div className="projection"><span>Scheduled burst</span><b>{burstRequests.toLocaleString()} requests</b></div></div><label className="authorization"><input type="checkbox" checked={burstAuthorized} onChange={(event) => setBurstAuthorized(event.target.checked)} /><span>I am authorized to load-test this destination and understand that Stop immediately terminates the run.</span></label></>}</>}
            {tier === "human" && <><div className="credential-note">Each journey waits up to 2 minutes for an exact non-empty suffix. Successful captures respect the 58-second minimum update interval. A detected challenge waits 10 seconds before retrying with the same sticky IP and browser identity. An ordinary no-suffix timeout retries immediately with no cooldown.</div><label className="authorization"><input type="checkbox" checked={followExternalRedirects} onChange={(event) => setFollowExternalRedirects(event.target.checked)} /><span>Follow public cross-domain tracking redirects and record the final landing page.</span></label><label className="authorization"><input type="checkbox" checked={visibleBrowser} onChange={(event) => setVisibleBrowser(event.target.checked)} /><span>Open a visible browser on this machine (local debugging only). Leave off for unattended operation.</span></label></>}
            {browserTier && <div className="devices"><p>Device pool <span>{devicePool.length} of {devices.length} selected</span></p><div className="preset-row"><button type="button" className="preset" onClick={() => setDevicePool(devices.map((device) => device.id))}>Select all devices</button><button type="button" className="preset" onClick={() => setDevicePool([])}>Clear pool</button></div><div>{devices.map((device) => <button type="button" key={device.id} title={`${device.locale} · ${device.touch ? "touch" : "desktop"}`} onClick={() => setDevicePool((current) => current.includes(device.id) ? current.filter((id) => id !== device.id) : [...current, device.id])} className={devicePool.includes(device.id) ? "device selected" : "device"}>{device.touch ? <Smartphone size={15} /> : <Laptop size={15} />}{device.id}</button>)}</div></div>}
            {browserTier && <div className="field-row two"><Field label="Fingerprint profile"><select value={fingerprintMode} onChange={(event) => setFingerprintMode(event.target.value as "balanced" | "hardened")}><option value="hardened">Hardened consistency</option><option value="balanced">Balanced / native-first</option></select></Field><div className="projection"><span>Protected surfaces</span><b>{fingerprintMode === "hardened" ? "Canvas · WebRTC · WebGL · Audio" : "WebRTC · Screen · Hardware"}</b></div></div>}

            <div className="rule" /><Section number="05" title="Measurement coverage" copy="Choose evidence collection and challenge-vendor detection for this run." />
            <div className="sensor-grid">
              <label className={tier === "trivial-http" && tlsCapture ? "sensor-card active" : "sensor-card"}><input type="checkbox" checked={tlsCapture} disabled={tier !== "trivial-http"} onChange={(event) => setTlsCapture(event.target.checked)} /><span><b>TLS ClientHello / JA3</b><small>{tier === "trivial-http" ? "Correlated per request through MITM" : "Raw HTTP tier only; browser session isolation is preserved"}</small></span></label>
              <div className={tier === "human" ? "sensor-card active" : "sensor-card"}><Activity size={17} /><span><b>Frame telemetry</b><small>{tier === "human" ? "DOM behavior batched by animation frame" : "Enabled automatically for Journey tier"}</small></span></div>
            </div>
            <div className="signature-list"><p>Challenge signatures <span>{challengeSignatures.length}/{SIGNATURES.length} active</span></p><div>{SIGNATURES.map((signature) => <button type="button" key={signature} className={challengeSignatures.includes(signature) ? "signature active" : "signature"} onClick={() => setChallengeSignatures((current) => current.includes(signature) ? current.filter((item) => item !== signature) : [...current, signature])}>{signature}</button>)}</div></div>
            <label className="authorization"><input type="checkbox" checked={stagingMode} onChange={(event) => setStagingMode(event.target.checked)} /><span>Enforce staging mode. The backend will accept only hosts listed in <code>TAH_STAGING_TARGETS</code>.</span></label>
          </div>

          <aside className="launch-card">
            <p className="kicker">Launch review</p><h2>{campaign || "Untitled campaign"}</h2>
            <div className="route-visual"><span>{geo.city || geo.state || `${geo.country} · random IP`}</span><i /><span>{targetHost}</span></div>
            <dl><Summary label="Execution" value={burstMode && tier === "trivial-http" ? "Guarded Burst" : TIERS.find((item) => item.id === tier)?.title ?? tier} /><Summary label="Network" value={proxyMode === "rotating-residential" ? "Rotating" : "Sticky"} /><Summary label="Load" value={tier === "human" ? "Continuous · one at a time" : burstMode && tier === "trivial-http" ? `${projectedRequests} requests · ${targetRps} RPS · ${burstDuration}s` : browserTier ? `${projectedRequests} sessions · ${Math.min(concurrent, repeats)} concurrent` : `${projectedRequests} requests · ${concurrent} concurrent`} /><Summary label="Geo" value={geo.state || geo.city ? [geo.city, geo.state, geo.country].filter(Boolean).join(", ") : `${selectedCountry?.name ?? geo.country} · random country-wide exits`} /><Summary label="Evidence" value={tier === "trivial-http" && tlsCapture ? "JA3 + vendor signatures" : tier === "human" ? "Exact suffix · frame telemetry" : "Vendor signatures"} /></dl>
            <div className="checks"><CheckRow pass={connected} label="Control server" /><CheckRow pass={proxyConfigured} label="Verified residential exit" /><CheckRow pass={validUrl} label="Valid target URL" /><CheckRow pass={!browserTier || devicePool.length > 0} label="Device identity" /></div>
            {tier === "human" && <label className="authorization"><input type="checkbox" checked={syncGoogleAds} onChange={(event) => { setSyncGoogleAds(event.target.checked); if (event.target.checked) setUseScriptMesh(false); }} /><span>After capture, insert the exact suffix through the direct Google Ads API. Leave unchecked for traffic testing and capture only.</span></label>}
            {tier === "human" && <label className="authorization"><input type="checkbox" checked={useScriptMesh} onChange={(event) => { setUseScriptMesh(event.target.checked); if (event.target.checked) setSyncGoogleAds(false); }} /><span>After capture, queue the exact suffix for the 2,000-campaign Rolling Apps Script Fleet. The newest value is delivered through the campaign's assigned MCC shard.</span></label>}
            {tier === "human" && (syncGoogleAds || useScriptMesh) && <div className="field-row three"><Field label="Google Ads customer ID"><input value={runCustomerId} onChange={(event) => setRunCustomerId(event.target.value)} placeholder="Client account ID" /></Field><Field label="Google Ads campaign ID"><input value={runGoogleCampaignId} onChange={(event) => setRunGoogleCampaignId(event.target.value)} placeholder="Campaign ID" /></Field><Field label="Manager account ID (MCC)"><input value={runLoginCustomerId} onChange={(event) => setRunLoginCustomerId(event.target.value)} placeholder="Required for MCC access" /></Field></div>}
            {tier === "human" && <label className="authorization"><input type="checkbox" checked={dailySchedule} onChange={(event) => setDailySchedule(event.target.checked)} /><span>Run this L4 campaign automatically every day during a local-time window.</span></label>}
            {tier === "human" && dailySchedule && <div className="field-row three"><Field label="Schedule timezone"><select value={scheduleTimezone} onChange={(event) => setScheduleTimezone(event.target.value)}>{INTERNATIONAL_TIMEZONES.map((timezone) => <option key={timezone} value={timezone}>{timezoneLabel(timezone)}</option>)}</select></Field><Field label="Daily start (24-hour)"><input type="time" value={scheduleStartTime} onChange={(event) => setScheduleStartTime(event.target.value)} /></Field><Field label="Daily stop (24-hour)"><input type="time" value={scheduleStopTime} onChange={(event) => setScheduleStopTime(event.target.value)} /></Field></div>}
            {tier === "human" && dailySchedule && <div className="devices"><p>Run on days <span>{scheduleDays.length} of 7 selected</span></p><div className="preset-row"><button type="button" className="preset" onClick={() => setScheduleDays([1, 2, 3, 4, 5])}>Monday–Friday</button><button type="button" className="preset" onClick={() => setScheduleDays([1, 2, 3, 4, 5, 6])}>Monday–Saturday</button><button type="button" className="preset" onClick={() => setScheduleDays(WEEKDAYS.map((day) => day.value))}>Every day</button></div><div>{WEEKDAYS.map((day) => <button type="button" key={day.value} onClick={() => setScheduleDays((current) => current.includes(day.value) ? current.filter((value) => value !== day.value) : [...current, day.value])} className={scheduleDays.includes(day.value) ? "device selected" : "device"}>{day.label}</button>)}</div></div>}
            {tier === "human" && schedules.length > 0 && <div className="checks">{schedules.map((schedule) => <p className={schedule.lastError ? "fail" : "pass"} key={schedule.id}><span>{schedule.lastError ? "!" : <Check size={14} />}</span>{schedule.scenarioId}: {weekdaySummary(schedule.days ?? [])} · {schedule.startTime}–{schedule.stopTime} {schedule.timezone}{schedule.lastError ? ` · ${schedule.lastError}` : ""}<button type="button" onClick={() => send({ type: "remove_schedule", payload: { id: schedule.id } })}>Remove</button></p>)}</div>}
            <label className="authorization"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} /><span>I confirm I own or have written authorization to test this destination.</span></label>
            <button type="button" className="launch" disabled={!ready || (tier === "human" && dailySchedule && scheduleDays.length === 0)} onClick={start}><Play size={18} fill="currentColor" />{tier === "human" && dailySchedule ? "Save daily schedule" : "Launch authorized run"}</button>
            {!proxyConfigured && <p className="credential-note">Enter your IPRoyal gateway, port, username, and base password above, then connect it to the local backend.</p>}
            {notice && <p className="notice">{notice}</p>}
          </aside>
        </section>

        <AdsIntegration captures={capturedCampaigns} />
      <ScriptBridge
        campaigns={savedCampaigns}
        controlConnected={connected}
        onSetFleetCampaign={(campaignRecordId, enabled, nextShardId) => send({ type: "set_campaign_fleet", payload: { id: campaignRecordId, enabled, shardId: nextShardId } })}
      />

        <section id="campaigns" className="run-deck saved-campaigns-deck">
          <div className="run-heading"><div><p className="kicker">Persistent registry</p><h2>Saved campaigns</h2></div><div className="field-row two"><Field label="Active limit (1–5,000)"><input type="number" min={1} max={5000} value={activeLimit} onChange={(event) => setActiveLimit(Math.min(5000, Math.max(1, Math.trunc(event.currentTarget.valueAsNumber || 1))))} /></Field><button type="button" onClick={() => send({ type: "set_active_limit", payload: { limit: activeLimit } })}>Apply capacity</button></div></div>
          <div className="credential-note">{savedCampaigns.length.toLocaleString()} of 5,000 saved · {lockedPorts.length} gateway ports currently leased · campaigns without a free dedicated port remain queued.</div>
          <div className="campaign-registry-tools">
            <label><span>Find a saved campaign</span><input type="search" value={campaignSearch} placeholder="Name, number, URL, customer, or campaign ID" onChange={(event) => { setCampaignSearch(event.currentTarget.value); setCampaignPage(1); }} /></label>
            <span aria-live="polite">{filteredSavedCampaigns.length.toLocaleString()} matching</span>
          </div>
          <div className="run-list">{filteredSavedCampaigns.length === 0 ? <div className="empty"><Activity size={24} /><p>{savedCampaigns.length ? "No campaigns match this search." : "No persistent campaigns saved."}</p></div> : visibleSavedCampaigns.map((item) => <article key={item.id}><span className={item.status === "running" ? "pulse" : "pulse ended"} /><div><b>{String(item.number).padStart(3, "0")} · {item.name}</b><small>Port {item.config.proxyPort} · {item.config.seedUrl}</small></div><strong>{item.status.toUpperCase()}</strong><Link href={`/runs/${encodeURIComponent(item.id)}/edit`}>Edit</Link><button type="button" disabled={item.status === "running"} onClick={() => send({ type: "start_campaign", payload: { id: item.id } })}><Play size={14} />Start</button><button type="button" onClick={() => send({ type: "restart_campaign", payload: { id: item.id } })}><RefreshCw size={14} />Restart</button><button type="button" disabled={item.status !== "running" && item.status !== "queued"} onClick={() => send({ type: "stop_campaign", payload: { id: item.id } })}><CircleStop size={14} />Stop</button></article>)}</div>
          {filteredSavedCampaigns.length > campaignPageSize && <nav className="campaign-pagination" aria-label="Saved campaign pages"><button type="button" disabled={visibleCampaignPage <= 1} onClick={() => setCampaignPage(Math.max(1, visibleCampaignPage - 1))}>Previous</button><span>Page {visibleCampaignPage.toLocaleString()} of {campaignPageCount.toLocaleString()}</span><button type="button" disabled={visibleCampaignPage >= campaignPageCount} onClick={() => setCampaignPage(Math.min(campaignPageCount, visibleCampaignPage + 1))}>Next</button></nav>}
        </section>

        <section id="runs" className="run-deck live-run-deck">
          <div className="run-heading"><div><p className="kicker">Live operations</p><h2>Run deck</h2></div><button type="button" onClick={() => send({ type: "list_runs" })}><RefreshCw size={15} />Refresh</button></div>
          <div className="run-grid"><div className="run-list">{runs.length === 0 ? <div className="empty"><Activity size={24} /><p>No campaigns launched in this session.</p></div> : runs.map((run) => <article key={run.id}><span className={run.alive ? "pulse" : "pulse ended"} /><div><b>{run.scenarioId}</b><small>{run.id} · {new Date(run.startedAt).toLocaleTimeString()}</small></div><strong>{run.alive ? "RUNNING" : run.exitCode === 0 ? "COMPLETE" : "STOPPED"}</strong>{run.dashboardPort && <a href={`/dashboard?run=${encodeURIComponent(run.id)}`} target="_blank" rel="noreferrer">Telemetry</a>}<button type="button" disabled={!run.alive} onClick={() => send({ type: "cancel_run", payload: { id: run.id } })}><CircleStop size={15} />Stop</button></article>)}</div><div className="console"><div><TerminalSquare size={15} />Orchestrator output <span>{log.length} lines</span></div><pre>{log.length ? log.join("\n") : "Waiting for a run. Output will appear here."}</pre></div></div>
          <div className="challenge-queue"><div className="run-heading"><div><p className="kicker">Human intervention</p><h2>Challenge queue</h2></div><strong>{runs.flatMap((run) => run.challenges ?? []).filter((challenge) => challenge.status === "pending").length} pending</strong></div><label className="authorization"><input type="checkbox" checked={challengeAlertsEnabled} onChange={async (event) => { const requested = event.target.checked; if (!requested) { challengeAlertsEnabledRef.current = false; setChallengeAlertsEnabled(false); return; } const granted = typeof Notification !== "undefined" && (Notification.permission === "granted" || await Notification.requestPermission() === "granted"); challengeAlertsEnabledRef.current = granted; setChallengeAlertsEnabled(granted); if (!granted) setNotice("Browser notification permission was not granted."); }} /><span>Show operating-system alerts when a new challenge session is preserved.</span></label>{runs.flatMap((run) => (run.challenges ?? []).filter((challenge) => challenge.status === "pending").map((challenge) => ({ run, challenge }))).length === 0 ? <div className="empty"><ShieldCheck size={24} /><p>No browser sessions are waiting for genuine challenge clearance.</p></div> : runs.flatMap((run) => (run.challenges ?? []).filter((challenge) => challenge.status === "pending").map((challenge) => <article key={challenge.id}><div><span className="challenge-vendor">{challenge.vendor}</span><b>{run.scenarioId}</b><small>{challenge.challengeType} · {challenge.referenceId ?? "no reference ID"}</small></div><p title={challenge.url}>{challenge.url}</p>{challenge.lastError && <p className="challenge-error">{challenge.lastError}</p>}<div className="challenge-actions"><button type="button" onClick={() => send({ type: "challenge_action", payload: { runId: run.id, challengeId: challenge.id, action: "resume" } })}>Check now</button><button type="button" onClick={() => send({ type: "challenge_action", payload: { runId: run.id, challengeId: challenge.id, action: "skip" } })}>Skip</button><button type="button" onClick={() => send({ type: "challenge_action", payload: { runId: run.id, challengeId: challenge.id, action: "stop" } })}>Stop session</button></div></article>))}</div>
        </section>
      </div>
    </main>
  );
}

function Section({ number, title, copy }: { number: string; title: string; copy: string }) { return <div className="section-head"><span>{number}</span><div><h2>{title}</h2><p>{copy}</p></div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label><span>{label}</span>{children}</label>; }
function Mode({ selected, disabled = false, onClick, icon, title, copy }: { selected: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode; title: string; copy: string }) { return <button type="button" disabled={disabled} className={selected ? "mode selected" : "mode"} onClick={onClick}>{icon}<span><b>{title}</b><small>{copy}</small></span></button>; }
function Summary({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function CheckRow({ pass, label }: { pass: boolean; label: string }) { return <p className={pass ? "pass" : "fail"}><span>{pass ? <Check size={14} /> : "!"}</span>{label}</p>; }
