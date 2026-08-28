import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { request as httpRequest, type RequestOptions as HttpRequestOptions } from 'node:http';

export interface TlsFingerprint {
  tls_version?: string;
  cipher?: string;
  alpn?: string;
  server_cert_subject?: string;
  server_cert_issuer?: string;
}

// Issue an HTTP(S) request via Node stdlib, going through a CONNECT proxy
// tunnel and capturing the JA3 fingerprint from the TLS handshake to the
// destination. Returns the response body, status code, headers, and the
// captured TLS fingerprint.
export async function fireWithJa3(
  url: URL,
  proxyUrl: URL | null,
  opts: { headers?: Record<string, string>; ca?: Buffer | string; method?: string; fpSink?: { fp?: TlsFingerprint } },
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  fp: TlsFingerprint;
}> {
  const fp: TlsFingerprint = {};
  const sink = opts.fpSink ?? { fp: undefined };
  const method = opts.method ?? 'GET';
  const headers = opts.headers ?? {};

  // 1. Open CONNECT tunnel through proxy (or direct).
  const openSocket = async (): Promise<any> => {
    if (!proxyUrl) return null;
    const proxyHost = proxyUrl.hostname;
    const proxyPort = proxyUrl.port ? Number(proxyUrl.port) : 80;
    const proxyAuth = proxyUrl.username || proxyUrl.password
      ? `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
      : undefined;
    return await new Promise<any>((resolve, reject) => {
      const req = httpRequest({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`,
        headers: {
          Host: `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`,
          ...(proxyAuth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxyAuth).toString('base64') } : {}),
        },
      });
      req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) reject(new Error(`CONNECT failed: ${res.statusCode}`));
        else resolve(socket);
      });
      req.once('error', reject);
      req.end();
    });
  };

  const tunneled = await openSocket();
  const targetHost = url.hostname;
  const targetPort = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);

  // 2. If HTTPS, open TLS over the tunneled socket with our JA3-aware connector.
  const tlsSocket = url.protocol === 'https:'
    ? await new Promise<any>((resolve, reject) => {
        const tlsOpts: ConnectionOptions = {
          socket: tunneled ?? undefined,
          servername: targetHost,
          ...(opts.ca ? { ca: opts.ca } : {}),
        };
        const sock = tlsConnect(tlsOpts);
        sock.once('secureConnect', () => {
          const cert = sock.getPeerCertificate() as any;
          fp.tls_version = sock.getProtocol() ?? undefined;
          sink.fp = fp;
          fp.cipher = sock.getCipher()?.name ?? undefined;
          fp.alpn = typeof sock.alpnProtocol === 'string' ? sock.alpnProtocol : undefined;
          fp.server_cert_subject = cert?.subject?.CN;
          fp.server_cert_issuer = cert?.issuer?.CN;
          resolve(sock);
        });
        sock.once('error', reject);
      })
    : tunneled;

  // 3. Send HTTP request over TLS socket (or plain socket for http://).
  return await new Promise((resolve, reject) => {
    const reqOpts: HttpRequestOptions = {
      host: targetHost,
      port: targetPort,
      method,
      path: url.pathname + url.search,
      headers,
      ...(tlsSocket ? { createConnection: () => tlsSocket } : {}),
    };
    const req = httpRequest(reqOpts);
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    req.on('response', (res) => {
      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) hdrs[k] = v.join(', ');
        else if (v != null) hdrs[k] = String(v);
      }
      res.on('data', (c) => {
        const incomingChunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
        const maxBytes = Number(process.env.TAH_MAX_RESPONSE_BODY_BYTES) || 2_000_000;
        const remaining = Math.max(0, maxBytes - bufferedBytes);
        if (remaining <= 0) return;
        const boundedChunk = incomingChunk.length <= remaining ? incomingChunk : incomingChunk.subarray(0, remaining);
        chunks.push(boundedChunk);
        bufferedBytes += boundedChunk.length;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: hdrs, body: Buffer.concat(chunks), fp }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
