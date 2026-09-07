import { lookup } from 'node:dns/promises';
import { ProxyTransportError, ProxyResponseError, classifyProxyConnectError } from './transportFailure.js';
import { connect, isIP, type Socket } from 'node:net';
import { createServer, request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function abortError(): Error { return new Error('Operation aborted'); }
export async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(abortError());
      timer = setTimeout(() => reject(new Error('Operation deadline exceeded')), Math.max(1, timeoutMs));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
export function normalizedHost(host: string): string { return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); }
export function isPublicAddress(raw: string): boolean {
  let ip = normalizedHost(raw);
  if (isIP(ip) === 6) {
    // Equivalent IPv6 spellings must receive the same reserved-range verdict.
    try { ip = normalizedHost(new URL(`http://[${ip}]/`).hostname); }
    catch { return false; }
  }
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Global unicast only; mapped/transition/documentation addresses fail closed.
  if (isIP(ip) !== 6 || !/^[23][0-9a-f]{3}:/.test(ip)) return false;
  return !/^2001:(?:0:|:|db8:)/.test(ip) && !ip.startsWith('2002:');
}
export function publicHttpUrl(raw: string | URL): URL {
  const url = new URL(String(raw));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only public HTTP(S) destinations are supported');
  if (url.username || url.password) throw new Error('Credential-bearing destination URLs are blocked');
  const host = normalizedHost(url.hostname);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Local destinations are blocked');
  if (isIP(host) && !isPublicAddress(host)) throw new Error('Non-public destination address is blocked');
  return url;
}
type AddressResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
export async function resolvePublicAddress(hostname: string, resolver: AddressResolver = (host) => lookup(host, { all: true, verbatim: true })): Promise<string> {
  const host = normalizedHost(hostname);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await withDeadline(resolver(host), 5_000);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('DNS destination is not exclusively public');
  return (addresses.find(({ family }) => family === 4) ?? addresses[0])!.address;
}
export function assertProxyProtocol(proxy?: URL | null): void {
  if (proxy && !['direct:', 'http:', 'https:', 'socks5:'].includes(proxy.protocol)) throw new Error('Unsupported upstream proxy protocol');
}
function readBytes(socket: Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('readable', read); socket.off('end', end); socket.off('error', fail); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const end = () => fail(new Error('Proxy closed during handshake'));
    const read = () => {
      const bytes = socket.read(count) as Buffer | null;
      if (!bytes) return;
      cleanup();
      if (bytes.length !== count) reject(new Error('Incomplete proxy handshake')); else resolve(bytes);
    };
    socket.on('readable', read); socket.once('end', end); socket.once('error', fail); read();
  });
}
function socksAddress(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from([1, ...ip.split('.').map(Number)]);
  const [left = '', right = ''] = ip.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const groups = [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  const output = Buffer.alloc(17); output[0] = 4;
  groups.forEach((group, index) => output.writeUInt16BE(parseInt(group, 16), 1 + index * 2));
  return output;
}
/** CONNECT the checked literal IP, retaining original URL/Host/SNI at the caller.
 * No target DNS resolution or direct fallback is delegated to an upstream. */
export async function openPublicSocket(rawUrl: URL, upstream?: URL | null, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Socket> {
  assertProxyProtocol(upstream);
  const url = publicHttpUrl(rawUrl);
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 30_000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const ip = await withDeadline(resolvePublicAddress(url.hostname), remaining(), options.signal);
  if (options.signal?.aborted) throw abortError();
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  let socket: Socket | undefined;
  let request: ClientRequest | undefined;
  let cancelled = false;
  const own = (value: Socket) => { socket = value; value.on('error', () => undefined); return value; };
  try {
    if (!upstream || upstream.protocol === 'direct:') {
      socket = await withDeadline(new Promise<Socket>((resolve, reject) => {
        const value = own(connect({ host: ip, port }));
        value.once('connect', () => resolve(value)); value.once('error', reject);
      }), remaining(), options.signal);
    } else if (upstream.protocol === 'socks5:') {
      const proxy = upstream;
      socket = await withDeadline((async () => {
        const connection = await new Promise<Socket>((resolve, reject) => {
          const value = own(connect({ host: normalizedHost(proxy.hostname), port: Number(proxy.port || 1080) }));
          value.once('connect', () => resolve(value)); value.once('error', reject);
        });
        const user = Buffer.from(decodeURIComponent(proxy.username));
        const pass = Buffer.from(decodeURIComponent(proxy.password));
        if (user.length > 255 || pass.length > 255) throw new Error('SOCKS credentials exceed protocol limits');
        const authenticated = user.length > 0 || pass.length > 0;
        connection.write(Buffer.from([5, 1, authenticated ? 2 : 0]));
        const greeting = await readBytes(connection, 2);
        if (greeting[0] !== 5 || greeting[1] !== (authenticated ? 2 : 0)) throw new Error('SOCKS authentication negotiation failed');
        if (authenticated) {
          connection.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
          const auth = await readBytes(connection, 2);
          if (auth[0] !== 1 || auth[1] !== 0) throw new Error('SOCKS authentication failed');
        }
        const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
        connection.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(ip), portBytes]));
        const reply = await readBytes(connection, 4);
        if (reply[0] === 5 && reply[2] === 0 && [3, 4, 5].includes(reply[1]!)) {
          throw new ProxyTransportError(reply[1] === 5 ? 'connection_refused' : 'network_unreachable');
        }
        if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error('SOCKS CONNECT failed');
        if (reply[3] === 1) await readBytes(connection, 6);
        else if (reply[3] === 4) await readBytes(connection, 18);
        else if (reply[3] === 3) { const length = await readBytes(connection, 1); await readBytes(connection, length[0]! + 2); }
        else throw new Error('Invalid SOCKS address response');
        return connection;
      })(), remaining(), options.signal);
    } else {
      const proxy = upstream;
      const destination = (isIP(ip) === 6 ? '[' + ip + ']' : ip) + ':' + port;
      socket = await withDeadline(new Promise<Socket>((resolve, reject) => {
        const credentials = proxy.username || proxy.password ? Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') : undefined;
        request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
          hostname: normalizedHost(proxy.hostname), port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
          method: 'CONNECT', path: destination, agent: false,
          headers: { Host: destination, ...(credentials ? { 'Proxy-Authorization': 'Basic ' + credentials } : {}) },
        });
        request.once('connect', (response, connection, head) => {
          if (cancelled || response.statusCode !== 200) {
            connection.destroy();
            const status = response.statusCode ?? 0;
            reject(cancelled ? abortError() : [502, 503, 504].includes(status)
              ? new ProxyTransportError('node_unavailable')
              : new ProxyResponseError(status, String(response.headers['retry-after'] ?? ''), String(response.headers['cf-ray'] ?? '')));
            return;
          }
          const value = own(connection); if (head.length) value.unshift(head); resolve(value);
        });
        request.once('response', (response) => { response.destroy(); reject(new Error('Upstream did not establish a tunnel')); });
        request.once('error', reject); request.end();
      }), remaining(), options.signal);
    }
    const ready = socket;
    const abort = () => ready.destroy();
    options.signal?.addEventListener('abort', abort, { once: true });
    ready.once('close', () => options.signal?.removeEventListener('abort', abort));
    if (options.signal?.aborted) { ready.destroy(); throw abortError(); }
    return ready;
  } catch (error) {
    cancelled = true; request?.destroy(); socket?.destroy();
    if (options.signal?.aborted) throw abortError();
    // No target HTTP request has been sent when this connection boundary fails.
    if (upstream && upstream.protocol !== 'direct:') throw classifyProxyConnectError(error) ?? error;
    throw error;
  }
}
export async function createPublicEgressProxy(upstream?: URL | null, options: {
  port?: number; signal?: AbortSignal; timeoutMs?: number;
  onUpstreamFailure?: (failure: { hostname: string; error: ProxyTransportError | ProxyResponseError }) => void;
} = {}) {
  assertProxyProtocol(upstream);
  if (options.signal?.aborted) throw abortError();
  const sockets = new Set<Socket>();
  const reportFailure = (raw: string, error: unknown) => {
    if (!(error instanceof ProxyTransportError) && !(error instanceof ProxyResponseError)) return;
    try { options.onUpstreamFailure?.({ hostname: new URL(raw).hostname, error }); } catch { /* Diagnostic callbacks cannot break socket cleanup. */ }
  };
  let closed = false;
  const track = (socket: Socket) => {
    sockets.add(socket); socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(120_000, () => socket.destroy());
    return socket;
  };
  const server = createServer({ maxHeaderSize: 16_384 }, (incoming, outgoing) => {
    void (async () => {
      const target = publicHttpUrl(incoming.url || '');
      if (target.protocol !== 'http:') throw new Error('HTTPS requires CONNECT');
      const socket = track(await openPublicSocket(target, upstream, options));
      if (closed || incoming.destroyed) { socket.destroy(); return; }
      const headers: import('node:http').OutgoingHttpHeaders = { ...incoming.headers, host: target.host, connection: 'close' };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const request = httpRequest({ hostname: normalizedHost(target.hostname), port: Number(target.port || 80), method: incoming.method, path: target.pathname + target.search, headers, agent: false, createConnection: () => socket }, (response) => {
        outgoing.writeHead(response.statusCode || 502, response.headers); response.pipe(outgoing);
      });
      const timer = setTimeout(() => request.destroy(new Error('Forward request deadline exceeded')), options.timeoutMs ?? 30_000);
      const cleanup = () => { clearTimeout(timer); request.destroy(); socket.destroy(); };
      outgoing.once('close', cleanup);
      request.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.once('aborted', cleanup); incoming.pipe(request);
    })().catch((error) => {
      reportFailure(incoming.url || '', error);
      if (!outgoing.headersSent) outgoing.writeHead(error instanceof ProxyTransportError ? 502 : error instanceof ProxyResponseError ? error.status || 502 : 403);
      outgoing.end();
    });
  });
  server.maxConnections = 128;
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('connect', (request, stream, head) => {
    const client = stream as Socket;
    client.pause();
    void (async () => {
      const target = publicHttpUrl('https://' + (request.url || '') + '/');
      const socket = track(await openPublicSocket(target, upstream, options));
      if (closed || client.destroyed) { socket.destroy(); return; }
      client.once('close', () => socket.destroy()); socket.once('close', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      client.pipe(socket); socket.pipe(client); client.resume();
    })().catch((error) => {
      reportFailure('https://' + (request.url || '') + '/', error);
      const status = error instanceof ProxyTransportError ? 502 : error instanceof ProxyResponseError ? error.status || 502 : 403;
      client.end('HTTP/1.1 ' + status + ' Connection Failed\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  const close = async () => {
    if (closed) return; closed = true; options.signal?.removeEventListener('abort', abort);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const abort = () => { void close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) { await close(); throw abortError(); }
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('Guarded proxy failed to bind'); }
  return { proxy: { server: 'http://127.0.0.1:' + address.port, bypass: '<-loopback>' }, port: address.port, close, activeConnections: () => sockets.size };
}
