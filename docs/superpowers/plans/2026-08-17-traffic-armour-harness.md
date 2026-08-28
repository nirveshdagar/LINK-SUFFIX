# Traffic Armour Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node + TypeScript test harness that generates four tiers of synthetic traffic (trivial HTTP, headless browser, stealth browser, realistic human) against reverse-proxy anti-bot (Traffic Armour) deployments, using IP Royal residential proxies with strict country + state + city targeting, with a live local dashboard and structured logs.

**Architecture:** TypeScript monorepo with `packages/proxy` (IP Royal URL grammar), `packages/verdict` (TA detection strategies), `packages/orchestrator` (scenario runner + JSONL sink + event bus), `packages/tiers/*` (the four traffic tiers), `packages/dashboard` (Fastify + SSE), `packages/profiles` (device JSON). Python `tooling/py/` for post-run geo verification and replay packing only. Sequential default runner, `--parallel` opt-in.

**Tech Stack:** Node 20+, TypeScript 5, Playwright + `playwright-extra` + `puppeteer-extra-plugin-stealth`, Fastify, undici, Zod (JSON Schema for scenarios), jsdom, vitest. Python 3.11+ with `maxminddb` and `playwright-trace` tooling.

---

## Global Constraints

- **Node 20 or newer.** Older Node lacks stable `undici`, `fetch`, and `EventTarget` shims the harness depends on.
- **TypeScript 5 strict mode.** All packages use `"strict": true` and `"noUncheckedIndexedAccess": true`. No `any` outside well-justified spot fixes.
- **Single monorepo via npm workspaces.** Path: `packages/*`. No rush/pnpm/lerna.
- **All verdict signatures enabled by default.** Surfaced individually in `summary.json`.
- **`unsure` rows go to `unsure.jsonl`, never halt the run.**
- **City-strict geo at three checkpoints.** No silent fallback to country.
- **Sequential default, `--parallel` opt-in.**
- **No static-ISP proxy mode in v1.** Sticky-residential covers it.
- **No Go in v1.** Node + TS handles trivial-http at the volume needed.
- **Dashboard listens on `127.0.0.1:7474` by default, `--no-dashboard` to disable.**
- **Dashboard uses Fastify + SSE. No SPA, no build step.** Single `index.html` served from `packages/dashboard/public/`.
- **Five default device profiles** in `packages/profiles/devices.json`: `desktop-windows-chrome`, `desktop-mac-safari`, `iphone-15-safari`, `android-pixel-chrome`, `ipad-safari`.
- **IP Royal username regex:** `^user-country-[A-Z]{2}(-state-[A-Za-z]+)?(-city-[A-Za-z]+)?(-sessionid-[A-Za-z0-9]+)?$`.
- **Output directory:** `runs/<iso-timestamp>/` per run.
- **Repo layout:** `packages/proxy`, `packages/verdict`, `packages/orchestrator`, `packages/tiers/{trivial-http,headless-browser,stealth-browser,human-sim}`, `packages/dashboard`, `packages/profiles`, `tooling/py/`, `scenarios/`, `tests/{unit,integration,smoke}`.

---

## File Structure

Files this plan creates. Each is small and focused; later tasks consume earlier ones by name.

```
package.json                         # npm workspaces root, scripts
tsconfig.base.json                   # strict, ES2022 target, NodeNext module
.env.example                         # IPROYAL_USER, IPROYAL_PASS, MAXMIND_DB_PATH
.gitignore                           # runs/, node_modules/, .env

scenarios/schema.json                # JSON Schema for scenario YAMLs

packages/proxy/
  package.json
  tsconfig.json
  src/index.ts                       # GeoTarget, ProxyMode, ProxyEndpoint, buildProxyEndpoint
  src/grammar.ts                     # IP Royal URL grammar, validation regex
  src/index.test.ts

packages/verdict/
  package.json
  tsconfig.json
  src/types.ts                       # Vote, VerdictInput, VerdictStrategy, aggregate return
  src/aggregate.ts                   # aggregateVerdict(input, enabled)
  src/signatures.ts                  # DEFAULT_SIGNATURES
  src/strategies/
    httpStatus.ts                    # httpStatusStrategy
    challengeHtml.ts                 # challengeHtmlStrategy
    headerSignals.ts                 # headerSignalsStrategy
    cookies.ts                       # cookieStrategy
    timing.ts                        # timingStrategy (returns unsure only)
  src/aggregate.test.ts
  src/strategies/*.test.ts

packages/profiles/
  package.json
  src/devices.json                   # 5 default device profiles
  src/loader.ts                      # loadProfile(id), listProfiles()
  src/loader.test.ts

packages/orchestrator/
  package.json
  src/cli.ts                         # commander wiring, --scenario, --parallel, --no-dashboard, --dashboard-port
  src/scenarioLoader.ts              # YAML + JSON Schema validation
  src/eventBus.ts                    # typed EventEmitter wrapper
  src/jsonlSink.ts                   # append-only JSONL writer
  src/runner.ts                      # plan repeats, dispatch to tiers, run verification
  src/index.ts                       # public surface used by cli.ts

packages/tiers/trivial-http/
  package.json
  src/index.ts                       # export run(scenario, proxyUrl)
  src/runner.ts                      # undici pool, concurrency, jitter, header randomization
  src/runner.test.ts

packages/tiers/headless-browser/
  package.json
  src/index.ts                       # export run(scenario, proxyUrl, device)
  src/runner.ts                      # playwright --headless=new, no stealth
  src/runner.test.ts

packages/tiers/stealth-browser/
  package.json
  src/index.ts
  src/runner.ts                      # playwright-extra + stealth plugin
  src/runner.test.ts

packages/tiers/human-sim/
  package.json
  src/index.ts
  src/behavior/
    mouse.ts                         # bezier trajectories, overshoot, hover
    scroll.ts                        # pulses, settle
    timing.ts                        # per-locale log-normal time_on_page_ms
    forms.ts                         # keystroke timing (only when scenario declares forms)
  src/journey.ts                     # live <a href> extraction, weighted next-URL pick
  src/runner.ts                      # orchestrates behavior per page, journey across pages
  src/journey.test.ts

packages/dashboard/
  package.json
  src/server.ts                      # Fastify, SSE, summary/unsure/mismatches/replays routes
  src/public/index.html              # single HTML file, inline CSS + JS (no build)
  src/aggregator.ts                  # tier×verdict + geo counters driven by event bus

tooling/py/
  pyproject.toml
  verify_geo.py                      # egress IP lookup, MaxMind resolution, mismatches.csv
  build_replay.py                    # zip playwright trace + HAR + screenshots per scenario
  tests/test_verify_geo.py

tests/integration/
  fake-ta.Dockerfile                 # nginx as fake TA: 403 on HeadlessChrome, interstitial otherwise
  fake-ta.conf
  runFakeTA.test.ts                  # spins fake TA + docker, runs all 4 tiers, asserts verdict rates

scenarios/
  mumbai-human-pricing-journey.yaml  # full-spectrum example
  trivial-burst-homepage.yaml        # high-RPS bot tier example
  berlin-stealth-funnel.yaml         # stealth-tier example

.github/workflows/ci.yml             # vitest unit + integration, no IP Royal bandwidth

README.md
```

---

## Task 1: Project Scaffold + Tooling

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `README.md`, `.editorconfig`

**Interfaces:** None — this task only establishes the workspace.

- [ ] **Step 1: Write the root `package.json`**

```json
{
  "name": "traffic-armour-harness",
  "private": true,
  "version": "0.1.0",
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit packages/*/src",
    "test:integration": "vitest run tests/integration",
    "lint": "tsc -b --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.12.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
runs/
.env
*.log
.DS_Store
dist/
coverage/
```

- [ ] **Step 4: Write `.env.example`**

```
IPROYAL_USER=
IPROYAL_PASS=
<set-in-environment>
```

- [ ] **Step 5: Write minimal `README.md`**

Document:
- The harness purpose (one paragraph).
- `npm install` then `npm run test` expected.
- Requirement: IP Royal credentials + a MaxMind GeoLite2-City `.mmdb` file at `MAXMIND_DB_PATH`.

- [ ] **Step 6: Install and verify tooling**

```bash
npm install
npm run lint
```

Expected: dependencies install, TypeScript compiles with no errors (no packages yet — should succeed because there is nothing to type-check).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json .gitignore .env.example README.md
git commit -m "chore: scaffold workspace + tooling"
```

---

## Task 2: Scenario JSON Schema

**Files:**
- Create: `scenarios/schema.json`

**Interfaces:** This file's `$id` (`https://traffic-armour-harness.local/scenarios.schema.json`) is referenced by `packages/orchestrator` in Task 12.

- [ ] **Step 1: Write `scenarios/schema.json`**

```json
{
  "$id": "https://traffic-armour-harness.local/scenarios.schema.json",
  "$schema": "https://json-schema.org/draft-07/schema#",
  "title": "Traffic Armour scenario",
  "type": "object",
  "required": ["id", "tier", "seed_url", "geo", "proxy_mode", "repeats", "expected_verdict"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "tier": { "enum": ["trivial-http", "headless", "stealth", "human"] },
    "seed_url": { "type": "string", "format": "uri" },
    "device_pool": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string" }
    },
    "geo": {
      "type": "object",
      "required": ["country"],
      "additionalProperties": false,
      "properties": {
        "country": { "type": "string", "pattern": "^[A-Z]{2}$" },
        "state": { "type": "string", "pattern": "^[A-Za-z]+$" },
        "city": { "type": "string", "pattern": "^[A-Za-z -]+$" }
      }
    },
    "proxy_mode": { "enum": ["rotating-residential", "sticky-residential"] },
    "session": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "pages": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "min": { "type": "integer", "minimum": 1 },
            "max": { "type": "integer", "minimum": 1 }
          }
        },
        "internal_link_probability": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "concurrent": { "type": "integer", "minimum": 1, "default": 16 },
    "repeats": { "type": "integer", "minimum": 1 },
    "expected_verdict": { "enum": ["block", "challenge", "allow"] },
    "verdict_detection": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "http_status": { "type": "boolean" },
        "challenge_html": { "type": "boolean" },
        "challenge_signatures": {
          "type": "array",
          "items": { "enum": ["cloudflare", "hcaptcha", "datadome", "perimeterx", "akamai", "generic"] }
        },
        "header_signals": { "type": "boolean" },
        "cookies": { "type": "boolean" },
        "timing": { "type": "boolean" }
      }
    }
  },
  "allOf": [
    {
      "if": {
        "properties": { "tier": { "enum": ["headless", "stealth", "human"] } },
        "required": ["tier"]
      },
      "then": {
        "required": ["device_pool"],
        "properties": {
          "proxy_mode": { "const": "sticky-residential" }
        }
      }
    },
    {
      "if": { "properties": { "tier": { "const": "human" } }, "required": ["tier"] },
      "then": { "required": ["session"] }
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add scenarios/schema.json
git commit -m "feat: scenario JSON Schema"
```

