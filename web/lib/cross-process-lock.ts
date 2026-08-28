import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import pg, { type Pool } from "pg";

const { Pool: PgPool } = pg;
const localTails = new Map<string, Promise<void>>();
let pool: Pool | null = null;

function databasePool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new PgPool({
      connectionString: process.env.DATABASE_URL,
      max: Math.max(2, Number(process.env.TAH_LOCK_DB_POOL_SIZE) || 4),
      connectionTimeoutMillis: Math.max(2_000, Number(process.env.TAH_DB_CONNECT_TIMEOUT_MS) || 10_000),
      idleTimeoutMillis: 30_000,
      ssl: process.env.TAH_DATABASE_SSL === "1" ? { rejectUnauthorized: process.env.TAH_DATABASE_SSL_REJECT_UNAUTHORIZED !== "0" } : undefined,
    });
    pool.on("error", () => { const failed = pool; pool = null; void failed?.end().catch(() => undefined); });
  }
  return pool;
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function lockName(key: string) { return createHash("sha256").update(key).digest("hex"); }

async function withDatabaseLock<T>(key: string, work: () => Promise<T>) {
  const currentPool = databasePool();
  if (!currentPool) return null;
  const client = await currentPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    return { value: await work() };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
    client.release();
  }
}

async function withFileLock<T>(key: string, work: () => Promise<T>) {
  const directory = path.join(process.env.WORKSPACE_ROOT || process.cwd(), ".runtime", "locks");
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, `${lockName(key)}.lock`);
  const timeoutMs = Math.max(1_000, Number(process.env.TAH_FILE_LOCK_TIMEOUT_MS) || 30_000);
  const staleMs = Math.max(timeoutMs, Number(process.env.TAH_FILE_LOCK_STALE_MS) || 120_000);
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const metadata = JSON.parse(await readFile(lockPath, "utf8")) as { createdAt?: number };
        if (!metadata.createdAt || Date.now() - metadata.createdAt > staleMs) { await rm(lockPath, { force: true }); continue; }
      } catch { await rm(lockPath, { force: true }); continue; }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${key}`);
      await delay(25 + Math.floor(Math.random() * 50));
    }
  }
  try { return await work(); }
  finally { await handle.close().catch(() => undefined); await rm(lockPath, { force: true }).catch(() => undefined); }
}

export async function withCrossProcessLock<T>(key: string, work: () => Promise<T>) {
  const previous = localTails.get(key) || Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => tail);
  localTails.set(key, queued);
  await previous.catch(() => undefined);
  try {
    try {
      const databaseResult = await withDatabaseLock(key, work);
      if (databaseResult) return databaseResult.value;
    } catch (error) {
      if (process.env.TAH_DISTRIBUTED_REQUIRED === "1") throw error;
    }
    return await withFileLock(key, work);
  } finally {
    release();
    if (localTails.get(key) === queued) localTails.delete(key);
  }
}
