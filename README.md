# Traffic Armour Test Harness

A Node + TypeScript operator-facing run book for the Traffic Armour test harness. The
harness is a four-tier bot-traffic generator (`trivial-http`, `headless`,
`stealth`, `human`) that drives synthetic traffic at a reverse-proxy
anti-bot (Traffic Armour) deployment through IP Royal residential proxies,
classifies each response with pluggable verdict strategies, and writes
JSONL artifacts to `runs/<timestamp>/` for offline analysis. A live
local dashboard at `http://localhost:7474` mirrors the run in real time.

This README is the **operator run book**: install, configure credentials,
run a scenario, read the outputs, troubleshoot. The full architectural
spec lives in
[`docs/superpowers/specs/2026-08-17-traffic-armour-harness-design.md`](docs/superpowers/specs/2026-08-17-traffic-armour-harness-design.md).

---

## 1. Requirements

- **Node.js 20+** (see `engines` in [`package.json`](package.json)).
- **IP Royal residential proxy account** — username and password.
- **MaxMind GeoLite2-City `.mmdb`** — used by the post-run geo-verification
  tool. Optional for the orchestrator itself; required if you want to
  audit egress IP vs requested city.
- **Local network access** to the target Traffic Armour deployment.

`npm install` (run at the repo root) resolves all workspace packages
declared under `packages/*` and `packages/*/*`.

---

## 2. Configuration

Copy `.env.example` to `.env` and fill in the three values:

```ini
# .env (repo root)
IPROYAL_USER=<your-iproyal-username>
IPROYAL_PASS=<your-iproyal-password>
MAXMIND_DB_PATH=./GeoLite2-City.mmdb
```

| Var | Required? | Used by | Notes |
|---|---|---|---|
| `IPROYAL_USER` | yes (any tier) | `packages/orchestrator/src/cli.ts` | The CLI exits 1 if either `IPROYAL_USER` or `IPROYAL_PASS` is empty. `IPROYAL_USER` is reserved for future per-user routing and is **not** currently embedded in the proxy username (see `buildProxyEndpoint` in `packages/proxy/src/index.ts`). |
| `IPROYAL_PASS` | yes (any tier) | `packages/proxy/src/index.ts` (`buildProxyEndpoint`) | Embedded in the proxy URL as `url.password`. |
| `IPROYAL_HOSTNAME` | no | `packages/proxy/src/grammar.ts` | Defaults to `geo.iproyal.com`. Override only if your IP Royal account points at a regional gateway. |
| `MAXMIND_DB_PATH` | yes (for `verify_geo.py`) | `tooling/py/verify_geo.py` | Path to a local `GeoLite2-City.mmdb`. The orchestrator does not read this — only the post-run Python tool does. |
| `TAH_INTEGRATION` | no | `tests/integration/runFakeTA.test.ts` | Set to `1` to enable the Docker-gated integration suite. |

The orchestrator CLI does **not** auto-load `.env`. Either source it
before invoking (`set -a; source .env; set +a` in bash,
`Get-Content .env | ForEach-Object { ... }` in PowerShell) or export
the variables in your shell.

### 2.1 MaxMind setup

1. Create a free MaxMind account at <https://www.maxmind.com/en/geolite2/signup>.
2. In the account portal, generate a license key.
3. Download `GeoLite2-City.mmdb` (the binary format, not the CSV).
4. Place it at the path in `MAXMIND_DB_PATH` (default `./GeoLite2-City.mmdb`
   relative to the repo root).

### 2.2 IP Royal credential shape

`buildProxyEndpoint` constructs the proxy username as a series of
`-`-joined segments:

```
user-country-<CC>(-state-<State>)?(-city-<City>)?(-sessionid-<Id>)?
```

The CLI builds this from each scenario's `geo:` block plus a
per-repeat session id (sticky sessions only). The grammar is enforced
by `IPROYAL_USERNAME_REGEX` in
[`packages/proxy/src/grammar.ts`](packages/proxy/src/grammar.ts):
- `country` must be a 2-letter ISO code (`[A-Z]{2}`).
- `state` and `city` may contain letters and spaces (spaces become `-`).
- `sessionid` must be alphanumeric only (no hyphens).
- An invalid username throws `InvalidProxyGeoError`; the runner
  records the repeat in `skipped.jsonl` and continues.

