# Approved redirect-only capture

This is an explicit per-campaign policy, not a global relaxation of capture safety.
It records a real HTTP Location from one approved affiliate origin to one approved
merchant origin. The merchant is excluded from the journey's network allowlist.
The displayed result is "Redirect verified; destination not visited".

A shared, native browser may execute JavaScript on approved tracking pages. The
network proxy denies excluded origins before DNS lookup or upstream CONNECT.
Browser routing is defense in depth, not the sole redirect boundary.

Requirements:
- Direct-entry human tier, one verified sticky proxy session, no MITM.
- Exact HTTP(S) intermediary origins, approved individually with their protocol.
- The starting URL, final affiliate issuer and merchant must remain HTTPS.
- An HTTP intermediary can redirect onward but cannot issue trusted final capture evidence.
- The merchant hostname must be excluded, including alternate ports.
- An actual 301, 302, 303, 307 or 308 Location from the approved issuer.
- Exactly one nonempty required irclickid or im_ref parameter.
- Exact URL/query bytes, no inserted or substituted attribution.
- The control service validates against the immutable run policy.
- 403, 429, challenge URLs and cf-mitigated challenges remain terminal.
- Existing backoff and historical-suffix preservation remain active.
- No changes to Google Ads targets, tokens, scheduling or Apps Script.

Saved configuration uses redirectCapture; scenario YAML uses redirect_capture.
Omitting the field during campaign editing preserves an existing policy. Set it
to null to explicitly disable it, then restart the campaign. New campaigns do
not inherit this mode. Natural Click cannot be combined with this policy.

Evidence is stored with the run, capture timestamp and suffix. The Fleet label
appears only when its current suffix and timestamp match that evidence. It does
not claim that a merchant accepted, rendered or approved an automated visit.
