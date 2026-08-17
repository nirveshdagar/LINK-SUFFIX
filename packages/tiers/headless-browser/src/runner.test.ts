import { describe, it, expect } from 'vitest';
import { loadProfile } from '@tah/profiles';
import { run } from './runner.js';

describe('run (smoke, requires network + Playwright Chromium)', () => {
  it('yields one RequestEvent from example.com via a non-routable proxy', async () => {
    if (!process.env.TAH_RUN_SMOKE) return;
    const scenario = {
      id: 'smoke-headless',
      tier: 'headless' as const,
      seed_url: 'https://example.com',
      geo: { country: 'US' },
      proxy_mode: 'rotating-residential' as const,
      repeats: 1,
      expected_verdict: 'allow' as const,
    };
    const device = loadProfile('iphone-15');
    const it = run(scenario, new URL('http://127.0.0.1:1'), device);
    const ev = await it[Symbol.asyncIterator]().next();
    expect(ev.done).toBe(false);
    if (!ev.done) {
      expect(ev.value.events.length).toBeGreaterThanOrEqual(1);
      expect(ev.value.tier).toBe('headless');
      expect(ev.value.timing.pages_visited).toBe(1);
      expect(ev.value.final_verdict).toBe('unsure');
    }
  });
});

describe('headless-browser fingerprint rotation', () => {
  it('produces ua_actual + template_id + timezone in ta_signal', async () => {
    if (!process.env.TAH_RUN_SMOKE) return;
    const profile = loadProfile('iphone-15-safari');
    const profile1 = loadProfile('iphone-15-safari');
    // Cast through unknown because tier's run() signature accepts a Scenario; we pass a stub.
    const stubScenario = {
      id: 'test', tier: 'headless', seed_url: 'https://example.test/',
      geo: { country: 'US' }, proxy_mode: 'sticky-residential',
      repeats: 1, expected_verdict: 'allow',
    } as any;
    let fp1: any;
    for await (const e of run(stubScenario, new URL('http://127.0.0.1:1'), profile)) {
      fp1 = e.events[0]?.ta_signal;
    }
    let fp2: any;
    for await (const e of run(stubScenario, new URL('http://127.0.0.1:1'), profile1)) {
      fp2 = e.events[0]?.ta_signal;
    }
    expect(fp1?.ua_actual).toBeDefined();
    expect(fp1?.template_id).toBeDefined();
    expect(fp1?.timezone).toBeDefined();
    // Two runs should produce different UAs (random template + build)
    expect(fp1?.ua_actual).not.toBe(fp2?.ua_actual);
  });
});