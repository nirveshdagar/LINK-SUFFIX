"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

const CONTROL_PORT = process.env.NEXT_PUBLIC_CONTROL_WS_PORT ?? "3101";
const PORTS = [12321, ...Array.from({ length: 51 }, (_, index) => 11200 + index), 32325, ...Array.from({ length: 51 }, (_, index) => 51200 + index)];
const DAYS = [{ value: 1, label: "Mon" }, { value: 2, label: "Tue" }, { value: 3, label: "Wed" }, { value: 4, label: "Thu" }, { value: 5, label: "Fri" }, { value: 6, label: "Sat" }, { value: 0, label: "Sun" }];
const TIMEZONES = (() => {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  return [...new Set(["UTC", ...(intl.supportedValuesOf?.("timeZone") ?? ["Asia/Kolkata", "Europe/London", "America/New_York"])])];
})();

type Campaign = {
  id: string;
  number: number;
  name: string;
  status: string;
  config: Record<string, any>;
};

export default function CampaignEditorPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = decodeURIComponent(String(params.id));
  const wsRef = useRef<WebSocket | null>(null);
  const pendingActionRef = useRef<"save" | "restart" | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [form, setForm] = useState<Record<string, any> | null>(null);
  const [lockedPorts, setLockedPorts] = useState<number[]>([]);
  const [notice, setNotice] = useState("Connecting to campaign registry…");
  const [pendingAction, setPendingAction] = useState<"save" | "restart" | null>(null);

  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const local = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
    const wsUrl = local
      ? `${scheme}://${window.location.hostname}:${CONTROL_PORT}`
      : `${scheme}://${window.location.host}/control-ws`;
    const ws = new WebSocket(wsUrl, ["tah-control"]);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "list_campaigns" }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "campaigns") {
        const found = (message.payload as Campaign[]).find((item) => item.id === id) ?? null;
        setCampaign(found);
        setForm((current) => current ?? (found ? { ...found.config, scenarioId: found.name } : null));
        setNotice(found ? "" : "Campaign was not found.");
      }
      if (message.type === "capacity") setLockedPorts(message.payload?.lockedPorts ?? []);
      if (message.type === "campaign_saved") {
        setCampaign(message.payload);
        setForm({ ...message.payload.config, scenarioId: message.payload.name });
        if (pendingActionRef.current === "restart") {
          setNotice("Changes saved. Restarting campaign…");
          ws.send(JSON.stringify({ type: "restart_campaign", payload: { id } }));
        } else if (pendingActionRef.current === "save") {
          pendingActionRef.current = null;
          setPendingAction(null);
          router.push("/#campaigns");
        } else setNotice("Campaign changes saved.");
      }
      if (message.type === "campaign_restarted") {
        pendingActionRef.current = null;
        setPendingAction(null);
        router.push("/#campaigns");
      }
      if (message.type === "error") {
        pendingActionRef.current = null;
        setPendingAction(null);
        setNotice(message.payload?.message ?? "Control backend rejected the change.");
      }
    };
    ws.onclose = () => setNotice("Control backend disconnected.");
    return () => ws.close();
  }, [id, router]);

  const send = (type: string, payload: unknown) => wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ type, payload }));
  const availablePorts = useMemo(() => PORTS.filter((port) => port === Number(form?.proxyPort) || !lockedPorts.includes(port)), [form?.proxyPort, lockedPorts]);
  const set = (key: string, value: unknown) => setForm((current) => current ? { ...current, [key]: value } : current);
  const setDeliveryMethod = (method: "direct" | "mesh", enabled: boolean) => setForm((current) => current ? {
    ...current,
    syncGoogleAds: method === "direct" ? enabled : enabled ? false : current.syncGoogleAds,
    useScriptMesh: method === "mesh" ? enabled : enabled ? false : current.useScriptMesh,
  } : current);
  const setGeo = (key: string, value: string) => setForm((current) => current ? { ...current, geo: { ...(current.geo ?? {}), [key]: value } } : current);
  const schedule = form?.schedule as { timezone?: string; startTime?: string; stopTime?: string; days?: number[] } | undefined;
  const setSchedule = (value: Record<string, unknown> | undefined) => set("schedule", value);
  const submit = (action: "save" | "restart") => {
    if (pendingAction || !form) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("Control backend is not connected. Wait for reconnection and try again.");
      return;
    }
    pendingActionRef.current = action;
    setPendingAction(action);
    setNotice(action === "restart" ? "Saving changes before restart…" : "Saving campaign changes…");
    wsRef.current.send(JSON.stringify({ type: "update_campaign", payload: { ...form, id, authorized: true } }));
  };

  if (!form || !campaign) return <main style={styles.shell}><div style={styles.card}><p>{notice}</p><Link href="/#campaigns">Back to dashboard</Link></div></main>;

  return <main style={styles.shell}>
    <header style={styles.header}><div><p style={styles.kicker}>Campaign {String(campaign.number).padStart(3, "0")}</p><h1 style={styles.title}>Edit {campaign.name}</h1><p style={styles.muted}>Changes apply on the next start or restart. The active process keeps its current immutable configuration.</p></div><Link href="/#campaigns" style={styles.link}>Back to dashboard</Link></header>
    {notice && <div style={styles.notice}>{notice}</div>}
    <section style={styles.card}>
      <h2>Identity and destination</h2>
      <div style={styles.grid}><label style={styles.label}>Campaign name<input style={styles.input} value={form.scenarioId ?? ""} onChange={(event) => set("scenarioId", event.target.value)} /></label><label style={styles.label}>Tracking URL<input style={styles.input} value={form.seedUrl ?? ""} onChange={(event) => set("seedUrl", event.target.value)} /></label></div>
      <div style={styles.grid3}><label style={styles.label}>Dedicated gateway port<select style={styles.input} value={form.proxyPort} onChange={(event) => set("proxyPort", Number(event.target.value))}>{availablePorts.map((port) => <option key={port}>{port}</option>)}</select></label><label style={styles.label}>Country<input style={styles.input} value={form.geo?.country ?? "US"} onChange={(event) => setGeo("country", event.target.value.toUpperCase())} /></label><label style={styles.label}>State<input style={styles.input} value={form.geo?.state ?? ""} onChange={(event) => setGeo("state", event.target.value)} placeholder="Any" /></label><label style={styles.label}>City<input style={styles.input} value={form.geo?.city ?? ""} onChange={(event) => setGeo("city", event.target.value)} placeholder="Any" /></label><label style={styles.label}>Device pool IDs<input style={styles.input} value={(form.devicePool ?? []).join(", ")} onChange={(event) => set("devicePool", event.target.value.split(",").map((value) => value.trim()).filter(Boolean))} /></label></div>
    </section>
    <section style={styles.card}>
      <h2>Google Ads target</h2>
      <label style={styles.check}><input type="checkbox" checked={form.syncGoogleAds === true} onChange={(event) => setDeliveryMethod("direct", event.target.checked)} />After capture, insert the exact suffix through the direct Google Ads API.</label>
      <label style={styles.check}><input type="checkbox" checked={form.useScriptMesh === true} onChange={(event) => setDeliveryMethod("mesh", event.target.checked)} />After capture, queue the exact suffix for the 2,000-campaign Rolling Apps Script Fleet. The newest value is delivered through the campaign&apos;s assigned MCC shard.</label>
      <div style={styles.grid3}><label style={styles.label}>Customer ID<input style={styles.input} value={form.customerId ?? ""} onChange={(event) => set("customerId", event.target.value)} /></label><label style={styles.label}>Campaign ID<input style={styles.input} value={form.googleCampaignId ?? ""} onChange={(event) => set("googleCampaignId", event.target.value)} /></label><label style={styles.label}>Manager account ID (MCC)<input style={styles.input} value={form.loginCustomerId ?? ""} onChange={(event) => set("loginCustomerId", event.target.value)} placeholder="Required when accessed through MCC" /></label></div>
    </section>
    <section style={styles.card}>
      <h2>Daily schedule</h2>
      <label style={styles.check}><input type="checkbox" checked={Boolean(schedule)} onChange={(event) => setSchedule(event.target.checked ? { timezone: "Asia/Kolkata", startTime: "09:00", stopTime: "22:00", days: DAYS.map((day) => day.value) } : undefined)} />Enable timezone-aware daily schedule</label>
      {schedule && <><div style={styles.grid3}><label style={styles.label}>Timezone<select style={styles.input} value={schedule.timezone} onChange={(event) => setSchedule({ ...schedule, timezone: event.target.value })}>{TIMEZONES.map((timezone) => <option key={timezone}>{timezone}</option>)}</select></label><label style={styles.label}>Start<input style={styles.input} type="time" value={schedule.startTime} onChange={(event) => setSchedule({ ...schedule, startTime: event.target.value })} /></label><label style={styles.label}>Stop<input style={styles.input} type="time" value={schedule.stopTime} onChange={(event) => setSchedule({ ...schedule, stopTime: event.target.value })} /></label></div><div style={styles.days}>{DAYS.map((day) => <button type="button" key={day.value} style={(schedule.days ?? []).includes(day.value) ? styles.dayOn : styles.day} onClick={() => setSchedule({ ...schedule, days: (schedule.days ?? []).includes(day.value) ? (schedule.days ?? []).filter((value) => value !== day.value) : [...(schedule.days ?? []), day.value] })}>{day.label}</button>)}</div></>}
    </section>
    <footer style={styles.actions}><button style={styles.primary} disabled={Boolean(pendingAction)} onClick={() => submit("save")}>{pendingAction === "save" && <span style={styles.spinner} />}Save changes</button><button style={styles.secondary} disabled={Boolean(pendingAction)} onClick={() => submit("restart")}>{pendingAction === "restart" && <span style={styles.spinner} />}Restart with saved configuration</button><button style={styles.danger} disabled={Boolean(pendingAction)} onClick={() => send("delete_campaign", { id })}>Delete campaign</button></footer>
    <style>{`@keyframes campaign-editor-spin { to { transform: rotate(360deg); } }`}</style>
  </main>;
}

