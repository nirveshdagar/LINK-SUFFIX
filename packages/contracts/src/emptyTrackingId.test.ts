import { describe, expect, it } from 'vitest';
import { assertDeliverableSuffix, captureUrlIssue, deliverySuffixIssue, evaluateCaptureResult } from './captureSafety.js';

const fixture = (suffix: string, status = 200, headers: Record<string, string> = {}) => {
  const url = 'https://merchant.example/?' + suffix;
  return { tier: 'human', final_landing_url: url, final_verdict: 'allow',
    events: [{ url, status, headers, ta_signal: { main_document: 'true' } }] };
};

describe('empty affiliate identifier incident regression', () => {
  it.each([
    'irclickid=&sharedid=publisher&irgwc=1&afsrc=1',
    'irclickid=&UTM_source=impact&Partner_id=123',
    'irclickid=&utm_source=affiliate&utm_medium=impact',
    'irclickid=&affid=123&shareid=publisher',
    'im_ref=&sharedid=&im_rewards=',
    'irclickid',
    'IRCLICKID=',
    '%69rclickid=%20%09',
    'im_ref=+',
    'irclickid=valid&irclickid=',
    'im_ref=&im_ref=valid',
  ])('rejects incomplete identifier in %s before capture or delivery', suffix => {
    expect(deliverySuffixIssue(suffix)).toMatch(/empty tracking identifier/);
    expect(captureUrlIssue('https://merchant.example/?' + suffix)).toMatch(/empty tracking identifier/);
    expect(() => assertDeliverableSuffix(suffix)).toThrow(/empty tracking identifier/);
    expect(evaluateCaptureResult(fixture(suffix))).toMatchObject({
      accepted: false, code: 'empty_tracking_identifier',
      diagnostics: { hostname: 'merchant.example', httpStatus: 200 },
    });
  });

  it.each([
    'irclickid=exact%2Fid&sharedid=&im_rewards=&x=+&x=%20',
    'im_ref=exact%3Aid&sharedid=&im_rewards=',
    'utm_source=publisher&optional=',
    'note=irclickid%3D&referrer=https%3A%2F%2Fpublisher.example%2F',
  ])('preserves optional empties and exact bytes in %s', suffix => {
    expect(deliverySuffixIssue(suffix)).toBeNull();
    expect(evaluateCaptureResult(fixture(suffix))).toMatchObject({ accepted: true, suffix });
  });

  it('refusal and challenge evidence remain terminal even when the ID is blank', () => {
    expect(evaluateCaptureResult(fixture('irclickid=', 403))).toMatchObject({ accepted: false, code: 'blocked_response' });
    expect(evaluateCaptureResult(fixture('irclickid=', 200, { 'cf-mitigated': 'challenge' })))
      .toMatchObject({ accepted: false, code: 'cloudflare_challenge' });
    expect(evaluateCaptureResult(fixture('irclickid=&__cf_chl_rt_tk=fixture')))
      .toMatchObject({ accepted: false, code: 'cloudflare_challenge' });
  });

  it('does not accept an empty identifier from a redirect Location', () => {
    const event = fixture('irclickid=&irgwc=1');
    event.events = [{ url: 'https://tracker.example/link', status: 302,
      headers: { location: event.final_landing_url },
      ta_signal: { main_document: 'true', capture_path: 'redirect-first' } } as typeof event.events[number]];
    expect(evaluateCaptureResult(event)).toMatchObject({ accepted: false, code: 'empty_tracking_identifier' });
  });

  it('diagnostics contain no click values, cookies, or full URLs', () => {
    const decision = evaluateCaptureResult(fixture('irclickid=&sharedid=private-source', 200, { 'set-cookie': 'private_cookie=secret' }));
    expect(JSON.stringify(decision)).not.toMatch(/private-source|private_cookie|https:/);
  });
});
