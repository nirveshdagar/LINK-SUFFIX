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