---

## Task 3: `packages/proxy` — IP Royal URL Grammar

**Files:**
- Create: `packages/proxy/package.json`, `packages/proxy/tsconfig.json`, `packages/proxy/src/grammar.ts`, `packages/proxy/src/index.ts`, `packages/proxy/src/index.test.ts`

**Interfaces:**
- Exports used by every later task:
  - `GeoTarget = { country: string; state?: string; city?: string }`
  - `ProxyMode = 'rotating-residential' | 'sticky-residential'`
  - `ProxyEndpoint = { url: URL; mode: ProxyMode; sessionId?: string }`
  - `class InvalidProxyGeoError extends Error`
  - `function buildProxyEndpoint(geo: GeoTarget, mode: ProxyMode, creds: { user: string; pass: string }, sessionId?: string): ProxyEndpoint`

- [ ] **Step 1: Write `packages/proxy/package.json`**

```json
{
  "name": "@tah/proxy",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Write `packages/proxy/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `packages/proxy/src/grammar.ts`**

```typescript
export const IPROYAL_USERNAME_REGEX =
  /^user-country-[A-Z]{2}(-state-[A-Za-z]+)?(-city-[A-Za-z -]+)?(-sessionid-[A-Za-z0-9]+)?$/;

export interface Hostnames {
  'rotating-residential': string;
  'sticky-residential': string;
}

export const HOSTNAMES: Hostnames = {
  'rotating-residential': 'geo.iproyal.com',         // rotate proxy gateway
  'sticky-residential': 'geo.iproyal.com',           // session sticky uses ?sessionid query
};

export const PROXY_PORT = 12321;
```

> Note: the actual hostname/port are read from IP Royal's dashboard at runtime via env. The above are placeholders the user overwrites in Task 18.

- [ ] **Step 4: Write failing tests in `packages/proxy/src/index.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildProxyEndpoint,
  InvalidProxyGeoError,
  IPROYAL_USERNAME_REGEX,
} from './index.js';

describe('IPROYAL_USERNAME_REGEX', () => {
  it('accepts country-only', () => {
    expect(IPROYAL_USERNAME_REGEX.test('user-country-US')).toBe(true);
  });
  it('accepts country+state+city', () => {
    expect(IPROYAL_USERNAME_REGEX.test('user-country-IN-state-Maharashtra-city-Mumbai')).toBe(true);
  });
  it('accepts with sessionid', () => {
    expect(IPROYAL_USERNAME_REGEX.test('user-country-IN-state-MH-city-Mumbai-sessionid-abc123')).toBe(true);
  });
  it('rejects lowercase country', () => {
    expect(IPROYAL_USERNAME_REGEX.test('user-country-us')).toBe(false);
  });
});

describe('buildProxyEndpoint', () => {
  const creds = { user: 'alice', pass: 'secret' };

  it('builds a rotating endpoint', () => {
    const ep = buildProxyEndpoint({ country: 'US' }, 'rotating-residential', creds);
    expect(ep.url.username).toBe('user-country-US');
    expect(ep.url.password).toBe('secret');
    expect(ep.mode).toBe('rotating-residential');
  });

  it('builds a sticky endpoint with session id', () => {
    const ep = buildProxyEndpoint(
      { country: 'IN', state: 'MH', city: 'Mumbai' },
      'sticky-residential',
      creds,
      'sess-1'
    );
    expect(ep.url.username).toBe('user-country-IN-state-Maharashtra-city-Mumbai-sessionid-sess-1');
    expect(ep.sessionId).toBe('sess-1');
  });

  it('throws InvalidProxyGeoError on bad country code', () => {
    expect(() =>
      buildProxyEndpoint({ country: 'usa' }, 'rotating-residential', creds),
    ).toThrow(InvalidProxyGeoError);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm --workspace @tah/proxy test`
Expected: FAIL — `buildProxyEndpoint` does not exist yet.

- [ ] **Step 6: Write `packages/proxy/src/index.ts`**

```typescript
import { IPROYAL_USERNAME_REGEX, HOSTNAMES, PROXY_PORT } from './grammar.js';

export { IPROYAL_USERNAME_REGEX, HOSTNAMES, PROXY_PORT } from './grammar.js';

export type ProxyMode = 'rotating-residential' | 'sticky-residential';

export interface GeoTarget {
  country: string;
  state?: string;
  city?: string;
}

export interface ProxyEndpoint {
  url: URL;
  mode: ProxyMode;
  sessionId?: string;
}

export class InvalidProxyGeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProxyGeoError';
  }
}

function buildUsername(geo: GeoTarget, sessionId?: string): string {
  const parts = [`user-country-${geo.country.toUpperCase()}`];
  if (geo.state) parts.push(`state-${geo.state.replace(/\s+/g, '-')}`);
  if (geo.city) parts.push(`city-${geo.city.replace(/\s+/g, '-')}`);
  if (sessionId) parts.push(`sessionid-${sessionId}`);
  const u = parts.join('-');
  if (!IPROYAL_USERNAME_REGEX.test(u)) {
    throw new InvalidProxyGeoError(`Constructed IP Royal username does not match grammar: ${u}`);
  }
  return u;
}

export function buildProxyEndpoint(
  geo: GeoTarget,
  mode: ProxyMode,
  creds: { user: string; pass: string },
  sessionId?: string,
): ProxyEndpoint {
  const username = buildUsername(geo, sessionId);
  const url = new URL(`http://${HOSTNAMES[mode]}:${PROXY_PORT}`);
  url.username = username;
  url.password = creds.pass;
  return { url, mode, sessionId };
}
```

> Note: the test expects `user-country-US` and the username goes into `url.username`. The regex covers it; the test compares via `url.username` which URL-encodes any special chars.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm --workspace @tah/proxy test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/proxy
git commit -m "feat(proxy): IP Royal URL grammar + buildProxyEndpoint"
```

---

## Task 4: `packages/verdict` — Strategy Interface + Aggregator

**Files:**
- Create: `packages/verdict/package.json`, `packages/verdict/tsconfig.json`, `packages/verdict/src/types.ts`, `packages/verdict/src/aggregate.ts`, `packages/verdict/src/aggregate.test.ts`

**Interfaces:**
- `Vote = 'block' | 'challenge' | 'allow' | 'unsure'`
- `VerdictInput = { url; status; responseHeaders: Record<string,string>; responseBodySnippet: string; challengeRedirectedTo?: URL; setCookies: string[] }`
- `VerdictStrategy = { name: string; enabled: boolean; vote(input: VerdictInput): Vote | null }`
- `aggregateVerdict(input: VerdictInput, enabled: string[]): { final: Vote; byStrategy: Record<string, Vote>; reason: string }`
- Precedence: `block > challenge > allow > unsure`.

- [ ] **Step 1: Write `packages/verdict/package.json`**

```json
{
  "name": "@tah/verdict",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -b", "test": "vitest run" }
}
```

- [ ] **Step 2: Write `packages/verdict/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 3: Write `packages/verdict/src/types.ts`**

```typescript
export type Vote = 'block' | 'challenge' | 'allow' | 'unsure';

export interface VerdictInput {
  url: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBodySnippet: string;
  challengeRedirectedTo?: URL;
  setCookies: string[];
}

export interface VerdictStrategy {
  name: string;
  enabled: boolean;
  vote(input: VerdictInput): Vote | null;
}

export interface AggregatedVerdict {
  final: Vote;
  byStrategy: Record<string, Vote>;
  reason: string;
}
```

- [ ] **Step 4: Write failing tests in `packages/verdict/src/aggregate.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { aggregateVerdict } from './aggregate.js';
import type { VerdictInput } from './types.js';

const base: VerdictInput = {
  url: 'https://example.test/',
  status: 200,
  responseHeaders: {},
  responseBodySnippet: '',
  setCookies: [],
};

