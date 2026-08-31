#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

PROGRAM="link-suffix-storage-maintenance"
DISK_PATH="${TAH_MAINTENANCE_DISK_PATH:-/}"
DISK_TRIGGER_PERCENT="${TAH_MAINTENANCE_DISK_TRIGGER_PERCENT:-70}"
DISK_TARGET_PERCENT="${TAH_MAINTENANCE_DISK_TARGET_PERCENT:-60}"
MIN_AVAILABLE_GB="${TAH_MAINTENANCE_MIN_AVAILABLE_GB:-40}"
BUILD_CACHE_RETENTION="${TAH_MAINTENANCE_BUILD_CACHE_RETENTION:-12h}"
IMAGE_RETENTION_HOURS="${TAH_MAINTENANCE_IMAGE_RETENTION_HOURS:-12}"
KEEP_APP_IMAGES="${TAH_MAINTENANCE_KEEP_APP_IMAGES:-4}"
KEEP_RELEASES="${TAH_MAINTENANCE_KEEP_RELEASES:-5}"
MAX_LOAD_PER_CPU="${TAH_MAINTENANCE_MAX_LOAD_PER_CPU:-0.80}"
DOCKER_BIN="${TAH_MAINTENANCE_DOCKER_BIN:-docker}"
LOCK_FILE="${TAH_MAINTENANCE_LOCK_FILE:-/run/lock/link-suffix-storage-maintenance.lock}"
DEPLOYMENT_MARKER="${TAH_MAINTENANCE_DEPLOYMENT_MARKER:-/run/lock/link-suffix-deploy.lock}"
CURRENT_LINK="${TAH_MAINTENANCE_CURRENT_LINK:-/opt/link-suffix/current}"
RELEASES_ROOT="${TAH_MAINTENANCE_RELEASES_ROOT:-/opt/link-suffix/releases}"
STATUS_FILE="${TAH_MAINTENANCE_STATUS_FILE:-/var/lib/link-suffix-maintenance/status.env}"
DRY_RUN="${TAH_MAINTENANCE_DRY_RUN:-0}"
DISABLE_LOCK="${TAH_MAINTENANCE_DISABLE_LOCK:-0}"
SKIP_DEPLOYMENT_CHECK="${TAH_MAINTENANCE_SKIP_DEPLOYMENT_CHECK:-0}"
ALLOW_CUSTOM_RELEASES_ROOT="${TAH_MAINTENANCE_ALLOW_CUSTOM_RELEASES_ROOT:-0}"

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  local level="$1"
  local event="$2"
  shift 2
  printf 'timestamp=%s program=%s level=%s event=%s' "$(timestamp)" "$PROGRAM" "$level" "$event"
  if [[ "$#" -gt 0 ]]; then printf ' %s' "$*"; fi
  printf '\n'
}

fail() {
  log error configuration_error "message=$*"
  exit 2
}

require_uint() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be an unsigned integer"
}

require_decimal() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "$name must be a non-negative number"
}

validate_configuration() {
  require_uint TAH_MAINTENANCE_DISK_TRIGGER_PERCENT "$DISK_TRIGGER_PERCENT"
  require_uint TAH_MAINTENANCE_DISK_TARGET_PERCENT "$DISK_TARGET_PERCENT"
  require_uint TAH_MAINTENANCE_MIN_AVAILABLE_GB "$MIN_AVAILABLE_GB"
  require_uint TAH_MAINTENANCE_IMAGE_RETENTION_HOURS "$IMAGE_RETENTION_HOURS"
  require_uint TAH_MAINTENANCE_KEEP_APP_IMAGES "$KEEP_APP_IMAGES"
  require_uint TAH_MAINTENANCE_KEEP_RELEASES "$KEEP_RELEASES"
  require_decimal TAH_MAINTENANCE_MAX_LOAD_PER_CPU "$MAX_LOAD_PER_CPU"
  (( DISK_TRIGGER_PERCENT >= 1 && DISK_TRIGGER_PERCENT <= 99 )) || fail "disk trigger must be between 1 and 99"
  (( DISK_TARGET_PERCENT >= 1 && DISK_TARGET_PERCENT < DISK_TRIGGER_PERCENT )) || fail "disk target must be below disk trigger"
  (( KEEP_APP_IMAGES >= 2 )) || fail "at least two application images must be retained"
  (( KEEP_RELEASES >= 2 )) || fail "at least two releases must be retained"
}