Hostname: `geo.iproyal.com`, port `12321` (defined as
`HOSTNAMES[mode]` and `PROXY_PORT` in
[`packages/proxy/src/grammar.ts`](packages/proxy/src/grammar.ts)).
Both `rotating-residential` and `sticky-residential` modes use the
same host/port — the difference is the session-id segment in the
username, which makes IP Royal pin a sticky session for the lifetime
of the connection.

---

## 3. Run commands

The orchestrator ships as the workspace CLI `tah`. From the repo root:

```bash
# Build the workspaces once (tsc -b on all packages).
npm run build

# Run the trivial-http scenario in this repo. The dashboard binds to
# http://localhost:7474/ by default; the run directory is runs/<ISO-ts>/
# at the repo root.
npm run run -- --scenario scenarios/trivial-burst-homepage.yaml

# Run the human-sim journey (sticky residential, Mumbai, 3 repeats).
npm run run -- --scenario scenarios/mumbai-human-pricing-journey.yaml

# Run the stealth-browser scenario (Berlin, expect a challenge verdict).
npm run run -- --scenario scenarios/berlin-stealth-funnel.yaml

# Fan all repeats out concurrently instead of running sequentially.
npm run run -- --scenario scenarios/mumbai-human-pricing-journey.yaml --parallel

# Move the dashboard to a different port (default 7474) — useful when
# something else is already bound there.
npm run run -- --scenario scenarios/mumbai-human-pricing-journey.yaml --dashboard-port 7600

# Run without the dashboard (headless / CI use).
npm run run -- --scenario scenarios/trivial-burst-homepage.yaml --no-dashboard
```

CLI definition: [`packages/orchestrator/src/cli.ts`](packages/orchestrator/src/cli.ts).
`commander` parses `--scenario` (required), `--parallel` (boolean,
default `false`), `--dashboard-port` (string, default `7474`),
`--no-dashboard` (boolean, default `true`).

`npm run run` is the alias defined in
[`packages/orchestrator/package.json`](packages/orchestrator/package.json)
(`scripts.run: "node dist/cli.js"`); it executes the compiled CLI in
`packages/orchestrator/dist/cli.js`.

### 3.1 Run lifecycle

1. `cli.ts` parses argv and computes a run id (the current ISO
   timestamp with `:` and `.` replaced by `-`, so the directory name
   is filesystem-safe).
2. The CLI checks that `IPROYAL_USER` and `IPROYAL_PASS` are set; if
   not, it logs the error and exits 1 **before** binding the
   dashboard port. (See `cli.ts` for the rationale — re-ordering
   avoids an `EADDRINUSE` retry window if creds are missing.)
3. If the dashboard is enabled, `startDashboard` (Fastify + SSE in
   [`packages/dashboard/src/server.ts`](packages/dashboard/src/server.ts))
   binds `127.0.0.1:<port>` and subscribes to the event bus.
4. `runScenario` (in
   [`packages/orchestrator/src/runner.ts`](packages/orchestrator/src/runner.ts))
   loads the YAML, validates it against
   [`scenarios/schema.json`](scenarios/schema.json), opens a JSONL sink
   under `runs/<ts>/`, picks the tier, and runs each repeat.
5. Each request event flows: tier runner -> `aggregateVerdict` (in
   [`packages/verdict/src/aggregate.ts`](packages/verdict/src/aggregate.ts))
   -> optional sub-100ms `unsure` override -> event bus (dashboard
   live feed) -> `runs/<ts>/scenarios.jsonl`.

### 3.2 Tier-specific notes

- **`trivial-http`** — undici + `ProxyAgent` (`packages/tiers/trivial-http/src/runner.ts`).
  High-RPS, no browser, user-agent picked at random from
  `UA_POOL` (curl / python-requests / Go / Wget / empty).
- **`headless`** — Playwright bare launch, no stealth. Verifies the
  test site reacts to a headless signature.
- **`stealth`** — Playwright + `puppeteer-extra-plugin-stealth`. Strips
  `navigator.webdriver`, fakes a real Chrome runtime.
- **`human`** — Playwright + behavioral layer
  (`packages/tiers/human-sim/src/behavior/`): mouse movement, scroll
  pulses, inter-action timing, multi-page journey driven by
  `internal_link_probability`. Requires `session.pages` and a
  `device_pool` in the scenario (enforced by the JSON schema's
  `allOf`).

`device_pool` is consumed by `loadProfile` (in
[`packages/profiles/src/loader.ts`](packages/profiles/src/loader.ts))
which reads `packages/profiles/src/devices.json`. Five built-in
profiles: `desktop-windows-chrome`, `desktop-mac-safari`,
`iphone-15-safari`, `android-pixel-chrome`, `ipad-safari`.

