# Native desktop compatibility mode

This is ordinary, headed Playwright Chromium. It does not hide webdriver,
override client hints or user agents, spoof TLS, solve challenges, or rotate
proxy routes after website refusals.

## Scope

Opt in with a campaign's existing session.headless=false and a Chromium desktop
device pool. The first production opt-in is campaign-000018 (Udemy) only.
All other campaigns keep their existing configuration. Windows/macOS use their
native display. Linux headed Chromium gets an owned Xvfb display and a private,
writable temporary HOME/config/cache/runtime directory. Xvfb must be installed
in the image (the existing Playwright Linux browser dependencies supply it).
Startup fails clearly if it is unavailable; there is no silent engine fallback.

## Isolation and lifetime

A virtual display and native browser are reused by the existing pool.
Each journey still creates its own browser context and retains the configured
sticky proxy session, public-egress guard, capacity permit, and context cleanup.
The temporary HOME is not a persistent browser profile or a cookie store.
Campaign session snapshots, where enabled, retain their existing separate
encrypted storage boundaries. Global HOME and DISPLAY are never modified.

Display startup is bounded to 8 seconds, browser launch to 30 seconds.
Launch failures, idle eviction, browser disconnect, display failure, and pool
shutdown release owned resources. Display shutdown escalates from TERM to KILL
after 2 seconds, with a further 2-second bound. Cleanup only removes the
generated tah-native-desktop-* directory under the operating-system temp root.
No live filesystem mounts, tokens, proxy credentials, or campaign data are removed.

## Capture safeguards

The runner and suffix acceptance rules are unchanged. HTTP 403/429, explicit
challenge responses, and challenge query tokens stop the journey. Bounded
backoff remains active and the last valid suffix is retained. A successful
test does not guarantee that a third-party site will accept every later request.

## Rollout and rollback

Build and run lifecycle/capture regressions first. Test the actual image with
network disabled and its read-only filesystem: headed Chromium must launch,
retain navigator.webdriver=true, isolate two contexts, and remove its runtime
after shutdown. A bounded authorized Udemy canary must use one existing proxy
lease with no fallback or capture/database/Ads writes.

Deploy with database/state backup and the usual application rollback.
Only then opt in Udemy by changing session.headless and devicePool; preserve
all other campaign fields and all paused/running states. Do not restart a
campaign that an operator has paused. Confirm new valid im_ref captures and
subsequent Google Ads read-back separately. Roll back the opt-in and application
image if native desktop startup or cleanup fails; do not relax edge rejection.
