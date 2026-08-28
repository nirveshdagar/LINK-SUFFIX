$ErrorActionPreference = 'Stop'
$compose = Join-Path $PSScriptRoot '..\docker-compose.infrastructure.yml'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $projectRoot
try {
  docker compose -f $compose exec -T postgres sh -ec @'
export PGPASSWORD=tah_local_dev
rm -f /tmp/tah_restore_test.dump
pg_dump -U tah -d tah -Fc -f /tmp/tah_restore_test.dump
dropdb -U tah --if-exists tah_restore_test
createdb -U tah tah_restore_test
pg_restore -U tah -d tah_restore_test --no-owner --no-privileges /tmp/tah_restore_test.dump
test "$(psql -U tah -d tah_restore_test -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('tah_control_state','tah_control_events')")" = "2"
dropdb -U tah tah_restore_test
rm -f /tmp/tah_restore_test.dump
'@
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL restore verification failed' }
  Write-Output 'PostgreSQL backup and isolated restore verification passed'
}
finally {
  Pop-Location
}
