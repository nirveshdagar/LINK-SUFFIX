import { describe, expect, it } from 'vitest';

import {
  continuousIntervalMs,
  MINIMUM_CONTINUOUS_INTERVAL_MS,
  remainingContinuousDelayMs,
} from './continuousCadence.js';

describe('continuous campaign cadence', () => {
  it('never permits a start interval below 58 seconds', () => {
    expect(continuousIntervalMs(undefined)).toBe(MINIMUM_CONTINUOUS_INTERVAL_MS);
    expect(continuousIntervalMs(10_000)).toBe(MINIMUM_CONTINUOUS_INTERVAL_MS);
    expect(continuousIntervalMs(60_000)).toBe(60_000);
  });

  it('waits without a browser only for the remaining cadence', () => {
    expect(remainingContinuousDelayMs(1_000, 11_000, 58_000)).toBe(48_000);
    expect(remainingContinuousDelayMs(1_000, 70_000, 58_000)).toBe(0);
  });
});
