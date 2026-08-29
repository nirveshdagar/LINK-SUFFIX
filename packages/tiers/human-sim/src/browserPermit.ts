import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface BrowserPermit {
  slot: number;
  release: () => void;
}

export interface BrowserPermitOptions {
  permitDir?: string;
  maxPermits?: number;
  pollMs?: number;
  timeoutMs?: number;
  staleMs?: number;
  runId?: string;
}

function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupAbandonedPermits(permitDir: string, staleMs: number): void {
  const now = Date.now();
  for (const name of readdirSync(permitDir)) {
    if (!/^permit-\d+\.lock$/.test(name)) continue;
    const file = path.join(permitDir, name);
    try {
      const metadata = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
      if (processAlive(Number(metadata.pid))) continue;
      if (now - statSync(file).mtimeMs < staleMs && metadata.pid === undefined) continue;
      unlinkSync(file);
    } catch {
      try {
        if (now - statSync(file).mtimeMs >= staleMs) unlinkSync(file);
      } catch {
        // Another process released or replaced the permit.
      }
    }
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function acquireBrowserPermit(options: BrowserPermitOptions = {}): Promise<BrowserPermit> {
  const root = process.env.WORKSPACE_ROOT ?? process.cwd();
  const permitDir = options.permitDir
    ?? process.env.TAH_BROWSER_PERMIT_DIR
    ?? path.join(root, 'runs', 'browser-permits');
  const maxPermits = positiveInteger(
    options.maxPermits ?? process.env.TAH_BROWSER_PERMITS ?? process.env.TAH_MAX_BROWSER_CONCURRENCY,
    8,
    1,
    5_000,
  );
  const pollMs = positiveInteger(options.pollMs ?? process.env.TAH_BROWSER_PERMIT_POLL_MS, 125, 10, 5_000);
  const timeoutMs = positiveInteger(options.timeoutMs ?? process.env.TAH_BROWSER_PERMIT_TIMEOUT_MS, 300_000, 1_000, 3_600_000);
  const staleMs = positiveInteger(options.staleMs ?? process.env.TAH_BROWSER_PERMIT_STALE_MS, 600_000, 30_000, 7_200_000);
  const startedAt = Date.now();
  let lastCleanupAt = 0;
  mkdirSync(permitDir, { recursive: true });

  while (Date.now() - startedAt < timeoutMs) {
    if (Date.now() - lastCleanupAt >= 5_000) {
      cleanupAbandonedPermits(permitDir, staleMs);
      lastCleanupAt = Date.now();
    }
    for (let slot = 0; slot < maxPermits; slot += 1) {
      const file = path.join(permitDir, `permit-${slot}.lock`);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(file, 'wx', 0o600);
        writeFileSync(descriptor, JSON.stringify({
          pid: process.pid,
          runId: options.runId ?? process.env.TAH_RUN_ID ?? '',
          acquiredAt: new Date().toISOString(),
        }));
        closeSync(descriptor);
        descriptor = undefined;
        let released = false;
        return {
          slot,
          release: () => {
            if (released) return;
            released = true;
            try { unlinkSync(file); } catch { /* already released or reclaimed */ }
          },
        };
      } catch (error: unknown) {
        if (descriptor !== undefined) {
          try { closeSync(descriptor); } catch { /* descriptor already closed */ }
          try { unlinkSync(file); } catch { /* no partial permit remained */ }
        }
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
    }
    await wait(pollMs);
  }

  throw new Error(`Browser permit wait exceeded ${timeoutMs}ms (${maxPermits} permits)`);
}