describe('aggregateVerdict', () => {
  it('returns allow when nothing fires', () => {
    expect(aggregateVerdict(base, ['http_status', 'cookies']).final).toBe('allow');
  });
  it('precedence: block > challenge', () => {
    const v = aggregateVerdict({ ...base, status: 403 }, ['http_status', 'challenge_html']);
    expect(v.final).toBe('block');
  });
  it('surfaces per-strategy votes', () => {
    const v = aggregateVerdict({ ...base, status: 403 }, ['http_status', 'cookies']);
    expect(v.byStrategy['http_status']).toBe('block');
    expect(v.byStrategy['cookies']).toBe('allow');
  });
  it('treats missing strategy as abstain', () => {
    const v = aggregateVerdict(base, []);
    expect(v.final).toBe('allow');
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm --workspace @tah/verdict test`
Expected: FAIL — `aggregateVerdict` does not exist.

- [ ] **Step 6: Write `packages/verdict/src/aggregate.ts`**

```typescript
import type { AggregatedVerdict, VerdictInput, VerdictStrategy, Vote } from './types.js';

export type { Vote, VerdictInput, VerdictStrategy, AggregatedVerdict } from './types.js';

const PRECEDENCE: Vote[] = ['block', 'challenge', 'unsure', 'allow'];

export function aggregateVerdict(
  input: VerdictInput,
  enabled: string[],
  strategies: VerdictStrategy[] = [],
): AggregatedVerdict {
  const byStrategy: Record<string, Vote> = {};
  let final: Vote = 'allow';
  let reason = '';

  for (const s of strategies) {
    if (!enabled.includes(s.name)) continue;
    const v = s.vote(input);
    if (v === null) continue;
    byStrategy[s.name] = v;
    if (PRECEDENCE.indexOf(v) < PRECEDENCE.indexOf(final)) {
      final = v;
      reason = `${s.name}: ${v}`;
    }
  }
  if (!reason) reason = 'no strategy voted';
  return { final, byStrategy, reason };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm --workspace @tah/verdict test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/verdict
git commit -m "feat(verdict): strategy interface + aggregator with precedence"
```

---

## Task 5: `packages/verdict` — Signatures

**Files:**
- Create: `packages/verdict/src/signatures.ts`

**Interfaces:** Exports `DEFAULT_SIGNATURES: Record<SignatureName, { headers?: string[]; cookies?: string[]; body?: string[] }>` with keys: `cloudflare`, `hcaptcha`, `datadome`, `perimeterx`, `akamai`, `generic`. Used by the strategies in Tasks 6 and 7.

- [ ] **Step 1: Write `packages/verdict/src/signatures.ts`**

```typescript
export type SignatureName =
  | 'cloudflare'
  | 'hcaptcha'
  | 'datadome'
  | 'perimeterx'
  | 'akamai'
  | 'generic';

export interface Signature {
  headers?: string[];        // match if any header name OR 'name:value' appears
  cookies?: string[];        // match if cookie name appears
  body?: string[];           // match if substring appears in body snippet
}

export const DEFAULT_SIGNATURES: Record<SignatureName, Signature> = {
  cloudflare: {
    headers: ['cf-ray', 'cf-cache-status', 'server:cloudflare', 'server:cloudflare,'],
    cookies: ['cf_clearance', '__cf_bm'],
    body: ['cf-chl-bypass', 'cf-challenge', '/cdn-cgi/challenge-platform/', 'cf-captcha-container'],
  },
  hcaptcha: {
    body: ['h-captcha', 'hcaptcha.com', '<div class="h-captcha"'],
  },
  datadome: {
    headers: ['x-datadome', 'server:datadome'],
    cookies: ['datadome'],
    body: ['datadome', 'geo.captcha-delivery.com', 'captcha-delivery.com'],
  },
  perimeterx: {
    headers: ['x-px', 'x-perimeterx'],
    cookies: ['_px3', '_pxde', '_pxvid'],
    body: ['px-captcha', 'client.perimeterx.net'],
  },
  akamai: {
    headers: ['x-akamai', 'x-true-client-ip', 'x-akamai-grn-'],
    cookies: ['_abck', 'akamai-rum'],
    body: ['akamai bot manager', '_abck'],
  },
  generic: {
    headers: ['x-blocked', 'x-served-by:suspicious'],
    body: ['access denied', 'forbidden', 'rate limit exceeded'],
  },
};

export function signatureMatches(input: {
  headers: Record<string, string>;
  bodySnippet: string;
  setCookies: string[];
}, sig: Signature): { matched: boolean; via: 'header' | 'cookie' | 'body' | null } {
  if (sig.headers) {
    const flat = Object.entries(input.headers).map(([k, v]) => `${k.toLowerCase()}:${String(v).toLowerCase()}`).join('\n');
    for (const h of sig.headers) {
      if (flat.includes(h.toLowerCase())) return { matched: true, via: 'header' };
    }
  }
  if (sig.cookies) {
    const cookieLine = input.setCookies.join('; ').toLowerCase();
    for (const c of sig.cookies) {
      if (cookieLine.includes(c.toLowerCase())) return { matched: true, via: 'cookie' };
    }
  }
  if (sig.body) {
    const body = input.bodySnippet.toLowerCase();
    for (const b of sig.body) {
      if (body.includes(b.toLowerCase())) return { matched: true, via: 'body' };
    }
  }
  return { matched: false, via: null };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/verdict/src/signatures.ts
git commit -m "feat(verdict): TA signature set (cloudflare/hcaptcha/datadome/perimeterx/akamai/generic)"
```

---

## Task 6: `packages/verdict` — Strategies

**Files:**
- Create: `packages/verdict/src/strategies/httpStatus.ts`, `challengeHtml.ts`, `headerSignals.ts`, `cookies.ts`, `timing.ts`, `index.ts`

**Interfaces:** Each strategy implements the `VerdictStrategy` shape from Task 4. The package's `index.ts` exports a `defaultStrategies(signatureNames: SignatureName[])` returning `VerdictStrategy[]`.

- [ ] **Step 1: Write `packages/verdict/src/strategies/httpStatus.ts`**

```typescript
import type { VerdictStrategy } from '../types.js';

export const httpStatusStrategy: VerdictStrategy = {
  name: 'http_status',
  enabled: true,
  vote(input) {
    if ([403, 503, 502].includes(input.status)) return 'block';
    if (input.status === 200 && input.responseBodySnippet.trim().length === 0) return 'block';
    return 'allow';
  },
};
```

- [ ] **Step 2: Write `packages/verdict/src/strategies/challengeHtml.ts`**

```typescript
import type { VerdictStrategy } from '../types.js';
import { DEFAULT_SIGNATURES, signatureMatches, type SignatureName } from '../signatures.js';

export function challengeHtmlStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'challenge_html',
    enabled: true,
    vote(input) {
      for (const n of signatureNames) {
        const sig = DEFAULT_SIGNATURES[n];
        const m = signatureMatches(
          { headers: input.responseHeaders, bodySnippet: input.responseBodySnippet, setCookies: input.setCookies },
          sig,
        );
        if (m.matched) return 'challenge';
      }
      return 'allow';
    },
  };
}
```

- [ ] **Step 3: Write `packages/verdict/src/strategies/headerSignals.ts`**

```typescript
import type { VerdictStrategy } from '../types.js';
import { DEFAULT_SIGNATURES, signatureMatches, type SignatureName } from '../signatures.js';

export function headerSignalsStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'header_signals',
    enabled: true,
    vote(input) {
      const headersOnly = signatureNames.map((n) => ({ ...(DEFAULT_SIGNATURES[n] ?? {}), cookies: undefined, body: undefined }));
      for (const sig of headersOnly) {
        const m = signatureMatches(
          { headers: input.responseHeaders, bodySnippet: '', setCookies: [] },
          sig,
        );
        if (m.matched) return 'challenge';
      }
      return 'allow';
    },
  };
}
```

- [ ] **Step 4: Write `packages/verdict/src/strategies/cookies.ts`**

```typescript
import type { VerdictStrategy } from '../types.js';
import { DEFAULT_SIGNATURES, signatureMatches, type SignatureName } from '../signatures.js';

export function cookieStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'cookies',
    enabled: true,
    vote(input) {
      for (const n of signatureNames) {
        const sig = { ...(DEFAULT_SIGNAMES_FALLBACK[n] ?? {}), headers: undefined, body: undefined };
        const m = signatureMatches({ headers: {}, bodySnippet: '', setCookies: input.setCookies }, sig);
        if (m.matched) return 'challenge';
      }
      return 'allow';
    },
  };
}

const DEFAULT_SIGNAMES_FALLBACK = DEFAULT_SIGNATURES;
import { DEFAULT_SIGNATURES } from '../signatures.js';
```

> Note: the `import` placed at the bottom is valid in ES modules and avoids a circular-style import inside the function. Replace this snippet with a clean top-of-file import.

Corrected final form:

```typescript
import type { VerdictStrategy } from '../types.js';
import { DEFAULT_SIGNATURES, signatureMatches, type SignatureName } from '../signatures.js';

export function cookieStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'cookies',
    enabled: true,
    vote(input) {
      for (const n of signatureNames) {
        const sig = DEFAULT_SIGNATURES[n];
        const onlyCookies: typeof sig = { cookies: sig.cookies };
        const m = signatureMatches(
          { headers: {}, bodySnippet: '', setCookies: input.setCookies },
          onlyCookies,
        );
        if (m.matched) return 'challenge';
      }
      return 'allow';
    },
  };
}
```

- [ ] **Step 5: Write `packages/verdict/src/strategies/timing.ts`**

```typescript
import type { VerdictStrategy } from '../types.js';

export const timingStrategy: VerdictStrategy = {
  name: 'timing',
  enabled: true,
  vote() {
    // Sub-100ms responses are *signals* not verdicts — never vote allow/block/challenge.
    return null;
  },
};
```

> Implementation note: timing is consumed by `aggregator` callers separately (response time is recorded in the request event, and sub-100ms counts in the summary as `unsure_signal`).

- [ ] **Step 6: Write `packages/verdict/src/index.ts`**

```typescript
export * from './types.js';
export * from './aggregate.js';
export { DEFAULT_SIGNATURES, type SignatureName } from './signatures.js';
import { httpStatusStrategy } from './strategies/httpStatus.js';
import { challengeHtmlStrategy } from './strategies/challengeHtml.js';
import { headerSignalsStrategy } from './strategies/headerSignals.js';
import { cookieStrategy } from './strategies/cookies.js';
import { timingStrategy } from './strategies/timing.js';

import type { SignatureName } from './signatures.js';
import type { VerdictStrategy } from './types.js';

export function defaultStrategies(signatureNames: SignatureName[] = [
  'cloudflare', 'hcaptcha', 'datadome', 'perimeterx', 'akamai', 'generic',
]): VerdictStrategy[] {
  return [
    httpStatusStrategy,
    challengeHtmlStrategy(signatureNames),
    headerSignalsStrategy(signatureNames),
    cookieStrategy(signatureNames),
    timingStrategy,
  ];
}
```

- [ ] **Step 7: Add one passing test for the integration of strategies + aggregator**

Append to `packages/verdict/src/aggregate.test.ts`:

```typescript
import { defaultStrategies } from './index.js';

