#!/usr/bin/env node
import path from 'node:path';
import { EventBus } from '@tah/contracts';
import { browserPoolStats, closeBrowserPool } from '@tah/human-sim';
import { runScenario, type RouteDecision } from './runner.js';

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
        onCapture: (capture) => send({ type: 'capture', runId: job.runId, capture }),
        onRouteDecision: (decision: RouteDecision) => send({ type: 'route_decision', runId: job.runId, decision }),
      });
      send({ type: 'exit', runId: job.runId, code: 0 });
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      send({ type: 'exit', runId: job.runId, code: aborted ? 143 : 99, error: aborted ? undefined : error instanceof Error ? error.message : String(error) });
    } finally {
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
