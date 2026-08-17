import { ProxyAgent, request } from 'undici';
import type { Scenario } from '@tah/orchestrator';
import type { RequestEvent } from '@tah/orchestrator';

const UA_POOL = [
  'curl/8.4.0',
  'python-requests/2.32.0',
  'Go-http-client/2.0',
  'Wget/1.21.4',
  '',
];

const LANG_POOL = ['', 'en', 'en-US,en;q=0.9', '*']; // some are weird on purpose

function pick<T>(arr: T[]): T {
  const i = Math.floor(Math.random() * arr.length);
  // length is checked by caller convention; arr always non-empty in tests
  return arr[i]!;
}

export async function fireOne(url: URL, proxyUrl: URL, ua: string, lang: string) {
  const dispatcher = new ProxyAgent({ uri: proxyUrl.toString() });
  const start = Date.now();
  const res = await request(url, {
    dispatcher,
    headers: {
      'User-Agent': ua,
      'Accept-Language': lang,
      'Accept': '*/*',
    },
  });
  const body = await res.body.text();
  return {
    url: url.toString(),
    method: 'GET',
    status: res.statusCode,
    time_ms: Date.now() - start,
    headers: res.headers as Record<string, string>,
    ta_signal: {},
    body_snippet: body.slice(0, 65536),
    body,
  };
}

export async function* run(scenario: Scenario, proxyUrl: URL, concurrency = scenario.concurrent ?? 16): AsyncIterable<RequestEvent> {
  const seed = new URL(scenario.seed_url);
  for (let i = 0; i < scenario.repeats; i++) {
    const ua = pick(UA_POOL);
    const lang = pick(LANG_POOL);
    const started = new Date().toISOString();
    const r = await fireOne(seed, proxyUrl, ua, lang);
    yield {
      scenario_id: scenario.id,
      repeat_index: i,
      tier: 'trivial-http',
      geo_requested: scenario.geo,
      proxy_mode: scenario.proxy_mode,
      started_at: started,
      events: [{
        url: r.url, method: r.method, status: r.status, time_ms: r.time_ms,
        headers: r.headers, ta_signal: r.ta_signal,
        body_snippet: r.body_snippet,
      }],
      final_verdict: 'unsure',  // tier does not classify; orchestrator does
      timing: { total_ms: r.time_ms },
    };
  }
}
