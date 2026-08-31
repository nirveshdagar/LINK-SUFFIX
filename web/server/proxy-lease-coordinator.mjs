import { randomUUID } from "node:crypto";

export class ProxyLeaseUnavailableError extends Error {
  constructor(message = "No proxy endpoint is currently available") {
    super(message);
    this.name = "ProxyLeaseUnavailableError";
  }
}

function boundedTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl)) return 120_000;
  return Math.min(24 * 60 * 60_000, Math.max(10_000, Math.trunc(ttl)));
}

export function createMemoryProxyLeaseRepository({ now = () => Date.now() } = {}) {
  const leases = new Map();
  const activeEndpoints = new Map();
  let fence = 0;
  return {
    async reserve(input) {
      const activeId = activeEndpoints.get(input.endpointKey);
      const active = activeId ? leases.get(activeId) : null;
      if (active && active.state === "active" && active.expiresAt > now()) return null;
      if (active) {
        active.state = "expired";
        activeEndpoints.delete(input.endpointKey);
      }
      const lease = { ...input, fencingToken: ++fence, state: "active", createdAt: now(), expiresAt: now() + input.ttlMs };
      leases.set(input.leaseId, lease);
      activeEndpoints.set(input.endpointKey, input.leaseId);
      return structuredClone(lease);
    },
    async renew({ leaseId, ownerId, fencingToken, ttlMs }) {
      const lease = leases.get(leaseId);
      if (!lease || lease.state !== "active" || lease.ownerId !== ownerId || lease.fencingToken !== fencingToken || lease.expiresAt <= now()) return null;
      lease.expiresAt = now() + ttlMs;
      return structuredClone(lease);
    },
    async release({ leaseId, ownerId, fencingToken, state = "released" }) {
      const lease = leases.get(leaseId);
      if (!lease || lease.state !== "active" || lease.ownerId !== ownerId || lease.fencingToken !== fencingToken) return false;
      lease.state = state;
      lease.releasedAt = now();
      activeEndpoints.delete(lease.endpointKey);
      return true;
    },
    async get(leaseId) {
      const lease = leases.get(leaseId);
      return lease ? structuredClone(lease) : null;
    },
    async reapExpired() {
      let count = 0;
      for (const lease of leases.values()) {
        if (lease.state === "active" && lease.expiresAt <= now()) {
          lease.state = "expired";
          activeEndpoints.delete(lease.endpointKey);
          count += 1;
        }
      }
      return count;
    },
  };
}

export function createMemoryProxyLeaseLock({ now = () => Date.now() } = {}) {
  const locks = new Map();
  return {
    async acquire(key, value, ttlMs) {
      const current = locks.get(key);
      if (current && current.expiresAt > now()) return false;
      locks.set(key, { value, expiresAt: now() + ttlMs });
      return true;
    },
    async renew(key, value, ttlMs) {
      const current = locks.get(key);
      if (!current || current.value !== value || current.expiresAt <= now()) return false;
      current.expiresAt = now() + ttlMs;
      return true;
    },
    async release(key, value) {
      const current = locks.get(key);
      if (!current || current.value !== value) return false;
      locks.delete(key);
      return true;
    },
  };
}

export function createRedisProxyLeaseLock(redis, prefix = "tah:proxy:lease") {
  const renewScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
  const releaseScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
  return {
    async acquire(key, value, ttlMs) { return (await redis.set(`${prefix}:${key}`, value, { NX: true, PX: ttlMs })) === "OK"; },
    async renew(key, value, ttlMs) { return Number(await redis.eval(renewScript, { keys: [`${prefix}:${key}`], arguments: [value, String(ttlMs)] })) === 1; },
    async release(key, value) { return Number(await redis.eval(releaseScript, { keys: [`${prefix}:${key}`], arguments: [value] })) === 1; },
  };
}

function mapLease(row) {
  if (!row) return null;
  return {
    leaseId: String(row.lease_id), providerId: String(row.provider_id), poolId: String(row.pool_id), campaignId: String(row.campaign_record_id),
    endpointKey: String(row.endpoint_key), ownerId: String(row.owner_id), sessionId: row.session_id ? String(row.session_id) : undefined,
    rotationMode: String(row.rotation_mode), fencingToken: Number(row.fencing_token), state: String(row.state),
    createdAt: new Date(row.created_at).getTime(), expiresAt: new Date(row.expires_at).getTime(),
  };
}

