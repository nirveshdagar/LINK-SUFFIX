# Traffic Armour Test Harness

A Node + TypeScript bot-traffic test harness that generates four tiers of synthetic
traffic (trivial HTTP, headless browser, stealth browser, and realistic human) against
reverse-proxy anti-bot (Traffic Armour) deployments, routed through IP Royal residential
proxies. The harness measures how each tier is classified (allowed, challenged, blocked)
and emits run artifacts for analysis.

## Getting started

```bash
npm install
npm run test
```

`npm install` sets up the npm workspaces. `npm run test` runs the Vitest suite.

## Requirements

Before running traffic tiers, you need:

- **IP Royal residential proxy credentials** — set `IPROYAL_USER` and `IPROYAL_PASS`
  in a local `.env` file (see `.env.example`).
- **MaxMind GeoLite2-City database** — download the `.mmdb` file from MaxMind and
  place it at the path configured by `MAXMIND_DB_PATH` (default `./GeoLite2-City.mmdb`).

Copy `.env.example` to `.env` and fill in the values before running any tier that
touches the network or performs geolocation lookups.
