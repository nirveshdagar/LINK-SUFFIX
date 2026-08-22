"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
type Tier = "trivial-http" | "headless" | "stealth" | "human";
type ProxyMode = "rotating-residential" | "sticky-residential";
interface Geo { country: string; state?: string; city?: string; tz?: string; }
interface Device { id: string; family: string; locale: string; touch: boolean; }
interface RunInfo { id: string; scenarioId: string; startedAt: number; alive: boolean; }
const TIERS: Tier[] = ["trivial-http", "headless", "stealth", "human"];
const PROXY_MODES: ProxyMode[] = ["rotating-residential", "sticky-residential"];
const GEO_PRESETS: Geo[] = [
  { country: "US", state: "CA", city: "LosAngeles", tz: "America/Los_Angeles" },
  { country: "US", state: "NY", city: "NewYork", tz: "America/New_York" },
  { country: "US", state: "TX", city: "Dallas", tz: "America/Chicago" },
  { country: "GB", city: "London", tz: "Europe/London" },
  { country: "DE", city: "Berlin", tz: "Europe/Berlin" },
  { country: "IN", state: "MH", city: "Mumbai", tz: "Asia/Kolkata" },
  { country: "JP", city: "Tokyo", tz: "Asia/Tokyo" },
  { country: "BR", state: "SP", city: "SaoPaulo", tz: "America/Sao_Paulo" },
];
export default function ControlPanel() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [url, setUrl] = useState("https://digitalserviceone.com/");
  const [tier, setTier] = useState<Tier>("trivial-http");
  const [proxyMode, setProxyMode] = useState<ProxyMode>("rotating-residential");
  const [geo, setGeo] = useState<Geo>(GEO_PRESETS[0]);
  const [repeats, setRepeats] = useState(10);
  const [concurrent, setConcurrent] = useState(5);
  const [scenarioId, setScenarioId] = useState("auto");
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicePool, setDevicePool] = useState<string[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    const ws = new WebSocket("ws://127.0.0.1:3001");
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "list_devices" }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "devices") setDevices(msg.payload as Device[]);
        if (msg.type === "geos") {/* unused */}
        if (msg.type === "runs") setRuns(msg.payload as RunInfo[]);
        if (msg.type === "log") {
          const { stream, data } = msg.payload as { stream: string; data: string };
          setLog((l) => [...l.slice(-199), "[" + stream + "] " + String(data).trim()]);
        }
      } catch {}
    };
    return () => ws.close();
  }, []);
  const start = () => {
    if (!connected) return;
    const sid = scenarioId === "auto" ? "ui-" + Date.now().toString(36) : scenarioId;
    wsRef.current?.send(JSON.stringify({
      type: "create_run",
      payload: {
        scenarioId: sid,
        tier,
        seedUrl: url,
        geo,
        proxyMode,
        repeats: Number(repeats),
        concurrent: Number(concurrent),
        devicePool: tier === "trivial-http" ? [] : devicePool,
      },
    }));
  };
  const cancel = (id: string) => wsRef.current?.send(JSON.stringify({ type: "cancel_run", payload: { id } }));

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-200 p-6 space-y-4">
      <header className="flex items-center justify-between border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold text-zinc-100">Traffic Armour Harness — Control</h1>
          <Link href="/" className="text-xs text-cyan-400 hover:underline">Live dashboard</Link>
        </div>
        <span className={"text-xs " + (connected ? "text-emerald-400" : "text-rose-400")}>
          {connected ? "control server connected" : "control server unreachable"}
        </span>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-zinc-800 rounded p-4 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Scenario</h2>
          <label className="block text-xs text-zinc-500 space-y-1"><span className="uppercase tracking-wider">URL</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-200 text-sm" />
          </label>

          <label className="block text-xs text-zinc-500 space-y-1">
            <span className="uppercase tracking-wider">tier</span>
            <select value={tier} onChange={(e) => setTier(e.target.value as Tier)} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-200 text-sm">
              {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>

          <label className="block text-xs text-zinc-500 space-y-1">
            <span className="uppercase tracking-wider">country / city</span>
            <select value={geo.country + "-" + (geo.state ?? "") + "-" + (geo.city ?? "")}
              onChange={(e) => {
                const idx = Number(e.target.value);
                setGeo(GEO_PRESETS[idx]);
              }}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-200 text-sm">
              {GEO_PRESETS.map((g, i) => (
                <option key={i} value={i}>
                  {g.country}{g.state ? " / " + g.state : ""} / {g.city ?? ""} {g.tz ? "(" + g.tz + ")" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs text-zinc-500 space-y-1">
            <span className="uppercase tracking-wider">repeats</span>
            <input type="number" min={1} value={repeats} onChange={(e) => setRepeats(Number(e.target.value))} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-200 text-sm" />
          </label>

          <button onClick={start} disabled={!connected} className="w-full rounded bg-cyan-500 hover:bg-cyan-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-zinc-950 font-semibold py-2 mt-2">Start run</button>
        </div>

        <div className="border border-zinc-800 rounded p-4 space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Devices</h2>
          <div className="flex flex-wrap gap-2">
            {devices.map((d) => {
              const on = devicePool.includes(d.id);
              return (
                <button type="button" key={d.id} onClick={() => setDevicePool((p) => (on ? p.filter((x) => x !== d.id) : [...p, d.id]))} className={"px-2 py-1 rounded border text-xs " + (on ? "border-cyan-500 bg-cyan-500/10 text-cyan-300" : "border-zinc-800 text-zinc-500")}>{d.id}</button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-zinc-800 rounded p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Runs</h2>
          {runs.length === 0 ? (
            <div className="text-xs text-zinc-600">No runs yet. Pick a scenario and click Start.</div>
          ) : (
            <ul className="space-y-1">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm border border-zinc-900 rounded px-2 py-1">
                  <span>{r.scenarioId}</span>
                  <button type="button" disabled={!r.alive} onClick={() => cancel(r.id)} className="text-xs px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800">{r.alive ? "cancel" : "done"}</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border border-zinc-800 rounded p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Log</h2>
          <pre className="bg-zinc-950 border border-zinc-900 rounded p-2 h-64 overflow-y-auto text-[10px] font-mono text-zinc-300 whitespace-pre-wrap">{log.join("\n")}</pre>
        </div>
      </section>
    </main>
  );
}
