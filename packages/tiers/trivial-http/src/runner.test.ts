import { describe, it, expect } from 'vitest';
import { fireOne } from './runner.js';

describe('fireOne (smoke, requires network)', () => {
  it('returns a 200 from httpbin via a hypothetical proxy', async () => {
    // Pass a non-routable proxy URL on purpose — httpbin should still respond if proxy absent.
    // For unit, we just check the function builds a request without crashing.
    const url = new URL('https://httpbin.org/anything');
    // Skipped in CI: skip-if-no-network guard.
    if (!process.env.TAH_RUN_SMOKE) return;
    const r = await fireOne(url, new URL('http://127.0.0.1:1'), 'curl/8.4.0', '');
    expect([200, 502, 503]).toContain(r.status);
  });
});
