# Traffic Armour Test Harness — Design

**Date:** 2026-08-17
**Status:** Draft — pending user approval

## 1. Purpose

A test harness that generates four tiers of synthetic traffic against reverse-proxy anti-bot (Traffic Armour) deployments, using IP Royal residential proxies with strict country + state + city targeting. The harness records each request's verdict so the user can measure Traffic Armour's accuracy: false positives on realistic human sessions, false negatives on bot tiers.

The user is building Traffic Armour itself and previously purchased traffic from a cheap vendor that turned out to be 100% bots. This harness replaces that vendor for self-testing.

## 2. Scope

In scope:

- Four traffic tiers (trivial HTTP, headless browser, stealth browser, realistic human).
- IP Royal rotating and sticky residential proxy modes with city-strict geo.
- Per-scenario multi-page journeys for human tier; live internal-link extraction at runtime.
- Generic verdict detection across the major reverse-proxy anti-bot vendors plus a generic category.
- Structured JSONL logs, replay bundles, summary statistics.
- Sequential default runner with `--parallel` opt-in.

Out of scope (v1):

- Production adversarial training pipelines.
- Static-ISP proxy mode (sticky-residential covers the same use cases).
- Distributed runs across machines.

## 3. Traffic Tiers

### 3.1 trivial-http (Tier 1)

Pure HTTP client (`undici` — bundled with Node 18+, ~3x faster than `axios` for high-concurrency workloads). No JavaScript execution. Randomized User-Agent per request, randomized skip-pattern headers. The job of this tier is to look obviously wrong to any reasonable detection: missing `Accept-Language`, suspicious ordering, no cookies, sometimes wrong protocol versions. Concurrency is set per scenario via `concurrent` (default 16).

Drives the false-negative floor — Traffic Armour MUST block this almost always.

### 3.2 headless-browser (Tier 2)

Playwright launched with no stealth. `--headless=new`, default Chromium. Real User-Agent string for the device profile (otherwise the trivial-http tier). No fingerprint evasions.

Drives the second false-negative floor — modern TAs can detect headless mode via `navigator.webdriver`, missing plugins, missing languages, headless-specific rendering anomalies.

### 3.3 stealth-browser (Tier 3)

Playwright + `playwright-extra` + stealth plugin (canvas noise, navigator override, plugins, languages, webdriver flag). Real device profile UA. Residential IP via sticky proxy.

Drives the harder problem — TA needs fingerprinting and behavioral analysis to catch this, not just signature.

### 3.4 human-sim (Tier 4)

Headed (`--headless=false`), real device profiles, residential IP via sticky session. Fully behavioral sequence per page:

- Bezier-curve mouse trajectories with overshoot + correction, ~150–600ms movement.
- Hover before click, 80–400ms.
- Scroll pattern: 3–7 pulses, 30–85% of page height, 150–400ms each.
- Per-locale log-normal `time_on_page_ms` (median ~22s, long tail).
- Click via `page.mouse.down/up`, never `element.click()`.
- Inline link bias — small chance of clicking a related link rather than the primary CTA.

Journey: `pages: {min: 8, max: 12}` per session. Each session:

1. Hits the seed URL.
2. Parses the rendered DOM, extracts same-origin internal `<a href>`s (excluding auth/global-nav).
3. Picks next URL with weighted probability `1 / (visit_count + 1)` + recency penalty.
4. Repeats until page count reached.
5. Small chance of `tab.close()` after `pagehide`.

If fewer than 3 internal links are extractable from a page, falls back to common URLs with a `link_fallback: true` flag on the JSONL line.

### 3.5 Device profiles

Per-scenario `device_pool` declares which device profiles the runner may pick for that scenario. Each session repeat randomly picks one profile from the pool, except where the user pins one explicitly.

Default device profile set, in `packages/profiles/devices.json`:

