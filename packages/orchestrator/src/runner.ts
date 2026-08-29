import { resolveRedirectFirst, run as runTrivial } from '@tah/trivial-http';
import { run as runHeadless } from '@tah/headless-browser';
import { run as runStealth } from '@tah/stealth-browser';
import { run as runHuman } from '@tah/human-sim';
import { buildProxyEndpoint } from '@tah/proxy';
import { defaultStrategies, aggregateVerdict, DEFAULT_SIGNATURES, signatureMatches } from '@tah/verdict';
import { loadProfile } from '@tah/profiles';
import { resolveProxyEgress } from '@tah/tz';
import { loadScenario } from './scenarioLoader.js';
import { EventBus } from '@tah/contracts';
import { JsonlSink, AppendOnlyJsonl } from './jsonlSink.js';
import type { Scenario, RequestEvent } from '@tah/contracts';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { burstOffsetMs, burstRequestCount } from './burst.js';
import { continuousIntervalMs, remainingContinuousDelayMs } from './continuousCadence.js';

const DEFAULT_PROFILE = 'desktop-windows-chrome';

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

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
    'cloudflare', 'hcaptcha', 'datadome', 'perimeterx', 'akamai', 'kasada', 'shape', 'fingerprintjs', 'generic',
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

  const burst = scenario.tier === 'trivial-http' ? scenario.load_profile : undefined;
  const continuous = scenario.tier === 'human' && scenario.continuous === true;
  const totalRuns = burst
    ? burstRequestCount(burst)
    : scenario.tier === 'trivial-http'
      ? scenario.repeats * (scenario.concurrent ?? 1)
      : scenario.repeats;
  const concurrency = Math.min(scenario.concurrent ?? 1, totalRuns);
  const burstStartedAt = Date.now();
  const waitForSchedule = async (index: number): Promise<void> => {
    if (!burst) return;
    const delay = burstStartedAt + burstOffsetMs(index, burst) - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  };

  if (continuous) {
    let i = 0;
    const intervalMs = continuousIntervalMs(process.env.TAH_CONTINUOUS_INTERVAL_MS);
    while (true) {
      const journeyStartedAt = Date.now();
      await runOneRepeat(i++, scenario, opts.creds, tierFn, profile, opts.bus, sink, unsureSink, skippedSink, opts.mitmUrl);
      const remainingMs = remainingContinuousDelayMs(journeyStartedAt, Date.now(), intervalMs);
      if (remainingMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
    }
  } else if (opts.parallel && concurrency > 1) {
    // A bounded worker pool prevents a large run from opening every browser or
    // request simultaneously. Each worker claims one unique repeat at a time.
    let nextRun = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (nextRun < totalRuns) {
        const i = nextRun++;
        await waitForSchedule(i);
        await runOneRepeat(i, scenario, opts.creds, tierFn, profile, opts.bus, sink, unsureSink, skippedSink, opts.mitmUrl);
      }
    }));
  } else {
    for (let i = 0; i < totalRuns; i++) {
      await waitForSchedule(i);
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
  // IPRoyal requires a sticky session identifier to be exactly eight
  // alphanumeric characters. Any other length silently behaves as rotating.
  const sessionId = createHash('sha256')
    .update(scenario.continuous
      ? `${scenario.id}:${process.env.TAH_RUN_ID ?? 'continuous'}`
      : `${scenario.id}:${i}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  let resolvedEgress: { ip?: string; timezone?: string; country?: string; state?: string; city?: string } = {};
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
  if (scenario.proxy_mode === 'sticky-residential') {
    try { resolvedEgress = await resolveProxyEgress(proxyUrl) as typeof resolvedEgress; } catch { /* retain requested geo */ }
  }

  // Pull out the per-event strategy list from the surrounding closure by
  // reading it from the scenario (re-derived here to keep the helper
  // self-contained; cheap because no I/O).
  const sigNames = (scenario.verdict_detection?.challenge_signatures ?? [
    'cloudflare', 'hcaptcha', 'datadome', 'perimeterx', 'akamai', 'kasada', 'shape', 'fingerprintjs', 'generic',
  ]) as any;
  const strategies = defaultStrategies(sigNames);
  const enabledNames = (['http_status', 'challenge_html', 'header_signals', 'cookies', 'timing'] as const)
    .filter((n) => (scenario.verdict_detection as any)?.[n] !== false);

  // Spec §9: retry the whole request once on a single request error before
  // logging `error`. We run the iteration in a closure so the retry replays
  // it from the start; on the second failure we emit a synthetic event
  // tagged `final_verdict: 'error'`.
  const attemptOnce = async (): Promise<void> => {
    // A continuous campaign keeps one coherent browser identity. This allows
    // unattended retries without using identity rotation to evade challenges.
    const stableProfileIndex = parseInt(createHash('sha256').update(`${scenario.id}:${process.env.TAH_RUN_ID ?? 'continuous'}`).digest('hex').slice(0, 8), 16) % profile.length;
    const repeatProfile = scenario.tier === 'human' && scenario.continuous
      ? profile[stableProfileIndex]
      : profile[i % profile.length];
    // For trivial-http, each orchestrator repeat already represents one request.
    // Let the tier emit exactly one request per repeat and keep its own concurrency.
    const tierScenario = scenario.tier === 'trivial-http'
      ? { ...scenario, repeats: 1, concurrent: 1 }
      : scenario;
    let iter: AsyncIterable<RequestEvent>;
    if (
      scenario.tier === 'human'
      && scenario.continuous === true
      && enabled(process.env.TAH_REDIRECT_FIRST_ENABLED, true)
    ) {
      const resolved = await resolveRedirectFirst(scenario, proxyUrl);
      if (resolved.outcome === 'captured' && resolved.finalUrl) {
        const lightweightEvent: RequestEvent = {
          scenario_id: scenario.id,
          repeat_index: i,
          tier: 'human',
          geo_requested: scenario.geo,
          proxy_mode: scenario.proxy_mode,
          started_at: resolved.startedAt,
          pages: [scenario.seed_url, ...resolved.redirects.map((redirect) => redirect.to)],
          final_landing_url: resolved.finalUrl,
          events: resolved.events,
          final_verdict: 'unsure',
          timing: {
            total_ms: resolved.totalMs,
            pages_visited: resolved.redirects.length + 1,
          },
        };
        iter = (async function* lightweightCapture() {
          yield lightweightEvent;
        })();
      } else {
        if (process.env.TAH_REDIRECT_FIRST_DEBUG === '1') {
          console.log(`TAH_REDIRECT_FALLBACK ${JSON.stringify({ reason: resolved.reason, scenario_id: scenario.id })}`);
        }
        iter = tierFn(tierScenario, proxyUrl, repeatProfile) as AsyncIterable<RequestEvent>;
      }
    } else {
      iter = tierFn(tierScenario, proxyUrl, repeatProfile) as AsyncIterable<RequestEvent>;
    }
    for await (const evt of iter) {
      evt.repeat_index = i;
      const last = [...evt.events].reverse().find((event) => event.ta_signal?.main_document === 'true') ?? evt.events.at(-1);
      if (last) {
        const signatureInput = {
          headers: last.headers,
          bodySnippet: last.body_snippet ?? '',
          setCookies: Object.entries(last.headers)
            .filter(([key]) => key.toLowerCase() === 'set-cookie')
            .map(([, value]) => String(value)),
        };
        const vendorEvidence = sigNames.map((name: keyof typeof DEFAULT_SIGNATURES) => ({ name, ...(signatureMatches(signatureInput, DEFAULT_SIGNATURES[name]) as any) })).filter((match: any) => match.matched);
        const detectedVendors = vendorEvidence.map((match: any) => match.name);
        if (detectedVendors.length) last.ta_signal.challenge_vendors = detectedVendors.join(',');
        if (vendorEvidence.length) last.ta_signal.challenge_vendor_evidence = JSON.stringify(vendorEvidence);
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

        evt.final_verdict = out.final;
      }
      evt.session_id = sessionId;
      evt.expected_verdict = scenario.expected_verdict;
      evt.expectation_met = scenario.expected_verdict ? evt.final_verdict === scenario.expected_verdict : undefined;
      if (resolvedEgress.ip) {
        evt.geo_resolved = { ip: resolvedEgress.ip, country: resolvedEgress.country ?? scenario.geo.country, state: resolvedEgress.state, city: resolvedEgress.city, verified: Boolean(resolvedEgress.country) };
      }
      const finalSignal = evt.events.at(-1)?.ta_signal;
      if (finalSignal && resolvedEgress.timezone) finalSignal.egress_timezone = resolvedEgress.timezone;
      bus.emit('request', evt);
      await sink.write(evt);
      if (evt.tier === 'human' && evt.final_landing_url) {
        console.log(`TAH_L4_CAPTURE ${JSON.stringify({
          final_landing_url: evt.final_landing_url,
          session_id: evt.session_id,
          repeat_index: evt.repeat_index,
        })}`);
      }
    }
  };

  let lastErr: unknown;
  const maxAttempts = scenario.load_profile?.mode === 'burst' ? 1 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
    session_id: sessionId,
    expected_verdict: scenario.expected_verdict,
    expectation_met: false,
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