const styles: Record<string, React.CSSProperties> = {
  shell: { minHeight: "100vh", background: "#f3efe4", color: "#10251d", padding: "40px clamp(18px,5vw,72px)", fontFamily: "Georgia, serif" },
  header: { display: "flex", justifyContent: "space-between", gap: 24, alignItems: "flex-start", maxWidth: 1200, margin: "0 auto 28px" },
  kicker: { font: "700 11px/1 monospace", letterSpacing: ".14em", textTransform: "uppercase", color: "#c64d32" }, title: { fontSize: "clamp(34px,5vw,64px)", margin: "8px 0" }, muted: { color: "#627068", maxWidth: 720 }, link: { color: "#10251d", fontWeight: 700 },
  card: { maxWidth: 1200, margin: "0 auto 18px", padding: 28, border: "1px solid #b9c0b8", borderRadius: 12, background: "rgba(255,255,255,.42)" },
  spinner: { display: "inline-block", width: 14, height: 14, marginRight: 9, border: "2px solid currentColor", borderRightColor: "transparent", borderRadius: "50%", verticalAlign: "-2px", animation: "campaign-editor-spin .7s linear infinite" },
  notice: { maxWidth: 1200, margin: "0 auto 18px", padding: 14, background: "#e6d7a8", borderRadius: 8 }, grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 18 }, grid3: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 18 },
  label: { display: "grid", gap: 7, fontWeight: 700 }, input: { width: "100%", padding: "12px 13px", border: "1px solid #aab3aa", borderRadius: 7, background: "#fbf8ef", color: "#10251d" }, check: { display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }, days: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }, day: { padding: "9px 14px", border: "1px solid #9da89f", background: "transparent", borderRadius: 999 }, dayOn: { padding: "9px 14px", border: "1px solid #10251d", background: "#10251d", color: "white", borderRadius: 999 },
  actions: { maxWidth: 1200, margin: "24px auto", display: "flex", flexWrap: "wrap", gap: 12 }, primary: { padding: "13px 20px", background: "#10251d", color: "white", border: 0, borderRadius: 7, fontWeight: 700 }, secondary: { padding: "13px 20px", background: "#d9c889", color: "#10251d", border: 0, borderRadius: 7, fontWeight: 700 }, danger: { padding: "13px 20px", background: "#b84c38", color: "white", border: 0, borderRadius: 7, fontWeight: 700 },
};
