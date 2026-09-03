import http from "node:http";
import WebSocket from "ws";
import { Pool } from "pg";

const endpoint = process.env.TAH_ALERTS_INTERNAL_URL?.trim() || "http://127.0.0.1:3100/api/alerts";
const apiToken = process.env.TAH_API_BEARER_TOKEN?.trim() || process.env.CONTROL_TOKEN?.trim() || "";
const controlToken = process.env.CONTROL_TOKEN?.trim() || "";
const controlWsUrl = process.env.TAH_CONTROL_INTERNAL_WS_URL?.trim() || "ws://control:3101";
const controlOrigin = process.env.TAH_CONTROL_RECOVERY_ORIGIN?.trim()
  || process.env.CONTROL_ALLOWED_ORIGINS?.split(",")[0]?.trim()
  || process.env.TAH_PUBLIC_BASE_URL?.trim()
  || "http://127.0.0.1:3100";
const port = Math.max(1, Number(process.env.TAH_HEALTH_WATCHDOG_PORT) || 3197);
const intervalMs = Math.max(5_000, Number(process.env.TAH_HEALTH_INTERVAL_MS) || 15_000);
const recoveryEnabled = /^(1|true|yes)$/i.test(process.env.TAH_CAMPAIGN_SELF_HEAL_ENABLED?.trim() || "");
const recoveryWindowMs = Math.max(15 * 60_000, Number(process.env.TAH_CAMPAIGN_RECOVERY_WINDOW_MS) || 60 * 60_000);
const recoveryMaxAttempts = Math.max(1, Math.min(12, Number(process.env.TAH_CAMPAIGN_RECOVERY_MAX_ATTEMPTS) || 4));
const recoveryFreshnessMs = Math.max(intervalMs * 2, Number(process.env.TAH_CAMPAIGN_RECOVERY_ALERT_FRESHNESS_MS) || 45_000);
const recoveryBaseCooldownMs = Math.max(60_000, Number(process.env.TAH_CAMPAIGN_RECOVERY_BASE_COOLDOWN_MS) || 120_000);
const endpointHost = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
const loopbackEndpoint = endpointHost === "127.0.0.1" || endpointHost === "localhost" || endpointHost === "::1";
const databaseUrl = process.env.TAH_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || process.env.TAH_POSTGRES_ADMIN_URL?.trim()
  || "";
const recoveryPool = recoveryEnabled && databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 30_000 })
  : null;

let lastSuccessAt = 0;
let lastFailure = "Waiting for the first evaluation";
let lastRecoveryFailure = "";
let running = false;
let recoverySchemaReady;
let summary = { open: 0, critical: 0, warning: 0, observing: 0 };
const recovery = {
  attempted: 0,
  dispatched: 0,
  failed: 0,
  suppressed: 0,
  exhausted: 0,
  lastCampaignId: "",
  lastAttemptAt: 0,
};

if (!apiToken && !loopbackEndpoint) {
  console.error("health-watchdog requires CONTROL_TOKEN or TAH_API_BEARER_TOKEN");
  process.exit(1);
}
if (recoveryEnabled && (!controlToken || !recoveryPool)) {
  console.error("health-watchdog self-healing requires CONTROL_TOKEN and TAH_DATABASE_URL or DATABASE_URL");
  process.exit(1);
}

function authHeaders(extra = {}) {
  return {
    ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
    ...extra,
  };
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Health API returned HTTP ${response.status}`);
  return payload;
}

async function ensureRecoverySchema() {
  if (!recoveryPool) return;
  if (!recoverySchemaReady) {
    recoverySchemaReady = recoveryPool.query(`
      CREATE TABLE IF NOT EXISTS tah_campaign_recovery (
        campaign_record_id TEXT PRIMARY KEY,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ,
        last_fingerprint TEXT,
        last_result TEXT,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => undefined);
  }
  await recoverySchemaReady;
}

function cooldownMs(attemptNumber) {
  return Math.min(15 * 60_000, recoveryBaseCooldownMs * (2 ** Math.max(0, attemptNumber - 1)));
}

