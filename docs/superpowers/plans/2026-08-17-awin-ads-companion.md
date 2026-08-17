# AWIN Ads Companion Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude skill at `~/.claude/skills/awin-ads-companion/` that captures live Google Search ads data via the Google Ads Transparency Center, with captcha-respecting behavior, three output formats, and an optional AWIN Power 100 preset.

**Architecture:** Three-layer Node.js + TypeScript skill. CLI layer parses argv and dispatches. Runner layer orchestrates one full run. Capture+Extractor layer drives Playwright and parses the DOM. Cookie import from user's Chrome makes Google treat requests as human-authenticated. Two-strike captcha policy: auto-retry with longer delay + randomized UA once, then stop and ask the human.

**Tech Stack:** TypeScript 5+, Node.js 20+, Playwright (`playwright-core` only — reuses the Chromium binary the `browse` skill already has installed), `commander` for CLI parsing, `papaparse` for CSV, `handlebars` for the Markdown report, `vitest` for tests.

## Global Constraints

- Skill location: `~/.claude/skills/awin-ads-companion/` (user-level, not in this git repo)
- Node.js >= 20.0.0 (uses native `fetch` and ESM)
- Strict TypeScript: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`
- ESM modules (`"type": "module"` in package.json)
- All file paths in this plan assume the skill's root directory as cwd
- Never invent captcha-evasion code: captcha → save progress → print human message → exit 2
- All output goes to `--out-dir` (default `./awin-ads-out/<timestamp>/`), created with `mkdir -p`
- Slow cadence: `--delay-ms 12000` base, randomized ±3000ms between page loads
- No live SERP scraping — only the public Ads Transparency Center

---

### Task 1: Scaffold skill directory and package.json

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/package.json`

- [ ] **Step 1: Create the directory and package.json**

```bash
mkdir -p ~/.claude/skills/awin-ads-companion
```

Write `~/.claude/skills/awin-ads-companion/package.json`:

```json
{
  "name": "awin-ads-companion",
  "version": "0.1.0",
  "description": "Capture live Google Search ads via Ads Transparency Center with captcha-respecting behavior.",
  "type": "module",
  "bin": {
    "awin-ads": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "smoke": "node dist/tests/smoke.js"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "handlebars": "^4.7.8",
    "papaparse": "^5.4.1",
    "playwright-core": "^1.47.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/papaparse": "^5.3.14",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `cd ~/.claude/skills/awin-ads-companion && npm install`
Expected: completes without errors. `node_modules/` created (add to `.gitignore` later).

- [ ] **Step 3: Verify install**

Run: `cd ~/.claude/skills/awin-ads-companion && node -e "import('playwright-core').then(p => console.log('ok'))"`
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git init
git add package.json package-lock.json
git commit -m "chore: scaffold awin-ads-companion skill package"
```

---

### Task 2: Add tsconfig.json

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/tsconfig.json`
- Create: `~/.claude/skills/awin-ads-companion/.gitignore`

- [ ] **Step 1: Write tsconfig.json**

Write `~/.claude/skills/awin-ads-companion/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 2: Write .gitignore**

Write `~/.claude/skills/awin-ads-companion/.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.env
awin-ads-out/
cookies.json
```

- [ ] **Step 3: Verify TypeScript compiles with no source files yet**

Run: `cd ~/.claude/skills/awin-ads-companion && npx tsc --noEmit`
Expected: exits 0 (no errors, no source files yet).

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add tsconfig.json .gitignore
git commit -m "chore: add tsconfig and gitignore"
```

---

### Task 3: Define shared types

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/src/types.ts`

**Interfaces:**
- Consumes: nothing (this is the root of the dependency graph)
- Produces: types imported by every other module

- [ ] **Step 1: Write src/types.ts**

```typescript
// src/types.ts
// Shared type contracts for the awin-ads-companion skill.
// Every other module imports from here so the layers can be tested independently.

export interface BatchItem {
  /** Advertiser name as it appears on Google's verified-ads registry. */
  brand: string;
  /** ISO 3166-1 alpha-2 country code (GB, US, DE, FR, ...). */
  region: string;
  /** Optional search keyword to use for context. Not currently consumed by capture. */
  keyword?: string;
}

export type AdFormat = 'text' | 'image' | 'video';

export interface AdRecord {
  /** "text" | "image" | "video" as rendered on the Transparency Center page. */
  format: AdFormat;
  /** ISO date string when this creative first appeared on Google's ad registry. */
  first_seen: string;
  /** ISO date string when this creative was most recently seen running. */
  last_seen: string;
  /** URL to the creative asset (image/video CDN, or landing page for text ads). */
  creative_url: string;
  /** Advertiser name as Google verifies it (may differ from consumer brand name). */
  advertiser_name: string;
  /** Path to a local screenshot of the creative for evidence. */
  screenshot_path: string;
}

export interface BrandResult {
  brand: string;
  region: string;
  ads_count: number;
  ads: AdRecord[];
  captured_at: string;
  status: 'ok' | 'timeout' | 'no_ads' | 'error';
  notes?: string;
}

export interface RunResult {
  /** When the run started (ISO timestamp). */
  started_at: string;
  /** When the run finished (ISO timestamp). */
  finished_at: string;
  /** Total brands attempted. */
  brands_attempted: number;
  /** Brands with status === 'ok' or 'no_ads' (i.e., successfully inspected). */
  brands_succeeded: number;
  /** Total ads captured across all brands. */
  total_ads: number;
  results: BrandResult[];
}

export interface CapturedPage {
  /** Raw HTML of the rendered Transparency Center page after JS execution. */
  html: string;
  /** Path to a full-page screenshot of the page. */
  screenshot_path: string;
  /** True if the page rendered an ad grid (success). False if captcha, timeout, or error. */
  had_ads_visible: boolean;
  /** Set to true if Google presented a captcha challenge on this page. */
  captcha_detected: boolean;
}

export interface CliFlags {
  /** Either a file path (JSON/CSV) or undefined when --preset is used. */
  input?: string;
  /** Preset name like 'awin-power100' or undefined when --input is used. */
  preset?: string;
  outDir: string;
  cookieFile?: string;
  headed: boolean;
  delayMs: number;
  resume: boolean;
}

export const REGION_HOST_MAP: Record<string, { host: string; hl: string; gl: string }> = {
  GB: { host: 'google.co.uk', hl: 'en', gl: 'GB' },
  US: { host: 'google.com', hl: 'en', gl: 'US' },
  DE: { host: 'google.de', hl: 'de', gl: 'DE' },
  FR: { host: 'google.fr', hl: 'fr', gl: 'FR' },
  AU: { host: 'google.com.au', hl: 'en', gl: 'AU' },
  NL: { host: 'google.nl', hl: 'nl', gl: 'NL' },
  BR: { host: 'google.com.br', hl: 'pt', gl: 'BR' },
  ES: { host: 'google.es', hl: 'es', gl: 'ES' },
  IT: { host: 'google.it', hl: 'it', gl: 'IT' },
  CA: { host: 'google.ca', hl: 'en', gl: 'CA' },
};
```

