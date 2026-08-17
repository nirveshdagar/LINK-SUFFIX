import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Aggregator } from './aggregator.js';
import type { EventBus } from '@tah/orchestrator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startDashboard(opts: { port: number; bus: EventBus; runDir: string }) {
  const app = Fastify({ logger: false });
  const agg = new Aggregator();
  opts.bus.on('request', (e) => agg.ingest(e));

  app.get('/events', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    const handler = (e: any) => reply.raw.write(`data: ${JSON.stringify({ kind: 'request', event: e })}\n\n`);
    const aggHandler = () => reply.raw.write(`data: ${JSON.stringify({ kind: 'state', state: agg.state })}\n\n`);
    opts.bus.on('request', handler);
    const iv = setInterval(aggHandler, 1000);
    req.raw.on('close', () => { clearInterval(iv); });
  });

  app.get('/summary', async () => agg.state);

  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
  });
  await app.listen({ host: '127.0.0.1', port: opts.port });
  return new URL(`http://127.0.0.1:${opts.port}/`);
}