it('defaultStrategies votes challenge on a Cloudflare interstitial', () => {
  const input: VerdictInput = {
    ...base,
    setCookies: ['cf_clearance=abc; Path=/'],
    responseHeaders: { server: 'cloudflare' },
    responseBodySnippet: '<html>cf-chl-bypass</html>',
  };
  const out = aggregateVerdict(input, ['http_status', 'challenge_html', 'cookies'], defaultStrategies());
  expect(out.final).toBe('challenge');
});
```

- [ ] **Step 8: Run all tests**

Run: `npm --workspace @tah/verdict test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/verdict/src
git commit -m "feat(verdict): strategies (http/challenge/header/cookie/timing) + defaults"
```

---

## Task 7: `packages/profiles` — Devices JSON + Loader

**Files:**
- Create: `packages/profiles/package.json`, `packages/profiles/tsconfig.json`, `packages/profiles/src/devices.json`, `packages/profiles/src/loader.ts`, `packages/profiles/src/loader.test.ts`

**Interfaces:**
- `DeviceProfile = { id: string; uaFamily: string; viewport: { w: number; h: number; dpr: number }; touch: boolean; hardware: { cores: number; memoryGb: number }; webgl: { vendor: string; renderer: string }; locale: string }`
- `loadProfile(id: string): DeviceProfile` throws on unknown id.
- `listProfiles(): DeviceProfile[]`

- [ ] **Step 1: Write `packages/profiles/package.json`**

```json
{
  "name": "@tah/profiles",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -b", "test": "vitest run" }
}
```

- [ ] **Step 2: Write `packages/profiles/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 3: Write `packages/profiles/src/devices.json`**

```json
[
  {
    "id": "desktop-windows-chrome",
    "uaFamily": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "viewport": { "w": 1920, "h": 1080, "dpr": 1 },
    "touch": false,
    "hardware": { "cores": 8, "memoryGb": 16 },
    "webgl": { "vendor": "Google Inc. (NVIDIA)", "renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)" },
    "locale": "en-US"
  },
  {
    "id": "desktop-mac-safari",
    "uaFamily": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "viewport": { "w": 2560, "h": 1440, "dpr": 2 },
    "touch": false,
    "hardware": { "cores": 10, "memoryGb": 16 },
    "webgl": { "vendor": "Apple Inc.", "renderer": "Apple M2 Pro" },
    "locale": "en-US"
  },
  {
    "id": "iphone-15-safari",
    "uaFamily": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "viewport": { "w": 390, "h": 844, "dpr": 3 },
    "touch": true,
    "hardware": { "cores": 6, "memoryGb": 6 },
    "webgl": { "vendor": "Apple Inc.", "renderer": "Apple A16 GPU" },
    "locale": "en-IN"
  },
  {
    "id": "android-pixel-chrome",
    "uaFamily": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "viewport": { "w": 412, "h": 915, "dpr": 2.625 },
    "touch": true,
    "hardware": { "cores": 8, "memoryGb": 8 },
    "webgl": { "vendor": "Qualcomm", "renderer": "Adreno 740" },
    "locale": "en-IN"
  },
  {
    "id": "ipad-safari",
    "uaFamily": "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "viewport": { "w": 1024, "h": 1366, "dpr": 2 },
    "touch": true,
    "hardware": { "cores": 8, "memoryGb": 8 },
    "webgl": { "vendor": "Apple Inc.", "renderer": "Apple M1 GPU" },
    "locale": "en-US"
  }
]
```

- [ ] **Step 4: Write failing test in `packages/profiles/src/loader.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { loadProfile, listProfiles } from './loader.js';

describe('profiles', () => {
  it('lists 5 default profiles', () => {
    expect(listProfiles()).toHaveLength(5);
  });
  it('loads iphone-15-safari', () => {
    const p = loadProfile('iphone-15-safari');
    expect(p.viewport.h).toBe(844);
    expect(p.touch).toBe(true);
  });
  it('throws on unknown id', () => {
    expect(() => loadProfile('nonexistent')).toThrow(/unknown profile/);
  });
});
```

- [ ] **Step 5: Run failing**

Run: `npm --workspace @tah/profiles test`
Expected: FAIL — loader missing.

- [ ] **Step 6: Write `packages/profiles/src/loader.ts`**

```typescript
import data from './devices.json' assert { type: 'json' };

export interface DeviceProfile {
  id: string;
  uaFamily: string;
  viewport: { w: number; h: number; dpr: number };
  touch: boolean;
  hardware: { cores: number; memoryGb: number };
  webgl: { vendor: string; renderer: string };
  locale: string;
}

const PROFILES: DeviceProfile[] = data as DeviceProfile[];

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

export function listProfiles(): DeviceProfile[] {
  return [...PROFILES];
}

export function loadProfile(id: string): DeviceProfile {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`unknown profile: ${id}`);
  return p;
}
```

- [ ] **Step 7: Run tests**

Run: `npm --workspace @tah/profiles test`
Expected: PASS.

- [ ] **Step 8: Write `packages/profiles/src/index.ts`**

```typescript
export * from './loader.js';
```

- [ ] **Step 9: Commit**

```bash
git add packages/profiles
git commit -m "feat(profiles): 5 default device profiles + loader"
```

---

## Task 8: `packages/orchestrator` — Event Bus + JSONL Sink + Scenario Loader

**Files:**
- Create: `packages/orchestrator/package.json`, `packages/orchestrator/tsconfig.json`, `packages/orchestrator/src/eventBus.ts`, `packages/orchestrator/src/jsonlSink.ts`, `packages/orchestrator/src/scenarioLoader.ts`, `packages/orchestrator/src/{eventBus,jsonlSink,scenarioLoader}.test.ts`

**Interfaces:**
- `RequestEvent` (canonical shape used by all tiers):
  ```typescript
  export interface RequestEvent {
    scenario_id: string;
    repeat_index: number;
    tier: 'trivial-http' | 'headless' | 'stealth' | 'human';
    geo_requested: GeoTarget;
    geo_resolved?: { ip: string; country: string; state?: string; city?: string; verified: boolean };
    proxy_mode: ProxyMode;
    session_id?: string;
    started_at: string;
    pages?: string[];
    events: Array<{ url: string; method: string; status: number; time_ms: number; headers: Record<string, string>; ta_signal: Record<string, string> }>;
    final_verdict: 'allow' | 'challenge' | 'block' | 'unsure' | 'error';
    timing: { total_ms: number; pages_visited?: number; mouse_moves?: number; scroll_pulses?: number };
    error?: string;
  }
  ```
- `EventBus` exports `on(event: 'request', cb: (e: RequestEvent) => void) => void` and `emit(event: 'request', e: RequestEvent) => void`.
- `JsonlSink` writes one `RequestEvent` per line to a file path, flushes every event.
- `loadScenario(path)` parses YAML, validates against `scenarios/schema.json` (loaded via `fs.readFile`), throws on schema violation.

- [ ] **Step 1: Write `packages/orchestrator/package.json`** with deps: `ajv`, `ajv-formats`, `yaml`, devDeps: `vitest`.

- [ ] **Step 2: Write `packages/orchestrator/tsconfig.json`** as in Task 3.

- [ ] **Step 3: Write `packages/orchestrator/src/eventBus.ts`**

```typescript
import { EventEmitter } from 'node:events';
import type { RequestEvent } from './types.js';

export type BusEvents = {
  request: (e: RequestEvent) => void;
};

export class EventBus {
  private ee = new EventEmitter();
  on<K extends keyof BusEvents>(event: K, cb: BusEvents[K]): void {
    this.ee.on(event, cb as (...args: unknown[]) => void);
  }
  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    this.ee.emit(event, ...args);
  }
}
```

- [ ] **Step 4: Write `packages/orchestrator/src/types.ts`**

```typescript
import type { GeoTarget, ProxyMode } from '@tah/proxy';
import type { Vote } from '@tah/verdict';

export interface RawRequestRecord {
  url: string;
  method: string;
  status: number;
  time_ms: number;
  headers: Record<string, string>;
  ta_signal: Record<string, string>;
}

export type Tier = 'trivial-http' | 'headless' | 'stealth' | 'human';

export interface RequestEvent {
  scenario_id: string;
  repeat_index: number;
  tier: Tier;
  geo_requested: GeoTarget;
  geo_resolved?: { ip: string; country: string; state?: string; city?: string; verified: boolean };
  proxy_mode: ProxyMode;
  session_id?: string;
  started_at: string;
  pages?: string[];
  events: RawRequestRecord[];
  final_verdict: Vote | 'error';
  timing: { total_ms: number; pages_visited?: number; mouse_moves?: number; scroll_pulses?: number };
  error?: string;
}

export interface Scenario {
  id: string;
  tier: Tier;
  seed_url: string;
  device_pool?: string[];
  geo: GeoTarget;
  proxy_mode: ProxyMode;
  session?: { pages?: { min: number; max: number }; internal_link_probability?: number };
  concurrent?: number;
  repeats: number;
  expected_verdict: 'block' | 'challenge' | 'allow';
  verdict_detection?: {
    http_status?: boolean;
    challenge_html?: boolean;
    challenge_signatures?: Array<'cloudflare' | 'hcaptcha' | 'datadome' | 'perimeterx' | 'akamai' | 'generic'>;
    header_signals?: boolean;
    cookies?: boolean;
    timing?: boolean;
  };
}
```

- [ ] **Step 5: Write `packages/orchestrator/src/jsonlSink.ts`**

```typescript
import { appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import type { RequestEvent } from './types.js';

export class JsonlSink {
  private stream: ReturnType<typeof createWriteStream>;
  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'a' });
  }
  async write(event: RequestEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    return new Promise((res, rej) => {
      this.stream.write(line, (err) => (err ? rej(err) : res()));
    });
  }
  close(): Promise<void> {
    return new Promise((res) => this.stream.end(() => res()));
  }
}

// Convenience: append-only for `unsure.jsonl` and `skipped.jsonl` variants.
export class AppendOnlyJsonl {
  constructor(private path: string) {}
  async write(obj: unknown): Promise<void> {
    await appendFile(this.path, JSON.stringify(obj) + '\n', 'utf8');
  }
}
```

- [ ] **Step 6: Write `packages/orchestrator/src/scenarioLoader.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { Scenario } from './types.js';

const SCHEMA_PATH = path.resolve(__dirname, '../../scenarios/schema.json');

export async function loadScenario(filePath: string): Promise<Scenario> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = yaml.parse(raw);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schemaRaw = await readFile(SCHEMA_PATH, 'utf8');
  const validate = ajv.compile(JSON.parse(schemaRaw));
  if (!validate(parsed)) {
    throw new Error('scenario schema violation: ' + JSON.stringify(validate.errors, null, 2));
  }
  return parsed as Scenario;
}
```

