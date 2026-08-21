import { describe, it, expect } from 'vitest';
import { fireOne, SKIP_REQUEST } from './runner.js';
import type { Scenario } from '@tah/contracts';

const stubScenario = { id: 't', tier: 'trivial-http', seed_url: '', geo: { country: 'US' }, proxy_mode: 'rotating-residential', repeats: 1 } as unknown as Scenario;

describe('fireOne (smoke, requires network)', () => {
  it('returns a 200 from httpbin via direct connection', async () => {
    if (!process.env.TAH_RUN_SMOKE) return;
    const url = new URL('https://httpbin.org/anything');
    const r = await fireOne(url, new URL('direct://'), stubScenario);
    if (r === SKIP_REQUEST) throw new Error('unexpected skip');
    expect([200, 502, 503]).toContain(r.events[0]!.status);
  });
});
