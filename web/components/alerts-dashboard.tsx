"use client";

import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, Megaphone, Play, Radio, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import AlertRailLink from "./alert-rail-link";
import CapacityRailLink from "./capacity-rail-link";
import ProxyRailLink from "./proxy-rail-link";
import styles from "./alerts-dashboard.module.css";

type AlertStatus = "observing" | "active" | "acknowledged" | "resolved";
type HealthState = "healthy" | "warning" | "critical";
interface AlertRecord {
  fingerprint: string; severity: "warning" | "critical"; status: AlertStatus; component: string; scope: string;
  code: string; title: string; message: string; remediation: string; campaignRecordId?: string; shardId?: string;
  occurrenceCount: number; firstSeenAt: string; lastSeenAt: string; acknowledgedBy?: string; resolvedAt?: string;
}
interface HeartbeatRecord {
  componentId: string; componentType: string; state: HealthState; message: string; latencyMs?: number; lastSeenAt: string; stale: boolean;
}
interface Report {
  generatedAt: string; state: HealthState;
  summary: { open: number; critical: number; warning: number; acknowledged: number; observing: number; resolved24h: number };
  alerts: AlertRecord[]; heartbeats: HeartbeatRecord[];
}

function age(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function AlertsDashboard() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"open" | "all" | "critical" | "observing">("open");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/alerts?resolved=1", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setReport(payload);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Health report unavailable");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (action: "acknowledge" | "resolve" | "evaluate", fingerprint = "") => {
    setBusy(fingerprint || action);
    try {
      const response = await fetch("/api/alerts", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, fingerprint }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed");
    } finally {
      setBusy("");
    }
  };

  const alerts = useMemo(() => (report?.alerts || []).filter((alert) => {
    if (filter === "open" && alert.status === "resolved") return false;
    if (filter === "critical" && (alert.severity !== "critical" || alert.status === "resolved")) return false;
    if (filter === "observing" && alert.status !== "observing") return false;
    const needle = query.trim().toLowerCase();
    return !needle || [alert.title, alert.message, alert.component, alert.scope, alert.campaignRecordId, alert.shardId]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(needle));
  }), [filter, query, report]);

  const healthy = !error && report?.state === "healthy";
  return (
    <div className={`control-shell ${styles.shell}`}>
      <aside className="rail">
        <Link className="rail-brand" href="/" aria-label="Traffic Armour">TA</Link>
        <nav>
          <Link className="rail-link" href="/"><Play size={18} /><span>Compose</span></Link>
          <Link className="rail-link" href="/#ads"><Megaphone size={18} /><span>Ads</span></Link>
          <Link className="rail-link" href="/#runs"><Radio size={18} /><span>Runs</span></Link>
          <Link className="rail-link" href="/dashboard"><Activity size={18} /><span>Telemetry</span></Link>
          <ProxyRailLink />
          <CapacityRailLink />
          <AlertRailLink active />
        </nav>
      </aside>

      <main className={styles.main}>
        <header className={`${styles.hero} ${healthy ? styles.heroHealthy : styles.heroAlert}`}>
          <div>
            <p className={styles.kicker}>Operational heartbeat</p>
            <h1>{healthy ? "All monitored systems are healthy" : "Attention is required"}</h1>
            <p>Campaign capture, immutable Fleet delivery, Apps Script shards, control dependencies, and sustained server pressure are checked every 15 seconds.</p>
          </div>
          <div className={styles.heroState}>
            {healthy ? <CheckCircle2 size={30} /> : <AlertTriangle size={30} />}
            <strong>{error ? "WATCHDOG UNREACHABLE" : report?.state?.toUpperCase() || "CHECKING"}</strong>
            <span>{report ? `Updated ${age(report.generatedAt)}` : "Waiting for first heartbeat"}</span>
          </div>
        </header>

        {error && <div className={styles.error}><AlertTriangle size={17} />{error}</div>}

        <section className={styles.metrics} aria-label="Alert totals">
          <article><span>OPEN INCIDENTS</span><strong>{report?.summary.open ?? "-"}</strong></article>
          <article><span>CRITICAL</span><strong>{report?.summary.critical ?? "-"}</strong></article>
          <article><span>WARNING</span><strong>{report?.summary.warning ?? "-"}</strong></article>
          <article><span>OBSERVING</span><strong>{report?.summary.observing ?? "-"}</strong></article>
          <article><span>RESOLVED · 24H</span><strong>{report?.summary.resolved24h ?? "-"}</strong></article>
        </section>

        <section className={styles.workspace}>
          <div className={styles.alertColumn}>
            <div className={styles.sectionHead}>
              <div><p className={styles.kicker}>Incident queue</p><h2>Alerts requiring action</h2></div>
              <button type="button" onClick={() => act("evaluate")} disabled={busy === "evaluate"}><RefreshCw size={15} className={busy === "evaluate" ? styles.spin : ""} />Check now</button>
            </div>
            <div className={styles.filters}>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find campaign, shard, component, or problem" />
              <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
                <option value="open">Open and observing</option><option value="critical">Critical only</option>
                <option value="observing">Observing only</option><option value="all">Include resolved</option>
              </select>
            </div>
            <div className={styles.alertList}>
              {!alerts.length && <div className={styles.empty}><CheckCircle2 size={24} /><strong>No alerts in this view</strong><span>Sustained faults will appear here with a direct corrective action.</span></div>}
              {alerts.map((alert) => (
                <article key={alert.fingerprint} className={`${styles.alertCard} ${styles[alert.severity]} ${alert.status === "resolved" ? styles.resolved : ""}`}>
                  <header>
                    <div><span className={styles.badge}>{alert.severity}</span><span className={styles.status}>{alert.status}</span></div>
                    <time title={new Date(alert.lastSeenAt).toLocaleString()}>{age(alert.lastSeenAt)}</time>
                  </header>
                  <h3>{alert.title}</h3>
                  <p>{alert.message}</p>
                  <dl>
                    <div><dt>Component</dt><dd>{alert.component}</dd></div>
                    <div><dt>Scope</dt><dd>{alert.scope}</dd></div>
                    {alert.campaignRecordId && <div><dt>Campaign</dt><dd>{alert.campaignRecordId}</dd></div>}
                    {alert.shardId && <div><dt>Shard</dt><dd>{alert.shardId}</dd></div>}
                  </dl>
                  <div className={styles.remediation}><strong>Safest next action</strong><span>{alert.remediation}</span></div>
                  {alert.status !== "resolved" && <footer>
                    {alert.status === "active" && <button type="button" onClick={() => act("acknowledge", alert.fingerprint)} disabled={busy === alert.fingerprint}>Acknowledge</button>}
                    <button type="button" className={styles.secondary} onClick={() => act("resolve", alert.fingerprint)} disabled={busy === alert.fingerprint}>Resolve</button>
                  </footer>}
                </article>
              ))}
            </div>
          </div>

          <aside className={styles.heartbeatColumn}>
            <div className={styles.sectionHead}><div><p className={styles.kicker}>Micro heartbeat</p><h2>Component state</h2></div><Server size={20} /></div>
            <p className={styles.heartbeatNote}>A missing heartbeat becomes critical after 60 seconds. Normal load does not create an alert.</p>
            <div className={styles.heartbeatList}>
              {(report?.heartbeats || []).map((heartbeat) => (
                <article key={heartbeat.componentId}>
                  <i className={styles[heartbeat.state]} aria-hidden="true" />
                  <div><strong>{heartbeat.componentId}</strong><span>{heartbeat.message}</span><small>{heartbeat.componentType} · {age(heartbeat.lastSeenAt)}{heartbeat.latencyMs !== undefined ? ` · ${heartbeat.latencyMs}ms` : ""}</small></div>
                </article>
              ))}
              {!report?.heartbeats.length && <div className={styles.emptySmall}>Waiting for component heartbeats.</div>}
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