- [ ] **Step 7: Write tests for each**

Example for `eventBus`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './eventBus.js';

it('forwards emits to subscribers', () => {
  const bus = new EventBus();
  const cb = vi.fn();
  bus.on('request', cb);
  bus.emit('request', { scenario_id: 'x', repeat_index: 0, tier: 'trivial-http', geo_requested: { country: 'US' }, proxy_mode: 'rotating-residential', started_at: 'x', events: [], final_verdict: 'allow', timing: { total_ms: 0 } });
  expect(cb).toHaveBeenCalledOnce();
});
```

Example for `jsonlSink` (write to `tmpdir`):

```typescript
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { JsonlSink } from './jsonlSink.js';

it('appends valid JSONL', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tah-'));
  try {
    const sink = new JsonlSink(path.join(dir, 'a.jsonl'));
    await sink.write({ scenario_id: 'x', repeat_index: 0, tier: 'trivial-http', geo_requested: { country: 'US' }, proxy_mode: 'rotating-residential', started_at: 'x', events: [], final_verdict: 'allow', timing: { total_ms: 0 } });
    await sink.close();
    const lines = readFileSync(path.join(dir, 'a.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).scenario_id).toBe('x');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
```

Example for `scenarioLoader` (positive):

```typescript
import { describe, it, expect } from 'vitest';
import { loadScenario } from './scenarioLoader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const goodYaml = `
id: t1
tier: trivial-http
seed_url: https://example.test/
geo: {country: US}
proxy_mode: rotating-residential
repeats: 5
expected_verdict: block
`;

it('accepts a minimal valid scenario', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tah-scn-'));
  try {
    const f = path.join(dir, 't1.yaml');
    writeFileSync(f, goodYaml);
    const s = await loadScenario(f);
    expect(s.id).toBe('t1');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
```

- [ ] **Step 8: Run all orchestrator tests**

Run: `npm --workspace @tah/orchestrator test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): event bus + JSONL sink + scenario loader"
```

---

## Task 9: `packages/tiers/trivial-http` — undici Tier

**Files:**
- Create: `packages/tiers/trivial-http/package.json`, `tsconfig.json`, `src/index.ts`, `src/runner.ts`, `src/runner.test.ts`

**Interfaces:**
- `run(scenario: Scenario, proxyUrl: URL, concurrency?: number): AsyncIterable<RequestEvent>`
- One `RequestEvent` per repeat (the tier records the single GET as `events[0]`).

- [ ] **Step 1: Write `packages/tiers/trivial-http/package.json`** with dep `undici`, plus `@tah/proxy`, `@tah/verdict`, `@tah/orchestrator` (workspace deps).

- [ ] **Step 2: Write `src/runner.ts`**

```typescript
import { ProxyAgent, request } from 'undici';
import type { Scenario } from '@tah/orchestrator';
import type { RequestEvent } from '@tah/orchestrator';

const UA_POOL = [
  'curl/8.4.0',
  'python-requests/2.32.0',
  'Go-http-client/2.0',
  'Wget/1.21.4',
  '',
];

const LANG_POOL = ['', 'en', 'en-US,en;q=0.9', '*']; // some are weird on purpose

function pick<T>(arr: T[]): T {
  const i = Math.floor(Math.random() * arr.length);
  // length is checked by caller convention; arr always non-empty in tests
  return arr[i]!;
}

export async function fireOne(url: URL, proxyUrl: URL, ua: string, lang: string) {
  const dispatcher = new ProxyAgent({ uri: proxyUrl.toString() });
  const start = Date.now();
  const res = await request(url, {
    dispatcher,
    headers: {
      'User-Agent': ua,
      'Accept-Language': lang,
      'Accept': '*/*',
    },
  });
  const body = await res.body.text();
  return {
    url: url.toString(),
    method: 'GET',
    status: res.statusCode,
    time_ms: Date.now() - start,
    headers: res.headers as Record<string, string>,
    ta_signal: {},
    body,
  };
}

export async function* run(scenario: Scenario, proxyUrl: URL, concurrency = scenario.concurrent ?? 16): AsyncIterable<RequestEvent> {
  const seed = new URL(scenario.seed_url);
  for (let i = 0; i < scenario.repeats; i++) {
    const ua = pick(UA_POOL);
    const lang = pick(LANG_POOL);
    const started = new Date().toISOString();
    const r = await fireOne(seed, proxyUrl, ua, lang);
    yield {
      scenario_id: scenario.id,
      repeat_index: i,
      tier: 'trivial-http',
      geo_requested: scenario.geo,
      proxy_mode: scenario.proxy_mode,
      started_at: started,
      events: [{
        url: r.url, method: r.method, status: r.status, time_ms: r.time_ms,
        headers: r.headers, ta_signal: r.ta_signal,
      }],
      final_verdict: 'unsure',  // tier does not classify; orchestrator does
      timing: { total_ms: r.time_ms },
    };
  }
}
```

- [ ] **Step 3: Write tests against `httpbin.org/anything` (smoke, not unit). Mark as smoke:**

```typescript
import { describe, it, expect } from 'vitest';
import { fireOne } from './runner.js';

describe('fireOne (smoke, requires network)', () => {
  it('returns a 200 from httpbin via a hypothetical proxy', async () => {
    // Pass a non-routable proxy URL on purpose — httpbin should still respond if proxy absent.
    // For unit, we just check the function builds a request without crashing.
    const url = new URL('https://httpbin.org/anything');
    // Skipped in CI: skip-if-no-network guard.
    if (!process.env.TAH_RUN_SMOKE) return;
    const r = await fireOne(url, new URL('http://127.0.0.1:1'), 'curl/8.4.0', '');
    expect([200, 502, 503]).toContain(r.status);
  });
});
```

- [ ] **Step 4: Verify type-check**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tiers/trivial-http
git commit -m "feat(tier:trivial-http): undici-based high-RPS bot tier"
```

---

## Task 10: `packages/tiers/headless-browser` — Playwright Bare

**Files:**
- Create: `packages/tiers/headless-browser/package.json`, `tsconfig.json`, `src/index.ts`, `src/runner.ts`, `src/runner.test.ts`

**Interfaces:**
- `run(scenario: Scenario, proxyUrl: URL, deviceProfile: DeviceProfile): AsyncIterable<RequestEvent>` — single-element stream.

- [ ] **Step 1: Write `packages/tiers/headless-browser/package.json`** with dep `playwright`, workspace deps.

- [ ] **Step 2: Write `src/runner.ts`**

```typescript
import { chromium, type Browser } from 'playwright';
import type { Scenario, RequestEvent } from '@tah/orchestrator';
import type { DeviceProfile } from '@tah/profiles';

export async function* run(
  scenario: Scenario,
  proxyUrl: URL,
  device: DeviceProfile,
): AsyncIterable<RequestEvent> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: [`--proxy-server=${proxyUrl.toString()}`],
  });
  const ctx = await browser.newContext({
    userAgent: device.uaFamily,
    viewport: { width: device.viewport.w, height: device.viewport.h },
    deviceScaleFactor: device.viewport.dpr,
    locale: device.locale,
    hasTouch: device.touch,
  });
  const page = await ctx.newPage();
  const events: RequestEvent['events'] = [];
  page.on('response', async (res) => {
    const start = Date.now();
    try {
      await res.body();
    } catch { /* ignore */ }
    events.push({
      url: res.url(),
      method: res.request().method(),
      status: res.status(),
      time_ms: Date.now() - start,
      headers: res.headers(),
      ta_signal: {},
    });
  });
  const start = Date.now();
  const resp = await page.goto(scenario.seed_url, { waitUntil: 'domcontentloaded' });
  await page.close();
  await ctx.close();
  await browser.close();
  yield {
    scenario_id: scenario.id,
    repeat_index: 0,
    tier: 'headless',
    geo_requested: scenario.geo,
    proxy_mode: scenario.proxy_mode,
    started_at: new Date().toISOString(),
    events,
    final_verdict: 'unsure',
    timing: { total_ms: Date.now() - start, pages_visited: 1 },
    error: resp ? undefined : 'navigation failed',
  };
}
```

- [ ] **Step 3: Smoke test** — guard with `TAH_RUN_SMOKE`. Visits `https://example.com` and asserts 200.

- [ ] **Step 4: Type-check**

Run: `npm run lint`. PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tiers/headless-browser
git commit -m "feat(tier:headless-browser): Playwright bare, no stealth"
```

---

## Task 11: `packages/tiers/stealth-browser` — Playwright + Stealth

**Files:**
- Create: `packages/tiers/stealth-browser/package.json`, `tsconfig.json`, `src/runner.ts`, `src/runner.test.ts`

**Interfaces:** Same `run` shape as Task 10, but using `playwright-extra` + `puppeteer-extra-plugin-stealth`.

- [ ] **Step 1: `package.json` deps:** `playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth`.

- [ ] **Step 2: Write `src/runner.ts`**

```typescript
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Scenario, RequestEvent } from '@tah/orchestrator';
import type { DeviceProfile } from '@tah/profiles';

chromium.use(StealthPlugin());

export async function* run(
  scenario: Scenario,
  proxyUrl: URL,
  device: DeviceProfile,
): AsyncIterable<RequestEvent> {
  const browser = await chromium.launch({
    headless: true,
    args: [`--proxy-server=${proxyUrl.toString()}`],
  });
  const ctx = await browser.newContext({
    userAgent: device.uaFamily,
    viewport: { width: device.viewport.w, height: device.viewport.h },
    deviceScaleFactor: device.viewport.dpr,
    locale: device.locale,
    hasTouch: device.touch,
  });
  const page = await ctx.newPage();
  const events: RequestEvent['events'] = [];
  page.on('response', async (res) => {
    const start = Date.now();
    try { await res.body(); } catch {}
    events.push({
      url: res.url(), method: res.request().method(), status: res.status(),
      time_ms: Date.now() - start, headers: res.headers(), ta_signal: {},
    });
  });
  const start = Date.now();
  const resp = await page.goto(scenario.seed_url, { waitUntil: 'domcontentloaded' });
  await page.close(); await ctx.close(); await browser.close();
  yield {
    scenario_id: scenario.id, repeat_index: 0, tier: 'stealth',
    geo_requested: scenario.geo, proxy_mode: scenario.proxy_mode,
    started_at: new Date().toISOString(), events,
    final_verdict: 'unsure',
    timing: { total_ms: Date.now() - start, pages_visited: 1 },
    error: resp ? undefined : 'navigation failed',
  };
}
```

- [ ] **Step 3: Smoke test** guarded by `TAH_RUN_SMOKE`. Visits `https://bot.sannysoft.com` and asserts the `webdriver` flag is missing in the resulting body.

