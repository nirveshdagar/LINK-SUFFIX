#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${TAH_MAINTENANCE_INSTALL_ROOT:-}"

destination() {
  printf '%s%s\n' "$INSTALL_ROOT" "$1"
}

if [[ -z "$INSTALL_ROOT" && "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

install -D -m 0750 "$SCRIPT_DIR/storage-maintenance.sh" "$(destination /usr/local/sbin/link-suffix-storage-maintenance)"
install -D -m 0644 "$SCRIPT_DIR/systemd/link-suffix-storage-maintenance.service" "$(destination /etc/systemd/system/link-suffix-storage-maintenance.service)"
install -D -m 0644 "$SCRIPT_DIR/systemd/link-suffix-storage-maintenance.timer" "$(destination /etc/systemd/system/link-suffix-storage-maintenance.timer)"

environment_file="$(destination /etc/default/link-suffix-storage-maintenance)"
if [[ ! -e "$environment_file" ]]; then
  install -d -m 0755 "$(dirname "$environment_file")"
  cat > "$environment_file" <<'EOF'
TAH_MAINTENANCE_DISK_TRIGGER_PERCENT=70
TAH_MAINTENANCE_DISK_TARGET_PERCENT=60
TAH_MAINTENANCE_MIN_AVAILABLE_GB=40
TAH_MAINTENANCE_BUILD_CACHE_RETENTION=12h
TAH_MAINTENANCE_IMAGE_RETENTION_HOURS=12
TAH_MAINTENANCE_KEEP_APP_IMAGES=4
TAH_MAINTENANCE_KEEP_RELEASES=5
TAH_MAINTENANCE_MAX_LOAD_PER_CPU=0.80
EOF
  chmod 0644 "$environment_file"
fi

if [[ -z "$INSTALL_ROOT" ]]; then
  systemctl daemon-reload
  systemctl enable --now link-suffix-storage-maintenance.timer
fi

echo "Storage maintenance installed."
