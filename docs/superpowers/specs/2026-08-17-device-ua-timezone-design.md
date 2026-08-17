# Device UA + Timezone Rotation — Design

**Date:** 2026-08-17
**Status:** Draft — pending user approval

## 1. Purpose

The Traffic Armour Test Harness currently uses 5 fixed device profiles, each with ONE hard-coded `User-Agent` string. This makes every navigation across thousands of runs fingerprint-identical: same UA, same locale, no timezone. Real users (and IP Royal's residential pool) drift across thousands of browser versions in the wild, so a fingerprint-stable UA is one of the easiest signals a fingerprinting TA can use to flag synthetic traffic.

This change replaces single-UA profiles with **template sets** that produce millions of unique UA combinations, paired with an **egress-IP-derived timezone** that's resolved once per session. Each navigation in a browser tier uses a fresh Playwright context with a unique fingerprint bundle, keeping HTTP header `User-Agent`, JS-readable `navigator.userAgent`, `Intl.DateTimeFormat().resolvedOptions().timeZone`, and `navigator.languages` all consistent.

The user is extending an existing v1 harness to defeat fingerprint-based detection.

## 2. Scope

In scope:

- New package `packages/ua` with template library, synthesizer, and Playwright context applier.
- New package `packages/tz` with static city → IANA map (≥2000 entries), and `geoip2-lite` JS-only IP → city lookup.
- All three browser tiers (headless, stealth, human-sim) rotate UA + timezone + locale on each navigation.
- Per-session cache for the egress-IP timezone (one Python-or-JS lookup per session, all pages share).
- New `RequestEvent.events[i].ta_signal` fields: `ua_actual`, `template_id`, `timezone`, `tz_lookup_failed`.

Out of scope:

- Per-navigation rotation in the `trivial-http` tier (no browser; not in the user's request).
- JavaScript-level fingerprint masking beyond UA + tz + locale (Canvas/WebGL/audio fingerprinting — separate effort).
- Proxy-side UA spoofing at the IP Royal gateway level.
- Mobile-network type randomization (only desktop/mobile-UA, not 4G/Wi-Fi).
- Battery, memory, screen-color-depth, `navigator.connection` randomization.

## 3. UA Template Library

### 3.1 Template shape

```typescript
export interface UaTemplate {
  id: string;                // "iphone-15-pro-max-safari"
  family: UaFamily;          // 'iphone' | 'ipad' | 'android' | 'mac-safari' | 'mac-chrome' | 'windows-chrome' | 'windows-edge'
  uaPattern: string;         // "Mozilla/5.0 (iPhone; CPU iPhone OS __BUILD__ like Mac OS X) AppleWebKit/605.1.15 ... Mobile/15E148 Safari/604.1"
  buildRange: { minMajor: number; maxMajor: number; minMinor: number; maxMinor: number };
  viewport: { w: number; h: number; dpr: number };
  hardware: { cores: [number, number]; memoryGb: [number, number] };
  webgl: { vendors: string[]; renderers: string[] };
  locale: string;            // base locale, e.g. "en-US"
  languages: string[];       // ['en-US', 'en'] for en-US; locked to template.locale, NOT to timezone
  cityAffinity: Continent[]; // which continents feel natural for this template
}
```

### 3.2 Template list (~25 templates total)

5 device profiles × ~5 templates each:

| Profile id | Template ids |
|---|---|
| `desktop-windows-chrome` | `desktop-windows-chrome-110`, `desktop-windows-chrome-118`, `desktop-windows-chrome-124`, `desktop-windows-chrome-edge-110`, `desktop-windows-chrome-edge-124` |
| `desktop-mac-safari` | `mac-safari-15`, `mac-safari-16`, `mac-safari-17`, `mac-chrome-118`, `mac-chrome-124` |
| `iphone-15-safari` | `iphone-15-safari`, `iphone-15-plus-safari`, `iphone-15-pro-safari`, `iphone-15-pro-max-safari`, `iphone-14-pro-safari`, `iphone-se-3-safari` |
| `android-pixel-chrome` | `pixel-7-chrome`, `pixel-8-chrome`, `pixel-8-pro-chrome`, `samsung-s23-chrome`, `samsung-s24-chrome`, `oneplus-11-chrome` |
| `ipad-safari` | `ipad-air-5-safari`, `ipad-pro-11-safari`, `ipad-pro-12-9-safari`, `ipad-mini-6-safari` |

### 3.3 Pool size

~25 templates × ~120 build patches each (e.g. `Chrome/118.0.0.0` through `Chrome/118.20.99.99` for one template) = ~3,000 unique UA strings. Across profile options and per-navigation rotation, this expands to **~100k+ unique fingerprint combinations** in a typical run (5 profiles × 5 templates × 100 builds × 8 hardware variants × 4 timezone families = 80,000+). With 30+ pages per scenario and varying locales, runs in the millions of unique fingerprints are easily achievable.

### 3.4 Invariant: family × fingerprint consistency

Each template enforces that `webgl.vendors` and `webgl.renderers` are physically plausible (e.g., `iphone-*` templates use `Apple Inc.` + `Apple A16 GPU` family, never `NVIDIA`). Hardware cores and memory are within realistic ranges for the family (iPhones: 4-8 cores / 4-8 GB; Windows desktop: 4-32 cores / 8-128 GB).

## 4. UA Synthesis

```typescript
export interface SynthesizedFingerprint {
  templateId: string;
  ua: string;                // uaPattern with __BUILD__ replaced
  build: string;             // e.g. "17_5"
  fingerprint: {
    viewport: { w: number; h: number; dpr: number };
    hardware: { cores: number; memoryGb: number };
    webgl: { vendor: string; renderer: string };
    locale: string;
    languages: string[];
    timezone: string;        // IANA, e.g. "Asia/Kolkata"
  };
}

export function synthesizeUA(
  template: UaTemplate,
  opts?: { build?: string; timezone?: string }
): SynthesizedFingerprint;
```

- `build` defaults to random pick from `template.buildRange`, formatted as `${major}_${minor}` (with `_` separator matching UA convention).
- If `opts.timezone` provided, used as-is. Otherwise caller must resolve and pass.
- `hardware.cores` and `memoryGb` picked uniformly from `[min, max]` range.
- `webgl.vendor` and `webgl.renderer` picked uniformly from `vendors`/`renderers` arrays.

## 5. Timezone Resolution

Three-layer fallback, session-cached:

```
1. timeZoneFromIP(egressIp)        # geoip2-lite (JS), cached per session by IP
   Failure: fall through

2. tzForGeo(scenario.geo)          # static ~2000-entry city → IANA map
   Failure: fall through

3. commonTzForLocale(template.locale)  # static locale → IANA-zones list, random pick
   Failure: return 'UTC'
```

Cache: `Map<string, string>` keyed by IP, lifetime = one tier run. Reset per repeat.

### 5.1 Static map (`packages/tz/src/cityTimezone.ts`)

≥2000 entries covering: North America (US, CA, MX), Europe (UK, DE, FR, IT, ES, NL, PL, SE, NO, FI, DK), Asia (IN, JP, CN, KR, SG, TH, ID, PH, MY, VN, AE, SA, IL, TR), Oceania (AU, NZ), South America (BR, AR, CL, CO), Africa (ZA, EG, NG, KE, MA).

Format: `[{ key: 'IN-Maharashtra-Mumbai', tz: 'Asia/Kolkata' }, ...]`. The `key` follows the same format as `IPRoyal` geo target: `${country}-${state}-${city}` with spaces in city stripped.

Lookup: `tzForGeo({ country, state, city })` returns the matching tz or `null`.

### 5.2 Egress IP lookup (`packages/tz/src/egressTimezone.ts`)

```typescript
import maxmind from 'geoip2-lite';
import { tzForGeo } from './cityTimezone.js';

const cache = new Map<string, string>();

export async function timeZoneFromIP(ip: string, dbBuffer?: Buffer): Promise<string | null> {
  if (cache.has(ip)) return cache.get(ip)!;
  const rec = dbBuffer ? maxmind.get(ip, dbBuffer) : null;
  if (!rec) { cache.set(ip, ''); return null; }
  const country = rec.country?.iso_code ?? '';
  const subs = rec.subdivisions?.[0]?.iso_code ?? '';
  const city = (rec.city?.names as Record<string,string> | undefined)?.en ?? '';
  const tz = tzForGeo({ country, state: subs, city });
  cache.set(ip, tz ?? '');
  return tz;
}

export function resetTzCache(): void { cache.clear(); }
```

`geoip2-lite` is bundled in-process; no subprocess, no API rate limit. MMDB file is read once at session start (passed as `Buffer` from caller — `iproyal` flow provides it).

### 5.3 Locale → IANA fallback (`packages/tz/src/commonTz.ts`)

```typescript
export function commonTzForLocale(locale: string): string {
  const candidates: Record<string, string[]> = {
    'en-US': ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Denver'],
    'en-IN': ['Asia/Kolkata'],
    'en-GB': ['Europe/London'],
    'de-DE': ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich'],
    'fr-FR': ['Europe/Paris'],
    'ja-JP': ['Asia/Tokyo'],
    // ...
  };
  const list = candidates[locale] ?? ['UTC'];
  return list[Math.floor(Math.random() * list.length)];
}
```

## 6. Browser Tier Integration

### 6.1 Per-navigation flow

For each navigation in `headless-browser`, `stealth-browser`, `human-sim`:

```
1. profile = loadProfile(scenario.device_pool[rand])
2. template = pick template from profile.templateIds (random per nav)
3. timezone = await resolveTimezone(egressIp, scenario.geo, template.locale)
   - `egressIp` is the proxy session's egress IP. For IP Royal, the proxy URL is
     sticky-residential per session, so all pages in the same session share one egress IP.
     First navigation: probe via https://api.ipify.org?format=json through the proxy
     and cache the IP for the rest of the session. Repeat the probe only if the proxy
     reconnects.
4. synthesized = synthesizeUA(template, { timezone })
5. close current context, open new context with synthesized.fingerprint
6. page.goto(url) inside new context
7. log ua_actual + template_id + timezone in ta_signal
8. (after page load) capture body_snippet (already wired)
```

### 6.2 Why new context per navigation

Re-applying headers on the same context leaves `navigator.userAgent` (JS-readable) static — TA sees `UA header: "Chrome/124.0.1.2"` vs `navigator.userAgent: "Chrome/124.0.0.0"` and flags as bot. New context per navigation guarantees all fingerprint surfaces move together. Cost: ~150ms × ~12 pages per session = ~1.8s extra. Acceptable.

### 6.3 Trivial-http tier

**Does NOT rotate UA.** The tier is `undici` HTTP with no browser. Already rotates UA via `pick(UA_POOL)`. No change.

## 7. Packages and Files

### 7.1 New package: `packages/ua`

- `packages/ua/package.json` — no runtime deps; `devDeps: vitest`
- `packages/ua/tsconfig.json`
- `packages/ua/src/types.ts` — `UaFamily`, `Continent`, `UaTemplate`, `SynthesizedFingerprint`
- `packages/ua/src/templates.ts` — exports ~25 template objects
- `packages/ua/src/profileTemplates.ts` — `profileId → templateId[]`
- `packages/ua/src/synthesize.ts` — `synthesizeUA(template, opts)`
- `packages/ua/src/applyTo.ts` — Playwright context applier
- `packages/ua/src/synthesize.test.ts`
- `packages/ua/src/templates.test.ts`
- `packages/ua/src/index.ts` — re-exports

### 7.2 New package: `packages/tz`

- `packages/tz/package.json` — `deps: geoip2-lite`
- `packages/tz/tsconfig.json`
- `packages/tz/src/cityTimezone.ts` — ≥2000-entry map
- `packages/tz/src/commonTz.ts` — locale fallback
- `packages/tz/src/egressTimezone.ts` — `timeZoneFromIP(ip, dbBuffer)`, `resetTzCache()`
- `packages/tz/src/cityTimezone.test.ts`
- `packages/tz/src/egressTimezone.test.ts` (mock geoip2-lite)
- `packages/tz/src/index.ts`

### 7.3 Modified: `packages/profiles`

- `loader.ts` — `DeviceProfile` adds `templateIds: string[]`. `loadProfile(id)` returns the augmented profile.
- `devices.json` — each profile gains `templateIds: ["...", "..."]` field.

### 7.4 Modified: browser tiers

- `packages/tiers/headless-browser/src/runner.ts` — per-navigation fingerprint rotation
- `packages/tiers/stealth-browser/src/runner.ts` — same
- `packages/tiers/human-sim/src/runner.ts` — same; integrates with existing per-page behavioral sequence

### 7.5 Modified: `RequestEvent`

- `packages/orchestrator/src/types.ts` — `RawRequestRecord.ta_signal: { ua_actual?, template_id?, timezone?, tz_lookup_failed?, body_snippet?: string }`. Already a record, just gains new optional fields.

## 8. Public API

```typescript
// packages/ua
import { synthesizeUA, profileTemplates, templates } from '@tah/ua';
const fp = synthesizeUA(templates[0], { timezone: 'Asia/Kolkata' });

// packages/tz
import { timeZoneFromIP, tzForGeo, commonTzForLocale, resetTzCache } from '@tah/tz';
const tz = await timeZoneFromIP('203.0.113.42', dbBuffer);

// packages/profiles (modified)
import { loadProfile } from '@tah/profiles';
const profile = loadProfile('iphone-15-safari');  // profile.templateIds now populated
```

## 9. Error Handling

| Failure | Behavior |
|---|---|
| `MAXMIND_DB_PATH` unset | Skip IP-based lookup, fall through to scenario-geo map |
| Scenario geo not in `cityTimezone.ts` map | Fall through to `commonTzForLocale(template.locale)` |
| `commonTzForLocale` returns no candidates | Use `UTC` |
| `geoip2-lite.get()` returns null (no record) | Return null; fall through |
| `timeZoneFromIP` throws (corrupt MMDB) | Log warning, fall through; do not crash navigation |
| Playwright new-context launch fails | Skip this navigation, retry once per spec §9, mark repeat `final_verdict: 'error'` if both attempts fail |
| Template id missing from `profileTemplates` map | Throw at startup (test will catch); fail-fast |

## 10. Testing

### Unit (`packages/ua` and `packages/tz`)
- `templates.test.ts`: every template has valid `uaPattern` containing `__BUILD__`, regex matches expected family prefix, viewport + hardware in declared range, webgl vendors/renderers plausible.
- `synthesize.test.ts`: build patch formatted `${major}_${minor}`, fingerprint fields populated, override options respected.
- `cityTimezone.test.ts`: `tzForGeo({ country: 'IN', state: 'Maharashtra', city: 'Mumbai' })` returns `Asia/Kolkata`; unknown geo returns null.
- `egressTimezone.test.ts`: cache behavior, mocked geoip2-lite result, fallback when geoip2-lite returns null.

### Integration (gated `TAH_PER_NAV_ROTATION=1`)
- Spin a fake TA (existing `tests/integration/fake-ta`), launch headless tier against it, assert that successive `request.headers['user-agent']` values differ across navigations and that `Intl.DateTimeFormat().resolvedOptions().timeZone` matches the recorded `ta_signal.timezone`.

### Snapshot / property
- For a fixed RNG seed, generate 1000 UAs from one template; assert all parse, all have correct OS marker, no duplicate build numbers.

### Existing tests
- All 30 existing unit tests must continue to pass. The `RequestEvent` shape gains optional fields; existing tests don't break.
- The integration test from Task 15 must continue to work (gated `TAH_INTEGRATION=1`).

## 11. Decisions Locked In

- Build-version variation is the primary UA differentiator; major-version variation within templates as second axis (combined produces ~3k unique UAs per template).
- Per-page navigation cadence for UA rotation.
- Egress-IP–derived timezone is primary; scenario-geo is fallback; locale-derived is final fallback.
- Full fingerprint bundle rotates (UA + tz + locale + viewport + hardware + webgl).
- Template-driven consistency — no free-form cross-product.
- All three browser tiers rotate UA: headless + stealth + human-sim.
- New Playwright context per navigation (option b).
- Languages stay locked to template.locale (don't follow timezone).
- Session-level cache for egress-IP timezone lookup.
- ≥2000-entry static city → IANA map.
- JS-only timezone lookup via `geoip2-lite` (no Python dep at runtime).
- Trivial-http tier unchanged.
- `RequestEvent.events[i].ta_signal` gains optional `ua_actual`, `template_id`, `timezone`, `tz_lookup_failed` fields.