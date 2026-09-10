# MCC-specific Google Ads workers

Worker setup accepts any valid 10-digit Google Ads manager account ID and a custom shard name.
MCC identity is independent of the shard name. Hyphens/spaces in MCC IDs are normalized.
Custom names use 1-80 letters, numbers, periods, underscores, colons or hyphens.

1. Select an existing shard or enter a unique custom name and click **Use new shard**.
2. Enter the MCC where the Google Ads script will be installed.
3. Enter this environment's public HTTPS base URL and generate the worker.
4. Install the generated copy in that MCC and schedule it hourly.

A bound shard keeps its MCC even when empty or paused. Create a new shard for another MCC.
A generated worker rejects the wrong MCC before a bridge heartbeat or campaign mutation.
Regeneration intentionally rotates only the selected shard's token, after confirmation.
Rejected MCC changes do not rotate tokens. Deployment itself rotates no tokens.

## Rollout

Apply only migration `013_fleet_shard_managers.sql` before deploying this feature.
It creates independent ownership metadata and backfills unambiguous non-archived assignments;
it does not rename shards or edit campaigns, captures, jobs or worker tokens.
Keep each environment's existing worker generation version. This feature does not upgrade v11 to v12.
On rollback, retain the additive metadata table; the previous application does not use it.

## Focused tests

`node --test web/tests/fleet-shard-config.test.ts`

For database tests, use a disposable PostgreSQL instance with database name `mcc_shard_test`,
bind its port only to loopback, and supply `TAH_MCC_SHARD_TEST_DATABASE_URL`.
Apply that environment's migrations before running
`node --test web/tests/fleet-shard-config.integration.test.ts`.
The test refuses non-loopback or differently named databases.
