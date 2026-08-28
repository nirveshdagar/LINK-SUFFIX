#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${1:?Pass a .dump file}"
BACKUP="$1"
sha256sum -c "$BACKUP.sha256"
TEST_DB="tah_restore_test_$(date +%s)"
ADMIN_URL="${TAH_POSTGRES_ADMIN_URL:-$DATABASE_URL}"

cleanup() { dropdb --if-exists --force --maintenance-db="$ADMIN_URL" "$TEST_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
createdb --maintenance-db="$ADMIN_URL" "$TEST_DB"
pg_restore --exit-on-error --no-owner --no-acl --dbname="${ADMIN_URL%/*}/$TEST_DB" "$BACKUP"

psql "${ADMIN_URL%/*}/$TEST_DB" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing FROM (VALUES
    ('tah_campaign_targets'),('tah_suffix_captures'),('tah_delivery_jobs'),('tah_script_shards'),('tah_audit_log')
  ) expected(name)
  WHERE to_regclass('public.' || expected.name) IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION 'Restore is missing required tables'; END IF;
END $$;
SELECT count(*) AS campaign_targets FROM tah_campaign_targets;
SELECT count(*) AS delivery_jobs FROM tah_delivery_jobs;
SQL