export function createPostgresProxyLeaseRepository(pool) {
  return {
    async reserve(input) {
      await pool.query("UPDATE tah_proxy_leases SET state='expired', updated_at=NOW() WHERE state='active' AND expires_at<=NOW()");
      const result = await pool.query(
        `INSERT INTO tah_proxy_leases
          (lease_id, provider_id, pool_id, campaign_record_id, endpoint_key, owner_id, session_id, rotation_mode, expires_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()+($9*INTERVAL '1 millisecond'),$10::jsonb)
         ON CONFLICT DO NOTHING RETURNING *`,
        [input.leaseId, input.providerId, input.poolId, input.campaignId, input.endpointKey, input.ownerId, input.sessionId || null, input.rotationMode, input.ttlMs, JSON.stringify(input.metadata || {})],
      );
      return mapLease(result.rows[0]);
    },
    async renew({ leaseId, ownerId, fencingToken, ttlMs }) {
      const result = await pool.query(
        `UPDATE tah_proxy_leases SET expires_at=NOW()+($4*INTERVAL '1 millisecond'), updated_at=NOW()
          WHERE lease_id=$1 AND owner_id=$2 AND fencing_token=$3 AND state='active' AND expires_at>NOW() RETURNING *`,
        [leaseId, ownerId, fencingToken, ttlMs],
      );
      return mapLease(result.rows[0]);
    },
    async release({ leaseId, ownerId, fencingToken, state = "released" }) {
      const result = await pool.query(
        `UPDATE tah_proxy_leases SET state=$4, released_at=NOW(), updated_at=NOW()
          WHERE lease_id=$1 AND owner_id=$2 AND fencing_token=$3 AND state='active' RETURNING lease_id`,
        [leaseId, ownerId, fencingToken, state],
      );
      return result.rowCount === 1;
    },
    async get(leaseId) { return mapLease((await pool.query("SELECT * FROM tah_proxy_leases WHERE lease_id=$1", [leaseId])).rows[0]); },
    async reapExpired() { return (await pool.query("UPDATE tah_proxy_leases SET state='expired', updated_at=NOW() WHERE state='active' AND expires_at<=NOW() RETURNING lease_id")).rowCount; },
  };
}

/**
 * @param {{ repository: any, lock: any, ownerId?: string, idFactory?: () => string }} options
 */
export function createProxyLeaseCoordinator({ repository, lock, ownerId = randomUUID(), idFactory = randomUUID }) {
  if (!repository || !lock) throw new Error("Proxy lease coordinator requires repository and lock stores");
  const lockValue = (lease) => `${lease.leaseId}:${lease.ownerId}:${lease.fencingToken}`;
  return {
    async acquire(input) {
      const ttlMs = boundedTtl(input.ttlMs);
      const endpointKeys = [...new Set(input.endpointKeys || [])];
      if (!endpointKeys.length) throw new ProxyLeaseUnavailableError("Proxy pool contains no endpoints");
      for (const endpointKey of endpointKeys) {
        const lease = await repository.reserve({ ...input, endpointKey, ownerId, leaseId: idFactory(), ttlMs });
        if (!lease) continue;
        const locked = await lock.acquire(`${lease.providerId}:${lease.endpointKey}`, lockValue(lease), ttlMs);
        if (locked) return lease;
        await repository.release({ leaseId: lease.leaseId, ownerId, fencingToken: lease.fencingToken, state: "released" });
      }
      throw new ProxyLeaseUnavailableError();
    },
    async renew(lease, ttlValue) {
      const ttlMs = boundedTtl(ttlValue);
      const renewed = await repository.renew({ leaseId: lease.leaseId, ownerId, fencingToken: lease.fencingToken, ttlMs });
      if (!renewed) return null;
      if (await lock.renew(`${lease.providerId}:${lease.endpointKey}`, lockValue(lease), ttlMs)) return renewed;
      await repository.release({ leaseId: lease.leaseId, ownerId, fencingToken: lease.fencingToken, state: "expired" });
      return null;
    },
    async release(lease, state = "released") {
      const released = await repository.release({ leaseId: lease.leaseId, ownerId, fencingToken: lease.fencingToken, state });
      if (released) await lock.release(`${lease.providerId}:${lease.endpointKey}`, lockValue(lease));
      return released;
    },
    async reapExpired() { return repository.reapExpired(); },
    ownerId,
    repository,
  };
}
