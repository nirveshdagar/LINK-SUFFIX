import { describe, expect, it } from 'vitest';
import { captureUrlIssue, deliverySuffixIssue, evaluateCaptureResult } from './captureSafety.js';

const exact = 'im_ref=click%2Fid&sharedid=&irpid=3425426&utm_tactic=%22Coupon%2FDeal%22%2C%22India%22&x=+&x=%20&im_rewards=';
const destination = 'https://www.udemy.com/?' + exact;
const response = (url = destination, status = 200, headers: Record<string, string> = {}) => ({
  url, status, headers, ta_signal: { main_document: 'true' },
});
const result = (changes: Record<string, unknown> = {}) => ({
  final_landing_url: destination, final_verdict: 'allow', events: [response()], ...changes,
});

describe('capture safety', () => {
  it('preserves the complete Udemy query byte-for-byte, including empty values', () => {
    const accepted = evaluateCaptureResult(result());
    expect(accepted).toEqual({ accepted: true, finalUrl: destination, suffix: exact, evidence: 'document-response' });
  });
  it.each(['__cf_chl_rt_tk=x', 'a=ok&__CF_CHL_TK=x', '%5F%5Fcf_chl_rt_tk=x', '__cf_chl_f_tk=x'])('rejects challenge query %s even on HTTP 200', suffix => {
    const url = 'https://trk.udemy.com/0GMebJ?' + suffix;
    expect(evaluateCaptureResult(result({ final_landing_url: url, events: [response(url)] })).accepted).toBe(false);
    expect(deliverySuffixIssue(suffix)).toMatch(/Cloudflare/);
    expect(captureUrlIssue(url)).toMatch(/Cloudflare/);
  });
  it('reproduces the live 403 challenge with block verdict', () => {
    const captured = evaluateCaptureResult(result({
      final_landing_url: 'https://trk.udemy.com/0GMebJ?__cf_chl_rt_tk=fixture',
      final_verdict: 'block',
      events: [response('https://trk.udemy.com/0GMebJ', 403, { 'cf-mitigated': 'challenge' })],
    }));
    expect(captured.accepted).toBe(false);
  });
  it('rejects case-insensitive challenge headers even without a token', () => {
    expect(evaluateCaptureResult(result({ events: [response(destination, 200, { 'Cf-Mitigated': 'Challenge' })] }))).toMatchObject({ accepted: false, code: 'cloudflare_challenge' });
  });
  it.each([403, 429, 500, 302])('does not accept an unconfirmed response with status %s', status => {
    expect(evaluateCaptureResult(result({ events: [response(destination, status)] })).accepted).toBe(false);
  });
  it.each(['block', 'blocked', 'challenge', 'error'])('rejects verdict %s even with a query and HTTP 200', verdict => {
    expect(evaluateCaptureResult(result({ final_verdict: verdict })).accepted).toBe(false);
  });
  it('rejects unresolved challenges and accepts a subsequently resolved successful document', () => {
    expect(evaluateCaptureResult(result({ challenge: { status: 'pending' } })).accepted).toBe(false);
    expect(evaluateCaptureResult(result({ challenge: { status: 'resolved' } })).accepted).toBe(true);
  });
  it('requires main-document evidence and ignores unrelated subresource errors', () => {
    expect(evaluateCaptureResult(result({ events: [] })).accepted).toBe(false);
    expect(evaluateCaptureResult(result({ events: [{ ...response(), ta_signal: {} }] })).accepted).toBe(false);
    expect(evaluateCaptureResult(result({ events: [response(), { ...response('https://pixel.test/', 403), ta_signal: {} }] })).accepted).toBe(true);
    expect(evaluateCaptureResult(result({ events: [response('https://tracker.test/', 403), { ...response(), ta_signal: {} }] })).accepted).toBe(false);
  });
  it('does not borrow a previous document response to justify an unobserved URL', () => {
    expect(evaluateCaptureResult(result({ events: [response('https://www.udemy.com/?old=1')] })).accepted).toBe(false);
  });
  it('retains proven redirect-first captures without claiming that the destination rendered', () => {
    const event = { ...response('https://tracker.test/link', 302, { Location: destination }), ta_signal: { main_document: 'true', capture_path: 'redirect-first' } };
    expect(evaluateCaptureResult(result({ events: [event] }))).toMatchObject({ accepted: true, suffix: exact, evidence: 'redirect-location' });
    expect(evaluateCaptureResult(result({ events: [{ ...event, headers: { Location: 'https://other.test/?wrong=1' } }] })).accepted).toBe(false);
    expect(evaluateCaptureResult(result({ events: [{ ...event, headers: { Location: destination, 'cf-mitigated': 'challenge' } }] })).accepted).toBe(false);
  });
  it('does not flag ordinary values merely mentioning a challenge parameter', () => {
    expect(deliverySuffixIssue('note=__cf_chl_rt_tk&redirect=https%3A%2F%2Fexample.test%2F')).toBeNull();
  });
  it('rejects challenge paths, failed journeys and fragment-only queries', () => {
    expect(captureUrlIssue('https://www.udemy.com/cdn-cgi/challenge-platform/?x=1')).toMatch(/Cloudflare/);
    expect(evaluateCaptureResult(result({ error: 'timeout' })).accepted).toBe(false);
    expect(evaluateCaptureResult(result({ final_landing_url: 'https://www.udemy.com/#route?x=1' }))).toMatchObject({ accepted: false, code: 'missing_suffix' });
  });
});
