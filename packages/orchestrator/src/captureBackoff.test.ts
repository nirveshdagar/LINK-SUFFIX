import { describe, expect, it } from 'vitest';
import type { CaptureDecision, CaptureRejection } from '@tah/contracts';
import { CaptureBackoff, isBlockedCapture } from './captureBackoff.js';

const blocked: CaptureRejection = { accepted: false, code: 'cloudflare_challenge', message: 'Blocked',
  diagnostics: { hostname: 'authorized-app.example', httpStatus: 403, rayId: '0123456789abcdef-DEL' } };
describe('campaign capture backoff', () => {
  it('backs off for 1, 2, 4, then at most 5 minutes without losing diagnostics', () => {
    const backoff = new CaptureBackoff();
    for (const [index, delay] of [60_000, 120_000, 240_000, 300_000, 300_000].entries()) {
      const decision = backoff.observe(blocked, 1000);
      expect(decision).toMatchObject({ diagnostics: blocked.diagnostics,
        retry: { delayMs: delay, notBefore: 1000 + delay, consecutiveBlocks: index + 1 } });
      expect(backoff.remainingMs(1000)).toBe(delay);
      expect(backoff.remainingMs(1000 + delay + 1)).toBe(0);
    }
  });
  it('isolates campaigns and resets only this campaign after a valid result', () => {
    const one = new CaptureBackoff(), two = new CaptureBackoff();
    one.observe(blocked, 1000);
    expect(two.remainingMs(1000)).toBe(0);
    const valid: CaptureDecision = { accepted: true, finalUrl: 'https://authorized-app.example/?x=1',
      suffix: 'x=1', evidence: 'document-response' };
    expect(one.observe(valid, 2000)).toEqual(valid);
    expect(one.remainingMs(2000)).toBe(0);
    expect(one.observe(blocked, 2000)).toMatchObject({ retry: { delayMs: 60_000, consecutiveBlocks: 1 } });
  });
  it('recognizes 429 and 403, but does not retry ordinary missing suffixes as edge blocks', () => {
    expect(isBlockedCapture({ ...blocked, code: 'unverified_destination', diagnostics: { httpStatus: 429 } })).toBe(true);
    expect(isBlockedCapture({ ...blocked, code: 'unverified_destination', diagnostics: { httpStatus: 403 } })).toBe(true);
    const missing: CaptureRejection = { accepted: false, code: 'missing_suffix', message: 'No suffix' };
    const backoff = new CaptureBackoff();
    backoff.observe(blocked, 0);
    expect(backoff.observe(missing, 10)).toEqual(missing);
    expect(backoff.remainingMs(10)).toBe(0);
  });
});
