# EVOMI campaign routing

New campaigns select the first configured, enabled EVOMI pool by default and start with country US. The same country dropdown and provider selection are available in campaign Edit. Existing campaigns are never automatically migrated.

Saving a new campaign or switching a stopped campaign persists a non-runnable draft before assigning the provider policy. A failed assignment remains stopped with a retryable Save changes operation. Country is part of the immutable campaign run configuration and is forwarded to the proxy lease. It is not chosen globally at random.

EVOMI uses one fresh sticky-session identifier per browser journey over shared access port 1000 (HTTP), 1001 (HTTPS) or 1002 (SOCKS5). Sessions do not guarantee globally unique IPs. Provider availability and geolocation accuracy are external constraints.

Provider credentials are encrypted using TAH_PROXY_VAULT_KEY; no credentials belong in Git. Saving a provider creates its default pool automatically. Custom endpoint pools remain an advanced option. IPRoyal dedicated-port exclusion is unchanged.

Required runtime configuration:
- TAH_UNIVERSAL_PROXY_ENABLED=1 for both web and control.
- TAH_PROXY_RUNTIME_INTERNAL_URL=http://web:3100/api/proxy-runtime in Docker; http://127.0.0.1:3100/api/proxy-runtime locally.
- DATABASE_URL, REDIS_URL, existing control authentication, and the proxy vault key.
- The existing universal-proxy database migration 006.

Country availability: https://docs.evomi.com/proxy-instructions/residential-proxies/geo-targetting/country/

Targeted tests: node --test tooling/tests/evomi-country-selection.test.mjs tooling/tests/evomi-setup.test.mjs