write_status() {
  local state="$1"
  local used_percent="$2"
  local available_gb="$3"
  local message="$4"
  local status_dir
  local temporary
  status_dir="$(dirname "$STATUS_FILE")"
  mkdir -p "$status_dir"
  temporary="${STATUS_FILE}.$$"
  {
    printf 'timestamp=%s\n' "$(timestamp)"
    printf 'state=%s\n' "$state"
    printf 'disk_used_percent=%s\n' "$used_percent"
    printf 'disk_available_gb=%s\n' "$available_gb"
    printf 'message=%s\n' "$message"
  } > "$temporary"
  mv -f "$temporary" "$STATUS_FILE"
}

read_disk_metrics() {
  local phase="$1"
  local upper_phase="${phase^^}"
  local used_name="TAH_MAINTENANCE_TEST_${upper_phase}_USED_PERCENT"
  local available_name="TAH_MAINTENANCE_TEST_${upper_phase}_AVAILABLE_GB"
  local used_override="${!used_name:-}"
  local available_override="${!available_name:-}"
  if [[ -n "$used_override" || -n "$available_override" ]]; then
    require_uint "$used_name" "$used_override"
    require_uint "$available_name" "$available_override"
    printf '%s %s\n' "$used_override" "$available_override"
    return
  fi

  df -Pk "$DISK_PATH" | awk 'NR == 2 { gsub("%", "", $5); printf "%s %d\n", $5, $4 / 1024 / 1024 }'
}

read_load_metrics() {
  local load_one="${TAH_MAINTENANCE_TEST_LOAD_ONE:-}"
  local cpu_count="${TAH_MAINTENANCE_TEST_CPU_COUNT:-}"
  if [[ -z "$load_one" ]]; then read -r load_one _ < /proc/loadavg; fi
  if [[ -z "$cpu_count" ]]; then cpu_count="$(getconf _NPROCESSORS_ONLN)"; fi
  require_decimal load_one "$load_one"
  require_uint cpu_count "$cpu_count"
  (( cpu_count >= 1 )) || fail "cpu count must be positive"
  printf '%s %s\n' "$load_one" "$cpu_count"
}

