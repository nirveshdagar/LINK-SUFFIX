import { Agent, createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { createPublicEgressProxy } from './network.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname !== 'intermediary.fixture.invalid') throw new Error('Unexpected fixture DNS lookup');
    return [{ address: '93.184.216.34', family: 4 }];
  }),
}));

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

async function fixture(
  responseStatus: number,
  run: (state: {
    get: (cookie?: string) => Promise<Reply>;
    tunnels: Array<{ target: string; authorization: string | undefined }>;
    forwarded: string[];
    failures: unknown[];
    directAttempts: () => number;
  }) => Promise<void>,
  connectStatus = 200,
) {
  const tunnels: Array<{ target: string; authorization: string | undefined }> = [];
  const forwarded: string[] = [];
  const failures: unknown[] = [];
  const sockets = new Set<Socket>();
  let directAttempts = 0;
  const original = Agent.prototype.createConnection;
  const connectSpy = vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (this: Agent, options, callback) {
    if ((options.hostname ?? options.host) !== '127.0.0.1') {
      directAttempts++;
      throw new Error('External connection prevented by isolated fixture');
    }
    return original.call(this, options, callback);
  });
  const upstream = createServer((_req, res) => res.writeHead(500).end());
  upstream.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  upstream.on('connect', (req, socket) => {
    tunnels.push({ target: req.url || '', authorization: req.headers['proxy-authorization'] });
    if (connectStatus !== 200) {
      socket.end('HTTP/1.1 ' + connectStatus + ' Proxy unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString();
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      forwarded.push(pending.slice(0, end));
      pending = '';
      const body = 'fixture-response';
      socket.end('HTTP/1.1 ' + responseStatus + ' Fixture\r\n' +
        'Location: https://affiliate.example/?irclickid=exact%2Fbytes&empty=\r\n' +
        'CF-Ray: fixture-ray\r\nRetry-After: 60\r\n' +
        'Content-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
    });
  });
  let guard: Awaited<ReturnType<typeof createPublicEgressProxy>> | undefined;
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    guard = await createPublicEgressProxy(
      new URL('http://campaign-session:fixture-secret@127.0.0.1:' + (upstream.address() as AddressInfo).port),
      { allowedOrigins: ['http://intermediary.fixture.invalid'], timeoutMs: 2000,
        onUpstreamFailure: failure => { failures.push(failure); } },
    );
    const port = guard.port;
    const get = (cookie = 'journey=one') => new Promise<Reply>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, agent: false,
        path: 'http://intermediary.fixture.invalid/redirect?encoded=%2F%2b&empty=',
        headers: { cookie, 'proxy-authorization': 'must-not-reach-target' },
      }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk.toString(); });
        res.once('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
        res.once('error', reject);
      });
      req.once('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Fixture request timed out')));
      req.end();
    });
    await run({ get, tunnels, forwarded, failures, directAttempts: () => directAttempts });
  } finally {
    await guard?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    connectSpy.mockRestore();
  }
}

it('forwards an approved HTTP redirect through the checked proxy socket without a direct connection', async () => {
  await fixture(307, async state => {
    const reply = await state.get();
    expect(reply.status).toBe(307);
    expect(reply.headers.location).toBe('https://affiliate.example/?irclickid=exact%2Fbytes&empty=');
    expect(reply.body).toBe('fixture-response');
    expect(state.tunnels).toEqual([{
      target: '93.184.216.34:80',
      authorization: 'Basic ' + Buffer.from('campaign-session:fixture-secret').toString('base64'),
    }]);
    expect(state.forwarded).toHaveLength(1);
    expect(state.forwarded[0]).toContain('GET /redirect?encoded=%2F%2b&empty= HTTP/1.1');
    expect(state.forwarded[0]).toContain('host: intermediary.fixture.invalid');
    expect(state.forwarded[0]).toContain('cookie: journey=one');
    expect(state.forwarded[0]).not.toMatch(/proxy-authorization|fixture-secret|must-not-reach-target/i);
    expect(state.directAttempts()).toBe(0);
    expect(state.failures).toHaveLength(0);
  });
});

it.each([403, 429])('preserves target HTTP %i diagnostics without retrying or changing the proxy route', async status => {
  await fixture(status, async state => {
    const reply = await state.get();
    expect(reply.status).toBe(status);
    expect(reply.headers['cf-ray']).toBe('fixture-ray');
    expect(reply.headers['retry-after']).toBe('60');
    expect(state.tunnels).toHaveLength(1);
    expect(state.forwarded).toHaveLength(1);
    expect(state.directAttempts()).toBe(0);
    expect(state.failures).toHaveLength(0);
  });
});

it('keeps concurrent forwarded requests on the configured session without mixing their cookies', async () => {
  await fixture(301, async state => {
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => state.get('journey=' + i)));
    expect(replies.every(reply => reply.status === 301)).toBe(true);
    expect(state.tunnels).toHaveLength(12);
    expect(new Set(state.tunnels.map(tunnel => tunnel.authorization)).size).toBe(1);
    expect(state.forwarded).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      expect(state.forwarded.filter(headers => headers.split('\r\n').includes('cookie: journey=' + i))).toHaveLength(1);
    }
    expect(state.directAttempts()).toBe(0);
  });
});

it('fails closed on a proxy outage without sending the target request or connecting directly', async () => {
  await fixture(200, async state => {
    expect((await state.get()).status).toBe(502);
    expect(state.tunnels).toHaveLength(1);
    expect(state.forwarded).toHaveLength(0);
    expect(state.failures).toHaveLength(1);
    expect(state.directAttempts()).toBe(0);
  }, 502);
});