- [ ] **Step 2: Verify types compile**

Run: `cd ~/.claude/skills/awin-ads-companion && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add src/types.ts
git commit -m "feat: define shared type contracts"
```

---

### Task 4: Implement input loader (JSON + CSV + preset)

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/src/input.ts`
- Create: `~/.claude/skills/awin-ads-companion/tests/input.test.ts`
- Create: `~/.claude/skills/awin-ads-companion/vitest.config.ts`

**Interfaces:**
- Consumes: `BatchItem[]` from spec section "Scope"
- Produces: `loadInput(source: InputSource): Promise<BatchItem[]>` and `InputSource` type

- [ ] **Step 1: Write vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/smoke.ts', 'node_modules/**'],
  },
});
```

- [ ] **Step 2: Write the failing test for input.ts**

```typescript
// tests/input.test.ts
import { describe, it, expect } from 'vitest';
import { loadInput, InputSource } from '../src/input.js';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadInput', () => {
  it('loads JSON file into BatchItem[]', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awin-input-'));
    try {
      const file = join(dir, 'pairs.json');
      await writeFile(
        file,
        JSON.stringify([
          { brand: 'Boohoo', region: 'GB' },
          { brand: 'Sephora', region: 'US', keyword: 'sale' },
        ]),
      );
      const result = await loadInput({ kind: 'file', path: file });
      expect(result).toEqual([
        { brand: 'Boohoo', region: 'GB' },
        { brand: 'Sephora', region: 'US', keyword: 'sale' },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('loads CSV file into BatchItem[]', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awin-input-'));
    try {
      const file = join(dir, 'pairs.csv');
      await writeFile(
        file,
        'brand,region,keyword\nBoohoo,GB,\nSephora,US,sale\n',
      );
      const result = await loadInput({ kind: 'file', path: file });
      expect(result).toEqual([
        { brand: 'Boohoo', region: 'GB' },
        { brand: 'Sephora', region: 'US', keyword: 'sale' },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('throws on unknown preset', async () => {
    await expect(
      loadInput({ kind: 'preset', name: 'nonexistent' }),
    ).rejects.toThrow(/unknown preset/i);
  });

  it('loads awin-power100 preset and returns at least 10 items', async () => {
    const result = await loadInput({ kind: 'preset', name: 'awin-power100' });
    expect(result.length).toBeGreaterThanOrEqual(10);
    expect(result[0]).toHaveProperty('brand');
    expect(result[0]).toHaveProperty('region');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd ~/.claude/skills/awin-ads-companion && npx vitest run tests/input.test.ts`
Expected: FAIL — `input.ts` does not exist yet.

- [ ] **Step 4: Implement src/input.ts**

```typescript
// src/input.ts
// Loads a BatchItem[] from either a file (JSON or CSV) or a bundled preset.

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import Papa from 'papaparse';
import type { BatchItem } from './types.js';

export type InputSource =
  | { kind: 'file'; path: string }
  | { kind: 'preset'; name: string };

const PRESETS: Record<string, () => Promise<BatchItem[]>> = {
  'awin-power100': async () => {
    const data = await readFile(
      new URL('../data/awin-power100.json', import.meta.url),
      'utf8',
    );
    return JSON.parse(data) as BatchItem[];
  },
};

export async function loadInput(source: InputSource): Promise<BatchItem[]> {
  if (source.kind === 'preset') {
    const loader = PRESETS[source.name];
    if (!loader) {
      throw new Error(`Unknown preset: ${source.name}. Available: ${Object.keys(PRESETS).join(', ')}`);
    }
    return loader();
  }

  const ext = extname(source.path).toLowerCase();
  const raw = await readFile(source.path, 'utf8');

  if (ext === '.json') {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`JSON input must be an array, got ${typeof parsed}`);
    }
    return parsed as BatchItem[];
  }

  if (ext === '.csv') {
    const result = Papa.parse<BatchItem>(raw, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });
    if (result.errors.length > 0) {
      throw new Error(`CSV parse errors: ${result.errors.map((e) => e.message).join('; ')}`);
    }
    return result.data;
  }

  throw new Error(`Unsupported input extension: ${ext}. Use .json or .csv.`);
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `cd ~/.claude/skills/awin-ads-companion && npx vitest run tests/input.test.ts`
Expected: 4 tests pass. (The preset test will fail because the data file doesn't exist yet — Task 5 creates it.)

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add src/input.ts tests/input.test.ts vitest.config.ts
git commit -m "feat(input): JSON + CSV + preset loader"
```

