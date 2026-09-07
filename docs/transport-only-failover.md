# Focused capture safety release

This release keeps the existing production dashboard, database schema and V11 Apps Script.
It does not include the unfinished Natural Click, UI, audit or session-storage work.

- One configured sticky residential proxy session per journey.
- At most one replacement after a confirmed pre-response upstream connection outage.
- Context/route cleanup and proxy lease release must complete before replacement.
- No replacement for HTTP policy responses, TLS/authentication/application failures or a journey that received a destination response.
- Main-document 403, 429, Cloudflare challenge URLs/headers/Locations stop the browser context.
- The scheduler applies 1/2/4/5-minute bounded backoff; a valid Retry-After can extend the deadline.
- Capture and bridge boundaries reject challenge suffixes. Historical valid captures remain unchanged.
- Hostname, HTTP status and Cloudflare Ray ID identify blocked attempts without exporting cookies.
- Existing invalid pending jobs are quarantined as dead before they can be leased.
- No Cloudflare bypass, TLS impersonation, automatic migrations or token rotation.