deployment_is_active() {
  [[ "$SKIP_DEPLOYMENT_CHECK" == "1" ]] && return 1
  [[ -e "$DEPLOYMENT_MARKER" || -e "${CURRENT_LINK}.next" ]] && return 0
  if pgrep -af '(docker|docker-compose|buildx).*(build|pull|push)' 2>/dev/null \
    | grep -vE 'storage-maintenance|pgrep -af' >/dev/null; then
    return 0
  fi
  if command -v "$DOCKER_BIN" >/dev/null 2>&1 \
    && "$DOCKER_BIN" ps -a --filter 'name=app-web-canary-' --format '{{.Names}}' 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

run_cleanup_command() {
  local action="$1"
  shift
  local rendered
  printf -v rendered '%q ' "$@"
  log info cleanup_planned "action=$action command=${rendered% } dry_run=$DRY_RUN"
  [[ "$DRY_RUN" == "1" ]] && return 0
  "$@"
}

cleanup_build_cache() {
  run_cleanup_command build_cache "$DOCKER_BIN" builder prune --all --force --filter "until=$BUILD_CACHE_RETENTION"
}

container_image_ids() {
  local reference
  local image_id
  while IFS= read -r reference; do
    [[ -n "$reference" ]] || continue
    image_id="$($DOCKER_BIN image inspect --format '{{.Id}}' "$reference" 2>/dev/null || true)"
    [[ -n "$image_id" ]] && printf '%s\n' "$image_id"
  done < <("$DOCKER_BIN" ps -a --format '{{.Image}}')
}

managed_image_records() {
  local image_id
  local inspection
  local created
  local tags
  local created_epoch
  {
    "$DOCKER_BIN" image ls --no-trunc --quiet --filter 'reference=traffic-armour-app:*'
    "$DOCKER_BIN" image ls --no-trunc --quiet --filter 'reference=traffic-armour-build:*'
  } | awk 'NF && !seen[$0]++' | while IFS= read -r image_id; do
    inspection="$($DOCKER_BIN image inspect --format '{{.Id}}|{{.Created}}|{{join .RepoTags ","}}' "$image_id" 2>/dev/null || true)"
    [[ -n "$inspection" ]] || continue
    IFS='|' read -r image_id created tags <<< "$inspection"
    created_epoch="$(date -u -d "$created" +%s 2>/dev/null || true)"
    [[ -n "$created_epoch" ]] || continue
    printf '%s|%s|%s\n' "$created_epoch" "$image_id" "$tags"
  done | sort -t '|' -k1,1nr
}

cleanup_managed_images() {
  local now_epoch="${TAH_MAINTENANCE_TEST_NOW_EPOCH:-$(date -u +%s)}"
  local cutoff_epoch=$(( now_epoch - IMAGE_RETENTION_HOURS * 3600 ))
  local rank=0
  local removed=0
  local created_epoch
  local image_id
  local tags
  declare -A protected=()

  while IFS= read -r image_id; do
    [[ -n "$image_id" ]] && protected["$image_id"]=1
  done < <(container_image_ids | awk 'NF && !seen[$0]++')

  while IFS='|' read -r created_epoch image_id tags; do
    [[ -n "$image_id" ]] || continue
    rank=$(( rank + 1 ))
    if (( rank <= KEEP_APP_IMAGES )); then
      protected["$image_id"]=1
      log info image_retained "reason=newest image=$tags"
      continue
    fi
    if [[ -n "${protected[$image_id]:-}" ]]; then
      log info image_retained "reason=container_reference image=$tags"
      continue
    fi
    if (( created_epoch > cutoff_epoch )); then
      log info image_retained "reason=retention_window image=$tags"
      continue
    fi
    run_cleanup_command old_application_image "$DOCKER_BIN" image rm "$image_id"
    removed=$(( removed + 1 ))
  done < <(managed_image_records)

  run_cleanup_command dangling_images "$DOCKER_BIN" image prune --force --filter "until=${IMAGE_RETENTION_HOURS}h"
  log info image_cleanup_complete "candidate_count=$removed"
}

container_release_directories() {
  local releases_real="$1"
  local container_id
  local source_path
  local relative
  local release_name
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    while IFS= read -r source_path; do
      [[ "$source_path" == "$releases_real/"* ]] || continue
      relative="${source_path#"$releases_real/"}"
      release_name="${relative%%/*}"
      [[ -n "$release_name" ]] && printf '%s/%s\n' "$releases_real" "$release_name"
    done < <("$DOCKER_BIN" inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$container_id" 2>/dev/null || true)
  done < <("$DOCKER_BIN" ps -aq)
}

container_image_release_directories() {
  local releases_real="$1"
  local release_dir
  local environment_file
  local image_tag
  local image_reference
  declare -A active_image_references=()

  while IFS= read -r image_reference; do
    [[ -n "$image_reference" ]] && active_image_references["$image_reference"]=1
  done < <("$DOCKER_BIN" ps -a --format '{{.Image}}')

  while IFS= read -r release_dir; do
    environment_file="$release_dir/.env.production"
    [[ -f "$environment_file" ]] || continue
    image_tag="$(sed -n 's/^TAH_IMAGE_TAG=//p' "$environment_file" | tail -n 1)"
    [[ -n "$image_tag" ]] || continue
    image_reference="traffic-armour-app:$image_tag"
    [[ -n "${active_image_references[$image_reference]:-}" ]] && printf '%s\n' "$release_dir"
  done < <(find "$releases_real" -mindepth 1 -maxdepth 1 -type d -print)
}

cleanup_old_releases() {
  [[ -d "$RELEASES_ROOT" ]] || return 0
  local releases_real
  local release_count
  local current_real
  local row
  local release_dir
  local release_real
  local rank=0
  local removed=0
  declare -A protected=()

  releases_real="$(realpath -e "$RELEASES_ROOT")"
  if [[ "$ALLOW_CUSTOM_RELEASES_ROOT" != "1" && "$releases_real" != "/opt/link-suffix/releases" ]]; then
    fail "refusing release cleanup outside /opt/link-suffix/releases"
  fi
  release_count="$(find "$releases_real" -mindepth 1 -maxdepth 1 -type d -printf '.\n' | wc -l)"
  if (( release_count <= KEEP_RELEASES )); then
    log info release_cleanup_complete "candidate_count=0"
    return 0
  fi
  current_real="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  [[ -n "$current_real" ]] && protected["$current_real"]=1
  while IFS= read -r release_dir; do
    [[ -n "$release_dir" ]] && protected["$release_dir"]=1
  done < <({
    container_release_directories "$releases_real"
    container_image_release_directories "$releases_real"
  } | awk 'NF && !seen[$0]++')

  while IFS= read -r row; do
    release_dir="${row#*|}"
    release_real="$(realpath -e "$release_dir")"
    rank=$(( rank + 1 ))
    if (( rank <= KEEP_RELEASES )) || [[ -n "${protected[$release_real]:-}" ]]; then
      log info release_retained "release=$release_real"
      continue
    fi
    [[ "$(dirname "$release_real")" == "$releases_real" ]] || fail "unsafe release path: $release_real"
    run_cleanup_command old_release rm -rf --one-file-system -- "$release_real"
    removed=$(( removed + 1 ))
  done < <(find "$releases_real" -mindepth 1 -maxdepth 1 -type d -printf '%T@|%p\n' | sort -t '|' -k1,1nr)
  log info release_cleanup_complete "candidate_count=$removed"
}

main() {
  validate_configuration

  if [[ "$DISABLE_LOCK" != "1" ]]; then
    command -v flock >/dev/null 2>&1 || fail "flock is required"
    mkdir -p "$(dirname "$LOCK_FILE")"
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
      log info skipped "reason=already_running"
      exit 0
    fi
  fi

  local initial_metrics
  local used_percent
  local available_gb
  local load_metrics
  local load_one
  local cpu_count
  initial_metrics="$(read_disk_metrics initial)"
  IFS=' ' read -r used_percent available_gb <<< "$initial_metrics"
  load_metrics="$(read_load_metrics)"
  IFS=' ' read -r load_one cpu_count <<< "$load_metrics"

  log info audit "disk_used_percent=$used_percent disk_available_gb=$available_gb load_one=$load_one cpu_count=$cpu_count"

  if deployment_is_active; then
    write_status skipped_deployment "$used_percent" "$available_gb" "deployment_in_progress"
    log info skipped "reason=deployment_in_progress"
    exit 0
  fi

  if awk -v load_value="$load_one" -v cpus="$cpu_count" -v maximum="$MAX_LOAD_PER_CPU" 'BEGIN { exit !((load_value / cpus) > maximum) }'; then
    write_status skipped_load "$used_percent" "$available_gb" "host_load_above_guard"
    log warning skipped "reason=host_load_above_guard load_per_cpu=$(awk -v load_value="$load_one" -v cpus="$cpu_count" 'BEGIN { printf "%.3f", load_value / cpus }')"
    exit 0
  fi

  if (( used_percent < DISK_TRIGGER_PERCENT && available_gb > MIN_AVAILABLE_GB )); then
    write_status healthy "$used_percent" "$available_gb" "below_cleanup_threshold"
    log info no_cleanup "reason=below_threshold"
    exit 0
  fi

  command -v "$DOCKER_BIN" >/dev/null 2>&1 || fail "docker command is unavailable"
  "$DOCKER_BIN" info >/dev/null

  cleanup_build_cache
  cleanup_old_releases

  local after_cache_metrics
  after_cache_metrics="$(read_disk_metrics after_cache)"
  IFS=' ' read -r used_percent available_gb <<< "$after_cache_metrics"
  log info post_cache "disk_used_percent=$used_percent disk_available_gb=$available_gb"

  if (( used_percent > DISK_TARGET_PERCENT || available_gb <= MIN_AVAILABLE_GB )); then
    cleanup_managed_images
  fi

  local final_metrics
  final_metrics="$(read_disk_metrics after_images)"
  IFS=' ' read -r used_percent available_gb <<< "$final_metrics"
  if (( used_percent >= DISK_TRIGGER_PERCENT || available_gb <= MIN_AVAILABLE_GB )); then
    write_status attention "$used_percent" "$available_gb" "safe_cleanup_completed_but_pressure_remains"
    log warning cleanup_complete "state=attention disk_used_percent=$used_percent disk_available_gb=$available_gb"
  else
    write_status healthy "$used_percent" "$available_gb" "safe_cleanup_completed"
    log info cleanup_complete "state=healthy disk_used_percent=$used_percent disk_available_gb=$available_gb"
  fi
}

main "$@"
