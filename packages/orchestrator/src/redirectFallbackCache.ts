export interface RedirectFallbackClaim {
  attemptPreflight: boolean;
  hostname: string;
  reason?: string;
  cacheUntil?: number;
  periodicProbe: boolean;
}

interface RedirectFallbackEntry {
  reason: string;
  fallbackCount: number;
  skipUntil: number;
  probeInFlight: boolean;
  updatedAt: number;
}

const MIN_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 60 * 60_000;

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function hostnameFor(rawUrl: string): string {
  try { return new URL(rawUrl).hostname.toLowerCase(); }
  catch { return "invalid"; }
}

export class AdaptiveRedirectFallbackCache {
  private readonly entries = new Map<string, RedirectFallbackEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, options.ttlMs ?? 30 * 60_000));
    this.maxEntries = Math.min(50_000, Math.max(100, options.maxEntries ?? 10_000));
  }

  claim(rawUrl: string, now = Date.now()): RedirectFallbackClaim {
    const hostname = hostnameFor(rawUrl);
    const entry = this.entries.get(hostname);
    if (!entry) {
      this.prune(now);
      this.entries.set(hostname, { reason: "unclassified", fallbackCount: 0, skipUntil: 0, probeInFlight: true, updatedAt: now });
      return { attemptPreflight: true, hostname, periodicProbe: false };
    }
    if (entry.probeInFlight) {
      return { attemptPreflight: false, hostname, reason: entry.reason, cacheUntil: entry.skipUntil, periodicProbe: false };
    }
    if (entry.skipUntil > now) {
      return { attemptPreflight: false, hostname, reason: entry.reason, cacheUntil: entry.skipUntil, periodicProbe: false };
    }
    entry.probeInFlight = true;
    entry.updatedAt = now;
    return { attemptPreflight: true, hostname, reason: entry.reason, periodicProbe: entry.fallbackCount > 0 };
  }

  recordCaptured(rawUrl: string): void {
    this.entries.delete(hostnameFor(rawUrl));
  }

  recordBrowserRequired(rawUrl: string, reason: string, now = Date.now()): number {
    const hostname = hostnameFor(rawUrl);
    const previous = this.entries.get(hostname);
    const skipUntil = now + this.ttlMs;
    this.entries.set(hostname, {
      reason: reason || "browser_required",
      fallbackCount: (previous?.fallbackCount ?? 0) + 1,
      skipUntil,
      probeInFlight: false,
      updatedAt: now,
    });
    this.prune(now);
    return skipUntil;
  }

  snapshot(now = Date.now()): { domains: number; blockedDomains: number; ttlMs: number } {
    let blockedDomains = 0;
    for (const entry of this.entries.values()) if (entry.skipUntil > now) blockedDomains += 1;
    return { domains: this.entries.size, blockedDomains, ttlMs: this.ttlMs };
  }

  private prune(now: number): void {
    for (const [hostname, entry] of this.entries) {
      if (!entry.probeInFlight && entry.skipUntil + this.ttlMs < now) this.entries.delete(hostname);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }
}

export const redirectFallbackCache = new AdaptiveRedirectFallbackCache({
  ttlMs: boundedNumber(process.env.TAH_REDIRECT_FALLBACK_CACHE_TTL_MS, 30 * 60_000, MIN_TTL_MS, MAX_TTL_MS),
  maxEntries: boundedNumber(process.env.TAH_REDIRECT_FALLBACK_CACHE_MAX_DOMAINS, 10_000, 100, 50_000),
});
