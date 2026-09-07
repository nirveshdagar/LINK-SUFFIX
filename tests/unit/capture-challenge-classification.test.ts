import { describe, expect, it } from 'vitest';
import { evaluateCaptureResult } from '@tah/contracts';
import { aggregateVerdict, DEFAULT_SIGNATURES, defaultStrategies, signatureMatches } from '../../packages/verdict/src/index.js';
import { activeBodyChallenge, activeHeaderChallenge } from '../../packages/verdict/src/challengeEvidence.js';
import type { VerdictInput } from '../../packages/verdict/src/types.js';

const names = Object.keys(DEFAULT_SIGNATURES) as Array<keyof typeof DEFAULT_SIGNATURES>;
const enabled = ['http_status', 'challenge_html', 'header_signals', 'cookies', 'timing'];
const suffix = 'irclickid=test%3Aid&sharedid=&dup=1&dup=2&empty=';
const url = 'https://merchant.example.test/?' + suffix;
const storefront = '<html><head><title>Smart rings | Store</title><script src="https://js.hcaptcha.com/1/api.js"></script></head><body><h1>Smart rings</h1><p>Shop our products</p></body></html>';
const input = (overrides: Partial<VerdictInput> = {}): VerdictInput => ({
  url, status: 200, responseHeaders: {}, responseBodySnippet: storefront, setCookies: [], ...overrides,
});
const verdict = (i: VerdictInput) => aggregateVerdict(i, enabled, defaultStrategies());
function capture(i: VerdictInput) {
  return evaluateCaptureResult({
    final_landing_url: i.url, final_verdict: verdict(i).final,
    events: [{ url: i.url, status: i.status, headers: i.responseHeaders,
      body_snippet: i.responseBodySnippet, ta_signal: { main_document: 'true' } }],
  });
}

describe('active challenge evidence', () => {
  it('accepts a RingConn-style HTTP 200 storefront loading hCaptcha', () => {
    const i = input({ responseHeaders: { server: 'cloudflare', 'cf-ray': 'a37602f159327d47-BOS' } });
    expect(verdict(i).final).toBe('allow');
    expect(capture(i)).toMatchObject({ accepted: true, suffix, evidence: 'document-response' });
    expect(signatureMatches({ headers: {}, bodySnippet: storefront, setCookies: [] }, DEFAULT_SIGNATURES.hcaptcha).matched).toBe(true);
  });

  it.each(['cf_clearance', '__cf_bm', 'datadome', '_px3', '_pxvid', '_abck', 'kp_lpa', '_shape', 'fpjsid'])(
    'does not reject a successful page for the %s cookie', name => {
      const cookie = name + '=fixture; Path=/; Secure';
      const i = input({ setCookies: [cookie], responseHeaders: { 'set-cookie': cookie } });
      expect(verdict(i).final).toBe('allow');
      expect(verdict(i).byStrategy.cookies).toBeUndefined();
      expect(capture(i).accepted).toBe(true);
    },
  );

  it.each([
    '<script src="https://js.hcaptcha.com/1/api.js"></script>',
    '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
    '<script src="https://client.perimeterx.net/site/main.js"></script>',
    '<script src="https://fingerprintjs.com/script.js"></script>',
    '<script>const message = "<h1>Access denied</h1>";</script>',
    '<script>const message = "<h1>Access denied</h1>',
    '<!-- <h1>Verify you are human</h1> -->',
    '<template><h1>Verify you are human</h1></template>',
    '<form action="/contact"><div class="h-captcha" data-sitekey="test"></div></form>',
    '<footer>Learn why access denied errors happen.</footer>',
  ])('does not confuse embedded resources with an interstitial: %s', fragment => {
    expect(capture(input({ responseBodySnippet: '<html><head><title>Store</title></head><body><h1>Shop</h1>' + fragment + '</body></html>' })).accepted).toBe(true);
  });

  it.each([
    { server: 'cloudflare', 'cf-ray': 'a37602f159327d47-BOS' },
    { 'x-datadome': 'enabled', 'x-akamai-grn': 'id', 'x-fpjs': 'true' },
    { 'x-diagnostic': 'cf-mitigated:challenge' },
    { 'x-blocked': 'false' },
  ])('matches only explicit mitigation header names and values: %j', headers => {
    expect(activeHeaderChallenge(headers, names)).toBeNull();
    expect(capture(input({ responseHeaders: headers })).accepted).toBe(true);
  });

  it.each([
    '<title>Just a moment...</title><div id="cf-challenge-running"></div>',
    '<title>Verify you are human</title><script src="https://js.hcaptcha.com/1/api.js"></script>',
    '<title>Store</title><h1>Please confirm that you are human</h1><div class="h-captcha"></div>',
    '<h1>Access Denied</h1><p>Reference #12345</p>',
    '<title>Security verification</title>',
    '<body>Press and hold to verify you are a human</body>',
    '<script>window._cf_chl_opt = {cvId:"3"};</script>',
    '<div id="px-captcha"></div>',
    '<iframe src="https://geo.captcha-delivery.com/captcha/?test=1"></iframe>',
  ])('still rejects an actual HTTP 200 interstitial: %s', html => {
    expect(activeBodyChallenge(html, names)).not.toBeNull();
    expect(verdict(input({ responseBodySnippet: html })).final).toBe('challenge');
    expect(capture(input({ responseBodySnippet: html })).accepted).toBe(false);
  });

  it.each([403, 429])('still stops HTTP %i even when HTML looks normal', status => {
    expect(capture(input({ status })).accepted).toBe(false);
  });

  it('rejects an explicit Cloudflare challenge on HTTP 200', () => {
    expect(capture(input({ responseHeaders: { 'CF-Mitigated': ' Challenge ' } }))).toMatchObject({
      accepted: false, code: 'cloudflare_challenge',
    });
  });

  it('rejects challenge URL parameters despite an otherwise normal storefront', () => {
    expect(capture(input({ url: url + '&__cf_chl_rt_tk=blocked' }))).toMatchObject({
      accepted: false, code: 'cloudflare_challenge',
    });
  });

  it('respects the enabled vendor set', () => {
    expect(activeBodyChallenge('<div id="px-captcha"></div>', ['hcaptcha'])).toBeNull();
    expect(activeHeaderChallenge({ 'cf-mitigated': 'challenge' }, ['hcaptcha'])).toBeNull();
  });
});
