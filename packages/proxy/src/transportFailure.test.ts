import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { openPublicSocket } from './network.js';
import { ProxyResponseError, ProxyTransportError, classifyProxyConnectError, isProxyTransportFailure } from './transportFailure.js';

describe('trusted proxy connection failure boundary', () => {
  it.each([
    ['ECONNREFUSED', 'connection_refused'], ['ECONNRESET', 'connection_reset'],
    ['EPIPE', 'connection_reset'], ['ENETUNREACH', 'network_unreachable'],
    ['EHOSTUNREACH', 'network_unreachable'], ['ETIMEDOUT', 'connect_timeout'],
  ])('classifies %s only when supplied by the connection boundary', (code, expected) => {
    const failure = classifyProxyConnectError(Object.assign(new Error('connection failed'), { code }));
    expect(failure?.transportCode).toBe(expected);
    expect(isProxyTransportFailure(failure)).toBe(true);
  });
  it.each([
    'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_CERT_AUTHORITY_INVALID',
    'proxy authentication failed', 'navigation timeout', 'database unavailable',
    'Target rejected capture: cloudflare_challenge', 'HTTP 403', 'HTTP 429',
  ])('does not turn an arbitrary error into failover authorization: %s', message => {
    expect(classifyProxyConnectError(new Error(message))).toBeUndefined();
    expect(isProxyTransportFailure(message)).toBe(false);
  });
  it.each([403, 407, 429])('keeps upstream HTTP %s separate from outages', status => {
    const error = new ProxyResponseError(status, '60', '0123456789abcdef-DEL');
    expect(classifyProxyConnectError(error)).toBeUndefined();
    expect(isProxyTransportFailure(error)).toBe(false);
  });
  it('requires an exact trusted reason, not a substring or suffix in another error', () => {
    expect(isProxyTransportFailure(new ProxyTransportError('node_unavailable'))).toBe(true);
    expect(isProxyTransportFailure('prefix Proxy transport failure: node_unavailable')).toBe(false);
    expect(isProxyTransportFailure('Proxy transport failure: node_unavailable; HTTP 403')).toBe(false);
  });
});

describe('loopback-only CONNECT fixture', () => {
  it.each([403, 407, 429, 502, 503, 504])('handles upstream status %s without contacting an origin', async status => {
    const sockets = new Set<Socket>();
    const server = createServer();
    let connects = 0;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('connect', (_request, socket) => {
      connects++;
      // This fixture never forwards CONNECT or creates an origin connection.
      socket.end('HTTP/1.1 ' + status + ' Fixture\r\nRetry-After: 60\r\nCF-Ray: 0123456789abcdef-DEL\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind');
    try {
      // Public literal passes destination validation without DNS. Only the
      // loopback proxy is contacted; the fixture above never forwards traffic.
      const operation = openPublicSocket(new URL('https://1.1.1.1/never-contacted'),
        new URL('http://127.0.0.1:' + address.port), { timeoutMs: 1000 });
      if (status >= 500) {
        await expect(operation).rejects.toMatchObject({ name: 'ProxyTransportError', transportCode: 'node_unavailable' });
      } else {
        await expect(operation).rejects.toMatchObject({ name: 'ProxyResponseError', status, retryAfter: '60', rayId: '0123456789abcdef-DEL' });
      }
      expect(connects).toBe(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
