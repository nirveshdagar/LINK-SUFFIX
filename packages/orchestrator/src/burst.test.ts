import { describe, expect, it } from 'vitest';
import { burstOffsetMs, burstRequestCount } from './burst.js';

describe('burst scheduler', () => {
  it('never schedules beyond the explicit request ceiling', () => {
    expect(burstRequestCount({ target_rps: 500, duration_seconds: 60, ramp_seconds: 0, max_requests: 1000 })).toBe(1000);
  });

  it('models 1,000 requests over two seconds without exceeding the window', () => {
    const profile = { target_rps: 500, duration_seconds: 2, ramp_seconds: 0, max_requests: 1000 };
    expect(burstRequestCount(profile)).toBe(1000);
    expect(burstOffsetMs(999, profile)).toBeLessThan(2000);
  });

  it('accounts for the reduced capacity of a linear ramp', () => {
    expect(burstRequestCount({ target_rps: 500, duration_seconds: 2, ramp_seconds: 2, max_requests: 1000 })).toBe(500);
  });
});
