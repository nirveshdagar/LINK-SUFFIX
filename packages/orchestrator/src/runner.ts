import { run as runTrivial } from '@tah/trivial-http';
import { run as runHeadless } from '@tah/headless-browser';
import { run as runStealth } from '@tah/stealth-browser';
import { run as runHuman } from '@tah/human-sim';
import { buildProxyEndpoint } from '@tah/proxy';
import { defaultStrategies, aggregateVerdict, type Vote } from '@tah/verdict';
import { loadProfile } from '@tah/profiles';
import { loadScenario } from './scenarioLoader.js';
import { EventBus } from '@tah/contracts';
import { JsonlSink, AppendOnlyJsonl } from './jsonlSink.js';
import type { Scenario, RequestEvent } from '@tah/contracts';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_PROFILE = 'desktop-windows-chrome';

// Each tier's `run` has a slightly different 3rd argument (a concurrency number
// for trivial-http, a DeviceProfile for the browser tiers), but they all take
// (scenario, proxyUrl, third) and return AsyncIterable<RequestEvent>. We type
// the dispatcher loosely so the switch in pickTier is statically exhaustiveness-
// checked against Scenario['tier'].
type TierRunner = (
  scenario: Scenario,
  proxyUrl: URL,
  third: any,
) => AsyncIterable<RequestEvent>;

export async function runScenario(opts: {
  scenarioFile: string;
  runDir: string;
  bus: EventBus;
  creds: { user: string; pass: string };
  parallel?: boolean;
  mitmUrl?: string;   // when present, tiers route through mitm instead of upstream proxy
}): Promise<void> {
  const scenario = await loadScenario(opts.scenarioFile);
  const sigNames = (scenario.verdict_detection?.challenge_signatures ?? [
    'cloudflare', 'hcaptcha', 'datadome', 'perimeterx', 'akamai', 'generic',
  ]) as any;
  const strategies = defaultStrategies(sigNames);

  // The names of the strategies whose `enabled` should be true. Anything in
  // scenario.verdict_detection set explicitly to `false` is dropped.
  const enabledNames = (['http_status', 'challenge_html', 'header_signals', 'cookies', 'timing'] as const)
    .filter((n) => (scenario.verdict_detection as any)?.[n] !== false);

  fs.mkdirSync(opts.runDir, { recursive: true });
  const sink = new JsonlSink(path.join(opts.runDir, 'scenarios.jsonl'));
  const unsureSink = new AppendOnlyJsonl(path.join(opts.runDir, 'unsure.jsonl'));
  const skippedSink = new AppendOnlyJsonl(path.join(opts.runDir, 'skipped.jsonl'));

  const tierFn = pickTier(scenario);
  // trivial-http accepts a number (concurrency) here; the browser tiers accept
  // a DeviceProfile[]. Either way the tier's signature is loose enough to take
  // the array without complaint. Pass the full device_pool so the browser
  // tiers can rotate per-navigation; trivial-http ignores it.
  const profile: any = scenario.device_pool && scenario.device_pool.length > 0
    ? scenario.device_pool.map((id: string) => loadProfile(id))
    : [loadProfile(DEFAULT_PROFILE)];

  if (opts.parallel) {
    // Fire all repeats concurrently. Cap is implicit at scenario.repeats.
    // Each repeat is an isolated coroutine that talks to the shared bus +
    // JSONL sink; the sink serialises writes so concurrency is safe.
    await Promise.all(
      Array.from({ length: scenario.repeats }, (_, i) =>
        runOneRepeat(i, scenario, opts.creds, tierFn, profile, opts.bus, sink, unsureSink, skippedSink, opts.mitmUrl),
      ),
    );
  } else {
    for (let i = 0; i < scenario.repeats; i++) {
      await runOneRepeat(i, scenario, opts.creds, tierFn, profile, opts.bus, sink, unsureSink, skippedSink, opts.mitmUrl);
    }
  }
  await sink.close();
}