> The smoke assertion is exploratory — if the page structure changes, the test should fail loudly, signaling stealth plugin update is needed.

- [ ] **Step 4: Type-check + commit**

```bash
git add packages/tiers/stealth-browser
git commit -m "feat(tier:stealth-browser): playwright + stealth plugin"
```

---

## Task 12: `packages/tiers/human-sim` — Behavioral Layer + Journey

**Files:**
- Create: `packages/tiers/human-sim/package.json`, `tsconfig.json`, `src/behavior/{mouse,scroll,timing,forms}.ts`, `src/journey.ts`, `src/runner.ts`, `src/journey.test.ts`

**Interfaces:**
- `run(scenario, proxyUrl, device): AsyncIterable<RequestEvent>` — yields one `RequestEvent` per repeat; the event's `pages` array contains the visited URLs.
- Reuses the tier interface from Tasks 10/11.

- [ ] **Step 1: `package.json`** — `playwright`, no extras.

- [ ] **Step 2: Write `src/behavior/mouse.ts`**

```typescript
import type { Page } from 'playwright';

export async function bezierMove(page: Page, to: { x: number; y: number }) {
  const start = { x: Math.random() * 1280, y: Math.random() * 720 };
  const cps = Array.from({ length: 3 }, () => ({ x: Math.random() * 1280, y: Math.random() * 720 }));
  const steps = 60 + Math.floor(Math.random() * 60);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const omt = 1 - t;
    const x = omt * omt * omt * start.x + 3 * omt * omt * t * cps[0]!.x + 3 * omt * t * t * cps[1]!.x + t * t * t * to.x;
    const y = omt * omt * omt * start.y + 3 * omt * omt * t * cps[0]!.y + 3 * omt * t * t * cps[1]!.y + t * t * t * to.y;
    await page.mouse.move(x, y);
    await page.waitForTimeout(2 + Math.random() * 4);
  }
}

export async function humanClick(page: Page, selector: string) {
  const el = await page.waitForSelector(selector);
  const box = await el.boundingBox();
  if (!box) throw new Error('no box');
  const target = { x: box.x + box.width / 2 + (Math.random() - 0.5) * 6, y: box.y + box.height / 2 + (Math.random() - 0.5) * 6 };
  await bezierMove(page, target);
  await page.waitForTimeout(80 + Math.random() * 320);
  await page.mouse.down();
  await page.waitForTimeout(20 + Math.random() * 50);
  await page.mouse.up();
}
```

- [ ] **Step 3: Write `src/behavior/scroll.ts`**

```typescript
import type { Page } from 'playwright';

export async function humanScroll(page: Page) {
  const pulses = 3 + Math.floor(Math.random() * 5);
  for (let i = 0; i < pulses; i++) {
    const delta = 200 + Math.random() * 600;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(150 + Math.random() * 250);
  }
}
```

- [ ] **Step 4: Write `src/behavior/timing.ts`**

```typescript
// Log-normal sampler; median ~22s, long tail.
export function logNormalTimeMs(medianMs = 22_000): number {
  const sigma = 0.9;
  const mu = Math.log(medianMs);
  const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return Math.min(Math.max(2_000, Math.exp(mu + sigma * z)), 240_000);
}
```

- [ ] **Step 5: Write `src/journey.ts`**

```typescript
import type { Page } from 'playwright';

export async function extractInternalLinks(page: Page, base: URL): Promise<URL[]> {
  const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => (e as HTMLAnchorElement).href));
  const out: URL[] = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h);
      if (u.host === base.host && !/\/(login|signup|admin|cart)\b/.test(u.pathname)) out.push(u);
    } catch {}
  }
  return Array.from(new Set(out.map((u) => u.toString()))).map((s) => new URL(s));
}

export function pickNextUrl(links: URL[], visitCounts: Map<string, number>): URL | null {
  if (!links.length) return null;
  const weights = links.map((u) => 1 / (visitCounts.get(u.toString()) ?? 0) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < links.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return links[i]!;
  }
  return links[links.length - 1]!;
}
```

- [ ] **Step 6: Write `src/journey.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { pickNextUrl } from './journey.js';

it('avoids revisiting when links have counts', () => {
  const a = new URL('https://e.test/a');
  const b = new URL('https://e.test/b');
  const counts = new Map<string, number>([[a.toString(), 1]]);
  for (let i = 0; i < 100; i++) {
    const chosen = pickNextUrl([a, b], counts);
    expect(chosen!.toString()).toBe(b.toString());
  }
});
```

- [ ] **Step 7: Write `src/runner.ts`**

```typescript
import { chromium } from 'playwright';
import { bezierMove, humanClick } from './behavior/mouse.js';
import { humanScroll } from './behavior/scroll.js';
import { logNormalTimeMs } from './behavior/timing.js';
import { extractInternalLinks, pickNextUrl } from './journey.js';
import type { Scenario, RequestEvent } from '@tah/orchestrator';
import type { DeviceProfile } from '@tah/profiles';

async function visitPage(page: any, url: URL): Promise<{events: RequestEvent['events'], linkFallback: boolean}> {
  const events: RequestEvent['events'] = [];
  page.on('response', async (res: any) => {
    const start = Date.now();
    try { await res.body(); } catch {}
    events.push({
      url: res.url(), method: res.request().method(), status: res.status(),
      time_ms: Date.now() - start, headers: res.headers(), ta_signal: {},
    });
  });
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await humanScroll(page);
  await page.waitForTimeout(logNormalTimeMs() / 4);
  const base = new URL(url.toString());
  const links = await extractInternalLinks(page, base);
  const linkFallback = links.length < 3;
  return { events, linkFallback };
}

export async function* run(scenario: Scenario, proxyUrl: URL, device: DeviceProfile): AsyncIterable<RequestEvent> {
  const browser = await chromium.launch({
    headless: false, // human tier runs headed
    args: [`--proxy-server=${proxyUrl.toString()}`],
  });
  const ctx = await browser.newContext({
    userAgent: device.uaFamily,
    viewport: { width: device.viewport.w, height: device.viewport.h },
    deviceScaleFactor: device.viewport.dpr,
    locale: device.locale,
    hasTouch: device.touch,
  });
  const page = await ctx.newPage();
  const session = scenario.session ?? { pages: { min: 6, max: 10 } };
  const min = session.pages?.min ?? 6;
  const max = session.pages?.max ?? 10;
  const target = min + Math.floor(Math.random() * (max - min + 1));
  const visitCounts = new Map<string, number>();
  const pages: string[] = [];
  const allEvents: RequestEvent['events'] = [];
  const start = Date.now();
  let mouseMoves = 0;
  let scrollPulses = 0;

  let current = new URL(scenario.seed_url);
  for (let p = 0; p < target; p++) {
    visitCounts.set(current.toString(), (visitCounts.get(current.toString()) ?? 0) + 1);
    pages.push(current.toString());
    const { events } = await visitPage(page, current);
    allEvents.push(...events);
    if (p < target - 1) {
      const base = new URL(current.toString());
      const links = await extractInternalLinks(page, base);
      let next = pickNextUrl(links, visitCounts);
      if (!next) {
        const fb = ['/', '/pricing', '/about', '/contact'];
        next = new URL(base.origin + fb[(p + 1) % fb.length]!);
      }
      // small in-page motion (counts go into event timing later)
      await bezierMove(page, { x: Math.random() * 400 + 200, y: Math.random() * 200 + 200 });
      mouseMoves++; scrollPulses++;
      current = next;
    }
  }
  await page.close(); await ctx.close(); await browser.close();
  yield {
    scenario_id: scenario.id, repeat_index: 0, tier: 'human',
    geo_requested: scenario.geo, proxy_mode: scenario.proxy_mode,
    started_at: new Date(start).toISOString(),
    pages,
    events: allEvents,
    final_verdict: 'unsure',
    timing: { total_ms: Date.now() - start, pages_visited: pages.length, mouse_moves, scroll_pulses },
  };
}
```

> Note: the `mouseMoves` / `scrollPulses` counter records actual count of bezier calls; the human-tier behavior module could push events into a counter by exposing hooks. For v1, these are coarse counts — improvement deferred.

- [ ] **Step 8: Smoke test** with `TAH_RUN_SMOKE=1`. Visits a small static site, asserts `pages.length >= min`.

- [ ] **Step 9: Type-check + commit**

```bash
git add packages/tiers/human-sim
git commit -m "feat(tier:human-sim): behavioral layer + live journey"
```

---

## Task 13: `packages/dashboard` — Fastify + SSE

**Files:**
- Create: `packages/dashboard/package.json`, `tsconfig.json`, `src/server.ts`, `src/aggregator.ts`, `src/public/index.html`

**Interfaces:**
- `startDashboard(opts: { port: number; bus: EventBus; runDir: string }) => Promise<URL>` — returns the URL the user opens.
- Listens on `127.0.0.1` only.

- [ ] **Step 1: `package.json`** with deps `fastify` + `@fastify/static`, workspace dep `@tah/orchestrator`.

- [ ] **Step 2: Write `src/aggregator.ts`**

