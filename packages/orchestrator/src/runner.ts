import { run as runTrivial } from '@tah/trivial-http';
import { run as runHeadless } from '@tah/headless-browser';
import { run as runStealth } from '@tah/stealth-browser';
import { run as runHuman } from '@tah/human-sim';
import { buildProxyEndpoint } from '@tah/proxy';
import { defaultStrategies, aggregateVerdict, type Vote } from '@tah/verdict';
import { loadProfile } from '@tah/profiles';
import { loadScenario } from './scenarioLoader.js';
import { EventBus } from './eventBus.js';
import { JsonlSink, AppendOnlyJsonl } from './jsonlSink.js';
import type { Scenario, RequestEvent } from './types.js';
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
  // a DeviceProfile. Either way the tier's signature is loose enough to take
  // the profile without complaint. Pass the profile so the browser tiers get
  // a real device; trivial-http ignores it.
  const profile = scenario.device_pool?.[0]
    ? loadProfile(scenario.device_pool[0])
    : loadProfile(DEFAULT_PROFILE);

  for (let i = 0; i < scenario.repeats; i++) {
    const sessionId = `${scenario.id}-${Date.now()}-${i}`;
    let proxyUrl: URL;
    try {
      proxyUrl = buildProxyEndpoint(scenario.geo, scenario.proxy_mode, opts.creds, sessionId).url;
    } catch (e: any) {
      await skippedSink.write({ scenario_id: scenario.id, repeat: i, reason: e.message });
      continue;
    }

    const iter = tierFn(scenario, proxyUrl, profile) as AsyncIterable<RequestEvent>;

    for await (const evt of iter) {
      const last = evt.events.at(-1);
      if (last) {
        // Note: tier request events don't currently capture response body, so
        // body-based challenge signatures can't actually match. Body capture is
        // a follow-up to Tasks 9-12; until then we pass an empty snippet and
        // rely on headers/cookies/status for classification.
        const out = aggregateVerdict(
          {
            url: last.url,
            status: last.status,
            responseHeaders: last.headers,
            responseBodySnippet: '',
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
      opts.bus.emit('request', evt);
      await sink.write(evt);
    }
  }
  await sink.close();
}

function pickTier(scenario: Scenario): TierRunner {
  switch (scenario.tier) {
    case 'trivial-http': return runTrivial as unknown as TierRunner;
    case 'headless': return runHeadless as unknown as TierRunner;
    case 'stealth': return runStealth as unknown as TierRunner;
    case 'human': return runHuman as unknown as TierRunner;
  }
}
