# @tah/google-ads

Google Ads `final_url_suffix` updater — rotates the query-string suffix on enabled campaigns automatically.

## How it works (58 s loop)

```
┌──────────────┐        ┌──────────────┐
│ Traffic Armour│ proxy  │   Target     │
│ orchestrator  │───────▶│  website     │
│ (live traffic)│        └──────┬───────┘
└──────┬───────┘               │ returns final URL with unique suffix
       │                        │ (e.g. ?gclid=abc123&dclid=xyz789)
       ▼                        ▼
┌────────────────────────────────────────────────┐
│  update-final-url-suffix.js (58 s loop)        │
│  1. Read last query string from scenarios.jsonl│
│  2. Push to Google Ads final_url_suffix field  │
└────────────────────────────────────────────────┘
```

## Quick start

### 1. Get Google Ads OAuth2 credentials

1. In [Google Cloud Console](https://console.cloud.google.com/): create an OAuth 2.0 Client ID (Desktop app).
2. In [Google Ads API Center](https://ads.google.com/aw/apicenter): generate a developer token.
3. In [Google Ads API OAuth Playground](https://developers.google.com/ads/api/docs/oauth/playground): authenticate and generate a refresh token for your Ads account.
4. Copy the `.env.example` → `.env` and fill in the values.

### 2. Start the traffic loop (separate process)

```bash
# Terminal 1 — start the control plane
npm run control

# Terminal 2 — start a scenario run so there's live traffic + a final URL
node tooling/google-ads/update-final-url-suffix.js
```

### 3. Single-use run (no long-lived process)

```bash
IPROYAL_USER=iproyal1365 \
IPROYAL_PASS=<set-in-environment>
TARGET_URL=https://digitalserviceone.com/ \
TARGET_CAMPAIGN=DSO_ \
TARGET_CUSTOMER_ID=1234567890 \
GOOGLE_ADS_DEVELOPER_TOKEN=YOUR_TOKEN \
GOOGLE_ADS_CLIENT_ID=YOUR_CLIENT_ID \
GOOGLE_ADS_CLIENT_SECRET=YOUR_CLIENT_SECRET \
GOOGLE_ADS_REFRESH_TOKEN=YOUR_REFRESH_TOKEN \
node tooling/google-ads/update-final-url-suffix.js
```

## Env vars

| Variable | Purpose |
|---|---|
| `IPROYAL_USER` | IP Royal residential proxy username |
| `IPROYAL_PASS` | IP Royal proxy password |
| `TARGET_URL` | URL to open and capture the final redirect |
| `TARGET_CAMPAIGN` | Regex to filter campaign names (e.g. `DSO_`) |
| `TARGET_CUSTOMER_ID` | 10-digit Google Ads customer id |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads developer token |
| `GOOGLE_ADS_CLIENT_ID` | OAuth2 client id |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth2 client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | Long-lived OAuth2 refresh token |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | (optional) MCC manager account |

## Package API

```ts
import { JsonlSuffixSource, FileSuffixSource, GoogleAdsUpdater } from "@tah/google-ads";

// Source 1 — orchestrator JSONL
const source = new JsonlSuffixSource("runs/<runId>/scenarios.jsonl");
const suffix = await source.getSuffix(); // "gclid=abc&dclid=def"

// Source 2 — plain text file
const fileSrc = new FileSuffixSource("runs/latest-suffix.txt");

// Updater
const updater = new GoogleAdsUpdater({
  developerToken: "...",
  clientId: "...",
  clientSecret: "...",
  refreshToken: "...",
  customerId: "1234567890",
});

const results = await updater.updateCampaignsMatching("1234567890", /DSO_/, suffix);
for (const r of results) console.log(`${r.type} ${r.resourceName}: ${r.previousSuffix} → ${r.newSuffix}`);
```

## Notes

- Google Ads API requires a **real OAuth2 refresh token** — you cannot use a service account.
- A developer token in **pending** state only affects test accounts; switch to production accounts once approved.
- `final_url_suffix` is appended to every final URL in the campaign, ad group, or ad — ensure the suffix you push uses the templates Google expects (e.g. `{_gclid}`, `{_dclid}`, `{_campaignid}`).
