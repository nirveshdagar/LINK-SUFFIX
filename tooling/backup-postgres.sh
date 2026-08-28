#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${TAH_BACKUP_DIR:-./backups}"
RETENTION_DAYS="${TAH_BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
umask 077
FILE="$BACKUP_DIR/traffic-armour-$STAMP.dump"

pg_dump --dbname="$DATABASE_URL" --format=custom --compress=9 --no-owner --no-acl --file="$FILE"
sha256sum "$FILE" > "$FILE.sha256"
find "$BACKUP_DIR" -type f \( -name 'traffic-armour-*.dump' -o -name 'traffic-armour-*.dump.sha256' \) -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$FILE"
