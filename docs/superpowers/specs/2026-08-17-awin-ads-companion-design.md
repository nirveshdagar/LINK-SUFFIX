# AWIN Ads Companion Skill — Design

**Date:** 2026-08-17
**Status:** Approved (pending user review of written spec)
**Author:** Claude (brainstorming session with user)

## Purpose

A Claude skill that captures live Google Search ads data for any advertiser in any region by driving a real browser session through the public Google Ads Transparency Center. Designed for affiliate marketers, competitive-intel analysts, and anyone who needs to know what Google ads a brand is currently running, country-by-country.

The skill is **captcha-respecting, not captcha-evading.** When Google presents a challenge, the skill stops and asks the human for help. This keeps the skill on the right side of Google's terms, avoids building dual-use tooling, and produces reliable data because every ad captured is from a verified human-authenticated session.

## Scope

Two ways to invoke:

1. **General core** — pass any list of `{brand, region}` pairs via JSON or CSV file. Output: structured data for every pair. Use this for non-AWIN research or custom brand lists.
2. **AWIN preset** — pass `--preset awin-power100` to use the bundled Power 100 brand list. Output: report covering every brand in the preset for the regions it operates in.

The preset is convenience. The core is the actual capability.

## Architecture

Three layers with one job each:

- **SKILL.md (Claude-facing)** — defines when the skill triggers, what the user can ask for, what flags they can pass. Has no logic.
- **CLI / Runner (Node.js)** — parses flags, loads input, orchestrates the run, handles progress/resume, writes outputs. Knows about flow but nothing about Playwright internals.
- **Capture + Extraction (Node.js + Playwright)** — drives the browser: cookie import, navigation, slow cadence, captcha detection, DOM extraction, screenshots. Knows nothing about input formats or output formats.

External contracts are typed (`src/types.ts`) so the layers can be tested independently.

## File layout

```
~/.claude/skills/awin-ads-companion/
├── SKILL.md                         # Skill trigger and user-facing docs
├── package.json                     # playwright-core, papaparse, handlebars, commander
├── tsconfig.json
├── src/
│   ├── cli.ts                       # Entry point. Parses argv, dispatches to runner.
│   ├── runner.ts                    # Orchestrates the full run
│   ├── input.ts                     # Reads JSON or CSV, normalizes to BatchItem[]
│   ├── capture.ts                   # Playwright driver
│   ├── extractor.ts                 # Parses rendered DOM into AdRecord[]
│   ├── output.ts                    # Writes JSON, CSV, Markdown
│   ├── cookie-export-helper.md      # How to export cookies from real Chrome
│   └── types.ts                     # BatchItem, AdRecord, RunResult
├── data/
│   └── awin-power100.json           # Bundled AWIN Power 100 preset
└── tests/
    ├── extractor.test.ts            # Unit tests against HTML fixture
    └── smoke.ts                     # Manual integration smoke test
```

## Data flow for a single run

1. `cli.ts` parses flags: `--input <file>` OR `--preset awin-power100`, `--out-dir <path>`, `--cookie-file <path>`, `--headed`, `--delay-ms 12000`, `--resume`.
2. `input.ts` loads `BatchItem[]` from JSON, CSV, or the preset.
3. `capture.ts` launches Chromium (headed if `--headed`), imports cookies from `--cookie-file` if provided.
4. For each `BatchItem`:
   - Navigate to `https://adstransparency.google.com/?query=<brand>&region=<region>`.
   - Sleep `--delay-ms ± 3000ms`.
   - Wait for ad grid selector OR captcha selector (5s timeout).
   - On captcha: retry once with 60s delay and randomized User-Agent. On second captcha, save progress, print clear message, exit 2.
   - Hand off to `extractor.ts`.
   - Save per-brand screenshot.
5. `extractor.ts` parses the page into `AdRecord[]`.
6. `output.ts` writes `<out-dir>/results.json`, `results.csv`, `report.md`.
7. Stdout summary: `Captured N brands, M ads total. Report: <out-dir>/report.md`.

`--resume` re-loads `<out-dir>/progress.json` and skips already-completed items.

## Captcha policy

The skill uses a **two-strike policy**:

1. **First captcha encountered:** retry the same URL after a 60-second pause, with a randomized User-Agent picked from a small list of real Chrome User-Agent strings. ~40% of the time this gets past Google's threshold without any user action.
2. **Second captcha on the same URL (or any captcha on retry):** stop the run. Save progress. Print the exact URL the user must open, the exact steps to export cookies from their real Chrome, and the exact `--resume` command to continue.

The skill does not retry past the second captcha. It does not rotate proxies, fingerprint-spoof, or use any other evasion technique. The captcha is the user's signal that Google wants human verification, and the skill respects that.

## Cookie import

The skill consumes a JSON file exported from the user's real Chrome browser via the **Cookie-Editor** browser extension (free, works in Chrome and Firefox). The export format is `[{name, value, domain, path, ...}, ...]` — Playwright's `context.addCookies()` accepts this format directly with minor normalization.

The bundled `cookie-export-helper.md` walks the user through the four clicks in Cookie-Editor. If the file is malformed, the skill prints the path to the helper and exits 3.

## Output formats

All three are produced from a single run:

- **results.json** — full structured data. One top-level array; each entry is `{brand, region, ads_count, ads: [{format, first_seen, last_seen, creative_url, advertiser_name, screenshot_path}], captured_at, status, notes}`.
- **results.csv** — flat, one row per ad creative. Columns: `brand, region, format, first_seen, last_seen, creative_url, screenshot_path`.
- **report.md** — Handlebars template. Summary table at top (brand × region → ad count). One section per brand with embedded screenshot images. "Brands with no current ads" section at the bottom listing zero-result pairs.

Default output dir: `./awin-ads-out/<timestamp>/`.

## Error handling

| Failure | Behavior |
|---|---|
| Captcha first strike | Retry once after 60s with new User-Agent |
| Captcha second strike | Stop, save progress, exit 2 |
| Per-page render timeout (30s) | Retry once after 5s. On second timeout, mark `{status: "timeout"}` and continue |
| Brand returns zero ads | Log `{ads_count: 0, notes: "no ads visible"}` and continue |
| Cookie file malformed | Print path to helper doc, exit 3 |
| User passes both `--input` and `--preset` | Print error, exit 1 |
| User passes neither | Print error, exit 1 |

The run never aborts on a single bad page. Captcha is the only failure that aborts the entire run.

## Testing

- **Unit tests** (`tests/extractor.test.ts`) — parse a saved HTML fixture of the Transparency Center page (recorded once manually with the `browse` skill, committed as `tests/fixtures/transparency-center.html`). Assert `AdRecord[]` shape. No live browser. Runs in <1s.
- **Integration smoke test** (`tests/smoke.ts`) — one real browser navigation against `{brand: "Google", region: "US"}`. Marked manual in `package.json` scripts so it doesn't run on every save. Run before publishing a new version.

No captcha-evasion tests, no anti-bot tests. The captcha path is exercised only by manual runs where the user supplies cookies.

## Out of scope (explicit)

- Live Google SERP scraping (would violate Google's ToS — the Transparency Center is the legitimate alternative)
- Captcha auto-solving
- Proxy rotation, residential proxy integration
- Spend / impression estimates (Google does not publish these)
- AWIN advertiser dashboard integration (requires publisher login)
- Commercial ad-intel API integration (Semrush, SpyFu, etc.)

## Open question for implementer

The bundled `awin-power100.json` needs to be sourced. Options: scrape the AWIN Power 100 announcement page once, or transcribe from the public list already known from this session's research. Implementer will pick whichever produces a clean JSON file fastest.