---

## Per-navigation fingerprint rotation

All three browser tiers (headless, stealth, human) rotate the full fingerprint
bundle on every navigation: User-Agent, locale, languages, viewport, hardware
concurrency + memory, WebGL vendor + renderer, and IANA timezone.

The User-Agent is synthesized from one of 25 templates across 5 device families,
varying only the build patch (e.g. `Chrome/124.0.0.0` → `Chrome/124.5.32.99`).
This produces millions of unique fingerprint combinations while keeping each
combination internally consistent (an iPhone UA cannot claim a Windows WebGL
renderer).

The timezone is resolved in three layers per session:

1. **Egress-IP lookup** via `geoip2-lite` (bundled MMDB lookup, in-process)
2. **Scenario geo lookup** against a 2000-entry static city→IANA map
3. **Locale fallback** (`en-US` → `America/New_York` etc.)

Egress-IP lookup is one-shot per session (cached). To skip IP rotation,
delete `.env`'s `MAXMIND_DB_PATH` or any pre-warmed proxy session.

Internally:

- `@tah/ua` owns all UA strings and templates
- `@tah/tz` owns all IANA timezone strings and IP→city resolution
- Browser tiers consume fully-built fingerprint bundles; they never see UA grammar

Each navigation opens a fresh Playwright context so HTTP `User-Agent`,
JS-readable `navigator.userAgent`, and `Intl.DateTimeFormat().resolvedOptions().timeZone`
all stay consistent.

---

## 4. Outputs

Every run writes to a fresh `runs/<ISO-timestamp>/` directory (the
`runs/` tree is gitignored). Files:

