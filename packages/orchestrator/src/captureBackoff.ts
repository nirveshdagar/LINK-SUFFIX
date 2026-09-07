import type { CaptureDecision, CaptureRejection } from '@tah/contracts';

const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 300_000;

export function isBlockedCapture(decision: CaptureRejection): boolean {
  return ['cloudflare_challenge', 'unresolved_challenge', 'blocked_response', 'rate_limited'].includes(decision.code)
    || [403, 429].includes(decision.diagnostics?.httpStatus ?? 0);
}

// One instance belongs to one running campaign, not the shared browser process.
// This reduces rejected requests; it never alters fingerprints or proxy routes.
export class CaptureBackoff {
  private consecutiveBlocks = 0;
  private notBefore = 0;

  remainingMs(now = Date.now()): number {
    return Math.min(MAX_DELAY_MS, Math.max(0, this.notBefore - now));
  }

  observe(decision: CaptureDecision, now = Date.now()): CaptureDecision {
    if (decision.accepted || !isBlockedCapture(decision)) {
      this.consecutiveBlocks = 0;
      this.notBefore = 0;
      return decision;
    }
    this.consecutiveBlocks = Math.min(32, this.consecutiveBlocks + 1);
    const ordinaryDelay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(3, this.consecutiveBlocks - 1));
    const retryAfter = decision.diagnostics?.retryAfterMs;
    const delayMs = Math.max(ordinaryDelay, Number.isSafeInteger(retryAfter) && retryAfter! >= 0 && now + retryAfter! <= 8_640_000_000_000_000 ? retryAfter! : 0);
    this.notBefore = now + delayMs;
    return { ...decision, retry: {
      notBefore: this.notBefore, delayMs, consecutiveBlocks: this.consecutiveBlocks,
    } };
  }
}
