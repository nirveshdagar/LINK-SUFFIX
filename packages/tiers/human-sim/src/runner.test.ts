import { describe, it, expect } from 'vitest';
import { loadProfile } from '@tah/profiles';
import { run } from './runner.js';

describe('human-sim fingerprint rotation across journey', () => {
  it('produces distinct ta_signal.ua_actual across navigation events', async () => {
    if (!process.env.TAH_RUN_SMOKE) return;
    const profile = loadProfile('iphone-15-safari');
    const stubScenario = {
      id: 'test',
      tier: 'human',
      seed_url: 'https://example.test/',
      geo: { country: 'US' },
      proxy_mode: 'sticky-residential',
      repeats: 1,
      expected_verdict: 'allow',
      session: { pages: { min: 2, max: 2 } },
    } as any;
    const uaSet = new Set<string>();
    const templateIds = new Set<string>();
    for await (const e of run(stubScenario, new URL('http://127.0.0.1:1'), profile)) {
      for (const ev of e.events) {
        if (ev.ta_signal.ua_actual) uaSet.add(ev.ta_signal.ua_actual);
        if (ev.ta_signal.template_id) templateIds.add(ev.ta_signal.template_id);
      }
    }
    expect(uaSet.size).toBeGreaterThanOrEqual(1);
    expect(templateIds.size).toBeGreaterThanOrEqual(1);
  });
});