import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
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
  url: string;
  ja3: string | null;
  ja3_hash: string | null;
  ja4: string | null;
  tls_version: string | null;
  cipher_suites: number[];
  extensions: number[];
}

export async function startMitm(opts: MitmOptions): Promise<MitmHandle> {
  // Copy ja3_addon.py from src/ to dist/ if missing — survives npm run build but
  // not bare `tsc -b` invocations which wipe dist without re-running the copy step.
  const addonSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ja3_addon.py');
  const addonDist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ja3_addon.py');
  if (existsSync(addonSrc) && !existsSync(addonDist)) {
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
    '--listen-port', String(opts.listenPort),
    '--set', 'block_global=false',
    '--set', 'ssl_insecure=true',
    '--set', `confdir=${tmp}`,
  ];
  if (upstreamAuth) args.push('--upstream-auth', upstreamAuth);

  // Pass recorder path to the addon via env var (addon reads it).
  const proc = spawn('mitmdump', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TAH_JA3_RECORDER: recorderPath },
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

  await waitForPort('127.0.0.1', opts.listenPort, 30_000);
  await waitForCert(caCertPath, 30_000);

  return {
    proc,
    listenUrl: `http://127.0.0.1:${opts.listenPort}`,
    recorderPath,
    caCertPath,
    shutdown: async () => {
      // Register exit listener BEFORE killing so a fast exit between
      // the call and listener attachment doesn't hang the caller.
      const exited = new Promise<void>((r) => proc.once('exit', () => r()));
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      await exited;
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
    .map((line) => JSON.parse(line) as Ja3Record);
}