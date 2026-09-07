import { describe, expect, it } from 'vitest';
import { CaptureBackoff, isBlockedCapture } from './captureBackoff.js';

describe('incomplete tracking capture recovery', () => {
  it('backs off incomplete responses without labelling them Cloudflare refusals', () => {
    const incomplete = { accepted: false as const, code: 'empty_tracking_identifier', message: 'Empty identifier' };
    expect(isBlockedCapture(incomplete)).toBe(false);
    const backoff = new CaptureBackoff();
    for (const [index, delayMs] of [60_000, 120_000, 240_000, 300_000, 300_000].entries()) {
      const now = 1_000_000 + index * 600_000;
      const result = backoff.observe(incomplete, now);
      expect(result).toMatchObject({ accepted: false, retry: { delayMs, notBefore: now + delayMs } });
      expect(backoff.remainingMs(now)).toBe(delayMs);
    }
    backoff.observe({ accepted: true, finalUrl: 'https://merchant.example/?irclickid=valid', suffix: 'irclickid=valid', evidence: 'document-response' }, 9_000_000);
    expect(backoff.remainingMs(9_000_000)).toBe(0);
  });
});
