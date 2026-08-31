import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "../..");
const maintenanceScript = path.join(projectRoot, "ops", "storage-maintenance.sh");
const installerScript = path.join(projectRoot, "ops", "install-storage-maintenance.sh");
const serviceFile = path.join(projectRoot, "ops", "systemd", "link-suffix-storage-maintenance.service");
const timerFile = path.join(projectRoot, "ops", "systemd", "link-suffix-storage-maintenance.timer");

function findBash() {
  const candidates = [
    process.env.GIT_BASH_PATH,
    process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : undefined,
    "bash",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("Bash is required to test storage maintenance");
}

const bash = findBash();

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "link-suffix-maintenance-"));
  roots.push(root);
  const mockDocker = path.join(root, "docker-mock.sh");
  const dockerLog = path.join(root, "docker.log");
  const releases = path.join(root, "releases");
  const status = path.join(root, "status", "status.env");
  mkdirSync(releases, { recursive: true });
  writeFileSync(mockDocker, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
if [[ "$1" == "info" ]]; then exit 0; fi
if [[ "$1 $2" == "builder prune" ]]; then echo "mock cache reclaimed"; exit 0; fi
if [[ "$1" == "ps" && "$*" == *"--format {{.Image}}"* ]]; then
  [[ -n "\${MOCK_ACTIVE_IMAGE_REF:-}" ]] && echo "$MOCK_ACTIVE_IMAGE_REF"
  exit 0
fi
if [[ "$1" == "ps" && "$*" == *"-aq"* ]]; then exit 0; fi
if [[ "$1 $2" == "image ls" ]]; then
  if [[ "$*" == *"traffic-armour-app"* ]]; then printf '%s' "\${MOCK_APP_IMAGE_IDS:-}"; fi
  if [[ "$*" == *"traffic-armour-build"* ]]; then printf '%s' "\${MOCK_BUILD_IMAGE_IDS:-}"; fi
  exit 0
fi
if [[ "$1 $2" == "image inspect" ]]; then
  ref="\${@: -1}"
  case "$ref" in
    traffic-armour-app:active) echo "sha256:active" ;;
    sha256:current) echo 'sha256:current|2026-09-01T00:00:00Z|traffic-armour-app:current' ;;
    sha256:previous) echo 'sha256:previous|2026-08-31T23:00:00Z|traffic-armour-app:previous' ;;
    sha256:active) echo 'sha256:active|2020-01-01T00:00:00Z|traffic-armour-app:active' ;;
    sha256:old) echo 'sha256:old|2020-01-01T00:00:00Z|traffic-armour-app:old' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "$1 $2" == "image rm" ]]; then echo "removed \${@: -1}"; exit 0; fi
