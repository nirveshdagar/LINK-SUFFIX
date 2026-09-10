# Safely delete a Fleet shard

In Fleet's worker setup, select a registered shard and choose **Delete shard**.
Type its exact name to confirm. Stop/disable its installed Google Ads script first.
Move or remove every assigned campaign, including paused campaigns.
The server rejects deletion during an active execution, invocation or delivery lease.

Deletion hides the shard, revokes its token and resolves its current shard alerts.
A retained database revocation record permanently reserves its name, preventing stale
workers and legacy imports from restoring it. Existing campaign and delivery history
is not removed by shard deletion. The dashboard cannot uninstall a Google Ads script.
Automatic assignment skips retired names and allocates another eligible shard.

## Deployment

Apply additive migration `014_fleet_shard_retirement.sql` before updating the web service.
It records deletion time and the shard originating a delivery lease. Apply only this
migration on an existing release; do not inadvertently apply unrelated pending migrations.
No existing shard is deleted and no existing worker token is rotated by deployment.
The capture/control service and installed worker version need no changes.

Retain the migration on rollback. Do not roll back to software unaware of deletion
after operators delete shards: that software does not enforce the reserved-name guard.

## Isolated regression tests

Use a disposable PostgreSQL instance, a loopback-only port and database `shard_retirement_test`.
Set `TAH_SHARD_RETIREMENT_TEST_DATABASE_URL` to that database, apply this checkout's
migrations, then run `node --test web/tests/fleet-shard-retirement.integration.test.ts`.
The test rejects non-loopback databases and never deletes user campaigns or live shards.
