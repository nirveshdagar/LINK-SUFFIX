import { request } from 'undici';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { waitForJa3Record } from '@tah/mitm';
import type { Scenario } from '@tah/contracts';
import type { RequestEvent } from '@tah/contracts';
import { fireWithJa3, type TlsFingerprint } from './ja3.js';

// When mitmproxy is in the chain, trust its CA in undici's TLS.
const MITM_CA_PATH = process.env.TAH_MITM_CA_PATH;
let _MITM_CA_CACHE: Buffer | string | undefined;
function getMitmCa(): Buffer | string | undefined {
  const p = process.env.TAH_MITM_CA_PATH ?? MITM_CA_PATH;
  if (!p) return undefined;
  if (_MITM_CA_CACHE) return _MITM_CA_CACHE;
  if (existsSync(p)) {
    _MITM_CA_CACHE = readFileSync(p);
    return _MITM_CA_CACHE;
  }
  return undefined;
}

export async function* run(
  scenario: Scenario,
  proxyUrl: URL,
  _third: unknown,
): AsyncGenerator<RequestEvent> {
  void _third;
  const target = scenario.repeats ?? 1;
  const concurrency = scenario.concurrent ?? 1;
  for (let i = 0; i < target; i++) {
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => fireOne(new URL(scenario.seed_url), proxyUrl, scenario)),
    );
    for (const evt of results) {
      yield evt;
    }
  }
}

export async function fireOne(url: URL, proxyUrl: URL, scenario: Scenario): Promise<RequestEvent> {
  const useProxy = proxyUrl.toString() !== 'direct://';
  const fpSink: { fp?: TlsFingerprint } = {};
  const correlationId = randomUUID();
  const start = Date.now();
  try {
    const result = useProxy
      ? await fireWithJa3(url, proxyUrl, { ca: getMitmCa(), fpSink, headers: { 'x-tah-correlation-id': correlationId } })
      : (await ja3DirectFetch(url, fpSink));
    const ja3 = process.env.TAH_JA3_RECORDER
      ? await waitForJa3Record(process.env.TAH_JA3_RECORDER, correlationId)
      : null;

    return {
      scenario_id: scenario.id,
      repeat_index: 0,
      tier: 'trivial-http' as const,
      geo_requested: scenario.geo,
      proxy_mode: scenario.proxy_mode,
      started_at: new Date(start).toISOString(),
      events: [{
        url: url.toString(),
        method: 'GET' as const,
        status: result.status,
        time_ms: Date.now() - start,
        headers: result.headers,
        ta_signal: fpSink.fp ? {
          tls_version: String(fpSink.fp.tls_version ?? ''),
          tls_cipher: String(fpSink.fp.cipher ?? ''),
          tls_alpn: String(fpSink.fp.alpn ?? ''),
          tls_cert_subject: String(fpSink.fp.server_cert_subject ?? ''),
          tls_cert_issuer: String(fpSink.fp.server_cert_issuer ?? ''),
          ...(ja3 ? {
            ja3: String(ja3.ja3_hash ?? ''),
            ja3_raw: String(ja3.ja3_raw ?? ''),
            tls_capture: 'mitm-correlated',
          } : {}),
        } : {},
        body_snippet: result.body.toString('utf8', 0, 65536),
      }],
      final_verdict: 'unsure' as const,
      timing: { total_ms: Date.now() - start },
    };
  } catch (err: any) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// Fallback: direct HTTPS fetch via undici without a connector.
async function ja3DirectFetch(url: URL, _sink: { fp?: TlsFingerprint }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const res = await request(url, {
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
    headers: {
      'User-Agent': 'tah-trivial-http/1.0',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': '*/*',
    },
  });
  const limit = Math.max(0, Number(process.env.TAH_MAX_RESPONSE_BODY_BYTES ?? 262_144));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    const bytes = Buffer.from(chunk);
    const remaining = limit - size;
    if (remaining <= 0) { res.body.destroy(); break; }
    chunks.push(bytes.subarray(0, remaining));
    size += Math.min(bytes.length, remaining);
    if (size >= limit) { res.body.destroy(); break; }
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) headers[k] = v.join(', ');
    else if (v != null) headers[k] = String(v);
  }
  return { status: res.statusCode, headers, body };
}