async function claimRecovery(campaignId, fingerprint) {
  await ensureRecoverySchema();
  const client = await recoveryPool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [`campaign-recovery:${campaignId}`],
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return { claimed: false, reason: "locked" };
    }
    await client.query(
      `INSERT INTO tah_campaign_recovery (campaign_record_id)
       VALUES ($1) ON CONFLICT (campaign_record_id) DO NOTHING`,
      [campaignId],
    );
    const stateResult = await client.query(
      `SELECT window_started_at, attempt_count, next_attempt_at
       FROM tah_campaign_recovery WHERE campaign_record_id = $1 FOR UPDATE`,
      [campaignId],
    );
    const state = stateResult.rows[0];
    const now = Date.now();
    const windowStartedAt = Date.parse(state.window_started_at);
    const windowExpired = !Number.isFinite(windowStartedAt) || now - windowStartedAt >= recoveryWindowMs;
    const attemptCount = windowExpired ? 0 : Number(state.attempt_count || 0);
    const nextAttemptAt = windowExpired || !state.next_attempt_at ? 0 : Date.parse(state.next_attempt_at);
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now) {
      await client.query("COMMIT");
      return { claimed: false, reason: "cooldown" };
    }
    if (attemptCount >= recoveryMaxAttempts) {
      await client.query("COMMIT");
      return { claimed: false, reason: "exhausted" };
    }
    const attemptNumber = attemptCount + 1;
    const nextAt = new Date(now + cooldownMs(attemptNumber));
    await client.query(
      `UPDATE tah_campaign_recovery
       SET window_started_at = CASE WHEN $2 THEN NOW() ELSE window_started_at END,
           attempt_count = $3,
           last_attempt_at = NOW(),
           next_attempt_at = $4,
           last_fingerprint = $5,
           last_result = 'claimed',
           last_error = NULL,
           updated_at = NOW()
       WHERE campaign_record_id = $1`,
      [campaignId, windowExpired, attemptNumber, nextAt, fingerprint],
    );
    await client.query("COMMIT");
    return { claimed: true, attemptNumber, nextAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function recordRecoveryResult(campaignId, result, error = "") {
  await recoveryPool.query(
    `UPDATE tah_campaign_recovery
     SET last_result = $2, last_error = NULLIF($3, ''), updated_at = NOW()
     WHERE campaign_record_id = $1`,
    [campaignId, result, error],
  );
}

async function resetRecoveredCampaigns(activeCampaignIds) {
  if (!recoveryPool) return;
  await ensureRecoverySchema();
  await recoveryPool.query(
    `UPDATE tah_campaign_recovery
     SET window_started_at = NOW(), attempt_count = 0, next_attempt_at = NULL,
         last_result = 'healthy', last_error = NULL, updated_at = NOW()
     WHERE attempt_count > 0 AND NOT (campaign_record_id = ANY($1::text[]))`,
    [activeCampaignIds],
  );
}

async function dispatchCampaignRestart(campaignId) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(controlWsUrl, ["tah-control", controlToken], { origin: controlOrigin });
    let dispatched = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      socket.terminate();
      finish(new Error("Control restart dispatch timed out"));
    }, 8_000);
    socket.once("open", () => {
      dispatched = true;
      socket.send(JSON.stringify({
        type: "restart_campaign",
        payload: { id: campaignId, reason: "automatic-capture-recovery" },
      }), (error) => {
        if (error) finish(error);
        else setTimeout(() => finish(), 500);
      });
    });
    socket.on("message", (data) => {
      if (!dispatched) return;
      try {
        const message = JSON.parse(String(data));
        if (message?.type === "error") finish(new Error(message.message || message.error || "Control rejected restart"));
      } catch {}
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", (code) => {
      if (!dispatched) finish(new Error(`Control socket closed before restart dispatch (${code})`));
    });
  });
}

function recoverableAlerts(report) {
  const now = Date.now();
  return (Array.isArray(report.alerts) ? report.alerts : []).filter((alert) => {
    if (!alert || (alert.status !== "active" && alert.status !== "acknowledged")) return false;
    if (alert.scope !== "capture" || !String(alert.fingerprint || "").endsWith(":capture-stale")) return false;
    if (!String(alert.campaignRecordId || "").trim()) return false;
    const lastSeenAt = Date.parse(alert.lastSeenAt || "");
    return Number.isFinite(lastSeenAt) && now - lastSeenAt <= recoveryFreshnessMs;
  });
}

