import Fastify from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Aggregator } from './aggregator.js';
import type { EventBus } from '@tah/contracts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startDashboard(opts: { port: number; bus: EventBus; runDir: string }) {
  const app = Fastify({ logger: false });
  const agg = new Aggregator();
  const runStart = Date.now();
  opts.bus.on('request', (e: Parameters<typeof agg.ingest>[0]) => agg.ingest(e));

  app.get('/events', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.hijack();
    const handler = (e: any) => reply.raw.write(`data: ${JSON.stringify({ kind: 'request', event: e })}\n\n`);
    const aggHandler = () => reply.raw.write(`data: ${JSON.stringify({ kind: 'state', state: { ...agg.state, elapsed_ms: Date.now() - runStart, runId: path.basename(opts.runDir) } })}\n\n`);
    opts.bus.on('request', handler);
    aggHandler();
    const iv = setInterval(aggHandler, 1000);
    req.raw.on('close', () => {
      clearInterval(iv);
      opts.bus.off('request', handler);
    });
  });

  app.get('/summary', async () => ({
    ...agg.state,
    elapsed_ms: Date.now() - runStart,
    runId: path.basename(opts.runDir),
  }));

  // Spec §13.1: server-side endpoints for unsure/mismatches/replays. These
  // read from the same run directory that the orchestrator writes to.
  app.get('/unsure', async (_req, reply) => {
    const p = path.join(opts.runDir, 'unsure.jsonl');
    if (!fs.existsSync(p)) return reply.code(404).send('no unsure file');
    reply.type('application/x-ndjson');
    return fs.createReadStream(p);
  });

  app.get('/mismatches', async (_req, reply) => {
    const p = path.join(opts.runDir, 'mismatches.csv');
    if (!fs.existsSync(p)) return reply.code(404).send('no mismatches file');
    reply.type('text/csv');
    return fs.createReadStream(p);
  });

  app.get('/replays', async () => {
    const replayDir = path.join(opts.runDir, 'replay');
    if (!fs.existsSync(replayDir)) return { bundles: [] };
    const items = fs.readdirSync(replayDir, { withFileTypes: true });
    return {
      bundles: items
        .filter((d) => d.isDirectory())
        .map((d) => ({ id: d.name })),
    };
  });

  app.get<{ Params: { id: string } }>('/replay/:id', async (req, reply) => {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(req.params.id)) return reply.code(400).send('invalid replay id');
    const replayRoot = path.resolve(opts.runDir, 'replay');
    const dir = path.resolve(replayRoot, req.params.id);
    if (!dir.startsWith(`${replayRoot}${path.sep}`)) return reply.code(400).send('invalid replay id');
    if (!fs.existsSync(dir)) return reply.code(404).send('no such replay');
    const files: { name: string; content: string }[] = [];
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      if (stat.isFile()) {
        files.push({ name: f, content: fs.readFileSync(full, 'utf8').slice(0, 1_000_000) });
      }
    }
    return { id: req.params.id, files };
  });

  app.get('/', async (_req, reply) => {
    return reply.send({ service: 'traffic-armour-telemetry', runId: path.basename(opts.runDir), dashboard: '/dashboard' });
  });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.headers.accept?.includes('text/html')) {
      return reply.redirect('/dashboard');
    }
    return reply.code(404).send('not found');
  });
  await app.listen({ host: process.env.TAH_TELEMETRY_HOST ?? '127.0.0.1', port: opts.port });
  // The telemetry server must not keep an otherwise completed CLI run alive.
  // It remains available while the scenario has active work.
  app.server.unref();
  return new URL(`http://127.0.0.1:${opts.port}/`);
}
