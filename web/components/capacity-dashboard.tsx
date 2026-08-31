"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Activity, AlertTriangle, CheckCircle2, Cpu, Database, Gauge, HardDrive, MemoryStick, Megaphone, Network, RefreshCw, Router, Server, TerminalSquare } from "lucide-react";
import styles from "./capacity-dashboard.module.css";
import AlertRailLink from "./alert-rail-link";
import CapacityRailLink from "./capacity-rail-link";
import ProxyRailLink from "./proxy-rail-link";

type HealthState = "healthy" | "warning" | "critical";

interface CapacitySnapshot {
  generatedAt: number;
  state: HealthState;
  host: { hostname: string; platform: string; architecture: string; nodeVersion: string; uptimeSeconds: number; logicalCpuCount: number; effectiveCpuCount: number; cpuModel: string; memorySource: string };
  load: { systemCpuPercent: number | null; oneMinuteLoad: number; normalizedLoad: number; totalMemoryBytes: number; availableMemoryBytes: number; usedMemoryBytes: number; memoryUsedRatio: number; disk: { totalBytes: number; availableBytes: number; usedBytes: number; availableRatio: number } };
  process: { pid: number; cpuPercent: number; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number; uptimeSeconds: number };
  infrastructure: {
    postgres: { configured: boolean; healthy: boolean; sizeBytes: number; connections: number; maxConnections: number };
    redis: { configured: boolean; healthy: boolean; usedMemoryBytes: number; maxMemoryBytes: number; keys: number };
  };
  services: { leader: boolean; postgresHealthy: boolean; redisHealthy: boolean; proxyConfigured: boolean; proxyVerified: boolean; proxyLocation: string; proxyTimezone: string };
  limits: { savedCampaignLimit: number; activeLimit: number; maxLocalWorkers: number; maxBrowserConcurrency: number; maxTotalConcurrency: number; maxTotalRps: number; launchGapMs: number; launchSpreadMs: number; sharedOrchestratorEnabled: boolean; sharedWorkerProcesses: number; sharedWorkerSlots: number; minimumAvailableMemoryRatio: number; maximumNormalizedLoad: number; targetCpuPercent: number; minimumFreeDiskRatio: number; plannedCampaignMemoryBytes: number; plannedCampaignCpuPercent: number };
  workload: { savedCampaigns: number; activeCampaigns: number; queuedCampaigns: number; errorCampaigns: number; lockedGatewayPorts: number; activeEvidenceBytes: number; evidenceFilesVisited: number; evidenceScanTruncated: boolean; resourceAdmissionAllowed: boolean; resourceAdmissionReasons: string[]; resourceAdmissionBlocks: number };
  capacity: { hardActiveCeiling: number; safeActiveNow: number; safeAdditionalCampaigns: number; additionalByMemory: number; additionalByCpu: number; limitHeadroom: number; recommendations: string[] };
  workerPool: { enabled: boolean; configuredProcesses: number; slotsPerProcess: number; taskCapacity: number; liveProcesses: number; activeTasks: number; browserInstances: number; activeBrowserContexts: number; workers: Array<{ id: string; pid: number | null; activeTasks: number; browserInstances: number; activeContexts: number }> };
  routing: { since: number; preflightAttempts: number; redirectFirstCaptures: number; browserFallbacks: number; cachedFallbacks: number; fallbackReasons: Array<{ reason: string; count: number }> };
  planning: { browserRequiredCampaignTarget: number; recommendedVcpu: number; effectiveVcpu: number; vcpuReady: boolean };
  campaigns: Array<{ campaignRecordId: string | null; campaignNumber: number | null; campaignName: string; runId: string; status: string; tier: string; pid: number | null; workerId: string | null; executionMode: string; routeDecision: { outcome?: string; reason?: string; preflightSkipped?: boolean } | null; startedAt: number; runtimeMs: number; proxyPort: number | null; targetHost: string; plannedCpuPercent: number; plannedMemoryBytes: number; evidenceBytes: number }>;
}

