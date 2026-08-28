import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const root = process.env.WORKSPACE_ROOT || process.cwd();
const migrationsDir = path.join(root, "migrations");
const connectionString = process.env.DATABASE_URL;

if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  max: 2,
  connectionTimeoutMillis: Math.max(2_000, Number(process.env.TAH_DB_CONNECT_TIMEOUT_MS) || 10_000),
  idleTimeoutMillis: 10_000,
  ssl: process.env.TAH_DATABASE_SSL === "1" ? { rejectUnauthorized: process.env.TAH_DATABASE_SSL_REJECT_UNAUTHORIZED !== "0" } : undefined,
});

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('traffic-armour-schema-migrations'))");
  await client.query("CREATE TABLE IF NOT EXISTS tah_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const appliedRows = await client.query("SELECT version FROM tah_schema_migrations");
  const applied = new Set(appliedRows.rows.map((row) => String(row.version)));
  const files = (await readdir(migrationsDir)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO tah_schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      process.stdout.write(`Applied ${file}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  try { await client.query("SELECT pg_advisory_unlock(hashtext('traffic-armour-schema-migrations'))"); } catch { /* connection may be gone */ }
  client.release();
  await pool.end();
}