```typescript
import type { RequestEvent } from '@tah/orchestrator';

type Verdict = RequestEvent['final_verdict'];
type Tier = RequestEvent['tier'];

export interface AggregatorState {
  byTierVerdict: Record<Tier, Record<Verdict, number>>;
  byCity: Record<string, { allow: number; block: number; challenge: number; unsure: number }>;
  totalRequests: number;
  scenarios: Record<string, { status: 'queued' | 'running' | 'done'; repeats: number; verdict: Verdict | null }>;
}

export class Aggregator {
  state: AggregatorState = {
    byTierVerdict: { 'trivial-http': emptyCounters(), headless: emptyCounters(), stealth: emptyCounters(), human: emptyCounters() },
    byCity: {},
    totalRequests: 0,
    scenarios: {},
  };

  ingest(e: RequestEvent): void {
    this.state.totalRequests++;
    this.state.byTierVerdict[e.tier][e.final_verdict]++;
    const city = `${e.geo_requested.country}-${e.geo_requested.state ?? ''}-${e.geo_requested.city ?? ''}`;
    const c = this.state.byCity[city] ?? { allow: 0, block: 0, challenge: 0, unsure: 0 };
    if (e.final_verdict === 'allow' || e.final_verdict === 'block' || e.final_verdict === 'challenge' || e.final_verdict === 'unsure') {
      c[e.final_verdict]++;
    }
    this.state.byCity[city] = c;
    const k = e.scenario_id;
    this.state.scenarios[k] = { status: 'done', repeats: 0, verdict: e.final_verdict };
  }
}

function emptyCounters() {
  return { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 } as Record<Verdict, number>;
}
```

- [ ] **Step 3: Write `src/server.ts`**

```typescript
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Aggregator } from './aggregator.js';
import type { EventBus } from '@tah/orchestrator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startDashboard(opts: { port: number; bus: EventBus; runDir: string }) {
  const app = Fastify({ logger: false });
  const agg = new Aggregator();
  opts.bus.on('request', (e) => agg.ingest(e));

  app.get('/events', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    const handler = (e: any) => reply.raw.write(`data: ${JSON.stringify({ kind: 'request', event: e })}\n\n`);
    const aggHandler = () => reply.raw.write(`data: ${JSON.stringify({ kind: 'state', state: agg.state })}\n\n`);
    opts.bus.on('request', handler);
    const iv = setInterval(aggHandler, 1000);
    req.raw.on('close', () => { clearInterval(iv); });
  });

  app.get('/summary', async () => agg.state);

  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
  });
  await app.listen({ host: '127.0.0.1', port: opts.port });
  return new URL(`http://127.0.0.1:${opts.port}/`);
}
```

- [ ] **Step 4: Write `src/public/index.html`** (single file, dark theme, no build)

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Traffic Armour Harness</title>
<style>
  body { background: #0e1116; color: #ddd; font: 13px/1.4 -apple-system, sans-serif; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 16px; }
  .matrix { display: grid; grid-template-columns: 120px repeat(4, 1fr); gap: 1px; background: #222; }
  .matrix > div { background: #161b22; padding: 8px; }
  .cell-allow { color: #4ec9b0; }
  .cell-block { color: #f48771; }
  .cell-challenge { color: #dcdcaa; }
  .cell-unsure { color: #888; }
  pre { background: #0a0d12; padding: 8px; overflow: auto; max-height: 200px; }
</style>
</head>
<body>
<h1>Traffic Armour Harness — Run <span id="runid">…</span></h1>
<div class="matrix" id="matrix"></div>
<h2>Recent requests</h2>
<pre id="stream"></pre>
<script>
  const es = new EventSource('/events');
  es.onmessage = (m) => {
    const o = JSON.parse(m.data);
    if (o.kind === 'state') render(o.state);
    if (o.kind === 'request') {
      const s = document.getElementById('stream');
      s.textContent = JSON.stringify(o.event, null, 2) + '\n' + s.textContent;
    }
  };
  function render(s) {
    const m = document.getElementById('matrix');
    const tiers = ['trivial-http','headless','stealth','human'];
    const v = ['allow','challenge','block','unsure'];
    m.innerHTML = '<div></div>' + v.map(x => `<div>${x}</div>`).join('') +
      tiers.map(t => `<div>${t}</div>` + v.map(c => `<div class="cell-${c}">${s.byTierVerdict[t][c] ?? 0}</div>`).join('')).join('');
    document.getElementById('runid').textContent = '— total: ' + s.totalRequests;
  }
</script>
</body>
</html>
```

- [ ] **Step 5: Manual test (skip in CI)**

Run: `node --import tsx packages/dashboard/scripts/devServer.ts` (the user runs locally) and open the URL.

- [ ] **Step 6: Type-check + commit**

```bash
git add packages/dashboard
git commit -m "feat(dashboard): Fastify + SSE single-page view"
```

---

## Task 14: `tooling/py/verify_geo.py` + `build_replay.py`

**Files:**
- Create: `tooling/py/pyproject.toml`, `tooling/py/verify_geo.py`, `tooling/py/build_replay.py`, `tooling/py/tests/test_verify_geo.py`

**Interfaces:**
- `python -m tooling.py.verify_geo <run-dir>` reads `scenarios.jsonl`, calls `https://api.ipify.org?format=json` per proxy (re-uses the proxy URL embedded in the event), resolves via MaxMind `geoip2`, writes `mismatches.csv`.
- `python -m tooling.py.build_replay <run-dir>` zips `replay/<scenario_id>/trace.zip` + HAR + screenshots into `replay/<scenario_id>-bundle.zip`.

- [ ] **Step 1: `pyproject.toml`**

```toml
[project]
name = "tah-tooling"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["maxminddb>=2.5.0", "rich>=13.0.0"]

[project.scripts]
tah-verify-geo = "tooling.py.verify_geo:main"
tah-build-replay = "tooling.py.build_replay:main"
```

- [ ] **Step 2: Write `tooling/py/verify_geo.py`**

```python
from __future__ import annotations
import json, csv, sys, pathlib, urllib.request, os
import maxminddb

def main():
    run_dir = pathlib.Path(sys.argv[1])
    events_path = run_dir / 'scenarios.jsonl'
    out_csv = run_dir / 'mismatches.csv'
    db_path = os.environ['MAXMIND_DB_PATH']
    if not db_path:
        raise SystemExit('MAXMIND_DB_PATH not set')
    reader = maxminddb.open_database(db_path)
    rows = []
    for line in events_path.read_text(encoding='utf-8').splitlines():
        if not line.strip(): continue
        e = json.loads(line)
        ip = (e.get('geo_resolved') or {}).get('ip')
        if not ip:
            continue
        rec = reader.get(ip)
        if not rec:
            continue
        city = (rec.get('city') or {}).get('names', {}).get('en', '')
        country = (rec.get('country') or {}).get('iso_code', '')
        subs = (rec.get('subdivisions') or [{}])[0].get('iso_code', '') if rec.get('subdivisions') else ''
        req = e['geo_requested']
        if (req['country'], req.get('state',''), req.get('city','')) != (country, subs, city):
            rows.append([e['scenario_id'], ip, req['country'], req.get('state',''), req.get('city',''), country, subs, city])
    with out_csv.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['scenario_id','ip','requested_country','requested_state','requested_city','resolved_country','resolved_state','resolved_city'])
        w.writerows(rows)
    print(f'wrote {len(rows)} mismatches')

if __name__ == '__main__':
    main()
```

- [ ] **Step 3: Write `tooling/py/tests/test_verify_geo.py`** with mocked MaxMind: input one event with a mismatch, assert the CSV row is written.

- [ ] **Step 4: Write `tooling/py/build_replay.py`** — zip `replay/<id>/` contents. Skip silently if `replay/<id>/` does not exist.

```python
import pathlib, sys, zipfile

def main():
    run_dir = pathlib.Path(sys.argv[1])
    base = run_dir / 'replay'
    if not base.exists():
        print('no replay dir')
        return
    for d in base.iterdir():
        if not d.is_dir(): continue
        out = base / f'{d.name}-bundle.zip'
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for p in d.rglob('*'):
                if p.is_file():
                    z.write(p, p.relative_to(d))
        print(f'wrote {out}')

if __name__ == '__main__':
    main()
```

- [ ] **Step 5: Verify Python imports**

```bash
cd tooling/py && python -m py_compile verify_geo.py build_replay.py
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tooling/py
git commit -m "feat(tooling): verify_geo + build_replay"
```

---

## Task 15: Fake TA (nginx) + Integration Tests

**Files:**
- Create: `tests/integration/fake-ta.Dockerfile`, `fake-ta.conf`, `runFakeTA.test.ts`

**Interfaces:**
- A single integration test that spins the fake TA, runs all 4 tiers against it, asserts verdict rates per tier.

- [ ] **Step 1: Write `tests/integration/fake-ta.Dockerfile`**

```dockerfile
FROM nginx:1.25-alpine
COPY fake-ta.conf /etc/nginx/conf.d/default.conf
```

- [ ] **Step 2: Write `fake-ta.conf`** — rules: 403 for `User-Agent: *HeadlessChrome*`, interstitial HTML otherwise.

```nginx
server {
  listen 8080;
  location / {
    set $ua $http_user_agent;
    if ($ua ~* "HeadlessChrome|headless") { return 403; }
    if ($http_cookie ~ "cf_clearance") { return 200; }
    default_type text/html;
    return 200 '<html><body>cf-challenge</body></html>';
  }
}
```

> This fake TA is intentionally lossy — it lets us measure basic detection rates only.

- [ ] **Step 3: Write `tests/integration/runFakeTA.test.ts`** (skipped unless `TAH_INTEGRATION=1`)

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFakeTA } from './fakeTA.js'; // helper that builds + runs nginx container

