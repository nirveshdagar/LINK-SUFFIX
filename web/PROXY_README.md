# IPRoyal traffic and campaign control

The active application consists of two local services:

- Next.js operator UI and API: `http://127.0.0.1:3100`
- Campaign control WebSocket and health service: `http://127.0.0.1:3101`

The former `/ads` workflow is integrated into the main control dashboard. The traffic API and the L4 browser runner are separate execution paths; campaigns should use the L4 runner when a real landing-page redirect journey is required.

## Required production controls

Set strong API, Ads, tracking, and control tokens. Configure `TAH_ALLOWED_TARGETS` with the exact authorized domains. Keep `TAH_ALLOW_INSECURE_LOCAL_DEV` and `TAH_ALLOW_UNLISTED_LOCAL_TARGETS` disabled outside isolated development.

## Capacity model

`TAH_MAX_ACTIVE_RUNS` is the operator-configured queue limit and defaults to 500. `TAH_MAX_LOCAL_WORKERS` is the real process admission limit for one server and defaults to 20. Up to 5000 campaign definitions may be saved; excess desired campaigns remain queued until worker and gateway-port capacity is available.

Browser concurrency is separately bounded by `TAH_MAX_BROWSER_CONCURRENCY`. Aggregate raw-request concurrency and RPS are bounded by `TAH_MAX_TOTAL_CONCURRENCY` and `TAH_MAX_TOTAL_RPS`.

## Capture and Google Ads pipeline

1. An authorized campaign opens its configured tracking URL through its leased IPRoyal gateway port.
2. The L4 browser follows the journey and records the final landing URL.
3. The query substring after `?` and before `#` is preserved byte-for-byte.
4. Capture-only campaigns stop at the stored suffix.
5. Ads-enabled campaigns serialize the mutation and enforce at least 58 seconds between writes to the same campaign.

Google Ads synchronization is disabled by default and requires explicit selection.

## Scheduling

Campaign schedules use an IANA timezone, weekday set, and 24-hour start and stop times. Schedule reconciliation defaults to every 30 seconds.

## IPRoyal tunnel

Each traffic-API proxy session launches a localhost-only tunnel. HTTP requests and HTTPS CONNECT requests are both forwarded to the configured IPRoyal gateway. Upstream authorization headers are not forwarded directly to target websites.

The gateway defaults to `geo.iproyal.com:12321` and can be overridden with `IPROYAL_HOSTNAME` and `IPROYAL_PORT`.

## Deployment limitation

Local JSON snapshots are atomically replaced and the control service enforces single-instance ownership. Multi-host production deployment still requires a shared database and distributed job queue; do not run multiple control servers against the same `runs/` directory.