async function runOneRepeat(
  i: number,
  scenario: Scenario,
  creds: { user: string; pass: string },
  tierFn: TierRunner,
  profile: any,
  bus: EventBus,
  sink: JsonlSink,
  unsureSink: AppendOnlyJsonl,
  skippedSink: AppendOnlyJsonl,
  mitmUrl: string | undefined,
): Promise<void> {
  // Session ID must match the IP Royal username grammar
  // ([A-Za-z0-9]+); scenario.id may contain hyphens (e.g.
  // `digitalserviceone-human-journey`), so build a short alphanumeric token
  // from a hash + monotonic counter.
  const sessionId = `${i}${Date.now().toString(36).slice(-6)}`;
  let proxyUrl: URL;
  try {
    if (process.env.TAH_NO_PROXY === '1') {
      proxyUrl = new URL('direct://');
    } else if (mitmUrl) {
      // Route through mitmproxy sidecar; mitm itself dials the upstream.
      // Credentials don't need to live in the per-request proxy URL — mitm
      // is already running with `--upstream-auth` or as a transparent proxy.
      proxyUrl = new URL(mitmUrl);
    } else {
      proxyUrl = buildProxyEndpoint(scenario.geo, scenario.proxy_mode, creds, sessionId).url;
    }
  } catch (e: any) {
    await skippedSink.write({ scenario_id: scenario.id, repeat: i, reason: e.message });
    return;
  }

  // Pull out the per-event strategy list from the surrounding closure by
  // reading it from the scenario (re-derived here to keep the helper
  // self-contained; cheap because no I/O).
  const sigNames = (scenario.verdict_detection?.challenge_signatures ?? [
    'cloudflare', 'hcaptcha', 'datadome', 'perimeterx', 'akamai', 'generic',
  ]) as any;
  const strategies = defaultStrategies(sigNames);
  const enabledNames = (['http_status', 'challenge_html', 'header_signals', 'cookies', 'timing'] as const)
    .filter((n) => (scenario.verdict_detection as any)?.[n] !== false);

  // Spec §9: retry the whole request once on a single request error before
  // logging `error`. We run the iteration in a closure so the retry replays
  // it from the start; on the second failure we emit a synthetic event
  // tagged `final_verdict: 'error'`.
  const attemptOnce = async (): Promise<void> => {
    // Pick a profile per repeat so the pool rotates (rather than always [0]).
    const repeatProfile = profile[i % profile.length];
    const iter = tierFn(scenario, proxyUrl, repeatProfile) as AsyncIterable<RequestEvent>;
    for await (const evt of iter) {
      const last = evt.events.at(-1);
      if (last) {
        // Pass through any captured body snippet so body-based challenge
        // signatures (cf-challenge, h-captcha, px-captcha, akamai bot
        // manager, access denied, etc.) can match.
        const out = aggregateVerdict(
          {
            url: last.url,
            status: last.status,
            responseHeaders: last.headers,
            responseBodySnippet: last.body_snippet ?? '',
            setCookies: Object.entries(last.headers)
              .filter(([k]) => k.toLowerCase() === 'set-cookie')
              .map(([, v]) => String(v)),
          },
          enabledNames as unknown as string[],
          strategies,
        );

        // Sub-100ms responses are suspicious: a successful allow with no
        // challenge signatures and an implausibly fast response is usually a
        // sign of a honeypot / shadow ban. Override to 'unsure' and record
        // the event separately.
        let verdict: Vote = out.final;
        if (verdict === 'allow' && last.time_ms < 100) {
          verdict = 'unsure';
          await unsureSink.write(evt);
        }
        evt.final_verdict = verdict;
      }
      bus.emit('request', evt);
      await sink.write(evt);
    }
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await attemptOnce();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  // Two failures — emit a synthetic error event so downstream consumers
  // (sink, dashboard) still see a record for this repeat.
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const errEvt: RequestEvent = {
    scenario_id: scenario.id,
    repeat_index: i,
    tier: scenario.tier,
    geo_requested: scenario.geo,
    proxy_mode: scenario.proxy_mode,
    started_at: new Date().toISOString(),
    events: [],
    final_verdict: 'error',
    timing: { total_ms: 0 },
    error: msg,
  };
  bus.emit('request', errEvt);
  await sink.write(errEvt);
}

function pickTier(scenario: Scenario): TierRunner {
  switch (scenario.tier) {
    case 'trivial-http': return runTrivial as unknown as TierRunner;
    case 'headless': return runHeadless as unknown as TierRunner;
    case 'stealth': return runStealth as unknown as TierRunner;
    case 'human': return runHuman as unknown as TierRunner;
    default:
      // Defensive: schema validation should catch this first, but if a
      // scenario slips through (e.g. a new tier was added without updating
      // this switch) fail loudly rather than returning `undefined`.
      throw new Error(`unsupported scenario.tier: ${(scenario as Scenario).tier}`);
  }
}