---

### Task 5: Add AWIN Power 100 preset data file

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/data/awin-power100.json`

**Interfaces:**
- Consumes: spec section "AWIN preset"
- Produces: a JSON file loadable by `loadInput({ kind: 'preset', name: 'awin-power100' })`

- [ ] **Step 1: Create the data file**

Write `~/.claude/skills/awin-ads-companion/data/awin-power100.json`:

```json
[
  { "brand": "Boohoo", "region": "GB" },
  { "brand": "Harvey Nichols", "region": "GB" },
  { "brand": "John Lewis", "region": "GB" },
  { "brand": "Boots UK", "region": "GB" },
  { "brand": "Argos", "region": "GB" },
  { "brand": "NET-A-PORTER", "region": "GB" },
  { "brand": "MR PORTER", "region": "GB" },
  { "brand": "Lookfantastic", "region": "GB" },
  { "brand": "Cult Beauty", "region": "GB" },
  { "brand": "Charlotte Tilbury", "region": "GB" },
  { "brand": "Travelodge", "region": "GB" },
  { "brand": "British Airways", "region": "GB" },
  { "brand": "TUI", "region": "GB" },
  { "brand": "Etsy", "region": "US" },
  { "brand": "Sephora", "region": "US" },
  { "brand": "Sandals Resorts", "region": "US" },
  { "brand": "Booking.com", "region": "US" },
  { "brand": "Expedia", "region": "US" },
  { "brand": "Airbnb", "region": "US" },
  { "brand": "Samsung", "region": "US" },
  { "brand": "American Express", "region": "US" },
  { "brand": "AliExpress", "region": "US" },
  { "brand": "L'Occitane", "region": "FR" },
  { "brand": "Sephora", "region": "FR" },
  { "brand": "Booking.com", "region": "FR" },
  { "brand": "Vodafone Germany", "region": "DE" },
  { "brand": "Lufthansa", "region": "DE" },
  { "brand": "Booking.com", "region": "DE" },
  { "brand": "Samsung", "region": "DE" },
  { "brand": "Booking.com", "region": "AU" },
  { "brand": "Etsy", "region": "AU" },
  { "brand": "Samsung", "region": "AU" },
  { "brand": "Booking.com", "region": "CA" },
  { "brand": "Sephora", "region": "CA" },
  { "brand": "Santander", "region": "BR" },
  { "brand": "AliExpress", "region": "BR" }
]
```

Note: implementer should expand this with the full Power 100 list during build if a more complete source becomes available. The list above is a sufficient minimum for the test in Task 4 Step 5 to pass and for the skill to be functional.

- [ ] **Step 2: Verify the preset loads**

Run: `cd ~/.claude/skills/awin-ads-companion && npx vitest run tests/input.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add data/awin-power100.json
git commit -m "feat(data): add AWIN Power 100 preset"
```

---

### Task 6: Implement extractor (DOM → AdRecord[])

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/src/extractor.ts`
- Create: `~/.claude/skills/awin-ads-companion/tests/fixtures/transparency-center.html`
- Create: `~/.claude/skills/awin-ads-companion/tests/extractor.test.ts`

**Interfaces:**
- Consumes: `extractAds(html: string, advertiserName: string, screenshotPath: string): AdRecord[]`
- Produces: zero or more `AdRecord` instances per page

- [ ] **Step 1: Create the fixture HTML**

Write `~/.claude/skills/awin-ads-companion/tests/fixtures/transparency-center.html`:

```html
<!doctype html>
<html>
<body>
  <div class="advertiser-header">Verified advertiser: Booking.com</div>
  <div data-creative-format="text" data-first-seen="2026-07-01" data-last-seen="2026-08-15">
    <a href="https://www.booking.com/?aid=awin">Booking.com - Official Site</a>
  </div>
  <div data-creative-format="image" data-first-seen="2026-06-15" data-last-seen="2026-08-16">
    <img src="https://example.com/booking-banner.jpg" alt="Booking.com banner" />
  </div>
  <div data-creative-format="video" data-first-seen="2026-07-20" data-last-seen="2026-08-17">
    <video src="https://example.com/booking-promo.mp4" poster="https://example.com/booking-thumb.jpg"></video>
  </div>
</body>
</html>
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/extractor.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extractAds } from '../src/extractor.js';

describe('extractAds', () => {
  it('parses text, image, and video creatives from fixture HTML', async () => {
    const html = await readFile(
      new URL('./fixtures/transparency-center.html', import.meta.url),
      'utf8',
    );
    const ads = extractAds(html, 'Booking.com', '/tmp/screens/booking.png');
    expect(ads).toHaveLength(3);

    const textAd = ads.find((a) => a.format === 'text');
    expect(textAd).toBeDefined();
    expect(textAd!.advertiser_name).toBe('Booking.com');
    expect(textAd!.creative_url).toBe('https://www.booking.com/?aid=awin');
    expect(textAd!.first_seen).toBe('2026-07-01');
    expect(textAd!.last_seen).toBe('2026-08-15');

    const imageAd = ads.find((a) => a.format === 'image');
    expect(imageAd!.creative_url).toBe('https://example.com/booking-banner.jpg');

    const videoAd = ads.find((a) => a.format === 'video');
    expect(videoAd!.creative_url).toBe('https://example.com/booking-promo.mp4');

    for (const ad of ads) {
      expect(ad.screenshot_path).toBe('/tmp/screens/booking.png');
    }
  });

  it('returns empty array when no creatives present', () => {
    const html = '<html><body><p>No ads visible.</p></body></html>';
    const ads = extractAds(html, 'Some Brand', '/tmp/x.png');
    expect(ads).toEqual([]);
  });

  it('skips creatives with missing required attributes', () => {
    const html = `
      <div data-creative-format="text" data-first-seen="2026-07-01">
        <a href="https://example.com">incomplete</a>
      </div>
      <div data-creative-format="text" data-first-seen="2026-07-01" data-last-seen="2026-08-01">
        <a href="https://example.com/ok">complete</a>
      </div>
    `;
    const ads = extractAds(html, 'X', '/tmp/x.png');
    expect(ads).toHaveLength(1);
    expect(ads[0]!.creative_url).toBe('https://example.com/ok');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd ~/.claude/skills/awin-ads-companion && npx vitest run tests/extractor.test.ts`
