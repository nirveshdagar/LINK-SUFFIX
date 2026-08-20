import { ProxyAgent, request } from 'undici';
import { readFileSync, existsSync } from 'node:fs';
import type { Scenario } from '@tah/orchestrator';
import type { RequestEvent } from '@tah/orchestrator';

// When mitmproxy is in the chain, trust its CA in undici's ProxyAgent.
const MITM_CA_PATH = process.env.TAH_MITM_CA_PATH;
const MITM_CA = MITM_CA_PATH && existsSync(MITM_CA_PATH)
  ? readFileSync(MITM_CA_PATH)
  : undefined;

export const SKIP_REQUEST = Symbol.for('tah.skip-request');

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
      if (evt === SKIP_REQUEST) continue;
      yield evt;
    }
  }
}

export async function fireOne(url: URL, proxyUrl: URL, scenario: Scenario): Promise<RequestEvent | typeof SKIP_REQUEST> {
  let dispatcher;
  if (proxyUrl.toString() === 'direct://') {
    dispatcher = undefined;
  } else {
    const authUrl = new URL(proxyUrl.toString());
    authUrl.pathname = '/';
    dispatcher = new ProxyAgent({
      uri: authUrl.toString(),
      requestTls: MITM_CA ? { ca: MITM_CA } : undefined,
    });
  }
  const start = Date.now();
  try {
    const res = await request(url, {
      dispatcher,
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
      headers: {
        'User-Agent': 'tah-trivial-http/1.0',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': '*/*',
      },
    });
    const body = await res.body.text();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) headers[k] = v.join(', ');
      else if (v != null) headers[k] = String(v);
    }
    return {
      scenario_id: scenario.id,
      repeat_index: 0,
      tier: 'trivial-http' as const,
      geo_requested: { country: 'US' },
      proxy_mode: scenario.proxy_mode,
      started_at: new Date(start).toISOString(),
      events: [{
        url: url.toString(),
        method: 'GET' as const,
        status: res.statusCode,
        time_ms: Date.now() - start,
        headers,
        ta_signal: {},
        body_snippet: body.slice(0, 65_536),
      }],
      final_verdict: 'unsure' as const,
      timing: { total_ms: Date.now() - start },
    };
  } catch (err: any) {
    return {
      scenario_id: scenario.id,
      repeat_index: 0,
      tier: 'trivial-http' as const,
      geo_requested: { country: 'US' },
      proxy_mode: scenario.proxy_mode,
      started_at: new Date(start).toISOString(),
      events: [],
      final_verdict: 'error' as const,
      timing: { total_ms: Date.now() - start },
      error: err.message ?? String(err),
    };
  }
}
