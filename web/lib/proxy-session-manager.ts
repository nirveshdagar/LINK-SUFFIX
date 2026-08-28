import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { emitStructuredLog } from "@/lib/observability";

export interface ProxySession {
  id: string;
  localPort: number;
  country: string;
  state: string;
  city: string;
  process: ChildProcess;
  status: "starting" | "ready" | "error" | "stopped";
  startedAt: number;
  lastUsedAt: number;
  error?: string;
}

export type PublicProxySession = Omit<ProxySession, "process">;

export interface TrafficRequest {
  id: string;
  sessionId: string;
  url: string;
  method: string;
  status?: number;
  ipSeen?: string;
  latencyMs?: number;
  ts: number;
  redirectChain?: Array<{ url: string; status: number }>;
  finalQuery?: string;
  suffix?: string;
  requestId?: string;
}

interface SessionMeta { requestId?: string; [key: string]: unknown }

const ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();
const TUNNEL_SCRIPT = path.join(ROOT, "web", "scripts", "proxy-tunnel.js");
const STARTUP_TIMEOUT_MS = Math.max(2_000, Number(process.env.TAH_PROXY_SESSION_STARTUP_MS) || 12_000);
const MAX_SESSIONS = Math.max(1, Number(process.env.TAH_PROXY_MAX_SESSIONS) || 40);
const SESSION_TTL_MS = Math.max(60_000, Number(process.env.TAH_PROXY_SESSION_TTL_MS) || 15 * 60_000);
const MAX_TRAFFIC_ENTRIES = Math.min(5_000, Math.max(100, Number(process.env.TAH_PROXY_MAX_TRAFFIC_ENTRIES) || 500));
const GC_INTERVAL_MS = Math.max(5_000, Number(process.env.TAH_PROXY_SESSION_GC_MS) || 30_000);
const PORT_MIN = Math.max(1_024, Number(process.env.TAH_PROXY_LOCAL_PORT_MIN) || 12_000);
const PORT_MAX = Math.min(65_000, Math.max(PORT_MIN + 100, Number(process.env.TAH_PROXY_LOCAL_PORT_MAX) || 64_000));

const sessions = new Map<string, ProxySession>();
const trafficLog: TrafficRequest[] = [];
const startingSessions = new Map<string, Promise<ProxySession>>();
const reservedPorts = new Set<number>();
let nextLocalPort = PORT_MIN;
let nextGc = 0;

function requestScopeId(requestId?: string) { return requestId ?? randomUUID(); }
function normalize(value?: string) { return (value ?? "").trim().toLowerCase(); }
function sessionKey(country?: string, state?: string, city?: string) { return `${normalize(country).toUpperCase()}|${normalize(state)}|${normalize(city)}`; }

function emitSessionLog(event: string, action: string, requestId?: string, details?: Record<string, unknown>) {
  emitStructuredLog({ event, requestId: requestScopeId(requestId), component: "proxy-session-manager", action, details });
}

async function portIsAvailable(port: number) {
  if (reservedPorts.has(port)) return false;
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function reservePort() {
  const span = PORT_MAX - PORT_MIN + 1;
  for (let attempt = 0; attempt < span; attempt += 1) {
    const port = nextLocalPort;
    nextLocalPort = port >= PORT_MAX ? PORT_MIN : port + 1;
    if (await portIsAvailable(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
  throw new Error(`No local proxy ports are available in ${PORT_MIN}-${PORT_MAX}`);
}

function terminateProcess(process: ChildProcess) {
  if (process.exitCode !== null || process.killed) return;
  try { process.kill("SIGTERM"); } catch { return; }
  const timer = setTimeout(() => {
    if (process.exitCode === null) {
      try { process.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }, 5_000);
  timer.unref();
}

function pruneSessions(now = Date.now()) {
  for (const session of sessions.values()) {
    if ((session.status === "ready" || session.status === "error") && now - session.lastUsedAt > SESSION_TTL_MS) stopSession(session.id);
  }
  if (sessions.size <= MAX_SESSIONS) return;
  [...sessions.values()]
    .filter((session) => session.status === "ready" || session.status === "error")
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    .slice(0, sessions.size - MAX_SESSIONS)
    .forEach((session) => stopSession(session.id));
}

function maybeGcSessions() {
  const now = Date.now();
  if (now < nextGc) return;
  nextGc = now + GC_INTERVAL_MS;
  pruneSessions(now);
}

export async function startSession(
  opts: { country?: string; state?: string; city?: string },
  meta?: SessionMeta,
): Promise<ProxySession> {
  maybeGcSessions();
  if (sessions.size + startingSessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()]
      .filter((session) => session.status !== "starting")
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!oldest) throw new Error(`Proxy session capacity reached (${MAX_SESSIONS})`);
    stopSession(oldest.id);
  }

  const country = normalize(opts.country || "US").toUpperCase();
  const state = opts.state?.trim() || "";
  const city = opts.city?.trim() || "";
  const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const localPort = await reservePort();
  const gatewayHost = process.env.IPROYAL_HOSTNAME || "geo.iproyal.com";
  const gatewayPort = process.env.IPROYAL_PORT || "12321";
  const proc = spawn(process.execPath, [TUNNEL_SCRIPT, String(localPort), gatewayHost, gatewayPort, country, state, city], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const now = Date.now();
  const session: ProxySession = { id, localPort, country, state, city, process: proc, status: "starting", startedAt: now, lastUsedAt: now };
  sessions.set(id, session);
  emitSessionLog("proxy.session.start", "create", meta?.requestId, { id, country, state, city, localPort });

  let stdoutBuffer = "";
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.off("error", onError);
      proc.off("exit", onExit);
      if (error) reject(error); else resolve();
    };
    const timeout = setTimeout(() => finish(new Error(`Tunnel ${id} failed to become ready within ${STARTUP_TIMEOUT_MS}ms`)), STARTUP_TIMEOUT_MS);
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`Tunnel ${id} exited before ready (code ${code ?? "unknown"})`));
    proc.once("error", onError);
    proc.once("exit", onExit);
    proc.stdout?.on("data", (buffer: Buffer) => {
      stdoutBuffer += buffer.toString("utf8");
      if (stdoutBuffer.length > 64_000) stdoutBuffer = stdoutBuffer.slice(-64_000);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.includes('"type":"tunnel-ready"') || line.includes('"type": "tunnel-ready"')) finish();
      }
    });
  });

  try {
    await ready;
    session.status = "ready";
    emitSessionLog("proxy.session.ready", "start", meta?.requestId, { id, localPort, country, state, city });
  } catch (error) {
    session.status = "error";
    session.error = error instanceof Error ? error.message : String(error);
    terminateProcess(proc);
    sessions.delete(id);
    reservedPorts.delete(localPort);
    emitSessionLog("proxy.session.error", "start", meta?.requestId, { id, error: session.error });
    throw error;
  }

  proc.stderr?.on("data", (buffer: Buffer) => emitSessionLog("proxy.session.stderr", "tunnel", meta?.requestId, { id, message: buffer.toString("utf8").slice(0, 2_000) }));
  proc.on("exit", (code) => {
    reservedPorts.delete(localPort);
    if (session.status !== "stopped") {
      session.status = "error";
      session.error = `Tunnel exited with code ${code ?? "unknown"}`;
    }
  });
  proc.on("error", (error) => {
    session.status = "error";
    session.error = error.message;
  });
  return session;
}