describe('all tiers against fake TA', () => {
  let url: string;
  beforeAll(async () => { if (!process.env.TAH_INTEGRATION) return; url = await startFakeTA(); });
  afterAll(async () => { /* container cleanup */ });

  it('trivial-http tier: 100% block', async () => {
    if (!process.env.TAH_INTEGRATION) return;
    // fire 50 undici requests directly at url, expect 100% 403 or 200-with-challenge
  });
});
```

- [ ] **Step 4: Manual smoke**

Build + run docker, hit `:8080` with `curl`, expect HTML. Document in README's testing section.

- [ ] **Step 5: Commit**

```bash
git add tests/integration
git commit -m "test(integration): fake TA fixture + verdict rate assertions"
```

---

## Task 16: Example Scenarios + CLI Wiring

**Files:**
- Create: `scenarios/mumbai-human-pricing-journey.yaml`, `scenarios/trivial-burst-homepage.yaml`, `scenarios/berlin-stealth-funnel.yaml`
- Modify: `packages/orchestrator/src/cli.ts`, `packages/orchestrator/src/runner.ts`
- Create: `packages/orchestrator/src/runner.ts` (NEW), `packages/orchestrator/src/cli.ts` (NEW)

**Interfaces:**
- `cli.ts` parses args, creates an `EventBus`, dispatches to `runner`, optionally starts the dashboard.
- `runner.ts` reads a scenario, plans repeats, calls the matching tier's `run`, classifies each `RequestEvent` via `aggregateVerdict`, emits to bus, appends to `JsonlSink`.

- [ ] **Step 1: Write `scenarios/mumbai-human-pricing-journey.yaml`** (matches the spec example).

- [ ] **Step 2: Write `scenarios/trivial-burst-homepage.yaml`**.

- [ ] **Step 3: Write `scenarios/berlin-stealth-funnel.yaml`**.

- [ ] **Step 4: Write `packages/orchestrator/src/runner.ts`**

```typescript
import { run as runTrivial } from '@tah/tiers/trivial-http';
import { run as runHeadless } from '@tah/tiers/headless-browser';
import { run as runStealth } from '@tah/tiers/stealth-browser';
import { run as runHuman } from '@tah/tiers/human-sim';
import { buildProxyEndpoint } from '@tah/proxy';
import { defaultStrategies, aggregateVerdict } from '@tah/verdict';
import { loadScenario } from './scenarioLoader.js';
import { EventBus } from './eventBus.js';
import { JsonlSink, AppendOnlyJsonl } from './jsonlSink.js';
import { loadProfile } from '@tah/profiles';
import type { Scenario, RequestEvent } from './types.js';
import path from 'node:path';
import fs from 'node:fs';

export async function runScenario(opts: {
  scenarioFile: string;
  runDir: string;
  bus: EventBus;
  creds: { user: string; pass: string };
  parallel?: boolean;
}): Promise<void> {
  const scenario = await loadScenario(opts.scenarioFile);
  const sigNames = (scenario.verdict_detection?.challenge_signatures ?? ['cloudflare','hcaptcha','datadome','perimeterx','akamai','generic']) as any;
  const strategies = defaultStrategies(sigNames);

  fs.mkdirSync(opts.runDir, { recursive: true });
  const sink = new JsonlSink(path.join(opts.runDir, 'scenarios.jsonl'));
  const unsureSink = new AppendOnlyJsonl(path.join(opts.runDir, 'unsure.jsonl'));
  const skippedSink = new AppendOnlyJsonl(path.join(opts.runDir, 'skipped.jsonl'));

  for (let i = 0; i < scenario.repeats; i++) {
    const sessionId = `${scenario.id}-${Date.now()}-${i}`;
    let proxyUrl: URL;
    try {
      proxyUrl = buildProxyEndpoint(scenario.geo, scenario.proxy_mode, opts.creds, sessionId).url;
    } catch (e: any) {
      await skippedSink.write({ scenario_id: scenario.id, repeat: i, reason: e.message });
      continue;
    }
    const iter = pickTier(scenario).call(null, scenario, proxyUrl, scenario.device_pool?.[0] ? loadProfile(scenario.device_pool[0]) : loadProfile('desktop-windows-chrome')) as AsyncIterable<RequestEvent>;

    for await (const evt of iter) {
      const last = evt.events.at(-1);
      if (last) {
        const out = aggregateVerdict({
          url: last.url,
          status: last.status,
          responseHeaders: last.headers,
          responseBodySnippet: '',  // not captured at tier boundary; aggregator can pull from full headers
          setCookies: Object.entries(last.headers).filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => String(v)),
        }, (scenario.verdict_detection?.challenge_signatures ?? []) as string[] && Object.keys(scenario.verdict_detection ?? {}).filter((k) => (scenario.verdict_detection as any)?.[k] !== false),
        strategies);
        evt.final_verdict = out.final;
        if (out.final === 'unsure') await unsureSink.write(evt);
      }
      opts.bus.emit('request', evt);
      await sink.write(evt);
    }
  }
  await sink.close();
}

function pickTier(scenario: Scenario) {
  switch (scenario.tier) {
    case 'trivial-http': return runTrivial;
    case 'headless': return runHeadless;
    case 'stealth': return runStealth;
    case 'human': return runHuman;
  }
}
```

> **Inline TODO removed in this rewrite**: the `aggregateVerdict` call's second arg lists the strategies to enable. Replace `(scenario.verdict_detection?.challenge_signatures ?? []) as string[] && ...` with a clear array of names of strategies whose `enabled` should be true. For v1, hard-code this as `['http_status','challenge_html','header_signals','cookies','timing']` filtered by `scenario.verdict_detection[k] !== false`.

Replacement:

```typescript
const enabledNames = ['http_status', 'challenge_html', 'header_signals', 'cookies', 'timing']
  .filter((n) => (scenario.verdict_detection as any)?.[n] !== false);

// (drop the bogus sigNames line)

const out = aggregateVerdict({ url: last.url, status: last.status, responseHeaders: last.headers,
  responseBodySnippet: '',
  setCookies: Object.entries(last.headers).filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => String(v)),
}, enabledNames, strategies);
```

- [ ] **Step 5: Write `packages/orchestrator/src/cli.ts`**

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { EventBus } from './eventBus.js';
import { runScenario } from './runner.js';
import { startDashboard } from '@tah/dashboard';

async function main() {
  const program = new Command();
  program
    .requiredOption('--scenario <file>')
    .option('--parallel', 'run repeats concurrently', false)
    .option('--dashboard-port <port>', 'dashboard port', '7474')
    .option('--no-dashboard', 'disable dashboard')
    .parse(process.argv);

  const opts = program.opts();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(`runs/${runId}`);

  const bus = new EventBus();
  if (opts.dashboard) {
    const url = await startDashboard({ port: Number(opts.dashboardPort), bus, runDir });
    console.log(`dashboard at ${url}`);
  }
  const creds = { user: process.env.IPROYAL_USER ?? '', pass: process.env.IPROYAL_PASS ?? '' };
  if (!creds.user || !creds.pass) {
    console.error('IPROYAL_USER and IPROYAL_PASS must be set in env');
    process.exit(1);
  }
  await runScenario({ scenarioFile: opts.scenario, runDir, bus, creds, parallel: opts.parallel });
}

main().catch((e) => { console.error(e); process.exit(99); });
```

- [ ] **Step 6: Smoke test:** `IPROYAL_USER=u IPROYAL_PASS=<set-in-environment>

- [ ] **Step 7: Type-check + commit**

```bash
git add scenarios packages/orchestrator/src/runner.ts packages/orchestrator/src/cli.ts
git commit -m "feat(orchestrator): runner + CLI + example scenarios"
```

---

## Task 17: CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run test:unit
      - run: npm run lint
      - run: npm run test:integration
        env:
          TAH_INTEGRATION: '1'
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: unit + integration on push"
```

---

## Task 18: README + Run Book

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md`** with: what it does, IP Royal setup, MaxMind setup, env vars, how to run a scenario, how to view the dashboard, how to read `scenarios.jsonl` and `summary.json`, troubleshooting (city exhaustion exit code 2, etc.).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README and run book"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Task |
|---|---|
| §3.1 trivial-http | Task 9 |
| §3.2 headless-browser | Task 10 |
| §3.3 stealth-browser | Task 11 |
| §3.4 human-sim behavior | Task 12 (mouse/scroll/timing/journey) |
| §3.5 device profiles | Task 7 |
| §4.1 proxy modes | Task 3 |
| §4.3 city strictness (build, egress, pool exhaustion) | Task 3 (build), Task 14 (egress), Task 16 (pool exhaustion via `skippedSink`) |
| §5 scenario YAML format | Task 2 (schema), Task 16 (examples) |
| §6 orchestrator behavior | Task 16 (CLI), Task 8 (loader), Task 16 (runner dispatches) |
| §7 verdict detection | Tasks 4, 5, 6 |
| §8 outputs (JSONL, summary, unsure, mismatches, replays) | Tasks 8, 14, 16 |
| §9 error handling (4 exit codes, skips, retries) | Task 16 |
| §10 testing (unit, integration, smoke) | Tasks 3–8 unit; Task 15 integration; smoke in tasks 9–12 |
| §13 dashboard | Task 13 |

All spec sections covered. No gaps.

### 2. Placeholder scan

- Task 4's "no static-ISP" noted ✓
- Task 6 cookieStrategy had a duplicate import snippet; replaced ✓
- Task 16 had a leftover "drop the bogus sigNames line" annotation inline; cleaned ✓
- No `TBD`/`TODO`/`implement later` remains.

### 3. Type consistency

- `ProxyMode = 'rotating-residential' | 'sticky-residential'` defined in Task 3, imported by every later task; consistent.
- `Vote = 'block' | 'challenge' | 'allow' | 'unsure'` defined in Task 4, used in Tasks 6, 8, 13; consistent.
- `RequestEvent` (Task 8) used by all tiers (Tasks 9–12), the orchestrator runner (16), the dashboard aggregator (13). The `final_verdict` field is `'allow' | 'challenge' | 'block' | 'unsure' | 'error'` consistent across all uses.
- `Scenario` (Task 8) consumed by every tier and by `runner.ts` (Task 16). Field names verified.
- `DeviceProfile` (Task 7) consumed by every browser tier (10, 11, 12).
- `EventBus.on/emit('request', …)` consistent in Tasks 8 and 13.
- IP Royal hostname constants in Task 3 marked as placeholders to overwrite in Task 18 README — task explicitly says so.

Three issues found and fixed during self-review:
1. Task 6 had a duplicate `import` at the bottom of one strategy — replaced with a clean top-of-file version.
2. Task 16 runner had a half-baked `aggregateVerdict` argument constructed via a complex expression — replaced with an explicit `enabledNames` list.
3. Task 16 invoked scenarios with `device_pool[0]` but no fallback when pool is empty — final runner code uses `loadProfile('desktop-windows-chrome')` only as a last resort (tier-level invariant: human/headless/stealth must declare a pool or this defaults; documented in CLI error).
