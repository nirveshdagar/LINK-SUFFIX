import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const WS_PORT = Number(process.env.WS_PORT ?? 3001);
// Resolve paths relative to the workspace root (cwd when this script is
// invoked from the repo root via `npm run control`). The script lives in
// web/server/ so we anchor on cwd which the npm script ensures is the
// workspace root, not the script directory.
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();
const ORCH_BIN = process.env.ORCH_BIN ?? path.join(WORKSPACE_ROOT, "packages/orchestrator/dist/cli.js");
const ORCH_CWD = process.env.ORCH_CWD ?? WORKSPACE_ROOT;
const SCENARIO_DIR = process.env.SCENARIO_DIR ?? path.join(WORKSPACE_ROOT, "scenarios");

const clients = new Set();
const runs = new Map();

function broadcast(msg, except) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c !== except && c.readyState === 1) c.send(data);
}

async function listDevices() {
  const p = path.join(ORCH_CWD, "packages/profiles/src/devices.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

async function listGeos() {
  return [
    { country: "US", state: "CA", city: "LosAngeles", tz: "America/Los_Angeles" },
    { country: "US", state: "NY", city: "NewYork", tz: "America/New_York" },
    { country: "US", state: "TX", city: "Dallas", tz: "America/Chicago" },
    { country: "GB", city: "London", tz: "Europe/London" },
    { country: "DE", city: "Berlin", tz: "Europe/Berlin" },
    { country: "FR", city: "Paris", tz: "Europe/Paris" },
    { country: "IN", state: "MH", city: "Mumbai", tz: "Asia/Kolkata" },
    { country: "JP", city: "Tokyo", tz: "Asia/Tokyo" },
    { country: "BR", state: "SP", city: "SaoPaulo", tz: "America/Sao_Paulo" },
    { country: "CA", state: "ON", city: "Toronto", tz: "America/Toronto" },
  ];
}

function buildScenarioYaml(p) {
  const lines = [];
  lines.push(`id: ${p.scenarioId}`);
  lines.push(`tier: ${p.tier}`);
  lines.push(`seed_url: ${p.seedUrl}`);
  lines.push(`geo:`);
  lines.push(`  country: ${p.geo.country}`);
  if (p.geo.state) lines.push(`  state: ${p.geo.state}`);
  if (p.geo.city) lines.push(`  city: ${p.geo.city}`);
  lines.push(`proxy_mode: ${p.proxyMode}`);
  lines.push(`repeats: ${p.repeats}`);
  if (p.concurrent) lines.push(`concurrent: ${p.concurrent}`);
  if (p.devicePool && p.devicePool.length && p.tier !== "trivial-http") {
    lines.push(`device_pool: [${p.devicePool.join(", ")}]`);
  }
  if (p.tier !== "trivial-http") {
    lines.push(`expected_verdict: ${p.expectedVerdict ?? "challenge"}`);
  }
  return lines.join("\n") + "\n";
}

async function listRuns() {
  return Array.from(runs.values()).map((r) => ({ id: r.id, scenarioId: r.scenarioId, startedAt: r.startedAt, alive: r.child.exitCode === null }));
}

async function cancelRun(id) {
  const r = runs.get(id);
  if (!r) return false;
  r.child.kill("SIGTERM");
  return true;
}

async function handle(ws, msg) {
  try {
    if (msg.type === "create_run") {
      const run = await startRun(msg.payload ?? {});
      runs.set(run.id, run);
      ws.send(JSON.stringify({ type: "run_started", payload: { id: run.id, scenarioId: run.scenarioId } }));
    } else if (msg.type === "cancel_run") {
      const ok = await cancelRun(msg.payload?.id);
      ws.send(JSON.stringify({ type: "run_cancelled", payload: { id: msg.payload?.id, ok } }));
    } else if (msg.type === "list_runs") {
      ws.send(JSON.stringify({ type: "runs", payload: await listRuns() }));
    } else if (msg.type === "list_devices") {
      ws.send(JSON.stringify({ type: "devices", payload: await listDevices() }));
    } else if (msg.type === "list_geos") {
      ws.send(JSON.stringify({ type: "geos", payload: await listGeos() }));
    } else {
      ws.send(JSON.stringify({ type: "error", payload: { message: `unknown ${msg.type}` } }));
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", payload: { message: e.message } }));
  }
}

const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
console.log(`control server listening on ws://127.0.0.1:${WS_PORT}`);
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "hello", payload: { time: Date.now() } }));
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString("utf8"));
      handle(ws, msg).catch((e) => console.error("handle error", e));
    } catch (e) { console.error("bad msg", e); }
  });
  ws.on("close", () => clients.delete(ws));
});