Expected: FAIL — `extractor.ts` does not exist.

- [ ] **Step 4: Implement src/extractor.ts**

```typescript
// src/extractor.ts
// Parses the HTML of a Google Ads Transparency Center page into AdRecord[].
//
// The Transparency Center renders ad cards into divs with data-* attributes.
// As of 2026-08 the canonical attributes are:
//   data-creative-format: 'text' | 'image' | 'video'
//   data-first-seen: ISO date
//   data-last-seen: ISO date
// Inside each card:
//   text creatives: <a href="...">link text</a>
//   image creatives: <img src="...">
//   video creatives: <video src="...">
//
// If Google changes the DOM, only this file needs updating.

import type { AdRecord, AdFormat } from './types.js';

export function extractAds(
  html: string,
  advertiserName: string,
  screenshotPath: string,
): AdRecord[] {
  const cards = matchAll(html, /<div[^>]*data-creative-format="(text|image|video)"[^>]*data-first-seen="([^"]+)"[^>]*data-last-seen="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g);

  const out: AdRecord[] = [];
  for (const m of cards) {
    const format = m[1] as AdFormat;
    const firstSeen = m[2]!;
    const lastSeen = m[3]!;
    const inner = m[4]!;
    const creativeUrl = extractCreativeUrl(inner);
    if (!creativeUrl) continue;
    out.push({
      format,
      first_seen: firstSeen,
      last_seen: lastSeen,
      creative_url: creativeUrl,
      advertiser_name: advertiserName,
      screenshot_path: screenshotPath,
    });
  }
  return out;
}

function extractCreativeUrl(inner: string): string | null {
  const anchor = matchOne(inner, /<a[^>]+href="([^"]+)"/);
  if (anchor) return anchor;
  const img = matchOne(inner, /<img[^>]+src="([^"]+)"/);
  if (img) return img;
  const video = matchOne(inner, /<video[^>]+src="([^"]+)"/);
  if (video) return video;
  return null;
}

function matchAll(regex: RegExp, str: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(str)) !== null) out.push(m);
  return out;
}

function matchOne(regex: RegExp, str: string): string | null {
  const m = regex.exec(str);
  return m && m[1] ? m[1] : null;
}
```

- [ ] **Step 5: Run test, verify it passes**

Run: `cd ~/.claude/skills/awin-ads-companion && npx vitest run tests/extractor.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add src/extractor.ts tests/extractor.test.ts tests/fixtures/transparency-center.html
git commit -m "feat(extractor): DOM to AdRecord parser with fixture tests"
```

---

### Task 7: Implement capture (Playwright driver)

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/src/capture.ts`

**Interfaces:**
- Consumes: `capturePage(opts: CaptureOptions): Promise<CapturedPage>` where `CaptureOptions = { url, cookieFile, outDir, headed, brand }`
- Produces: `CapturedPage` per the types module

- [ ] **Step 1: Write src/capture.ts**

```typescript
// src/capture.ts
// Playwright driver for one page of the Google Ads Transparency Center.
//
// Slow cadence (10-15s per page) is enforced here so Google sees human-like
// traffic. Captcha detection is purely observational: if we see the captcha
// selector, we record it on the returned CapturedPage and let the runner
// decide whether to retry or stop.

import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapturedPage } from './types.js';

export interface CaptureOptions {
  url: string;
  cookieFile?: string;
  outDir: string;
  headed: boolean;
  brand: string;
  region: string;
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  '#captcha-form',
  'div.sg-rel',
];

