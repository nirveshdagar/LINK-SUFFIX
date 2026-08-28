import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const DEFAULT_LEASE_MS = 15_000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 120_000;
const MAX_EVENT_BYTES = 256 * 1024;

function boundedLeaseMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LEASE_MS;
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.trunc(parsed)));
}

function sslConfig() {
  if (process.env.TAH_DATABASE_SSL !== "true") return undefined;
  return { rejectUnauthorized: process.env.TAH_DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" };
}

function safePayload(value) {
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES) {
    throw new Error(`Distributed payload exceeds ${MAX_EVENT_BYTES} bytes`);
  }
  return JSON.parse(encoded);
}

async function createRedisClient(redisUrl) {
  if (!redisUrl) return null;
  const { createClient } = await import("redis");
  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: Number(process.env.TAH_REDIS_CONNECT_TIMEOUT_MS || 5_000),
      reconnectStrategy(retries) {
        return Math.min(5_000, 100 * 2 ** Math.min(retries, 6));
      },
    },
  });
  client.on("error", (error) => {
    console.error("[distributed-store] Redis error:", error?.message || error);
  });
  await client.connect();
  return client;
}

export async function createDistributedControlStore({
  databaseUrl = process.env.DATABASE_URL,
  redisUrl = process.env.REDIS_URL,
  instanceId = process.env.TAH_INSTANCE_ID || randomUUID(),
  stateName = process.env.TAH_CONTROL_STATE_NAME || "control",
  leaseName = process.env.TAH_CONTROL_LEASE_NAME || "control-leader",
} = {}) {
  if (!databaseUrl) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required for production control state");
    }

    const memoryStates = new Map();
    let memoryLeader = false;
    return {
      enabled: false,
      instanceId,
      async acquireLeader() {
        memoryLeader = true;
        return true;
      },
      async renewLeader() {
        return memoryLeader;
      },
      async releaseLeader() {
        memoryLeader = false;
      },
      async loadState(nameOrFallback) {
        if (typeof nameOrFallback === "string") {
          return memoryStates.has(nameOrFallback) ? structuredClone(memoryStates.get(nameOrFallback)) : null;
        }
        return memoryStates.has(stateName) ? structuredClone(memoryStates.get(stateName)) : nameOrFallback;
      },
      async saveState(nameOrState, stateOrMetadata) {
        if (!memoryLeader) throw new Error("Cannot save control state without leadership");
        const requestedName = typeof nameOrState === "string" ? nameOrState : stateName;
        const state = typeof nameOrState === "string" ? stateOrMetadata : nameOrState;
        memoryStates.set(requestedName, structuredClone(state));
        return { version: 1, fencingToken: 1 };
      },
      async appendEvent(_type, _payload) {},
      async health() {
        return { postgres: false, redis: false, leader: memoryLeader, fencingToken: memoryLeader ? 1 : null };
      },
      async close() {
        memoryLeader = false;
      },
    };
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslConfig(),
    max: Number(process.env.TAH_CONTROL_DB_POOL_SIZE || 5),
    connectionTimeoutMillis: Number(process.env.TAH_DATABASE_CONNECT_TIMEOUT_MS || 5_000),
    idleTimeoutMillis: 30_000,
    application_name: `traffic-armour-control:${instanceId}`,
  });
  pool.on("error", (error) => {
    console.error("[distributed-store] PostgreSQL pool error:", error?.message || error);
  });

  await pool.query("SELECT 1");
  const redis = await createRedisClient(redisUrl);
  let fencingToken = null;
  let closed = false;

  async function acquireLeader(ttlMs = DEFAULT_LEASE_MS) {
    if (closed) return false;
    const leaseMs = boundedLeaseMs(ttlMs);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tah_leader_leases (lease_name, owner_id, fencing_token, expires_at)
         VALUES ($1, '', 0, NOW())
         ON CONFLICT (lease_name) DO NOTHING`,
        [leaseName],
      );
      const current = await client.query(
        `SELECT owner_id, fencing_token, expires_at
           FROM tah_leader_leases
          WHERE lease_name = $1
          FOR UPDATE`,
        [leaseName],
      );
      const row = current.rows[0];
      const expired = !row?.expires_at || new Date(row.expires_at).getTime() <= Date.now();
      if (row?.owner_id && row.owner_id !== instanceId && !expired) {
        await client.query("ROLLBACK");
        fencingToken = null;
        return false;
      }
      const nextToken = row?.owner_id === instanceId && !expired
        ? Number(row.fencing_token)
        : Number(row?.fencing_token || 0) + 1;
      await client.query(
        `UPDATE tah_leader_leases
            SET owner_id = $2,
                fencing_token = $3,
                expires_at = NOW() + ($4 * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE lease_name = $1`,
        [leaseName, instanceId, nextToken, leaseMs],
      );
      await client.query("COMMIT");
      fencingToken = nextToken;
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function renewLeader(ttlMs = DEFAULT_LEASE_MS) {
    if (closed || fencingToken === null) return false;
    const result = await pool.query(
      `UPDATE tah_leader_leases
          SET expires_at = NOW() + ($4 * INTERVAL '1 millisecond'),
              updated_at = NOW()
        WHERE lease_name = $1
          AND owner_id = $2
          AND fencing_token = $3
          AND expires_at > NOW()
      RETURNING fencing_token`,
      [leaseName, instanceId, fencingToken, boundedLeaseMs(ttlMs)],
    );
    if (result.rowCount !== 1) fencingToken = null;
    return result.rowCount === 1;
  }

  async function releaseLeader() {
    if (closed || fencingToken === null) return;
    await pool.query(
      `UPDATE tah_leader_leases
          SET owner_id = '', expires_at = NOW(), updated_at = NOW()
        WHERE lease_name = $1 AND owner_id = $2 AND fencing_token = $3`,
      [leaseName, instanceId, fencingToken],
    );
    fencingToken = null;
  }

  async function loadState(nameOrFallback) {
    const requestedName = typeof nameOrFallback === "string" ? nameOrFallback : stateName;
    const fallback = typeof nameOrFallback === "string" ? null : nameOrFallback;
    const result = await pool.query(
      "SELECT payload FROM tah_control_state WHERE name = $1",
      [requestedName],
    );
    return result.rows[0]?.payload ?? fallback;
  }

  async function saveState(nameOrState, stateOrMetadata) {
    if (closed || fencingToken === null) {
      throw new Error("Cannot save control state without an active fenced leader lease");
    }
    const requestedName = typeof nameOrState === "string" ? nameOrState : stateName;
    const state = typeof nameOrState === "string" ? stateOrMetadata : nameOrState;
    const payload = safePayload(state);
    const result = await pool.query(
      `INSERT INTO tah_control_state (name, payload, version, updated_at, updated_by, fencing_token)
       SELECT $1, $2::jsonb, 1, NOW(), $3, $4
         FROM tah_leader_leases
        WHERE lease_name = $5
          AND owner_id = $3
          AND fencing_token = $4
          AND expires_at > NOW()
       ON CONFLICT (name) DO UPDATE
         SET payload = EXCLUDED.payload,
             version = tah_control_state.version + 1,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by,
             fencing_token = EXCLUDED.fencing_token
       WHERE tah_control_state.fencing_token <= EXCLUDED.fencing_token
       RETURNING version, fencing_token`,
      [requestedName, JSON.stringify(payload), instanceId, fencingToken, leaseName],
    );
    if (result.rowCount !== 1) {
      fencingToken = null;
      throw new Error("Control-state write rejected because leadership was lost");
    }
    return {
      version: Number(result.rows[0].version),
      fencingToken: Number(result.rows[0].fencing_token),
    };
  }

  async function appendEvent(type, payload) {
    const eventType = String(type || "event").slice(0, 120);
    const safe = safePayload(payload);
    await pool.query(
      `INSERT INTO tah_control_events (event_type, payload, instance_id)
       VALUES ($1, $2::jsonb, $3)`,
      [eventType, JSON.stringify(safe), instanceId],
    );
    if (redis?.isReady) {
      await redis.xAdd(
        process.env.TAH_CONTROL_EVENT_STREAM || "tah:control:events",
        "*",
        { type: eventType, payload: JSON.stringify(safe), instanceId },
        { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10_000 } },
      ).catch((error) => {
        console.error("[distributed-store] Redis event append failed:", error?.message || error);
      });
    }
  }

  async function health() {
    let postgres = false;
    let redisHealthy = !redisUrl;
    let lease = null;
    try {
      await pool.query("SELECT 1");
      postgres = true;
      const result = await pool.query(
        `SELECT owner_id, fencing_token, expires_at > NOW() AS active
           FROM tah_leader_leases WHERE lease_name = $1`,
        [leaseName],
      );
      lease = result.rows[0] || null;
    } catch {}
    if (redis) {
      try {
        redisHealthy = (await redis.ping()) === "PONG";
      } catch {
        redisHealthy = false;
      }
    }
    return {
      postgres,
      redis: redisHealthy,
      leader: Boolean(lease?.active),
      leaderOwner: lease?.owner_id || null,
      fencingToken: lease?.fencing_token === undefined ? null : Number(lease.fencing_token),
      thisInstanceIsLeader: Boolean(lease?.active && lease.owner_id === instanceId && Number(lease.fencing_token) === fencingToken),
    };
  }

  async function close() {
    if (closed) return;
    await releaseLeader().catch(() => {});
    closed = true;
    if (redis?.isOpen) await redis.quit().catch(() => redis.disconnect());
    await pool.end();
  }

  return {
    enabled: true,
    instanceId,
    acquireLeader,
    renewLeader,
    releaseLeader,
    loadState,
    saveState,
    appendEvent,
    health,
    close,
  };
}