async function runRecovery(report) {
  if (!recoveryEnabled) return;
  const alerts = recoverableAlerts(report);
  const activeCampaignIds = [...new Set(alerts.map((alert) => String(alert.campaignRecordId).trim()))];
  await resetRecoveredCampaigns(activeCampaignIds);
  for (const alert of alerts) {
    const campaignId = String(alert.campaignRecordId).trim();
    const claim = await claimRecovery(campaignId, String(alert.fingerprint));
    if (!claim.claimed) {
      recovery.suppressed += 1;
      if (claim.reason === "exhausted") recovery.exhausted += 1;
      continue;
    }
    recovery.attempted += 1;
    recovery.lastCampaignId = campaignId;
    recovery.lastAttemptAt = Date.now();
    try {
      await dispatchCampaignRestart(campaignId);
      await recordRecoveryResult(campaignId, "dispatched");
      recovery.dispatched += 1;
      lastRecoveryFailure = "";
      console.log(`[health-watchdog] dispatched bounded capture recovery for ${campaignId} (attempt ${claim.attemptNumber}/${recoveryMaxAttempts})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordRecoveryResult(campaignId, "failed", message).catch(() => {});
      recovery.failed += 1;
      lastRecoveryFailure = `${campaignId}: ${message}`;
      console.error(`[health-watchdog] recovery dispatch failed for ${campaignId}: ${message}`);
    }
  }
}

async function evaluate() {
  if (running) return;
  running = true;
  try {
    const evaluationResponse = await fetch(endpoint, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json", "x-tah-watchdog": "1" }),
      body: JSON.stringify({ action: "evaluate" }),
      signal: AbortSignal.timeout(12_000),
    });
    const evaluation = await readJson(evaluationResponse);
    summary = { ...summary, ...(evaluation.summary || {}) };
    if (recoveryEnabled) {
      const reportResponse = await fetch(endpoint, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(12_000),
      });
      const report = await readJson(reportResponse);
      summary = { ...summary, ...(report.summary || {}) };
      await runRecovery(report);
    }
    lastSuccessAt = Date.now();
    lastFailure = "";
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
    console.error(`[health-watchdog] ${lastFailure}`);
  } finally {
    running = false;
  }
}

function metrics() {
  const healthy = lastSuccessAt > 0 && Date.now() - lastSuccessAt < intervalMs * 3;
  return [
    "# HELP tah_health_watchdog_up Whether the durable health evaluator is advancing.",
    "# TYPE tah_health_watchdog_up gauge",
    `tah_health_watchdog_up ${healthy ? 1 : 0}`,
    "# HELP tah_health_watchdog_last_success_timestamp_seconds Last successful evaluation Unix timestamp.",
    "# TYPE tah_health_watchdog_last_success_timestamp_seconds gauge",
    `tah_health_watchdog_last_success_timestamp_seconds ${Math.floor(lastSuccessAt / 1000)}`,
    "# HELP tah_health_alerts_open Open and acknowledged application incidents.",
    "# TYPE tah_health_alerts_open gauge",
    `tah_health_alerts_open ${Number(summary.open) || 0}`,
    "# HELP tah_health_alerts_critical Open critical application incidents.",
    "# TYPE tah_health_alerts_critical gauge",
    `tah_health_alerts_critical ${Number(summary.critical) || 0}`,
    "# HELP tah_health_alerts_warning Open warning application incidents.",
    "# TYPE tah_health_alerts_warning gauge",
    `tah_health_alerts_warning ${Number(summary.warning) || 0}`,
    "# HELP tah_health_alerts_observing Conditions waiting for their sustained threshold.",
    "# TYPE tah_health_alerts_observing gauge",
    `tah_health_alerts_observing ${Number(summary.observing) || 0}`,
    "# HELP tah_health_watchdog_recovery_attempts_total Automatic campaign recovery claims.",
    "# TYPE tah_health_watchdog_recovery_attempts_total counter",
    `tah_health_watchdog_recovery_attempts_total ${recovery.attempted}`,
    "# HELP tah_health_watchdog_recovery_dispatches_total Automatic restart commands dispatched.",
    "# TYPE tah_health_watchdog_recovery_dispatches_total counter",
    `tah_health_watchdog_recovery_dispatches_total ${recovery.dispatched}`,
    "# HELP tah_health_watchdog_recovery_failures_total Automatic restart dispatch failures.",
    "# TYPE tah_health_watchdog_recovery_failures_total counter",
    `tah_health_watchdog_recovery_failures_total ${recovery.failed}`,
    "# HELP tah_health_watchdog_recovery_suppressed_total Recoveries blocked by lock, cooldown, or attempt limit.",
    "# TYPE tah_health_watchdog_recovery_suppressed_total counter",
    `tah_health_watchdog_recovery_suppressed_total ${recovery.suppressed}`,
    "# HELP tah_health_watchdog_recovery_exhausted_total Recoveries blocked by the hourly attempt limit.",
    "# TYPE tah_health_watchdog_recovery_exhausted_total counter",
    `tah_health_watchdog_recovery_exhausted_total ${recovery.exhausted}`,
    "",
  ].join("\n");
}

http.createServer((request, response) => {
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(metrics());
    return;
  }
  if (request.url === "/healthz") {
    const healthy = lastSuccessAt > 0 && Date.now() - lastSuccessAt < intervalMs * 3;
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      healthy,
      lastSuccessAt: lastSuccessAt || null,
      lastFailure,
      lastRecoveryFailure,
      summary,
      recovery: { ...recovery, lastAttemptAt: recovery.lastAttemptAt || null },
    }));
    return;
  }
  response.writeHead(404).end();
}).listen(port, "0.0.0.0");

await evaluate();
setInterval(evaluate, intervalMs).unref();

async function shutdown() {
  await recoveryPool?.end().catch(() => {});
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