| File | What it is | When it appears |
|---|---|---|
| `scenarios.jsonl` | One JSON object per line, one per request event. The canonical record of the run. | Always. Streamed line-by-line as the run progresses. |
| `unsure.jsonl` | Events whose final verdict was overridden to `unsure` by the sub-100ms timing override. | When a request returned in <100ms **and** the verdict aggregator otherwise said `allow`. |
| `skipped.jsonl` | One line per repeat that was skipped — currently only happens when `buildProxyEndpoint` throws `InvalidProxyGeoError` (i.e. a scenario's `geo` or `sessionid` violates the IP Royal grammar). | When grammar validation fails. |
| `mismatches.csv` | Egress IP vs requested city mismatches, written by `tooling/py/verify_geo.py`. | Post-run, when the operator invokes the verification tool. |
| `geo_resolved.jsonl` | One JSON object per event with `{scenario_id, repeat_index, ip, country, state, city, verified}` written by `verify_geo.py`. | Post-run, when `MAXMIND_DB_PATH` is set so an offline lookup is possible. |
| `summary.json` | Aggregate run summary: by-tier-verdict counts, by-geo counts, latency p50/p95/p99, error count. Written by the CLI at end-of-run. | Post-run, always. |
| `replay/<scenario_id>/` | Per-repeat Playwright trace, HAR, screenshots. | Post-run, human tier only, when `tooling/py/build_replay.py` is invoked. |

The dashboard's `GET /summary` HTTP endpoint
([`packages/dashboard/src/server.ts:30`](packages/dashboard/src/server.ts))
returns the live `AggregatorState` (a tier x verdict confusion matrix,
city-level allow/block counts, and a scenarios map). The
`Aggregator` class is in
[`packages/dashboard/src/aggregator.ts`](packages/dashboard/src/aggregator.ts).
**Note:** the orchestrator does not currently persist a `summary.json`
to disk; the dashboard endpoint is the source of truth for the live
view. If you need a snapshot after the run, `curl http://localhost:7474/summary`
before stopping the process, or parse `scenarios.jsonl` and recompute
the same matrix offline.

### 4.1 Reading `scenarios.jsonl`

Each line is a `RequestEvent` (the type is defined in
[`packages/orchestrator/src/types.ts`](packages/orchestrator/src/types.ts)).
Shape:

```jsonc
{
  "scenario_id": "mumbai-human-pricing-journey",
  "repeat_index": 0,
  "tier": "human",
  "geo_requested": { "country": "IN", "state": "Maharashtra", "city": "Mumbai" },
  "geo_resolved": undefined,           // reserved; see Troubleshooting §8.8
  "proxy_mode": "sticky-residential",
  "session_id": "mumbai-human-pricing-journey-...-0",
  "started_at": "2026-08-17T...",
  "pages": ["https://...", "..."],     // human tier only
  "events": [
    {
      "url": "https://example.com/",
      "method": "GET",
      "status": 200,
      "time_ms": 412,
      "headers": { "server": "...", "cf-ray": "..." },
      "ta_signal": {}
    }
  ],
  "final_verdict": "allow",            // allow | challenge | block | unsure | error
  "timing": {
    "total_ms": 184000,
    "pages_visited": 6,
    "mouse_moves": 2483,               // human tier only
    "scroll_pulses": 47                // human tier only
  },
  "error": undefined                   // set if a per-request error happened
}
```

Quick checks:

```bash
# Count by final verdict.
jq -r '.final_verdict' runs/<ts>/scenarios.jsonl | sort | uniq -c

# Just the headless-tier events.
jq -c 'select(.tier == "headless")' runs/<ts>/scenarios.jsonl

# Everything that was challenged.
jq -c 'select(.final_verdict == "challenge")' runs/<ts>/scenarios.jsonl
```

### 4.2 Reading the live summary (dashboard `/summary`)

The HTTP endpoint returns:

```jsonc
{
  "byTierVerdict": {
    "trivial-http": { "allow": 0, "block": 0, "challenge": 0, "unsure": 0, "error": 0 },
    "headless":     { ... },
    "stealth":      { ... },
    "human":        { ... }
  },
  "byCity": {
    "US--":     { "allow": 0, "block": 0, "challenge": 0, "unsure": 0 },
    "IN-Maharashtra-Mumbai": { ... }
  },
  "totalRequests": 0,
  "scenarios": {
    "mumbai-human-pricing-journey": { "status": "done", "repeats": 0, "verdict": "allow" }
  }
}
```

`byTierVerdict` is a tier x verdict confusion matrix. `byCity` keys
are `<country>-<state>-<city>` (empty parts between dashes when
the scenario didn't specify `state` or `city`). `scenarios` is
keyed by `scenario_id`.

---

## 5. Dashboard

While a run is in progress, the orchestrator serves a single dark-themed
HTML page at `http://localhost:7474/`. The page opens an SSE
connection to `/events` and re-renders once a second.

What to look at:

- **Header** — run id (the ISO timestamp) and the running total of
  requests fired.
- **Tier x verdict matrix** — counts per (tier, verdict) cell. A
  well-behaved setup looks like: `trivial-http` and `headless` mostly
  `block`/`challenge`, `human` mostly `allow`. The `stealth` row
  should be somewhere in between.
- **Recent requests stream** — last N request events, newest first.
  Click a row (or just read the JSON) to inspect raw headers and
  cookies; the verdict strategies in
  [`packages/verdict/src/strategies/`](packages/verdict/src/strategies/)
  fire on `cf-ray`, `cf_clearance`, `x-datadome`, `_px3`, `_abck`,
  `server:cloudflare`, and other known fingerprint headers/cookies.

If port 7474 is taken, pass `--dashboard-port 7600` (or any free
port). The server only binds to `127.0.0.1`, so other hosts cannot
reach it.

---

## 6. Verdict strategies

The verdict aggregator
([`packages/verdict/src/aggregate.ts`](packages/verdict/src/aggregate.ts))
runs each `VerdictInput` through every enabled strategy and takes
the worst vote (precedence: `block` > `challenge` > `unsure` >
`allow`). The default strategy set
([`packages/verdict/src/index.ts`](packages/verdict/src/index.ts)) is:

| Strategy | Default vote | Source |
|---|---|---|
| `httpStatusStrategy` | `block` on 403/503/502 or blank-200, otherwise `allow` | [`strategies/httpStatus.ts`](packages/verdict/src/strategies/httpStatus.ts) |
| `challengeHtmlStrategy(sigs)` | `challenge` on body/header/cookie substring hit, else `allow` | [`strategies/challengeHtml.ts`](packages/verdict/src/strategies/challengeHtml.ts) |
| `headerSignalsStrategy(sigs)` | `challenge` on header-only fingerprint match, else `allow` | [`strategies/headerSignals.ts`](packages/verdict/src/strategies/headerSignals.ts) |
| `cookieStrategy(sigs)` | `challenge` on challenge-cookie name match, else `allow` | [`strategies/strategies/cookies.ts`](packages/verdict/src/strategies/cookies.ts) |
| `timingStrategy` | never votes (signal only) | [`strategies/timing.ts`](packages/verdict/src/strategies/timing.ts) |

The set of signatures (`cloudflare`, `hcaptcha`, `datadome`,
`perimeterx`, `akamai`, `generic`) is in
[`packages/verdict/src/signatures.ts`](packages/verdict/src/signatures.ts)
and can be overridden per-scenario via
`verdict_detection.challenge_signatures` (an array of names). Any of
`verdict_detection.{http_status, challenge_html, header_signals,
cookies, timing}` set to `false` in the scenario YAML drops that
strategy from the run.

A sub-100ms response is a *signal*, not a verdict on its own: the
runner overrides a clean `allow` to `unsure` and records the event
in `unsure.jsonl` (see
[`runner.ts:133-138`](packages/orchestrator/src/runner.ts)).
A sub-100ms response that already tripped a `challenge` or `block`
strategy stays at the worse verdict.

---

## 7. Exit codes

The orchestrator currently returns:

| Exit | Meaning | Triggered by |
|---|---|---|
| `0` | Run completed. | Normal end of `runScenario`. |
| `1` | Invalid scenario, missing required env var, or invalid CLI args. | `cli.ts` (missing `IPROYAL_USER`/`IPROYAL_PASS`), `loadScenario` (schema violation), or `commander` (e.g. `--scenario` not provided). |
| `2` | City pool exhausted. | Three egress-IP mismatches in a row for the same requested city. Detected by `tooling/py/check_pool_exhaustion.py`, which the CLI invokes after `verify_geo.py` finishes. |
| `4` | Disk full (JSONL write failed). | Spec target. Today, a write error throws and the unhandled-rejection handler in `cli.ts` falls through to exit 99. |
| `99` | Unhandled exception. | The `main().catch(...)` tail of `cli.ts`. Any other crash lands here. |

The **spec target** for exit codes 2 and 4 is documented in
[`docs/superpowers/specs/2026-08-17-traffic-armour-harness-design.md:303-314`](docs/superpowers/specs/2026-08-17-traffic-armour-harness-design.md)
but the corresponding `process.exit(2)` and `process.exit(4)` calls
have not been implemented in the orchestrator yet.

---

## 8. Troubleshooting

### 8.1 "IPROYAL_USER and IPROYAL_PASS must be set in env"

`cli.ts` exits 1 immediately. Either the env vars are not exported
in your shell, or they were set after the parent process started.
Confirm with `echo "$IPROYAL_USER" / $env:IPROYAL_USER`.

### 8.2 Schema violation: bad scenario

`loadScenario` validates the YAML against
[`scenarios/schema.json`](scenarios/schema.json) and throws with the
Ajv error list when the file is malformed. Common failures:

- `geo.country` lowercase — must be `^[A-Z]{2}$`.
- `state` or `city` with disallowed characters (allowed: letters
  and spaces; hyphens and digits are not).
- `device_pool` missing for `headless`/`stealth`/`human` tiers
  (the schema's `allOf` requires it for any non-trivial-http tier).
- `proxy_mode` is `rotating-residential` for a `headless`/`stealth`/
  `human` tier — must be `sticky-residential` (same `allOf` rule).
- `session` block missing for `human` tier.

### 8.3 City pool exhaustion / proxy returning wrong city

IP Royal's residential pool is best-effort: a sticky session for
`IN-Maharashtra-Mumbai` may rotate through a sibling city or
country if the requested city is empty. Two diagnostics:

1. `MAXMIND_DB_PATH=./GeoLite2-City.mmdb python tooling/py/verify_geo.py runs/<ts>`
   produces `runs/<ts>/mismatches.csv` listing every event whose
   `geo_resolved` (looked up via MaxMind) did not match the
   requested `(country, state, city)`. Empty output = every
   egress IP resolved correctly.
2. If a city is repeatedly exhausted, narrow the scenario to a
   `country`-only geo block and rely on IP Royal's pool rotation,
   or change `proxy_mode` to `rotating-residential` to accept
   city drift.

### 8.4 Browser tier crashes immediately

Playwright needs a Chromium install. From the repo root:

```bash
npx playwright install chromium
```

If the headless tier still fails, the `error` field on the emitted
`RequestEvent` will hold Playwright's launch error; the event
still goes to `scenarios.jsonl`.

### 8.5 Dashboard port already in use

Either pass `--dashboard-port <free-port>`, or run with
`--no-dashboard` for a headless run (the JSONL sink still runs).

### 8.6 `unsure` events dominating a run

A response that came back in <100ms is suspicious: many real
challenge interstitials take longer to render than the target
page. Two responses:

- Confirm with `verify_geo.py` that the egress IP is residential
  and in the requested country. A datacenter IP being served a
  near-instant 200 is a strong signal of a shadow block.
- Add or remove signatures via
  `verdict_detection.challenge_signatures` in the scenario YAML.
  The current set
  ([`packages/verdict/src/signatures.ts`](packages/verdict/src/signatures.ts))
  covers Cloudflare, hCaptcha, DataDome, PerimeterX, Akamai, and
  a generic fallback.

### 8.7 Unhandled exception / exit 99

The `.catch` at the bottom of `cli.ts` prints the error and exits
99. The most common cause today is a TypeScript build drift: if you
edited code in a workspace but did not `npm run build` (which is
`tsc -b`), `dist/cli.js` may be running stale code. Re-run
`npm run build` from the repo root and retry.

---

## 9. Tests

```bash
# Unit tests (fast; no network).
npm run test:unit

# Lint (tsc -b --noEmit on the full project).
npm run lint

# Integration tests (Docker required; gated on TAH_INTEGRATION).
TAH_INTEGRATION=1 npm run test:integration

# Everything CI runs.
npm run test
```

The integration suite
([`tests/integration/runFakeTA.test.ts`](tests/integration/runFakeTA.test.ts))
spins up a fake nginx-based Traffic Armour fixture, then runs all
four tiers against it and asserts verdict rates (trivial-http and
headless: ~100% block; stealth: 30-80% block; human: ~0% block).
The fake TA is defined in
[`tests/integration/fake-ta.Dockerfile`](tests/integration/fake-ta.Dockerfile)
and [`tests/integration/fake-ta.conf`](tests/integration/fake-ta.conf),
and is started/stopped via
[`tests/integration/fakeTA.ts`](tests/integration/fakeTA.ts).

CI runs the unit + integration suite on every push and PR via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## 10. Repo layout

```
.
├── README.md                          # this file
├── package.json                       # npm workspaces
├── tsconfig.base.json
├── .env.example                       # IPROYAL_USER, IPROYAL_PASS, MAXMIND_DB_PATH
├── .github/workflows/ci.yml
├── scenarios/                         # YAML inputs (validated by schema.json)
│   ├── schema.json
│   ├── trivial-burst-homepage.yaml
│   ├── mumbai-human-pricing-journey.yaml
│   └── berlin-stealth-funnel.yaml
├── packages/
│   ├── proxy/                         # IP Royal URL grammar
│   ├── verdict/                       # strategies + aggregator + signatures
│   ├── orchestrator/                  # CLI, scenario runner, JSONL sink
│   ├── tiers/
│   │   ├── trivial-http/              # HTTP client
│   │   ├── headless-browser/          # Playwright bare
│   │   ├── stealth-browser/           # Playwright + stealth plugin
│   │   └── human-sim/                 # Playwright + behavioral layer
│   ├── dashboard/                     # local web UI (Fastify + SSE)
│   └── profiles/                      # device profiles (devices.json)
├── tooling/py/
│   ├── verify_geo.py                  # MaxMind egress-IP audit
│   ├── build_replay.py                # zip up replay bundles
│   └── pyproject.toml
├── runs/                              # gitignored, one subdir per run
└── tests/
    ├── unit/
    └── integration/                   # TAH_INTEGRATION=1 gated
```

---

## 11. Post-run helpers

```bash
# Audit egress IPs against requested geo (writes mismatches.csv).
MAXMIND_DB_PATH=./GeoLite2-City.mmdb python tooling/py/verify_geo.py runs/<ts>

# Bundle each replay/<scenario_id>/ into a zip for sharing.
python tooling/py/build_replay.py runs/<ts>
```

`verify_geo.py` reads `scenarios.jsonl`, looks up every event's
`geo_resolved.ip` in the MaxMind DB, and writes a row to
`mismatches.csv` for each `(requested != resolved)` triple. **The
orchestrator does not currently populate `geo_resolved`** (the field
is declared in the `RequestEvent` type but no tier or post-step sets
it), so the tool silently skips every event today — `mismatches.csv`
ends up empty. The hook for it is in place; wiring an `ipify.org`
lookup per session is a follow-up.

`build_replay.py` zips each `replay/<scenario_id>/` subtree (Playwright
trace + HAR + screenshots) into a single bundle. The replay directory
is populated by the human tier (other tiers don't generate traces).
