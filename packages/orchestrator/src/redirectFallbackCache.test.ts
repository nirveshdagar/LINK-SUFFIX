import { describe, expect, it } from "vitest";
import { AdaptiveRedirectFallbackCache } from "./redirectFallbackCache.js";

describe("AdaptiveRedirectFallbackCache", () => {
  it("skips repeated preflights and permits a periodic probe after the TTL", () => {
    const cache = new AdaptiveRedirectFallbackCache({ ttlMs: 15 * 60_000 });
    expect(cache.claim("https://tracker.example/start", 1_000).attemptPreflight).toBe(true);
    const until = cache.recordBrowserRequired("https://tracker.example/start", "browser_navigation_required", 2_000);
    expect(cache.claim("https://tracker.example/other", 3_000)).toMatchObject({ attemptPreflight: false, reason: "browser_navigation_required", cacheUntil: until });
    expect(cache.claim("https://tracker.example/other", until + 1)).toMatchObject({ attemptPreflight: true, periodicProbe: true });
  });

  it("allows the fast path again immediately after a successful probe", () => {
    const cache = new AdaptiveRedirectFallbackCache({ ttlMs: 15 * 60_000 });
    cache.claim("https://tracker.example/start", 1_000);
    cache.recordBrowserRequired("https://tracker.example/start", "challenge_or_rate_limit", 2_000);
    cache.recordCaptured("https://tracker.example/start");
    expect(cache.claim("https://tracker.example/start", 3_000)).toMatchObject({ attemptPreflight: true, periodicProbe: false });
  });

  it("coordinates concurrent probes for the same hostname", () => {
    const cache = new AdaptiveRedirectFallbackCache({ ttlMs: 15 * 60_000 });
    expect(cache.claim("https://tracker.example/a", 1_000).attemptPreflight).toBe(true);
    expect(cache.claim("https://tracker.example/b", 1_001).attemptPreflight).toBe(false);
  });
});