| Id | UA family | Viewport | Touch | Hardware |
|---|---|---|---|---|
| `desktop-windows-chrome` | Win NT 10.0; Chrome | 1920×1080 | no | 8 cores, 16GB |
| `desktop-mac-safari` | Mac OS X; Safari | 2560×1440 | no | 10 cores, 16GB |
| `iphone-15-safari` | iPhone OS 17 | 390×844 @3x | yes | 6 cores |
| `android-pixel-chrome` | Android 14; Chrome | 412×915 @2.6x | yes | 8 cores |
| `ipad-safari` | iPad OS 17 | 1024×1366 @2x | yes | 8 cores |

Adding a new device is one entry in the JSON; no code change.

### 3.6 What the user said about the human tier (locked)

> "after traffic hit to the site a crawler or bot completely with human nature and completely from a different kind of device whether is mobile or desktop or tabs or android or iphone move to the site and select and clicks many places as humans do exact behaviour and moves to other pages also like if have 10 pages stay there to reduce the bounce rate"

Translation: device pool is per-scenario, URLs are extracted live (not fixed), behavior is variable per session.

## 4. IP Royal Integration

### 4.1 Proxy modes supported

| Mode | Hostname | Username suffix | Sticky? | Used by |
|---|---|---|---|---|
| `rotating-residential` | rotating residential gateway | `user-country-<CC>-state-<ST>-city-<City>` | no | trivial-http |
| `sticky-residential` | session residential gateway | `user-…-sessionid-<id>` | yes — same IP per sessionid | headless, stealth, human |

Static-ISP mode is out of scope for v1.

### 4.2 Proxy abstraction (`packages/proxy`)

```typescript
export type GeoTarget = { country: string; state?: string; city?: string };
export type ProxyMode = 'rotating-residential' | 'sticky-residential';

export interface ProxyEndpoint {
  url: URL;
  mode: ProxyMode;
  sessionId?: string;
}

export function buildProxyEndpoint(
  geo: GeoTarget,
  mode: ProxyMode,
  creds: { user: string; pass: string },
  sessionId?: string
): ProxyEndpoint;
```

Hostname constants and the username-suffix grammar live in this package. Other packages receive fully-built URLs and never know the grammar.

### 4.3 City-strictness enforcement

Three checkpoints, all loud:

1. **Build time** — `buildProxyEndpoint` validates the constructed proxy URL against the documented IP Royal regex. Invalid → throws `InvalidProxyGeoError`, scenario is skipped.
2. **Egress verification (post-request)** — `verify_geo.py` calls `https://api.ipify.org` through the same proxy and resolves the egress IP via MaxMind `geoip2`. Mismatch → row in `mismatches.csv`, no retry.
3. **Pool exhaustion** — three egress mismatches in a row for the same city aborts the run with `TAH-E001` and exit code 2.

## 5. Scenario Format

YAML files in `scenarios/`. Validated against JSON Schema at load time. Bad YAML fails the run before any traffic fires (exit code 1).

```yaml
# scenarios/mumbai-human-pricing-journey.yaml
id: mumbai-human-pricing-journey
tier: human                          # trivial-http | headless | stealth | human
seed_url: https://example.test/
device_pool: [iphone-15-safari, android-pixel-chrome]
geo:
  country: IN
  state: MH
  city: Mumbai
proxy_mode: sticky-residential
session:
  pages: {min: 8, max: 12}
  internal_link_probability: 0.85
expected_verdict: allow               # block | challenge | allow (test oracle)
repeats: 3
verdict_detection:
  http_status: true
  challenge_html: true
  challenge_signatures: [cloudflare, hcaptcha, datadome, perimeterx, akamai, generic]
  header_signals: true
  cookies: true
  timing: false
```

Non-human tiers omit `device_pool` and `session`:

```yaml
# scenarios/trivial-burst-homepage.yaml
id: trivial-burst-homepage
tier: trivial-http
seed_url: https://example.test/
geo: {country: US, state: CA, city: "Los Angeles"}
proxy_mode: rotating-residential
repeats: 200
concurrent: 16
expected_verdict: block
```

