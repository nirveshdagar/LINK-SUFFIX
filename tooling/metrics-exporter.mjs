import { createServer } from "node:http";
import pg from "pg";
import { createClient } from "redis";

const { Pool } = pg;
const HOST = process.env.TAH_METRICS_HOST || "0.0.0.0";
const PORT = Number(process.env.TAH_METRICS_PORT || 3198);
const TIMEOUT_MS = Number(process.env.TAH_METRICS_QUERY_TIMEOUT_MS || 5_000);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required by the metrics exporter");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.TAH_DATABASE_SSL === "true"
    ? { rejectUnauthorized: process.env.TAH_DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
    : undefined,
  max: 2,
  connectionTimeoutMillis: TIMEOUT_MS,
  statement_timeout: TIMEOUT_MS,
  application_name: "traffic-armour-metrics",
});
pool.on("error", (error) => console.error("[metrics] PostgreSQL pool error:", error.message));

let redis = null;
if (process.env.REDIS_URL) {
  redis = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: TIMEOUT_MS, reconnectStrategy: (retries) => Math.min(5_000, 100 * 2 ** Math.min(retries, 6)) },
  });
  redis.on("error", (error) => console.error("[metrics] Redis error:", error.message));
  await redis.connect();
}

const metric = (name, value, type = "gauge") => `# TYPE ${name} ${type}\n${name} ${Number(value) || 0}\n`;

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collectMetrics() {
  let databaseUp = 0;
  let redisUp = redis ? 0 : 1;
  const values = {
    leader: 0,
    targets: 0,
    pending: 0,
    leased: 0,
    failed: 0,
    dead: 0,
    workerFailures: 0,
    stalePollShards: 0,
    staleAckShards: 0,
    proxyEvents: 0,
    proxyFailures: 0,
  };

  try {
    const result = await withTimeout(pool.query(`
      SELECT
        (SELECT COUNT(*) FROM tah_leader_leases WHERE expires_at > NOW())::bigint AS leaders,
        (SELECT COUNT(*) FROM tah_campaign_targets WHERE enabled = TRUE)::bigint AS targets,
        (SELECT COUNT(*) FROM tah_delivery_jobs WHERE state = 'pending')::bigint AS pending,
        (SELECT COUNT(*) FROM tah_delivery_jobs WHERE state = 'leased')::bigint AS leased,
        (SELECT COUNT(*) FROM tah_delivery_jobs WHERE state = 'failed')::bigint AS failed,
        (SELECT COUNT(*) FROM tah_delivery_jobs WHERE state = 'dead')::bigint AS dead,
        (SELECT COALESCE(SUM(attempt_count), 0) FROM tah_delivery_jobs WHERE state IN ('failed', 'dead'))::bigint AS worker_failures,
        (SELECT COUNT(*) FROM tah_script_shards WHERE enabled = TRUE AND (last_poll_at IS NULL OR last_poll_at < NOW() - INTERVAL '5 minutes'))::bigint AS stale_poll_shards,
        (SELECT COUNT(DISTINCT target.shard_id)
           FROM tah_delivery_jobs job
           JOIN tah_campaign_targets target ON target.target_id = job.target_id
          WHERE job.state = 'leased'
            AND job.leased_at < NOW() - INTERVAL '5 minutes')::bigint AS stale_ack_shards,
        (SELECT COUNT(*) FROM tah_control_events WHERE event_type ~* 'proxy')::bigint AS proxy_events,
        (SELECT COUNT(*) FROM tah_control_events WHERE event_type ~* 'proxy.*(fail|error)|(?:fail|error).*proxy')::bigint AS proxy_failures
    `), "PostgreSQL metrics query");
    const row = result.rows[0] || {};
    databaseUp = 1;
    for (const [key, value] of Object.entries(row)) {
      const destination = {
        leaders: "leader",
        targets: "targets",
        pending: "pending",
        leased: "leased",
        failed: "failed",
        dead: "dead",
        worker_failures: "workerFailures",
        stale_poll_shards: "stalePollShards",
        stale_ack_shards: "staleAckShards",
        proxy_events: "proxyEvents",
        proxy_failures: "proxyFailures",
      }[key];
      if (destination) values[destination] = Number(value);
    }
  } catch (error) {
    console.error("[metrics] Collection failed:", error.message);
  }

  if (redis) {
    try {
      redisUp = await withTimeout(redis.ping(), "Redis ping") === "PONG" ? 1 : 0;
    } catch {
      redisUp = 0;
    }
  }

  return [
    metric("tah_database_up", databaseUp),
    metric("tah_redis_up", redisUp),
    metric("tah_control_leader", values.leader > 0 ? 1 : 0),
    metric("tah_script_targets_enabled", values.targets),
    metric("tah_script_pending_jobs", values.pending),
    metric("tah_script_leased_jobs", values.leased),
    metric("tah_script_failed_jobs", values.failed),
    metric("tah_script_dead_jobs", values.dead),
    metric("tah_worker_failures_total", values.workerFailures, "counter"),
    metric("tah_script_stale_poll_shards", values.stalePollShards),
    metric("tah_script_stale_ack_shards", values.staleAckShards),
    metric("tah_proxy_requests_total", values.proxyEvents, "counter"),
    metric("tah_proxy_failures_total", values.proxyFailures, "counter"),
  ].join("");
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" || !["/metrics", "/healthz"].includes(request.url || "")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }
  const body = await collectMetrics();
  const healthy = body.includes("tah_database_up 1") && body.includes("tah_redis_up 1");
  if (request.url === "/healthz") {
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: healthy }));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
  response.end(body);
});

server.listen(PORT, HOST, () => console.log(`metrics exporter listening on http://${HOST}:${PORT}`));

async function shutdown() {
  server.close();
  if (redis?.isOpen) await redis.quit().catch(() => redis.disconnect());
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
