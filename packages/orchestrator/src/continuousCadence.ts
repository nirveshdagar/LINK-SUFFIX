export const MINIMUM_CONTINUOUS_INTERVAL_MS = 58_000;

export function continuousIntervalMs(rawValue: unknown): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return MINIMUM_CONTINUOUS_INTERVAL_MS;
  return Math.min(3_600_000, Math.max(MINIMUM_CONTINUOUS_INTERVAL_MS, Math.trunc(parsed)));
}

export function remainingContinuousDelayMs(
  journeyStartedAt: number,
  now: number,
  intervalMs: number,
): number {
  return Math.max(0, journeyStartedAt + intervalMs - now);
}
