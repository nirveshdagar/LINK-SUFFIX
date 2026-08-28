import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADDON_PATH = path.resolve(here, './ja3_addon.py');

export interface MitmOptions {
  upstreamUrl: string;
  listenPort: number;
}

export interface MitmHandle {
  proc: ReturnType<typeof spawn>;
  listenUrl: string;
  recorderPath: string;
  caCertPath: string;
  shutdown: () => Promise<void>;
}

export interface Ja3Record {
  timestamp: number;
  correlation_id: string;
  url: string;
  ja3_hash: string | null;
  ja3_raw: string | null;
  sni: string | null;
  tls_version: string | null;
  cipher_suites: number[];
  extensions: number[];
}

export async function startMitm(opts: MitmOptions): Promise<MitmHandle> {
  // Copy ja3_addon.py from src/ to dist/ if missing — survives npm run build but
  // not bare `tsc -b` invocations which wipe dist without re-running the copy step.
  const addonSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ja3_addon.py');
  const addonDist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ja3_addon.py');
  if (existsSync(addonSrc)) {
    copyFileSync(addonSrc, addonDist);
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'tah-mitm-'));
  const recorderPath = path.join(tmp, 'ja3.jsonl');
  const caCertPath = path.join(tmp, 'mitmproxy-ca-cert.pem');

  // mitmproxy's `--mode upstream:` rejects user:pass@ — extract host:port
  // and pass credentials via `--upstream-auth` separately.
  const upstream = new URL(opts.upstreamUrl);
  const upstreamAuth = upstream.username
    ? `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`
    : null;
  const upstreamHostPort = `${upstream.protocol}//${upstream.host}`;

  const args = [
    '-s', ADDON_PATH,
    '--mode', `upstream:${upstreamHostPort}`,
    '--listen-host', '127.0.0.1',
    '--listen-port', String(opts.listenPort),
    '--set', 'block_global=true',
    '--set', `confdir=${tmp}`,
  ];
  // Pass recorder path to the addon via env var (addon reads it).
  const proc = spawn(process.env.TAH_MITMDUMP_BIN ?? 'mitmdump', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TAH_JA3_RECORDER: recorderPath,
      TAH_MITM_UPSTREAM_AUTH: upstreamAuth ?? '',
    },
    windowsHide: true,
  });

  proc.stdout.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    if (s.includes('listening') || s.includes('error') || s.includes('Error')) {
      process.stderr.write(`[mitm] ${s}`);
    }
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[mitm] ${chunk.toString('utf8')}`);
  });

  const stopProcess = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    try { proc.kill('SIGTERM'); } catch { return; }
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, 5_000)),
    ]);
  };
  const cleanupTemp = () => rmSync(tmp, { recursive: true, force: true });

  try {
    await waitForPort('127.0.0.1', opts.listenPort, 30_000);
    await waitForCert(caCertPath, 30_000);
  } catch (error) {
    await stopProcess();
    cleanupTemp();
    throw error;
  }

  return {
    proc,
    listenUrl: `http://127.0.0.1:${opts.listenPort}`,
    recorderPath,
    caCertPath,
    shutdown: async () => {
      await stopProcess();
      cleanupTemp();
    },
  };
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const { createConnection } = await import('node:net');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const c = createConnection({ host, port }, () => { c.end(); resolve(); });
        c.on('error', reject);
      });
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mitmproxy did not listen on ${host}:${port} within ${timeoutMs}ms`);
}

async function waitForCert(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mitmproxy CA cert did not appear at ${path} within ${timeoutMs}ms`);
}

export function readJa3Records(recorderPath: string): Ja3Record[] {
  if (!existsSync(recorderPath)) return [];
  const text = readFileSync(recorderPath, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Ja3Record]; } catch { return []; }
    });
}

export async function waitForJa3Record(recorderPath: string, correlationId: string, timeoutMs = 2_000): Promise<Ja3Record | null> {
  const startedAt = Date.now();
  let offset = 0;
  let partial = '';
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(recorderPath)) {
      const size = statSync(recorderPath).size;
      if (size < offset) {
        offset = 0;
        partial = '';
      }
      const available = Math.min(size - offset, 1024 * 1024);
      if (available > 0) {
        const descriptor = openSync(recorderPath, 'r');
        try {
          const buffer = Buffer.allocUnsafe(available);
          const bytesRead = readSync(descriptor, buffer, 0, available, offset);
          offset += bytesRead;
          const lines = (partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) {
            try {
              const record = JSON.parse(line) as Ja3Record;
              if (record.correlation_id === correlationId) return record;
            } catch { /* an incomplete or corrupt line is not evidence */ }
          }
        } finally {
          closeSync(descriptor);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}