## 6. Orchestrator Behavior

CLI entry: `npm run run -- --scenario scenarios/<file> --parallel false`.

1. Validate the scenario file against the schema.
2. Plan N repeats. Sequential default; `--parallel` allows concurrent scenario repeats with a configurable `--concurrency` cap.
3. For each repeat, pick a device profile from `device_pool` (or pass through if pinned).
4. Launch the right tier with the right proxy URL and device profile.
5. Stream per-page `RequestEvent`s from the tier into the JSONL sink and the live dashboard (see §13).
6. After each session: kick off egress-IP verification for the session's proxy.
7. After the full run: invoke `tooling/py/build_replay.py` for replay bundles (human tier only).

Per-tier execution detail:

- **trivial-http:** launch N concurrent `undici` requests in-process, no browser. Record raw events with timing.
- **headless / stealth / human:** launch Playwright per repeat (or per `--parallel` repeat group), pass proxy + UA + viewport, drive the journey with Playwright's mouse + keyboard APIs, capture `Response` objects on every navigation.

## 7. Verdict Detection

### 7.1 Strategy interface

```typescript
export type Vote = 'block' | 'challenge' | 'allow' | 'unsure';

export interface VerdictInput {
  url: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBodySnippet: string;        // first 64KB
  challengeRedirectedTo?: URL;
  setCookies: string[];
}

export interface VerdictStrategy {
  name: string;
  enabled: boolean;
  vote(input: VerdictInput): Vote | null;
}

export function aggregateVerdict(
  input: VerdictInput,
  enabled: string[]
): { final: Vote; byStrategy: Record<string, Vote>; reason: string };
```

Precedence: `block > challenge > allow > unsure`. Any single `block` wins.

### 7.2 Default strategies (all on by default)

- `httpStatusStrategy` — 403/503/502/blank-200 → `block`.
- `challengeHtmlStrategy` — body regex matches one of the configured signatures → `challenge`.
- `headerSignalsStrategy` — server-side fingerprint headers (cf-ray, x-datadome, etc.) → `challenge` if any.
- `cookieStrategy` — known challenge cookies (cf_clearance, _px3, _abck, datadome, akamai-rum) → `challenge`.
- `timingStrategy` — response < 100ms → `unsure` (not a vote; signal only).

### 7.3 Default signature set (all on by default)

```typescript
export const DEFAULT_SIGNATURES = {
  cloudflare: {
    headers: ['cf-ray', 'cf-cache-status', 'server:cloudflare'],
    cookies: ['cf_clearance', '__cf_bm'],
    body: ['cf-chl-bypass', 'cf-challenge', '/cdn-cgi/challenge-platform/'],
  },
  hcaptcha: {
    body: ['h-captcha', 'hcaptcha.com'],
  },
  datadome: {
    headers: ['x-datadome', 'server:datadome'],
    cookies: ['datadome'],
    body: ['datadome', 'geo.captcha-delivery.com'],
  },
  perimeterx: {
    headers: ['x-px', 'x-perimeterx'],
    cookies: ['_px3', '_pxde', '_pxvid'],
    body: ['px-captcha', 'client.perimeterx.net'],
  },
  akamai: {
    headers: ['x-akamai', 'x-true-client-ip', 'akamai-grn-'],
    cookies: ['_abck', 'akamai-rum'],
    body: ['akamai bot manager'],
  },
  generic: {
    headers: ['x-blocked', 'x-served-by'],
    body: ['access denied', 'forbidden', 'rate limit'],
  },
};
```

### 7.4 Unsure verdicts

`unsure` rows do NOT halt the run. They are written to `runs/<ts>/unsure.jsonl` and aggregated in `summary.json`. The user gets a separate report so they can refine signatures without blocking tests.

## 8. Outputs

