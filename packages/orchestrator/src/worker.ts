#!/usr/bin/env node
import path from 'node:path';
import { EventBus } from '@tah/contracts';
import { browserPoolStats, closeBrowserPool } from '@tah/human-sim';
import { runScenario, type RouteDecision } from './runner.js';
import { loadScenario } from './scenarioLoader.js';
import { leaseCampaignProxy, releaseCampaignProxy, renewCampaignProxy, reportCampaignProxy, type CampaignProxyLease } from './proxyRuntimeClient.js';

interface WorkerJob {
  runId: string;
  scenarioPath: string;
  runDir: string;
  challengeDir?: string;
  creds: { user: string; pass: string };
  proxyGateway?: { hostname?: string; port?: number };
}

interface WorkerMessage {
  type: 'start' | 'stop' | 'shutdown';
  job?: WorkerJob;
  runId?: string;
}

const tasks = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const maxTasks = Math.min(5_000, Math.max(1, Number(process.env.TAH_SHARED_WORKER_SLOTS ?? 25)));

function send(message: Record<string, unknown>): void {
  if (process.connected && process.send) process.send(message);
}

function start(job: WorkerJob): void {
  if (!job?.runId || tasks.has(job.runId)) return;
  if (tasks.size >= maxTasks) {
    send({ type: 'exit', runId: job.runId, code: 75, error: `Shared worker task ceiling (${maxTasks}) reached` });
    return;
  }
  const controller = new AbortController();
  const promise = (async () => {
    const proxyRuntimeEnabled = ['1', 'true'].includes(String(process.env.TAH_UNIVERSAL_PROXY_ENABLED || '').toLowerCase());
    const proxyRuntimeOptions = {
      enabled: proxyRuntimeEnabled,
      baseUrl: process.env.TAH_PROXY_RUNTIME_INTERNAL_URL,
      token: process.env.CONTROL_TOKEN || process.env.TAH_API_BEARER_TOKEN,
    };
    const startedAt = Date.now();
    const cpuStarted = process.cpuUsage();
    let proxyLease: CampaignProxyLease | null = null;
    let proxyLeaseFailure = '';
    let renewalTimer: NodeJS.Timeout | undefined;
    let journeyHealthy = false;
    send({ type: 'started', runId: job.runId, pid: process.pid });
    try {
      const scenario = await loadScenario(job.scenarioPath);
      proxyLease = await leaseCampaignProxy({ ...proxyRuntimeOptions, campaignRecordId: scenario.id, sessionId: job.runId, geo: scenario.geo as unknown as Record<string, unknown> });
      if (proxyLease) {
        let renewing = false;
        renewalTimer = setInterval(() => {
          if (renewing || !proxyLease) return;
          renewing = true;
          void renewCampaignProxy({ ...proxyRuntimeOptions, leaseId: proxyLease.leaseId, ttlMs: proxyLease.leaseTtlMs })
            .then((renewed) => { if (!renewed) { proxyLeaseFailure = 'Universal proxy lease became stale'; controller.abort(); } })
            .catch((error) => { proxyLeaseFailure = error instanceof Error ? error.message : String(error); controller.abort(); })
            .finally(() => { renewing = false; });
        }, Math.max(10_000, Math.min(30_000, Math.floor(proxyLease.leaseTtlMs / 3))));
        renewalTimer.unref();
      }
      await runScenario({
        scenarioFile: job.scenarioPath,
        runDir: job.runDir,
        bus: new EventBus(),
        creds: job.creds,
        runId: job.runId,
        telemetryDir: path.join(job.runDir, 'telemetry'),
        challengeDir: job.challengeDir,
        signal: controller.signal,
        proxyGateway: job.proxyGateway,
        mitmUrl: proxyLease?.proxyUrl,
        onCapture: (capture) => send({ type: 'capture', runId: job.runId, capture }),
        onRouteDecision: (decision: RouteDecision) => send({ type: 'route_decision', runId: job.runId, decision }),
      });
      journeyHealthy = true;
      send({ type: 'exit', runId: job.runId, code: 0 });
    } catch (error) {
      const aborted = !proxyLeaseFailure && (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'));
      send({ type: 'exit', runId: job.runId, code: aborted ? 143 : 99, error: aborted ? undefined : proxyLeaseFailure || (error instanceof Error ? error.message : String(error)) });
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      if (proxyLease) {
        const cpu = process.cpuUsage(cpuStarted);
        await reportCampaignProxy({ ...proxyRuntimeOptions, leaseId: proxyLease.leaseId, healthy: journeyHealthy && !proxyLeaseFailure, reason: proxyLeaseFailure || (journeyHealthy ? undefined : 'campaign journey failed'), proxyLatencyMs: Date.now() - startedAt, browserCpuMs: Math.round((cpu.user + cpu.system) / 1000), browserMemoryBytes: process.memoryUsage().rss }).catch(() => undefined);
        await releaseCampaignProxy({ ...proxyRuntimeOptions, leaseId: proxyLease.leaseId, state: proxyLeaseFailure ? 'expired' : 'released' }).catch(() => undefined);
      }
      tasks.delete(job.runId);
      send({ type: 'pool_stats', stats: browserPoolStats(), activeTasks: tasks.size });
    }
  })();
  tasks.set(job.runId, { controller, promise });
}

async function shutdown(): Promise<void> {
  for (const task of tasks.values()) task.controller.abort();
  await Promise.allSettled([...tasks.values()].map((task) => task.promise));
  await closeBrowserPool();
  process.exit(0);
}

process.on('message', (message: WorkerMessage) => {
  if (message?.type === 'start' && message.job) start(message.job);
  else if (message?.type === 'stop' && message.runId) tasks.get(message.runId)?.controller.abort();
  else if (message?.type === 'shutdown') void shutdown();
});

const statsTimer = setInterval(() => send({ type: 'pool_stats', stats: browserPoolStats(), activeTasks: tasks.size }), 5_000);
statsTimer.unref();
process.on('disconnect', () => void shutdown());
send({ type: 'ready', pid: process.pid, maxTasks });