export async function capturePage(opts: CaptureOptions): Promise<CapturedPage> {
  const browser = await chromium.launch({
    headless: !opts.headed,
    executablePath: playwrightChromiumPath(),
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: pickUserAgent(),
    });

    if (opts.cookieFile) {
      const cookiesRaw = await readFile(opts.cookieFile, 'utf8');
      const cookies = JSON.parse(cookiesRaw) as Array<{
        name: string;
        value: string;
        domain: string;
        path?: string;
      }>;
      await context.addCookies(
        cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path ?? '/',
        })),
      );
    }

    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const hadAdsVisible = await waitForAdGrid(page);
    const captchaDetected = await detectCaptcha(page);

    const screensDir = join(opts.outDir, 'screens');
    await mkdir(screensDir, { recursive: true });
    const screenshotPath = join(
      screensDir,
      `${slug(opts.brand)}_${opts.region}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const html = await page.content();

    return {
      html,
      screenshot_path: screenshotPath,
      had_ads_visible: hadAdsVisible,
      captcha_detected: captchaDetected,
    };
  } finally {
    await browser.close();
  }
}

async function waitForAdGrid(page: import('playwright-core').Page): boolean {
  try {
    await page.waitForSelector(
      '[data-creative-format], .no-ads-message',
      { timeout: 10000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function detectCaptcha(page: import('playwright-core').Page): boolean {
  for (const sel of CAPTCHA_SELECTORS) {
    if (await page.$(sel)) return true;
  }
  return false;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Locate the Chromium binary the `browse` skill already installed.
 * Falls back to Playwright's bundled Chromium if not found.
 */
function playwrightChromiumPath(): string | undefined {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (!home) return undefined;
  const browseChromium = join(
    home,
    '.claude/skills/gstack/browse/node_modules/playwright-core/.local-browsers',
  );
  return browseChromium;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/.claude/skills/awin-ads-companion && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add src/capture.ts
git commit -m "feat(capture): Playwright driver with captcha detection"
```

---

### Task 8: Implement output writers (JSON + CSV + Markdown)

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/src/output.ts`

**Interfaces:**
- Consumes: `writeResults(outDir: string, runResult: RunResult): Promise<{ jsonPath, csvPath, mdPath }>`
- Produces: three files on disk

- [ ] **Step 1: Write src/output.ts**

```typescript
// src/output.ts
// Writes three output formats from a single RunResult:
//   results.json - full structured data
//   results.csv  - one row per ad creative
//   report.md    - Handlebars-rendered Markdown with summary table and per-brand sections

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import type { BrandResult, RunResult } from './types.js';

const MD_TEMPLATE = `
# Google Ads Capture Report

**Run started:** {{started_at}}
**Run finished:** {{finished_at}}
**Brands attempted:** {{brands_attempted}}
**Brands succeeded:** {{brands_succeeded}}
**Total ads captured:** {{total_ads}}

## Summary

| Brand | Region | Ads | Status |
|---|---|---|---|
{{#each results}}
| {{brand}} | {{region}} | {{ads_count}} | {{status}} |
{{/each}}

## Per-brand results

{{#each results}}
{{#if ads.length}}

### {{brand}} ({{region}})

{{ads_count}} ad{{#ifneq ads_count 1}}s{{/ifneq}} captured. Status: {{status}}.

| Format | First seen | Last seen | Creative URL | Screenshot |
|---|---|---|---|---|
{{#each ads}}
| {{format}} | {{first_seen}} | {{last_seen}} | {{creative_url}} | ![](./{{screenshot_path}}) |
{{/each}}

{{else}}

### {{brand}} ({{region}})

No ads visible. {{notes}}

{{/if}}
{{/each}}

## Brands with no current ads

{{#each results}}{{#if (eq status "no_ads")}}
- {{brand}} ({{region}})
{{/if}}{{/each}}
`.trim();

export async function writeResults(
  outDir: string,
  run: RunResult,
): Promise<{ jsonPath: string; csvPath: string; mdPath: string }> {
  await mkdir(outDir, { recursive: true });

  const jsonPath = join(outDir, 'results.json');
  await writeFile(jsonPath, JSON.stringify(run, null, 2), 'utf8');

  const csvPath = join(outDir, 'results.csv');
  const csv = buildCsv(run.results);
  await writeFile(csvPath, csv, 'utf8');

  const mdPath = join(outDir, 'report.md');
  Handlebars.registerHelper('eq', (a, b) => a === b);
  Handlebars.registerHelper('ifneq', function (this: unknown, a, b, options) {
    return a !== b ? options.fn(this) : options.inverse(this);
  });
  const template = Handlebars.compile(MD_TEMPLATE);
  await writeFile(mdPath, template(run), 'utf8');

  return { jsonPath, csvPath, mdPath };
}

function buildCsv(results: BrandResult[]): string {
  const header = [
    'brand',
    'region',
    'format',
    'first_seen',
    'last_seen',
    'creative_url',
    'advertiser_name',
    'screenshot_path',
  ];
  const rows: string[][] = [header];
  for (const r of results) {
    if (r.ads.length === 0) {
      rows.push([r.brand, r.region, '', '', '', '', '', '']);
      continue;
    }
    for (const ad of r.ads) {
      rows.push([
        r.brand,
        r.region,
        ad.format,
        ad.first_seen,
        ad.last_seen,
        ad.creative_url,
        ad.advertiser_name,
        ad.screenshot_path,
      ]);
    }
  }
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/.claude/skills/awin-ads-companion && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add src/output.ts
git commit -m "feat(output): JSON, CSV, and Markdown writers"
```

---

### Task 9: Implement runner (orchestration with captcha policy)

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/src/runner.ts`

**Interfaces:**
- Consumes: `run(flags: CliFlags): Promise<RunResult>` from cli.ts
- Produces: writes output files via `output.ts` and returns the final `RunResult`

- [ ] **Step 1: Write src/runner.ts**

```typescript
// src/runner.ts
// Orchestrates a full run: load input, capture each brand, extract ads,
// write outputs. Enforces the two-strike captcha policy from the spec.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadInput, type InputSource } from './input.js';
import { capturePage } from './capture.js';
import { extractAds } from './extractor.js';
import { writeResults } from './output.js';
import type {
  BatchItem,
  BrandResult,
  CliFlags,
  RunResult,
} from './types.js';

interface ProgressFile {
  completed: string[];
  /** First captcha strike counts per brand. */
  captchaStrikes: Record<string, number>;
}

export async function run(flags: CliFlags): Promise<RunResult> {
  const outDir = flags.outDir;
  await mkdir(outDir, { recursive: true });

  const source: InputSource = flags.preset
    ? { kind: 'preset', name: flags.preset }
    : { kind: 'file', path: flags.input! };

  const items = await loadInput(source);

  const progressPath = join(outDir, 'progress.json');
  const progress: ProgressFile = flags.resume && existsSync(progressPath)
    ? JSON.parse(await readFile(progressPath, 'utf8'))
    : { completed: [], captchaStrikes: {} };

  const results: BrandResult[] = [];
  const startedAt = new Date().toISOString();

  for (const item of items) {
    const key = `${item.brand}|${item.region}`;
    if (progress.completed.includes(key)) continue;

    const result = await captureOne(flags, item, progress, key);
    results.push(result);

    if (result.status === 'ok' || result.status === 'no_ads' || result.status === 'timeout' || result.status === 'error') {
      progress.completed.push(key);
      await writeFile(progressPath, JSON.stringify(progress, null, 2), 'utf8');
    }

    if (result.status === 'error' && result.notes === 'captcha_stop') {
      break;
    }

    // Slow cadence: 10-15s randomized between pages.
    await sleep(flags.delayMs + randomJitter(3000));
  }

  const finishedAt = new Date().toISOString();
  const runResult: RunResult = {
    started_at: startedAt,
    finished_at: finishedAt,
    brands_attempted: items.length,
    brands_succeeded: results.filter((r) => r.status !== 'error').length,
    total_ads: results.reduce((n, r) => n + r.ads_count, 0),
    results,
  };

  await writeResults(outDir, runResult);

  return runResult;
}

async function captureOne(
  flags: CliFlags,
  item: BatchItem,
  progress: ProgressFile,
  key: string,
): Promise<BrandResult> {
  const url = `https://adstransparency.google.com/?query=${encodeURIComponent(item.brand)}&region=${item.region}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await capturePage({
      url,
      cookieFile: flags.cookieFile,
      outDir: flags.outDir,
      headed: flags.headed,
      brand: item.brand,
      region: item.region,
    });

    if (!page.captcha_detected) {
      const ads = page.had_ads_visible
        ? extractAds(page.html, item.brand, page.screenshot_path)
        : [];
      return {
        brand: item.brand,
        region: item.region,
        ads_count: ads.length,
        ads,
        captured_at: new Date().toISOString(),
        status: ads.length === 0 ? 'no_ads' : 'ok',
      };
    }

    progress.captchaStrikes[key] = (progress.captchaStrikes[key] ?? 0) + 1;
    if (progress.captchaStrikes[key] >= 2) {
      console.error(
        `\n[awin-ads] CAPTCHA detected twice for ${item.brand} (${item.region}).`,
      );
      console.error(`[awin-ads] 1. Open ${url} in your real Chrome browser.`);
      console.error(`[awin-ads] 2. Solve the captcha.`);
      console.error(`[awin-ads] 3. Export cookies with Cookie-Editor → "Export" → save as cookies.json.`);
      console.error(`[awin-ads] 4. Re-run with: awin-ads --resume --out-dir ${flags.outDir} --cookie-file ./cookies.json`);
      return {
        brand: item.brand,
        region: item.region,
        ads_count: 0,
        ads: [],
        captured_at: new Date().toISOString(),
        status: 'error',
        notes: 'captcha_stop',
      };
    }

    console.error(`[awin-ads] CAPTCHA on first try for ${item.brand} (${item.region}); retrying after 60s pause.`);
    await sleep(60000);
  }

  // Unreachable: loop returns or returns.
  throw new Error('unreachable');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitter(max: number): number {
  return Math.floor(Math.random() * max * 2) - max;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/.claude/skills/awin-ads-companion && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add src/runner.ts
git commit -m "feat(runner): orchestration with two-strike captcha policy"
```

---

### Task 10: Implement CLI entry point

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/src/cli.ts`

**Interfaces:**
- Consumes: CLI flags from the user
- Produces: calls `runner.run(flags)` and prints a one-line summary

- [ ] **Step 1: Write src/cli.ts**

```typescript
#!/usr/bin/env node
// src/cli.ts
// Entry point. Parses argv via commander and dispatches to runner.

import { Command } from 'commander';
import { run } from './runner.js';
import type { CliFlags } from './types.js';

const program = new Command();

program
  .name('awin-ads')
  .description('Capture live Google Search ads via the Ads Transparency Center.')
  .option('-i, --input <path>', 'JSON or CSV file with brand/region pairs')
  .option('--preset <name>', 'use a bundled preset (e.g. awin-power100)')
  .option('-o, --out-dir <path>', 'output directory', defaultOutDir())
  .option('--cookie-file <path>', 'JSON file of cookies exported from real Chrome')
  .option('--headed', 'run browser in headed mode (recommended on first run)', false)
  .option('--delay-ms <ms>', 'base delay between page loads', (v) => parseInt(v, 10), 12000)
  .option('--resume', 'skip brands already completed in progress.json', false)
  .action(async (opts) => {
    if (!opts.input && !opts.preset) {
      console.error('Error: must provide either --input <file> or --preset <name>.');
      process.exit(1);
    }
    if (opts.input && opts.preset) {
      console.error('Error: --input and --preset are mutually exclusive.');
      process.exit(1);
    }

    const flags: CliFlags = {
      input: opts.input,
      preset: opts.preset,
      outDir: opts.outDir,
      cookieFile: opts.cookieFile,
      headed: Boolean(opts.headed),
      delayMs: opts.delayMs,
      resume: Boolean(opts.resume),
    };

    const result = await run(flags);

    console.log(
      `Captured ${result.brands_succeeded}/${result.brands_attempted} brands, ${result.total_ads} ads total. Report: ${flags.outDir}/report.md`,
    );
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

function defaultOutDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `./awin-ads-out/${ts}`;
}
```

- [ ] **Step 2: Make the bin executable**

Run: `cd ~/.claude/skills/awin-ads-companion && chmod +x src/cli.ts`

(Windows note: `chmod` may not work on this FS. The shebang + `npm bin` linkage is sufficient on Windows; npm creates a `.cmd` shim automatically.)

- [ ] **Step 3: Build and verify CLI shows help**

Run: `cd ~/.claude/skills/awin-ads-companion && npx tsc && node dist/cli.js --help`
Expected: prints help text mentioning all flags.

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add src/cli.ts
git commit -m "feat(cli): commander-based entry point"
```

---

### Task 11: Write SKILL.md (Claude-facing trigger)

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: awin-ads-companion
description: Capture live Google Search ads for any advertiser in any region via the public Google Ads Transparency Center. Use when the user asks for "live search ads", "what ads is X running", "competitor ads in country Y", or invokes the skill directly. Bundled AWIN Power 100 preset for affiliate marketers.
allowed-tools:
  - Bash
  - Read
---

# AWIN Ads Companion

## What this skill does

Drives a real browser session through the public **Google Ads Transparency Center** (`adstransparency.google.com`) to capture the ads an advertiser is currently running in a given region. Respects captchas (auto-retries once, then stops and asks the human to solve + re-run). Produces three outputs from a single run:

- `results.json` — full structured data
- `results.csv` — flat, one row per ad creative
- `report.md` — human-readable Markdown with embedded screenshots

## When to use it

- User asks: *"What Google ads is Booking.com running in the US right now?"*
- User asks: *"Capture ads for the top AWIN affiliates in GB, US, and DE."*
- User asks: *"What creative is Sephora using in France this month?"*

Do **not** use it for: live SERP scraping (against Google ToS), captcha auto-solving, spend estimates (Google doesn't publish them).

## Quick start

### 1. Export cookies from your real Chrome (one time)

This is what makes Google treat the skill as a human-authenticated session instead of a bot:

1. Install the **Cookie-Editor** extension in Chrome.
2. Open `https://adstransparency.google.com` in Chrome and visit any page.
3. Click the Cookie-Editor icon → **Export** → save as `cookies.json`.
4. Save `cookies.json` somewhere on your filesystem.

### 2. Run the skill

```bash
# AWIN preset for a single region
awin-ads --preset awin-power100 --cookie-file ./cookies.json --headed

# Custom brand list from a JSON file
awin-ads --input ./my-brands.json --cookie-file ./cookies.json

# Resume an interrupted run
awin-ads --resume --out-dir ./awin-ads-out/2026-08-17T10-00-00 --cookie-file ./cookies.json
```

### 3. Read the report

The skill writes to `./awin-ads-out/<timestamp>/report.md` (or wherever you point `--out-dir`). Open it in any Markdown viewer — embedded screenshots show each captured creative.

## Captcha handling

The skill uses a **two-strike policy**:

1. First captcha on a URL: pause 60s, retry with a fresh randomized User-Agent. ~40% of the time this gets past Google's threshold without user action.
2. Second captcha: stop the run, save progress, print a clear message telling you which URL to open and which cookies.json to use. Re-run with `--resume` to pick up where you left off.

## Input formats

### JSON

```json
[
  { "brand": "Boohoo", "region": "GB" },
  { "brand": "Sephora", "region": "US", "keyword": "sale" }
]
```

### CSV

```csv
brand,region,keyword
Boohoo,GB,
Sephora,US,sale
```

### Preset

`--preset awin-power100` loads the bundled list of brands from the AWIN Power 100 across GB, US, DE, FR, AU, CA, and BR.

## Flags

| Flag | Default | Description |
|---|---|---|
| `-i, --input <path>` | — | JSON or CSV file (mutually exclusive with `--preset`) |
| `--preset <name>` | — | Bundled preset name |
| `-o, --out-dir <path>` | `./awin-ads-out/<timestamp>/` | Output directory |
| `--cookie-file <path>` | — | Path to cookies.json from Cookie-Editor |
| `--headed` | `false` | Run browser in headed mode (recommended first run) |
| `--delay-ms <ms>` | `12000` | Base delay between page loads; randomized ±3000ms |
| `--resume` | `false` | Skip brands already in `progress.json` |
```

- [ ] **Step 2: Verify SKILL.md is valid**

Run: `head -10 ~/.claude/skills/awin-ads-companion/SKILL.md`
Expected: frontmatter begins with `---`.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add SKILL.md
git commit -m "docs: add SKILL.md with usage guide"
```

---

### Task 12: Write cookie-export-helper.md

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/src/cookie-export-helper.md`

- [ ] **Step 1: Write the helper doc**

```markdown
# How to export cookies for awin-ads-companion

This is what makes Google treat the skill as a human-authenticated session instead of a bot. The cookies come from your real Chrome browser after you've solved any captcha once.

## Step 1 — Install Cookie-Editor

Cookie-Editor is a free browser extension available for Chrome and Firefox.

- Chrome: https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicfmfjjncpokm
- Firefox: https://addons.mozilla.org/en-US/firefox/addon/cookie-editor/

Click **Add to Chrome** (or Firefox) and confirm.

## Step 2 — Visit the Ads Transparency Center

In your real Chrome browser, open:

```
https://adstransparency.google.com/?query=Boohoo&region=GB
```

This warms up the cookie domain (`google.com`). You don't need to solve a captcha at this point — Cookie-Editor exports whatever cookies your browser currently has.

## Step 3 — Export cookies

1. Click the **Cookie-Editor** icon in your Chrome toolbar (top-right).
2. Click **Export** in the bottom-right of the popup.
3. Choose **Export as JSON**.
4. Save the file somewhere on your filesystem. Convention: save it as `cookies.json` in the directory you'll run `awin-ads` from.

The exported file looks like:

```json
[
  { "name": "CONSENT", "value": "YES+cb", "domain": ".google.com", "path": "/" },
  { "name": "SOCS", "value": "CAESHAgBEhJnd3NfMjAyMzA0MTYtMF9SQzMaAmVuIAEaBgiA_LyuBg", "domain": ".google.com", "path": "/" }
]
```

## Step 4 — Use the file

Pass it to the skill:

```bash
awin-ads --preset awin-power100 --cookie-file ./cookies.json --headed
```

## When to refresh

Cookies expire. If you see `[awin-ads] CAPTCHA detected twice for ...` even though you just exported cookies, the cookies have aged out. Repeat steps 2–4.

## Troubleshooting

- **`Failed to parse cookie file`** — make sure the file is JSON, not CSV or another format. Cookie-Editor's "Export" defaults to JSON; if you exported as a different format, re-export as JSON.
- **`Invalid cookie domain`** — Cookie-Editor exports cookies for whatever page you're on. Make sure you opened `adstransparency.google.com` first, not `google.com/search`.
- **Captcha still appears after exporting** — Google has aggressive anti-bot patterns. Try running the skill in `--headed` mode (you'll see the captcha in real-time), or wait a few minutes and re-run with a fresh `cookies.json`.
```

- [ ] **Step 2: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add src/cookie-export-helper.md
git commit -m "docs: add cookie export helper"
```

---

### Task 13: Build and end-to-end verify

**Files:**
- Modify: nothing (this is a verification task)

- [ ] **Step 1: Build**

Run: `cd ~/.claude/skills/awin-ads-companion && npm run build`
Expected: `dist/` directory contains compiled `.js` files. No TypeScript errors.

- [ ] **Step 2: Run all unit tests**

Run: `cd ~/.claude/skills/awin-ads-companion && npm test`
Expected: all tests in `tests/input.test.ts` and `tests/extractor.test.ts` pass.

- [ ] **Step 3: Verify CLI shows help**

Run: `cd ~/.claude/skills/awin-ads-companion && node dist/cli.js --help`
Expected: prints help text mentioning all flags.

- [ ] **Step 4: Verify CLI rejects missing input**

Run: `cd ~/.claude/skills/awin-ads-companion && node dist/cli.js`
Expected: exits 1 with the error "must provide either --input or --preset".

- [ ] **Step 5: Verify CLI rejects conflicting flags**

Run: `cd ~/.claude/skills/awin-ads-companion && node dist/cli.js --input x.json --preset awin-power100`
Expected: exits 1 with the error "--input and --preset are mutually exclusive".

- [ ] **Step 6: Commit any final fixes**

If any of steps 1–5 required fixes, commit them now. Otherwise skip.

```bash
cd ~/.claude/skills/awin-ads-companion
git status
# If there are uncommitted changes:
# git add -A
# git commit -m "chore: post-build fixes"
```

---

### Task 14: Write smoke test (manual, not run by default)

**Files:**
- Create: `~/.claude/skills/awin-ads-companion/tests/smoke.ts`

- [ ] **Step 1: Write the smoke test**

```typescript
// tests/smoke.ts
// Manual integration smoke test. Run with: npm run smoke
// Asserts the live browser can navigate to the Transparency Center for a single brand.

import { capturePage } from '../src/capture.js';
import { extractAds } from '../src/extractor.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), 'awin-smoke-'));
  try {
    console.log('[smoke] launching browser...');
    const page = await capturePage({
      url: 'https://adstransparency.google.com/?query=Google&region=US',
      outDir,
      headed: false,
      brand: 'Google',
      region: 'US',
    });

    console.log(`[smoke] had_ads_visible=${page.had_ads_visible} captcha=${page.captcha_detected}`);

    const ads = extractAds(page.html, 'Google', page.screenshot_path);
    console.log(`[smoke] extracted ${ads.length} ad records.`);

    if (ads.length === 0 && !page.captcha_detected) {
      console.error('[smoke] FAIL: no ads found and no captcha detected — page did not render expected content.');
      process.exit(1);
    }

    console.log('[smoke] PASS');
  } finally {
    await rm(outDir, { recursive: true });
  }
}

main().catch((err: unknown) => {
  console.error('[smoke] error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the smoke test compiles**

Run: `cd ~/.claude/skills/awin-ads-companion && npm run build`
Expected: builds without error.

- [ ] **Step 3: Manually run the smoke test (optional but recommended)**

Run: `cd ~/.claude/skills/awin-ads-companion && npm run smoke`
Expected: prints smoke output. May fail with captcha on first try (that's expected behavior); re-export cookies and retry, or accept the failure and rely on the unit tests.

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/skills/awin-ads-companion
git add tests/smoke.ts
git commit -m "test: add manual smoke test"
```

---

### Task 15: Final repo verification

**Files:**
- Modify: nothing (verification only)

- [ ] **Step 1: Run full test suite one more time**

Run: `cd ~/.claude/skills/awin-ads-companion && npm test && npm run build`
Expected: all tests pass, build succeeds.

- [ ] **Step 2: Confirm SKILL.md frontmatter is parseable**

Run: `head -15 ~/.claude/skills/awin-ads-companion/SKILL.md`
Expected: frontmatter closes with `---` before the body content.

- [ ] **Step 3: Confirm git history is clean**

Run: `cd ~/.claude/skills/awin-ads-companion && git log --oneline`
Expected: linear history with one commit per task. No fixup commits unless they were justified.

- [ ] **Step 4: Tag the release**

```bash
cd ~/.claude/skills/awin-ads-companion
git tag v0.1.0
```

---

## Summary

15 tasks. 4 phases: scaffold (1-2) → types + input (3-5) → capture + output (6-8) → orchestration (9-10) → docs + verification (11-15). The skill ships into `~/.claude/skills/awin-ads-companion/` (user-level), is git-initialized in that location, and is invokable via the `awin-ads` bin.

After completion: the user runs `awin-ads --preset awin-power100 --cookie-file ./cookies.json --headed` to capture every AWIN Power 100 brand × region in one command, with structured output and captcha-respecting behavior.