```
runs/<timestamp>/
  scenarios.jsonl         # all events, full per-request data
  summary.json            # verdict confusion matrix, latency stats
  skipped.jsonl           # scenarios skipped (invalid geo, etc.)
  unsure.jsonl            # requests where verdict was unsure
  mismatches.csv          # egress IP didn't match requested city
  replay/<scenario_id>/   # playwright trace + HAR + screenshots (human tier only)
```

Per-request shape:

```json
{
  "scenario_id": "mumbai-human-pricing-journey",
  "repeat_index": 0,
  "device_profile": "iphone-15-safari",
  "tier": "human",
  "geo_requested": {"country": "IN", "state": "MH", "city": "Mumbai"},
  "geo_resolved": {"ip": "203.0.113.42", "country": "IN", "state": "MH", "city": "Mumbai", "verified": true},
  "proxy_mode": "sticky-residential",
  "session_id": "session-2026-08-17-...-0",
  "started_at": "2026-08-17T...",
  "pages": ["https://...", "https://...", "..."],
  "events": [
    {"url": "...", "method": "GET", "status": 200, "time_ms": 412, "headers": {...}, "ta_signal": {...}}
  ],
  "final_verdict": "allow",
  "timing": {"total_ms": 184000, "pages_visited": 10, "mouse_moves": 2483, "scroll_pulses": 47}
}
```

## 9. Error Handling

| Failure | Behavior | Exit |
|---|---|---|
| Invalid scenario YAML | abort before traffic | 1 |
| Invalid IP Royal geo suffix | skip scenario, log to `skipped.jsonl` | — |
| City pool exhausted (3 mismatches in a row) | abort run | 2 |
| Single request error | retry once, then log `error` field | — |
| Browser launch failure | skip that repeat | — |
| Egress IP resolves to wrong city | log to `mismatches.csv`, request counted | — |
| `unsure` verdict | log to `unsure.jsonl`, run continues | — |
| JSONL write fails (disk full etc.) | hard stop, partial file preserved | 4 |

## 10. Testing

### Unit (`tests/unit/`)
- proxy: username-suffix regex coverage for all combinations.
- verdict: each strategy has fixture responses (block / challenge / allow / edge cases); aggregator precedence is tested.

### Integration (`tests/integration/`)
- Spin up `nginx` in Docker as a fake TA: 403 for `User-Agent: *HeadlessChrome*`, interstitial HTML for `cf-clearance`-missing, otherwise 200.
- trivial-http tier → expect ~100% block.
- headless tier → expect ~100% block.
- stealth tier with evasions on → expect 30–80% block.
- human tier → expect ~0% block.

### Smoke (`tests/smoke/`)
- One scenario per tier against `httpbin.org/anything`. Verifies egress IP is residential, JSONL lines are schema-valid. Opt-in due to IP Royal bandwidth cost.

CI runs unit + integration on every PR. Smoke is opt-in.

## 11. Repo Layout

```
traffic-armour-harness/
├── README.md
├── package.json                       # workspaces
├── tsconfig.base.json
├── .github/workflows/ci.yml
├── .env.example                       # IPROYAL_USER, IPROYAL_PASS, MAXMIND_DB_PATH
├── scenarios/
├── packages/
│   ├── proxy/                         # IP Royal URL grammar
│   ├── verdict/                       # strategies + aggregator + signatures
│   ├── orchestrator/                  # CLI, scenario runner, JSONL sink
│   ├── tiers/
│   │   ├── trivial-http/              # HTTP client
│   │   ├── headless-browser/          # Playwright bare
│   │   ├── stealth-browser/           # Playwright + stealth
│   │   └── human-sim/                 # Playwright + behavioral layer
│   ├── dashboard/                     # local web UI (Fastify + SSE)
│   └── profiles/
│       └── devices.json
├── tooling/
│   └── py/
│       ├── verify_geo.py
│       ├── build_replay.py
│       └── pyproject.toml
├── runs/                              # gitignored
├── tests/
│   ├── unit/
│   ├── integration/
│   └── smoke/
└── docs/superpowers/specs/
```

## 12. Decisions Locked In