const byteUnits = ["B", "KB", "MB", "GB", "TB"];
function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const unit = Math.min(byteUnits.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${byteUnits[unit]}`;
}
function formatPercent(value: number | null, digits = 0) {
  return value === null || !Number.isFinite(value) ? "Sampling" : `${value.toFixed(digits)}%`;
}
function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
function tone(value: number, warning: number, critical: number) {
  return value >= critical ? "critical" : value >= warning ? "warning" : "healthy";
}

function Meter({ label, value, display, detail, icon }: { label: string; value: number; display: string; detail: string; icon: React.ReactNode }) {
  const clamped = Math.max(0, Math.min(100, value));
  const state = tone(clamped, 65, 85);
  return (
    <article className={styles.meterCard} data-tone={state}>
      <div className={styles.meterRing} style={{ "--meter-angle": `${clamped * 3.6}deg` } as CSSProperties}><span>{icon}</span></div>
      <div><p>{label}</p><strong>{display}</strong><small>{detail}</small></div>
    </article>
  );
}

function ServiceState({ ok, label }: { ok: boolean; label: string }) {
  return <span className={styles.serviceState} data-ok={ok}>{ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{label}</span>;
}

export default function CapacityDashboard() {
  const [snapshot, setSnapshot] = useState<CapacitySnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const requestInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setRefreshing(true);
    try {
      const response = await fetch("/api/capacity", { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as CapacitySnapshot & { error?: string };
      if (!response.ok) throw new Error(body.error || `Capacity request failed (${response.status})`);
      setSnapshot(body);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Capacity data is unavailable");
    } finally {
      requestInFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const memoryPercent = snapshot ? snapshot.load.memoryUsedRatio * 100 : 0;
  const diskPercent = snapshot?.load.disk.totalBytes ? snapshot.load.disk.usedBytes / snapshot.load.disk.totalBytes * 100 : 0;
  const cpuPercent = snapshot?.load.systemCpuPercent ?? 0;
  const capacityPercent = snapshot?.capacity.hardActiveCeiling ? snapshot.workload.activeCampaigns / snapshot.capacity.hardActiveCeiling * 100 : 0;

  return (
    <main className={`control-shell ${styles.shell}`}>
      <aside className="rail">
        <Link className="brand-mark" href="/" aria-label="Traffic Armour home">TA</Link>
        <nav aria-label="Primary navigation">
          <Link className="rail-link" href="/#compose" title="Compose"><Router size={18} /><span>Compose</span></Link>
          <Link className="rail-link" href="/#ads" title="Ads"><Megaphone size={18} /><span>Ads</span></Link>
          <Link className="rail-link" href="/#runs" title="Runs"><Activity size={18} /><span>Runs</span></Link>
          <Link className="rail-link" href="/dashboard" title="Telemetry"><TerminalSquare size={18} /><span>Telemetry</span></Link>
          <ProxyRailLink />
          <CapacityRailLink active />
        <AlertRailLink />
      </nav>
        <div className="rail-foot">v0.1</div>
      </aside>

      <div className={`workspace ${styles.workspace}`}>
        <header className={styles.header}>
          <div><p className="kicker">Infrastructure / Capacity planning</p><h1>Know the ceiling before you reach it.</h1><p>Measured server health and conservative campaign budgets in one operational view.</p></div>
          <div className={styles.headerActions}>
            <span className={styles.overallState} data-state={snapshot?.state || "warning"}>{snapshot?.state || "Connecting"}</span>
            <button type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? styles.spinning : ""} /> Refresh</button>
            <small>{snapshot ? `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}` : "Waiting for server"}</small>
          </div>
        </header>

        {error && <div className={styles.error}><AlertTriangle size={17} /><span>{error}{error.includes("authentication") ? " Apply the control token on the main dashboard, then return here." : ""}</span></div>}

        <section className={styles.meterGrid} aria-label="Live resource load">
          <Meter label="CPU load" value={cpuPercent} display={formatPercent(snapshot?.load.systemCpuPercent ?? null, 1)} detail={snapshot ? `${snapshot.host.effectiveCpuCount.toFixed(1)} effective cores` : "Collecting sample"} icon={<Cpu size={19} />} />
          <Meter label="Memory used" value={memoryPercent} display={formatPercent(memoryPercent, 1)} detail={snapshot ? `${formatBytes(snapshot.load.availableMemoryBytes)} available` : "Collecting sample"} icon={<MemoryStick size={19} />} />
          <Meter label="Disk used" value={diskPercent} display={formatPercent(diskPercent, 1)} detail={snapshot ? `${formatBytes(snapshot.load.disk.availableBytes)} available` : "Collecting sample"} icon={<HardDrive size={19} />} />
          <Meter label="Active capacity" value={capacityPercent} display={snapshot ? `${snapshot.workload.activeCampaigns} / ${snapshot.capacity.hardActiveCeiling}` : "-"} detail={snapshot ? `${snapshot.capacity.safeAdditionalCampaigns} safe to add now` : "Collecting sample"} icon={<Gauge size={19} />} />
        </section>

        <section className={styles.capacityBand} data-state={snapshot?.state || "warning"}>
          <div><p>Safe active count now</p><strong>{snapshot?.capacity.safeActiveNow ?? "-"}</strong><small>Measured headroom plus currently active</small></div>
          <div><p>Safe campaigns to add</p><strong>{snapshot?.capacity.safeAdditionalCampaigns ?? "-"}</strong><small>Minimum of CPU, RAM, disk, and worker limits</small></div>
          <div><p>Saved / queued</p><strong>{snapshot ? `${snapshot.workload.savedCampaigns} / ${snapshot.workload.queuedCampaigns}` : "-"}</strong><small>Saved campaigns consume no browser budget until active</small></div>
          <div className={styles.recommendations}><p>Operator guidance</p>{snapshot?.capacity.recommendations.map(item => <span key={item}>{item}</span>) || <span>Waiting for a complete sample.</span>}</div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeader}><div><p className="kicker">Adaptive routing / Shared execution</p><h2>Browser work avoided and pooled</h2><p>Browser-only domains are cached for 15–60 minutes, then probed again. Every active journey still receives an isolated proxy-bound browser context.</p></div><Network size={22} /></div>
          <div className={styles.routingGrid}>
            <div><span>Redirect-first captures</span><strong>{snapshot?.routing.redirectFirstCaptures ?? "-"}</strong><small>{snapshot ? `${snapshot.routing.preflightAttempts} HTTP preflights attempted` : "Collecting"}</small></div>
            <div><span>Browser fallbacks</span><strong>{snapshot?.routing.browserFallbacks ?? "-"}</strong><small>{snapshot ? `${snapshot.routing.cachedFallbacks} redundant preflights skipped` : "Collecting"}</small></div>
            <div><span>Shared worker tasks</span><strong>{snapshot ? `${snapshot.workerPool.activeTasks} / ${snapshot.workerPool.taskCapacity}` : "-"}</strong><small>{snapshot ? `${snapshot.workerPool.liveProcesses} Node workers · ${snapshot.workerPool.browserInstances} browser instances · ${snapshot.workerPool.activeBrowserContexts} active contexts` : "Collecting"}</small></div>
            <div data-ready={snapshot?.planning.vcpuReady}><span>100-campaign CPU target</span><strong>{snapshot ? `${snapshot.planning.effectiveVcpu.toFixed(1)} / ${snapshot.planning.recommendedVcpu} vCPU` : "-"}</strong><small>{snapshot?.planning.vcpuReady ? "CPU requirement satisfied" : "Use at least 8 vCPU for 100 browser-required campaigns"}</small></div>
          </div>
          <div className={styles.reasonRow}><span>Fallback reasons</span>{snapshot?.routing.fallbackReasons.length ? snapshot.routing.fallbackReasons.map(item => <b key={item.reason}>{item.reason} <i>{item.count}</i></b>) : <b>No browser fallback recorded yet</b>}</div>
        </section>

        <div className={styles.twoColumn}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><div><p className="kicker">Measured configuration</p><h2>Server and services</h2></div><Server size={22} /></div>
            <dl className={styles.specGrid}>
              <div><dt>Server</dt><dd>{snapshot?.host.hostname || "-"}</dd></div>
              <div><dt>Operating system</dt><dd>{snapshot ? `${snapshot.host.platform} / ${snapshot.host.architecture}` : "-"}</dd></div>
              <div><dt>CPU</dt><dd>{snapshot?.host.cpuModel || "-"}</dd></div>
              <div><dt>Logical / effective cores</dt><dd>{snapshot ? `${snapshot.host.logicalCpuCount} / ${snapshot.host.effectiveCpuCount.toFixed(1)}` : "-"}</dd></div>
              <div><dt>Total RAM</dt><dd>{snapshot ? `${formatBytes(snapshot.load.totalMemoryBytes)} (${snapshot.host.memorySource})` : "-"}</dd></div>
              <div><dt>Total disk</dt><dd>{snapshot ? formatBytes(snapshot.load.disk.totalBytes) : "-"}</dd></div>
              <div><dt>Server uptime</dt><dd>{snapshot ? formatDuration(snapshot.host.uptimeSeconds) : "-"}</dd></div>
              <div><dt>Node runtime</dt><dd>{snapshot?.host.nodeVersion || "-"}</dd></div>
            </dl>
            <div className={styles.serviceRow}>
              <ServiceState ok={Boolean(snapshot?.services.leader)} label="Leader" />
              <ServiceState ok={Boolean(snapshot?.services.postgresHealthy)} label="PostgreSQL" />
              <ServiceState ok={Boolean(snapshot?.services.redisHealthy)} label="Redis" />
              <ServiceState ok={Boolean(snapshot?.services.proxyVerified)} label="Residential proxy" />
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}><div><p className="kicker">Configured guardrails</p><h2>Execution limits</h2></div><Network size={22} /></div>
            <dl className={styles.limitList}>
              <div><dt>Dashboard active limit</dt><dd>{snapshot?.limits.activeLimit ?? "-"}</dd></div>
              <div><dt>Local browser workers</dt><dd>{snapshot?.limits.maxLocalWorkers ?? "-"}</dd></div>
              <div><dt>Browser concurrency</dt><dd>{snapshot?.limits.maxBrowserConcurrency ?? "-"}</dd></div>
              <div><dt>Total concurrency</dt><dd>{snapshot?.limits.maxTotalConcurrency ?? "-"}</dd></div>
              <div><dt>Total request ceiling</dt><dd>{snapshot ? `${snapshot.limits.maxTotalRps} RPS` : "-"}</dd></div>
              <div><dt>Campaign launch gap</dt><dd>{snapshot ? `${(snapshot.limits.launchGapMs / 1000).toFixed(1)} sec` : "-"}</dd></div>
              <div><dt>Full launch spread</dt><dd>{snapshot ? `${(snapshot.limits.launchSpreadMs / 1000).toFixed(0)} sec` : "-"}</dd></div>
              <div><dt>Shared Node workers</dt><dd>{snapshot ? `${snapshot.limits.sharedWorkerProcesses} × ${snapshot.limits.sharedWorkerSlots} task slots` : "-"}</dd></div>
              <div><dt>Reserved memory floor</dt><dd>{snapshot ? formatPercent(snapshot.limits.minimumAvailableMemoryRatio * 100) : "-"}</dd></div>
              <div><dt>Required free disk</dt><dd>{snapshot ? formatPercent(snapshot.limits.minimumFreeDiskRatio * 100) : "-"}</dd></div>
            </dl>
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelHeader}><div><p className="kicker">Measured components</p><h2>Where memory and space are going</h2></div><Database size={22} /></div>
          <div className={styles.componentTable}>
            <div className={styles.tableHead}><span>Component</span><span>CPU</span><span>Memory</span><span>Storage / count</span><span>State</span></div>
            <div><span><Server size={15} /> Control process <small>PID {snapshot?.process.pid || "-"}</small></span><b>{snapshot ? formatPercent(snapshot.process.cpuPercent, 1) : "-"}</b><b>{snapshot ? `${formatBytes(snapshot.process.rssBytes)} RSS` : "-"}</b><b>{snapshot ? `${formatBytes(snapshot.process.heapUsedBytes)} heap` : "-"}</b><ServiceState ok={!error} label={error ? "Unavailable" : "Online"} /></div>
            <div><span><Activity size={15} /> Active browser budget <small>Planning model</small></span><b>{snapshot ? `${snapshot.workload.activeCampaigns * snapshot.limits.plannedCampaignCpuPercent}% core budget` : "-"}</b><b>{snapshot ? formatBytes(snapshot.workload.activeCampaigns * snapshot.limits.plannedCampaignMemoryBytes) : "-"}</b><b>{snapshot ? `${snapshot.workload.activeCampaigns} active` : "-"}</b><ServiceState ok={Boolean(snapshot?.workload.resourceAdmissionAllowed)} label={snapshot?.workload.resourceAdmissionAllowed ? "Admitted" : "Blocked"} /></div>
            <div><span><Database size={15} /> PostgreSQL <small>Durable state</small></span><b>-</b><b>{snapshot ? `${snapshot.infrastructure.postgres.connections} / ${snapshot.infrastructure.postgres.maxConnections} connections` : "-"}</b><b>{snapshot ? formatBytes(snapshot.infrastructure.postgres.sizeBytes) : "-"}</b><ServiceState ok={Boolean(snapshot?.infrastructure.postgres.healthy)} label={snapshot?.infrastructure.postgres.healthy ? "Healthy" : "Offline"} /></div>
            <div><span><Network size={15} /> Redis <small>Queue coordination</small></span><b>-</b><b>{snapshot ? formatBytes(snapshot.infrastructure.redis.usedMemoryBytes) : "-"}</b><b>{snapshot ? `${snapshot.infrastructure.redis.keys} keys` : "-"}</b><ServiceState ok={Boolean(snapshot?.infrastructure.redis.healthy)} label={snapshot?.infrastructure.redis.healthy ? "Healthy" : "Offline"} /></div>
            <div><span><HardDrive size={15} /> Active evidence <small>{snapshot?.workload.evidenceScanTruncated ? "Capped scan" : "Measured files"}</small></span><b>-</b><b>-</b><b>{snapshot ? `${formatBytes(snapshot.workload.activeEvidenceBytes)} / ${snapshot.workload.evidenceFilesVisited} files` : "-"}</b><ServiceState ok={!snapshot?.workload.evidenceScanTruncated} label={snapshot?.workload.evidenceScanTruncated ? "Partial" : "Measured"} /></div>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeader}><div><p className="kicker">Campaign decisions</p><h2>Active campaign resource deck</h2><p>CPU and RAM are conservative planning budgets. Evidence size, runtime, PID, and port are measured.</p></div><Activity size={22} /></div>
          <div className={styles.campaignScroller}>
            <table className={styles.campaignTable}>
              <thead><tr><th>Campaign</th><th>Runtime</th><th>Process</th><th>Gateway</th><th>CPU budget</th><th>RAM budget</th><th>Evidence</th></tr></thead>
              <tbody>
                {snapshot?.campaigns.length ? snapshot.campaigns.map(campaign => (
                  <tr key={campaign.runId}>
                    <td><strong>{campaign.campaignNumber ? String(campaign.campaignNumber).padStart(3, "0") + " · " : ""}{campaign.campaignName}</strong><small>{campaign.targetHost || campaign.runId}</small></td>
                    <td>{formatDuration(campaign.runtimeMs / 1000)}</td>
                    <td>PID {campaign.pid || "-"}<small>{campaign.workerId ? `${campaign.workerId} · ${campaign.executionMode}` : campaign.tier}</small></td>
                    <td>{campaign.proxyPort || "-"}</td>
                    <td>{formatPercent(campaign.plannedCpuPercent)}</td>
                    <td>{formatBytes(campaign.plannedMemoryBytes)}</td>
                    <td>{formatBytes(campaign.evidenceBytes)}</td>
                  </tr>
                )) : <tr><td colSpan={7} className={styles.empty}>No active campaigns. This is the best time to record the server's idle baseline.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <footer className={styles.methodNote}><strong>Capacity method:</strong> continuous L4 campaigns use shared Node workers and isolated browser contexts. Starts are distributed across the configured 58-second spread. CPU/RAM values remain conservative planning budgets until a production cgroup soak supplies exact per-context attribution.</footer>
      </div>
    </main>
  );
}
