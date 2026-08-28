#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/app/backups}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL_SECONDS="${TAH_BACKUP_INTERVAL_SECONDS:-86400}"
RESTORE_TEST_EVERY="${TAH_BACKUP_RESTORE_TEST_EVERY:-7}"
COUNTER_FILE="$BACKUP_DIR/.backup-count"

case "$INTERVAL_SECONDS" in (*[!0-9]*|"") echo "TAH_BACKUP_INTERVAL_SECONDS must be a positive integer" >&2; exit 1;; esac
case "$RESTORE_TEST_EVERY" in (*[!0-9]*|"") echo "TAH_BACKUP_RESTORE_TEST_EVERY must be a positive integer" >&2; exit 1;; esac
if (( INTERVAL_SECONDS < 3600 || RESTORE_TEST_EVERY < 1 )); then
  echo "Backup interval must be at least one hour and restore cadence must be positive" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

while true; do
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if TAH_BACKUP_DIR="$BACKUP_DIR" bash "$SCRIPT_DIR/backup-postgres.sh"; then
    count=0
    if [[ -f "$COUNTER_FILE" ]]; then read -r count < "$COUNTER_FILE" || count=0; fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$COUNTER_FILE"
    latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
    if [[ -n "$latest" ]] && (( count % RESTORE_TEST_EVERY == 0 )); then
      bash "$SCRIPT_DIR/restore-test-postgres.sh" "$latest"
    fi
    printf '%s\n' "$started" > "$BACKUP_DIR/.last-success"
  else
    printf '%s\n' "$started" > "$BACKUP_DIR/.last-failure"
  fi
  sleep "$INTERVAL_SECONDS"
done