- City-strict geo. Fail loud on missing egress IP, not silent fallback.
- All verdict signatures on by default (user tests across multiple TAs).
- `unsure` rows surfaced in separate report, do not halt the run.
- Sequential default, `--parallel` flag for concurrent scenario execution.
- `repeats` is per-scenario, edit manually in YAML.
- Device pool per scenario, URLs extracted live (not fixed).
- Human tier behavior is variable per session — nothing is fixed.
- Drop Go for v1; Node + TS handles trivial-http at the volume needed.
- Drop static-ISP for v1; sticky-residential covers the use case.
- Python retained in `tooling/py/` only — post-run helpers, not in hot path.
- Speed and low latency prioritized over stack diversity.
- Live local dashboard (Fastify + SSE), `http://localhost:7474`, `--no-dashboard` to disable.

## 13. Live Dashboard

A local web dashboard runs alongside the orchestrator. The user opens it in a browser to watch traffic in real time and judge Traffic Armour's verdict distribution as scenarios complete.

### 13.1 Architecture

The dashboard is a tiny Node web server (Fastify) inside the same process as the orchestrator. It subscribes to the same event stream that feeds `scenarios.jsonl` and renders an HTML page with auto-refresh via Server-Sent Events (SSE). No separate backend; no SPA build step.

```
orchestrator
  ├── JSONL sink  ──► runs/<ts>/scenarios.jsonl
  └── event bus   ──► dashboard (SSE)
                       └── GET  /             HTML page
                           /events        SSE stream
                           /summary       latest summary.json
                           /unsure        latest unsure.jsonl
                           /mismatches    latest mismatches.csv
                           /replays       lists replay bundles
                           /replay/:id    serves a single replay bundle
```

Dashboard server port: `http://localhost:<port>` where port defaults to `7474` and is configurable via `--dashboard-port`. Disabled by adding `--no-dashboard`.

### 13.2 What the page shows

A single HTML page, dark-themed, no framework. Six regions:

1. **Header bar** — run id, elapsed time, total requests fired, completed requests.
2. **Tier × verdict matrix** (live-counting) — `tier ∈ {trivial, headless, stealth, human}` × `verdict ∈ {allow, challenge, block, unsure}`. Each cell shows count + percent of that tier. Cell color: green/amber/red/grey. Stale cells update every ~1s via SSE.
3. **Geo breakdown** — top-N cities for the current run, by requests fired, with a small bar showing allow/block ratio per city. Reveals whether a city "looks fine" by IP Royal but TA blocks it anyway.
4. **Per-scenario list** — table of scenarios with status (queued / running / done), repeat counts, last verdict, link to replay bundle if human.
5. **Recent requests stream** — last 50 events, newest first. Each row: timestamp, scenario id, tier, URL, status, time_ms, final verdict, geo resolved. Click to expand raw `ta_signal` headers/cookies.
6. **Unsure / mismatch panels** — collapsible at the bottom. Surfaces `unsure.jsonl` and `mismatches.csv` lines live as they appear.

### 13.3 What the dashboard is NOT

- Not multi-user — listens on `127.0.0.1` only.
- Not persistent across runs — opens with the current run, dies with the orchestrator process.
- Not a replay viewer — clicking a replay just opens the existing Playwright trace viewer separately. The dashboard points to it.
- Not a config editor — scenarios are edited on disk, not via the dashboard.

### 13.4 Why SSE, not WebSocket

SSE is one-way (server→browser), unidirectional, works over plain HTTP/1.1, and Fastify has first-class support. The dashboard reads from the orchestrator, never writes back. WS would be overkill and adds reconnection complexity.

### 13.5 Updates to other sections

- **Repo Layout** (§11): add `packages/dashboard/` with `server.ts`, `index.html`, no build step.
- **Outputs** (§8): the dashboard reads from the same files but is not in `runs/<ts>/`.
- **Testing** (§10): integration tests assert the dashboard serves `/events` and pushes a message when a fake tier fires a `RequestEvent`.
