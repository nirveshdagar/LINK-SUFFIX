import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it, expect } from 'vitest';
import { createPublicEgressProxy } from './network.js';

it('denies excluded CONNECT/plain-HTTP origins before the upstream receives any request', async () => {
  let forwarded = 0;
  const upstream = createServer((_req, res) => { forwarded++; res.writeHead(502).end(); });
  upstream.on('connect', (_req, socket) => { forwarded++; socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const guard = await createPublicEgressProxy(new URL('http://127.0.0.1:' + (upstream.address() as AddressInfo).port),
    { allowedOrigins: ['https://affiliate.example'] });
  try {
    for (const [method, target] of [
      ['CONNECT', 'merchant.example:443'], ['CONNECT', 'affiliate.example:8443'],
      ['CONNECT', '127.0.0.1:443'], ['GET', 'http://merchant.example/?irclickid=x'],
      ['GET', 'http://affiliate.example/'],
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: guard.port, method, path: target, agent: false });
        req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
        req.on('response', res => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('Fixture deadline exceeded'))); req.end();
      });
      expect(status).toBe(403);
    }
    expect(forwarded).toBe(0);
  } finally {
    await guard.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
