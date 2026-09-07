# Capture challenge classification

Vendor presence is not an active challenge. hCaptcha SDKs, ordinary Cloudflare headers, clearance cookies, background JavaScript detection and fraud telemetry may accompany a successful merchant document.

Capture verdicts now use explicit mitigation headers, interstitial execution/container evidence, or verification text at the page heading/start. Cookie-only evidence abstains. Vendor signatures remain available for diagnostics.

HTTP 403/429, Cloudflare challenge URL parameters, unresolved challenges and missing destination evidence remain rejected by the independent capture guard. Existing backoff and historical-suffix preservation are unchanged. No challenge-solving, proxy rotation after refusal, or browser fingerprint overrides were added.

Regression fixtures are synthetic and use reserved example.test hosts. Before production cutover, replay stored RingConn responses through the candidate image without making external requests or writing campaign data.

References:
- https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
- https://docs.hcaptcha.com/
