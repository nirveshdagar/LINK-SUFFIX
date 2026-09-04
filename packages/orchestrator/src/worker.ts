#!/usr/bin/env node
import path from 'node:path';
import { EventBus } from '@tah/contracts';
import { browserPoolStats, closeBrowserPool } from '@tah/human-sim';
import { runScenario, type ContextProxyAllocator, type ContextProxyOutcome, type RouteDecision } from './runner.js';
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

interface ActiveProxyLease {
  lease: CampaignProxyLease;
  startedAt: number;
  cpuStarted: NodeJS.CpuUsage;
  renewalTimer?: NodeJS.Timeout;
  renewalFailure: string;
  closed: boolean;
  closing?: Promise<void>;
}

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
    let proxyLeaseFailure = '';
    const activeProxyLeases = new Map<string, ActiveProxyLease>();
    const finalizeProxyLease = async (lease: CampaignProxyLease, outcome: ContextProxyOutcome): Promise<void> => {
      const active = activeProxyLeases.get(lease.leaseId);
      if (!active) return;
      if (active.closing) return active.closing;
      active.closed = true;
      if (active.renewalTimer) clearInterval(active.renewalTimer);
      active.closing = (async () => {
        const cpu = process.cpuUsage(active.cpuStarted);
        const reason = active.renewalFailure || outcome.reason || (outcome.healthy ? undefined : 'browser context failed');
        await reportCampaignProxy({
          ...proxyRuntimeOptions,
          leaseId: lease.leaseId,
          healthy: outcome.healthy && !active.renewalFailure,
          reason,
          proxyLatencyMs: outcome.elapsedMs || Math.max(0, Date.now() - active.startedAt),
          browserCpuMs: Math.round((cpu.user + cpu.system) / 1000),
          browserMemoryBytes: process.memoryUsage().rss,
        }).catch(() => undefined);
        await releaseCampaignProxy({
          ...proxyRuntimeOptions,
          leaseId: lease.leaseId,
          state: active.renewalFailure ? 'expired' : 'released',
        }).catch(() => undefined);
      })().finally(() => activeProxyLeases.delete(lease.leaseId));
      return active.closing;
    };
    const proxyAllocator: ContextProxyAllocator | undefined = proxyRuntimeEnabled ? {
      async acquire(input) {
        const lease = await leaseCampaignProxy({ ...proxyRuntimeOptions, ...input });
        if (!lease) return null;
        const active: ActiveProxyLease = {
          lease,
          startedAt: Date.now(),
          cpuStarted: process.cpuUsage(),
          renewalFailure: '',
          closed: false,
        };
        let renewing = false;
        active.renewalTimer = setInterval(() => {
          if (renewing || active.closed) return;
          renewing = true;
          void renewCampaignProxy({ ...proxyRuntimeOptions, leaseId: lease.leaseId, ttlMs: lease.leaseTtlMs })
            .then((renewed) => {
              if (active.closed || renewed) return;
              active.renewalFailure = 'Universal proxy context lease became stale';
              proxyLeaseFailure ||= active.renewalFailure;
              controller.abort();
            })
            .catch((error) => {
              if (active.closed) return;
              active.renewalFailure = error instanceof Error ? error.message : String(error);
              proxyLeaseFailure ||= active.renewalFailure;
              controller.abort();
            })
            .finally(() => { renewing = false; });
        }, Math.max(10_000, Math.min(30_000, Math.floor(lease.leaseTtlMs / 3))));
        active.renewalTimer.unref();
        activeProxyLeases.set(lease.leaseId, active);
        return lease;
      },
      release: finalizeProxyLease,
    } : undefined;
    send({ type: 'started', runId: job.runId, pid: process.pid });
    try {
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
        proxyAllocator,
        onCapture: (capture) => send({ type: 'capture', runId: job.runId, capture }),
        onRouteDecision: (decision: RouteDecision) => send({ type: 'route_decision', runId: job.runId, decision }),
      });
      send({ type: 'exit', runId: job.runId, code: 0 });
    } catch (error) {
      const aborted = !proxyLeaseFailure && (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'));
      send({ type: 'exit', runId: job.runId, code: aborted ? 143 : 99, error: aborted ? undefined : proxyLeaseFailure || (error instanceof Error ? error.message : String(error)) });
    } finally {
      await Promise.allSettled([...activeProxyLeases.values()].map((active) => finalizeProxyLease(active.lease, {
        healthy: false,
        reason: proxyLeaseFailure || 'campaign worker stopped before browser context cleanup',
        elapsedMs: Math.max(0, Date.now() - active.startedAt),
      })));
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