export function stopSession(id: string, meta?: SessionMeta) {
  const session = sessions.get(id);
  if (!session || session.status === "stopped") return;
  session.status = "stopped";
  sessions.delete(id);
  reservedPorts.delete(session.localPort);
  emitSessionLog("proxy.session.stop", "stop", meta?.requestId, { id });
  terminateProcess(session.process);
}

export function getSession(id: string) { return sessions.get(id); }
export function listSessions(): PublicProxySession[] { return [...sessions.values()].map(({ process: _process, ...session }) => session); }

export async function assignSession(country?: string, state?: string, city?: string, meta?: SessionMeta) {
  maybeGcSessions();
  const key = sessionKey(country, state, city);
  const candidates = [...sessions.values()]
    .filter((session) => session.status === "ready")
    .filter((session) => !country || session.country === normalize(country).toUpperCase())
    .filter((session) => !state || normalize(session.state) === normalize(state))
    .filter((session) => !city || normalize(session.city) === normalize(city))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  if (candidates[0]) {
    candidates[0].lastUsedAt = Date.now();
    emitSessionLog("proxy.session.assign", "reuse", meta?.requestId, { id: candidates[0].id });
    return candidates[0];
  }
  const pending = startingSessions.get(key);
  if (pending) return pending;
  const next = startSession({ country: country || "US", state: state || "", city: city || "" }, meta)
    .finally(() => startingSessions.delete(key));
  startingSessions.set(key, next);
  return next;
}

export function logTraffic(request: TrafficRequest) {
  let redactedUrl = "invalid-url";
  try {
    const parsed = new URL(request.url);
    parsed.search = "";
    parsed.hash = "";
    redactedUrl = parsed.toString();
  } catch { /* retained as invalid-url */ }
  emitStructuredLog({
    event: "proxy.traffic.log",
    requestId: requestScopeId(request.requestId),
    component: "proxy-session-manager",
    action: "record",
    details: { sessionId: request.sessionId, status: request.status, url: redactedUrl },
  });
  trafficLog.push(request);
  if (trafficLog.length > MAX_TRAFFIC_ENTRIES) trafficLog.splice(0, trafficLog.length - MAX_TRAFFIC_ENTRIES);
}

export function getTraffic(limit = 200) { return trafficLog.slice(-Math.max(0, Math.min(limit, MAX_TRAFFIC_ENTRIES))); }

export function getSessionStats() {
  const all = [...sessions.values()];
  return {
    total: all.length,
    ready: all.filter((session) => session.status === "ready").length,
    starting: all.filter((session) => session.status === "starting").length,
    error: all.filter((session) => session.status === "error").length,
  };
}

export function getTrafficStats() {
  const recent = trafficLog.slice(-100);
  const bySession = new Map<string, number>();
  for (const event of recent) bySession.set(event.sessionId, (bySession.get(event.sessionId) || 0) + 1);
  return {
    total: recent.length,
    bySession: Object.fromEntries(bySession),
    statusCodes: recent.reduce<Record<number, number>>((result, event) => {
      const status = event.status ?? 0;
      result[status] = (result[status] || 0) + 1;
      return result;
    }, {}),
  };
}
