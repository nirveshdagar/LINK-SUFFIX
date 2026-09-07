import { describe, it, expect } from 'vitest';
import { parseRedirectCapturePolicy, redirectLocationForPolicy } from './redirectCapture.js';
import { evaluateCaptureResult } from './captureSafety.js';

const policy = { mode: 'redirect_only', issuer_origin: 'https://affiliate.example', destination_origin: 'https://merchant.example',
  required_parameter: 'irclickid', navigation_origins: ['https://tracker.example', 'https://affiliate.example'] } as const;
const valid = () => JSON.parse(JSON.stringify(policy));
const suffix = 'irclickid=real%2fId+Value&sharedid=&utm_tactic=%22Coupon%2FDeal%22&im_rewards=';
const url = 'https://merchant.example/?' + suffix;
const event = (changes: Record<string, unknown> = {}) => ({
  final_landing_url: url, final_verdict: 'unsure', redirect_capture: valid(),
  events: [{ url: 'https://affiliate.example/click', method: 'GET', status: 301, time_ms: 1,
    headers: { location: url }, ta_signal: { main_document: 'true', capture_path: 'browser-redirect-only',
      destination_visited: 'false', egress_guard: 'origin_allowlist' } }],
  ...changes,
});
describe('explicit redirect-only capture policy', () => {
  it('preserves every suffix byte from the approved Location', () => {
    const result = evaluateCaptureResult(event(), { redirectPolicy: valid() });
    expect(result).toEqual({ accepted: true, finalUrl: url, suffix, evidence: 'redirect-only' });
  });
  it('requires opt-in in the immutable run, not just worker-supplied policy', () => {
    expect(evaluateCaptureResult(event(), { redirectPolicy: undefined }).accepted).toBe(false);
    expect(evaluateCaptureResult(event(), { redirectPolicy: { ...valid(), destination_origin: 'https://other.example' } }).accepted).toBe(false);
  });
  it.each([301, 302, 303, 307, 308])('accepts real HTTP %s Location metadata', status => {
    const e = event(); e.events[0]!.status = status;
    expect(evaluateCaptureResult(e).accepted).toBe(true);
  });
  it.each([200, 204, 300, 304, 400, 403, 429, 500])('rejects HTTP %s as redirect evidence', status => {
    const e = event(); e.events[0]!.status = status;
    expect(evaluateCaptureResult(e).accepted).toBe(false);
  });
  it.each(['irclickid=', 'irclickid=%20', 'sharedid=', 'irclickid=one&irclickid=two',
    'irclickid=one&im_ref=', 'irclickid=one&__cf_chl_rt_tk=blocked'])('rejects unsafe/incomplete suffix %s', query => {
    const e = event(); e.final_landing_url = 'https://merchant.example/?' + query; e.events[0]!.headers.location = e.final_landing_url;
    expect(evaluateCaptureResult(e).accepted).toBe(false);
  });
  it('rejects a changed byte, missing Location, wrong issuer or a visited merchant', () => {
    for (const mutate of [
      (e: ReturnType<typeof event>) => { e.final_landing_url = e.final_landing_url.replace('%2f', '%2F'); },
      (e: ReturnType<typeof event>) => { e.events[0]!.headers.location = ''; },
      (e: ReturnType<typeof event>) => { e.events[0]!.url = 'https://tracker.example/click'; },
      (e: ReturnType<typeof event>) => { e.events[0]!.ta_signal.destination_visited = 'true'; },
      (e: ReturnType<typeof event>) => { e.events[0]!.ta_signal.egress_guard = ''; },
    ]) { const e = event(); mutate(e); expect(evaluateCaptureResult(e).accepted).toBe(false); }
  });
  it.each([403, 429])('never accepts a prior HTTP %s refusal followed by a valid-looking redirect', status => {
    const e = event(); e.events.unshift({ ...e.events[0]!, url: 'https://tracker.example/', status, headers: { location: '' } });
    expect(evaluateCaptureResult(e).accepted).toBe(false);
  });
  it('does not discard actual challenge evidence or merchant responses', () => {
    const e = event(); e.events.unshift({ ...e.events[0]!, url: 'https://merchant.example/', status: 200 });
    expect(evaluateCaptureResult(e).accepted).toBe(false);
    const challenged = event();
    Object.assign(challenged.events[0]!.headers, { 'cf-mitigated': 'challenge', 'cf-ray': 'a37602f159327d47-BOS' });
    expect(evaluateCaptureResult(challenged)).toMatchObject({ accepted: false, code: 'cloudflare_challenge',
      diagnostics: { rayId: 'a37602f159327d47-BOS' } });
  });
  it.each(['http://affiliate.example', 'https://affiliate.example/path', 'https://user:pass@affiliate.example',
    'https://127.0.0.1', 'https://host.internal', 'https://*.example', 'https://affiliate.example/'])('rejects unsafe origin %s', issuer => {
    expect(() => parseRedirectCapturePolicy({ ...valid(), issuer_origin: issuer })).toThrow();
  });
  it('requires seed and issuer approval and excludes the merchant hostname at every port', () => {
    expect(() => parseRedirectCapturePolicy(valid(), 'https://wrong.example/')).toThrow();
    expect(() => parseRedirectCapturePolicy({ ...valid(), navigation_origins: ['https://tracker.example'] })).toThrow();
    expect(() => parseRedirectCapturePolicy({ ...valid(), navigation_origins: [...valid().navigation_origins, 'https://merchant.example:8443'] })).toThrow();
    expect(parseRedirectCapturePolicy(valid(), 'https://tracker.example/')).toEqual(valid());
  });
  it('rejects credentials and relative/noncanonical destination headers', () => {
    const p = parseRedirectCapturePolicy(valid())!;
    for (const location of ['/other?irclickid=x', 'https://user@merchant.example/?irclickid=x',
      'https://merchant.example.evil.test/?irclickid=x', 'https://merchant.example/?irclickid=x\n', 'https://merchant.example\\@evil.test/']) {
      expect(redirectLocationForPolicy(p, { url: policy.issuer_origin + '/', status: 302, headers: { location } })).toBeUndefined();
    }
  });
  it('leaves ordinary successful document capture unchanged', () => {
    const e = event({ redirect_capture: undefined });
    e.events[0]!.url = url; e.events[0]!.status = 200; e.events[0]!.ta_signal.capture_path = 'browser';
    expect(evaluateCaptureResult(e, {})).toMatchObject({ accepted: true, evidence: 'document-response' });
  });
});
