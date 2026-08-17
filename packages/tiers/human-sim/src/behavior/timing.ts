/**
 * Log-normal sampler for human inter-page wait times.
 *
 * sigma = 0.9 gives a long-tailed distribution; with mu = ln(medianMs)
 * the median is exactly `medianMs`. The 2s-240s clamp keeps the harness
 * from drawing a >6 minute wait on a single page (which would explode
 * scenario runtime) or <2s (which would look bot-like).
 *
 * Default median of 22s is empirically the median of "seconds-on-page"
 * distributions measured across a corpus of human web sessions.
 */
export function logNormalTimeMs(medianMs = 22_000): number {
  const sigma = 0.9;
  const mu = Math.log(medianMs);
  const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return Math.min(Math.max(2_000, Math.exp(mu + sigma * z)), 240_000);
}
