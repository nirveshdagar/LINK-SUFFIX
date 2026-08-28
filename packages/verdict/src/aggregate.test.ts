import { describe, it, expect } from 'vitest';
import { aggregateVerdict } from './aggregate.js';
import { DEFAULT_SIGNATURES, defaultStrategies, signatureMatches } from './index.js';
import type { VerdictInput, VerdictStrategy } from './types.js';

const base: VerdictInput = {
  url: 'https://example.test/',
  status: 200,
  responseHeaders: {},
  responseBodySnippet: '',
  setCookies: [],
};

// Inline stub strategies so the tests don't depend on Task 6 implementations.
const stubStatus = (): VerdictStrategy => ({
  name: 'http_status', enabled: true,
  vote(i) { return i.status === 403 ? 'block' : null; },
});
const stubChallenge = (): VerdictStrategy => ({
  name: 'challenge_html', enabled: true,
  vote() { return null; },
});
const stubCookies = (): VerdictStrategy => ({
  name: 'cookies', enabled: true,
  vote() { return null; },
});

describe('aggregateVerdict', () => {
  it('returns allow when nothing fires', () => {
    expect(
      aggregateVerdict(base, ['http_status', 'cookies'], [stubStatus(), stubCookies()]).final,
    ).toBe('allow');
  });

  it('precedence: block > challenge', () => {
    const v = aggregateVerdict(
      { ...base, status: 403 },
      ['http_status', 'challenge_html'],
      [stubStatus(), stubChallenge()],
    );
    expect(v.final).toBe('block');
  });

  it('surfaces per-strategy votes', () => {
    const v = aggregateVerdict(
      { ...base, status: 403 },
      ['http_status', 'cookies'],
      [stubStatus(), stubCookies()],
    );
    expect(v.byStrategy['http_status']).toBe('block');
    // abstaining strategies are not surfaced in byStrategy
    expect(v.byStrategy['cookies']).toBeUndefined();
  });

  it('treats missing strategy as abstain', () => {
    const v = aggregateVerdict(base, [], [stubStatus(), stubCookies()]);
    expect(v.final).toBe('allow');
  });

  it('defaultStrategies votes challenge on a Cloudflare interstitial', () => {
    const input: VerdictInput = {
      ...base,
      setCookies: ['cf_clearance=abc; Path=/'],
      responseHeaders: { server: 'cloudflare' },
      responseBodySnippet: '<html>cf-chl-bypass</html>',
    };
    const out = aggregateVerdict(input, ['http_status', 'challenge_html', 'cookies'], defaultStrategies());
    expect(out.final).toBe('challenge');
  });

  it('does not treat ordinary Cloudflare CDN headers as a challenge', () => {
    const match = signatureMatches({
      headers: {
        server: 'cloudflare',
        'cf-ray': 'abc-LAX',
        'cf-cache-status': 'DYNAMIC',
      },
      bodySnippet: '',
      setCookies: [],
    }, DEFAULT_SIGNATURES.cloudflare);
    expect(match.matched).toBe(false);
  });
});
