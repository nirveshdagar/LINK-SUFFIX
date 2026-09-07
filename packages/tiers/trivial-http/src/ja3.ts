import { connect as tlsConnect, checkServerIdentity, type TLSSocket } from 'node:tls';
import { request as httpRequest } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { openPublicSocket, publicHttpUrl, normalizedHost, withDeadline } from '@tah/proxy';

export interface TlsFingerprint {
  tls_version?: string; cipher?: string; alpn?: string;
  server_cert_subject?: string; server_cert_issuer?: string;
}
/** Public, pinned direct/HTTP/HTTPS/SOCKS transport. TLS metadata is observed,
 * not a fabricated JA3 hash. Exact URL query bytes are never rebuilt. */
export async function fireWithJa3(url: URL, proxyUrl: URL | null, opts: {
  headers?: Record<string, string>; ca?: Buffer | string; method?: string;
  fpSink?: { fp?: TlsFingerprint }; headersOnly?: boolean; maxBodyBytes?: number; timeoutMs?: number;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer; fp: TlsFingerprint; bodyCaptureState: BodyCaptureState }> {
  const target = publicHttpUrl(url);
  const fp: TlsFingerprint = {};
  const deadline = Date.now() + Math.max(1, Math.min(120_000, Number(opts.timeoutMs) || 15_000));
  const remaining = () => Math.max(1, deadline - Date.now());
  const targetHost = normalizedHost(target.hostname);
  let socket: Socket | TLSSocket | undefined;
  try {
    socket = await openPublicSocket(target, proxyUrl, { timeoutMs: remaining() });
    if (target.protocol === 'https:') {
      const underlying = socket;
      socket = await withDeadline(new Promise<TLSSocket>((resolve, reject) => {
        const connection = tlsConnect({
          socket: underlying, host: targetHost, servername: isIP(targetHost) ? undefined : targetHost,
          checkServerIdentity: (_host, certificate) => checkServerIdentity(targetHost, certificate),
          ...(opts.ca ? { ca: opts.ca } : {}),
        });
        connection.once('error', reject);
        connection.once('secureConnect', () => {
          const certificate = connection.getPeerCertificate();
          fp.tls_version = connection.getProtocol() ?? undefined;
          fp.cipher = connection.getCipher()?.name;
          fp.alpn = typeof connection.alpnProtocol === 'string' ? connection.alpnProtocol : undefined;
          const subjectCN = certificate.subject?.CN;
          const issuerCN = certificate.issuer?.CN;
          fp.server_cert_subject = Array.isArray(subjectCN) ? subjectCN.join(', ') : subjectCN;
          fp.server_cert_issuer = Array.isArray(issuerCN) ? issuerCN.join(', ') : issuerCN;
          if (opts.fpSink) opts.fpSink.fp = fp;
          resolve(connection);
        });
      }), remaining());
    }
    const connected = socket;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const request = httpRequest({
        host: targetHost, port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
        method: opts.method ?? 'GET', path: target.pathname + target.search,
        headers: { 'User-Agent': 'tah-trivial-http/1.0', ...opts.headers },
        agent: false, createConnection: () => connected,
      });
      const timer = setTimeout(() => request.destroy(new Error('Request deadline exceeded')), remaining());
      const finish = (error?: Error, value?: { status: number; headers: Record<string, string>; body: Buffer; fp: TlsFingerprint; bodyCaptureState: BodyCaptureState }) => {
        if (settled) return; settled = true; clearTimeout(timer);
        request.destroy(); connected.destroy();
        if (error) reject(error); else resolve(value!);
      };
      request.once('error', (error) => finish(error));
      request.once('response', (response) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        const configured = opts.maxBodyBytes ?? Number(process.env.TAH_MAX_RESPONSE_BODY_BYTES ?? 262_144);
        const limit = Math.min(2_000_000, Math.max(0, Number.isFinite(configured) ? configured : 262_144));
        if (opts.headersOnly || !limit) { finish(undefined, { status, headers, body: Buffer.alloc(0), fp, bodyCaptureState: 'unavailable' }); return; }
        response.on('data', (chunk: Buffer) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const take = Math.min(bytes.length, limit - size);
          if (take > 0) { chunks.push(bytes.subarray(0, take)); size += take; }
          if (size >= limit) finish(undefined, { status, headers, body: Buffer.concat(chunks), fp, bodyCaptureState: 'truncated' });
        });
        response.once('end', () => finish(undefined, { status, headers, body: Buffer.concat(chunks), fp, bodyCaptureState: 'captured' }));
        response.once('error', (error) => finish(error));
        response.once('aborted', () => finish(new Error('Response aborted before completion')));
      });
      request.end();
    });
  } finally { socket?.destroy(); }
}

type BodyCaptureState = 'captured' | 'truncated' | 'unavailable';
