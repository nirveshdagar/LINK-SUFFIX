import http from "node:http";

const endpoint = process.env.TAH_ALERTS_INTERNAL_URL?.trim() || "http://127.0.0.1:3100/api/alerts";
const token = process.env.TAH_API_BEARER_TOKEN?.trim() || process.env.CONTROL_TOKEN?.trim() || "";
const port = Math.max(1, Number(process.env.TAH_HEALTH_WATCHDOG_PORT) || 3197);
const intervalMs = Math.max(5_000, Number(process.env.TAH_HEALTH_INTERVAL_MS) || 15_000);
const endpointHost = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
const loopbackEndpoint = endpointHost === "127.0.0.1" || endpointHost === "localhost" || endpointHost === "::1";
let lastSuccessAt = 0;
let lastFailure = "Waiting for the first evaluation";
let running = false;
let summary = { open: 0, critical: 0, warning: 0, observing: 0 };

if (!token && !loopbackEndpoint) {
  console.error("health-watchdog requires CONTROL_TOKEN or TAH_API_BEARER_TOKEN");
  process.exit(1);
}

async function evaluate() {
  if (running) return;
  running = true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        "x-tah-watchdog": "1",
      },
      body: JSON.stringify({ action: "evaluate" }),
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Health API returned HTTP ${response.status}`);
    summary = { ...summary, ...(payload.summary || {}) };
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
    response.end(JSON.stringify({ healthy, lastSuccessAt: lastSuccessAt || null, lastFailure, summary }));
    return;
  }
  response.writeHead(404).end();
}).listen(port, "0.0.0.0");

await evaluate();
setInterval(evaluate, intervalMs).unref();