if [[ "$1 $2" == "image prune" ]]; then echo "dangling removed"; exit 0; fi
if [[ "$1" == "inspect" ]]; then exit 0; fi
echo "unexpected docker command: $*" >&2
exit 64
`, { mode: 0o755 });

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TAH_MAINTENANCE_DOCKER_BIN: mockDocker,
    MOCK_DOCKER_LOG: dockerLog,
    TAH_MAINTENANCE_DISABLE_LOCK: "1",
    TAH_MAINTENANCE_SKIP_DEPLOYMENT_CHECK: "1",
    TAH_MAINTENANCE_ALLOW_CUSTOM_RELEASES_ROOT: "1",
    TAH_MAINTENANCE_RELEASES_ROOT: releases,
    TAH_MAINTENANCE_CURRENT_LINK: path.join(root, "current"),
    TAH_MAINTENANCE_STATUS_FILE: status,
    TAH_MAINTENANCE_TEST_LOAD_ONE: "0.1",
    TAH_MAINTENANCE_TEST_CPU_COUNT: "4",
    TAH_MAINTENANCE_TEST_NOW_EPOCH: String(Date.parse("2026-09-01T12:00:00Z") / 1000),
    TAH_MAINTENANCE_TEST_INITIAL_USED_PERCENT: "77",
    TAH_MAINTENANCE_TEST_INITIAL_AVAILABLE_GB: "36",
    TAH_MAINTENANCE_TEST_AFTER_CACHE_USED_PERCENT: "55",
    TAH_MAINTENANCE_TEST_AFTER_CACHE_AVAILABLE_GB: "70",
    TAH_MAINTENANCE_TEST_AFTER_IMAGES_USED_PERCENT: "55",
    TAH_MAINTENANCE_TEST_AFTER_IMAGES_AVAILABLE_GB: "70",
  };
  return { root, dockerLog, releases, status, baseEnv };
}

function runMaintenance(env: NodeJS.ProcessEnv) {
  return spawnSync(bash, [maintenanceScript], { env, encoding: "utf8" });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("guarded storage maintenance", () => {
  it("does nothing below the disk threshold", () => {
    const test = fixture();
    const result = runMaintenance({
      ...test.baseEnv,
      TAH_MAINTENANCE_TEST_INITIAL_USED_PERCENT: "60",
      TAH_MAINTENANCE_TEST_INITIAL_AVAILABLE_GB: "80",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("event=no_cleanup");
    expect(() => readFileSync(test.dockerLog, "utf8")).toThrow();
  });

  it("skips cleanup under sustained host load", () => {
    const test = fixture();
    const result = runMaintenance({ ...test.baseEnv, TAH_MAINTENANCE_TEST_LOAD_ONE: "4" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("reason=host_load_above_guard");
    expect(readFileSync(test.status, "utf8")).toContain("state=skipped_load");
    expect(() => readFileSync(test.dockerLog, "utf8")).toThrow();
  });

  it("skips cleanup while a deployment marker exists", () => {
    const test = fixture();
    const marker = path.join(test.root, "deploy.lock");
    writeFileSync(marker, "active");
    const result = runMaintenance({
      ...test.baseEnv,
      TAH_MAINTENANCE_SKIP_DEPLOYMENT_CHECK: "0",
      TAH_MAINTENANCE_DEPLOYMENT_MARKER: marker,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("reason=deployment_in_progress");
    expect(() => readFileSync(test.dockerLog, "utf8")).toThrow();
  });

  it("stops after cache cleanup reaches the disk target", () => {
    const test = fixture();
    const result = runMaintenance(test.baseEnv);
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(test.dockerLog, "utf8");
    expect(calls).toContain("builder prune --all --force --filter until=12h");
    expect(calls).not.toContain("image rm");
    expect(calls).not.toContain("image prune");
  });

  it("removes only old unreferenced application images", () => {
    const test = fixture();
    const result = runMaintenance({
      ...test.baseEnv,
      TAH_MAINTENANCE_KEEP_APP_IMAGES: "2",
      TAH_MAINTENANCE_TEST_AFTER_CACHE_USED_PERCENT: "72",
      TAH_MAINTENANCE_TEST_AFTER_CACHE_AVAILABLE_GB: "38",
      TAH_MAINTENANCE_TEST_AFTER_IMAGES_USED_PERCENT: "58",
      TAH_MAINTENANCE_TEST_AFTER_IMAGES_AVAILABLE_GB: "75",
      MOCK_ACTIVE_IMAGE_REF: "traffic-armour-app:active",
      MOCK_APP_IMAGE_IDS: "sha256:current\nsha256:previous\nsha256:active\nsha256:old\n",
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(test.dockerLog, "utf8");
    expect(calls).toContain("image rm sha256:old");
    expect(calls).not.toContain("image rm sha256:current");
    expect(calls).not.toContain("image rm sha256:previous");
    expect(calls).not.toContain("image rm sha256:active");
    expect(calls).toContain("image prune --force --filter until=12h");
  });

  it("retains an old release whose image is used by a running container", () => {
    const test = fixture();
    const releases: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const release = path.join(test.releases, `release-${index}`);
      mkdirSync(release);
      writeFileSync(path.join(release, ".env.production"), `TAH_IMAGE_TAG=${index === 0 ? "active" : `unused-${index}`}\n`);
      const modified = new Date(Date.UTC(2026, 7, 1 + index));
      utimesSync(release, modified, modified);
      releases.push(release);
    }
    const result = runMaintenance({ ...test.baseEnv, MOCK_ACTIVE_IMAGE_REF: "traffic-armour-app:active" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(releases[0])).toBe(true);
    expect(existsSync(releases[1])).toBe(false);
    expect(existsSync(releases[6])).toBe(true);
  });

  it("plans but does not execute destructive commands in dry-run mode", () => {
    const test = fixture();
    const result = runMaintenance({ ...test.baseEnv, TAH_MAINTENANCE_DRY_RUN: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("action=build_cache");
    const calls = readFileSync(test.dockerLog, "utf8");
    expect(calls).toBe("info\n");
  });

  it("contains no volume, container, system, process, or page-cache cleanup", () => {
    const source = readFileSync(maintenanceScript, "utf8");
    expect(source).not.toMatch(/docker\s+(volume|container|system)\s+prune/);
    expect(source).not.toMatch(/drop_caches|kill(all)?\b|swapoff|image\s+rm\s+--force/);
  });

  it("installs bounded service and persistent timer files into a staging root", () => {
    const test = fixture();
    const installRoot = path.join(test.root, "install-root");
    const result = spawnSync(bash, [installerScript], {
      env: { ...process.env, TAH_MAINTENANCE_INSTALL_ROOT: installRoot },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(installRoot, "usr/local/sbin/link-suffix-storage-maintenance"), "utf8")).toContain("cleanup_build_cache");
    expect(readFileSync(path.join(installRoot, "etc/systemd/system/link-suffix-storage-maintenance.service"), "utf8")).toContain("CPUQuota=20%");
    expect(readFileSync(path.join(installRoot, "etc/systemd/system/link-suffix-storage-maintenance.timer"), "utf8")).toContain("OnUnitInactiveSec=15min");
  });

  it("keeps the committed unit definitions resource bounded", () => {
    const service = readFileSync(serviceFile, "utf8");
    const timer = readFileSync(timerFile, "utf8");
    expect(service).toContain("MemoryMax=256M");
    expect(service).toContain("StateDirectory=link-suffix-maintenance");
    expect(service).toContain("IOSchedulingClass=idle");
    expect(service).toContain("NoNewPrivileges=true");
    expect(timer).toContain("Persistent=true");
  });
});
