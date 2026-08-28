import { withCrossProcessLock } from "@/lib/cross-process-lock";
import { NextResponse } from "next/server";
import { assignSession, startSession, stopSession, listSessions, logTraffic, getSessionStats, getTrafficStats, getTraffic } from "@/lib/proxy-session-manager";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { hasValidApiAuth, unauthorizedResponse } from "@/lib/api-auth";
import { API_POLICIES } from "@/lib/api-policy";
import { emitStructuredLog, newRequestId } from "@/lib/observability";
import { validateTrafficGet, validateTrafficPost, formatValidationError } from "@/lib/endpoint-schemas";
import { ProxyAgent } from "proxy-agent";
import { readFileSync } from "node:fs";
import { buildRateLimitHeaders, checkRateLimit, withRateLimitHeaders } from "@/lib/rate-limit";
import { extractExactQuerySuffix } from "@/lib/url-security";
import { atomicWriteJsonSync } from "@/lib/atomic-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = process.env.WORKSPACE_ROOT ? path.join(process.env.WORKSPACE_ROOT, "web") : process.cwd();
const SITES_FILE = path.join(ROOT, "ads-sites.json");
const STATE_FILE = path.join(ROOT, "ads-state.json");
const MAX_SITES = Math.max(1, Math.min(1000, Number(process.env.TAH_PROXY_MAX_SITES) || 250));
const trafficControllers = new Map<string, AbortController>();
const ALLOWED_TARGETS = (process.env.TAH_ALLOWED_TARGETS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);

function trafficHostAllowed(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (ALLOWED_TARGETS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return true;
  return process.env.NODE_ENV !== "production" && process.env.TAH_ALLOW_UNLISTED_LOCAL_TARGETS === "true";
}

interface SiteRecord {
  url: string;
  tags: string[];
  active: boolean;
  addedAt: number;
}

interface SitesState {
  sites: SiteRecord[];
  suffix: string;
}

async function followRedirects(startUrl: string, agent: http.Agent, signal?: AbortSignal) {
  const chain: Array<{ url: string; status: number }> = [];
  let current = startUrl;
  for (let depth = 0; depth < 10; depth++) {
    if (signal?.aborted) throw new Error("Traffic request cancelled");
    const result = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const parsed = new URL(current);
      const client = parsed.protocol === "https:" ? https : http;
      const req = client.request(parsed, { agent, timeout: 15_000 }, (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        res.resume();
        res.once("end", () => resolve({ status, location }));
      });
      req.once("timeout", () => req.destroy(new Error("Traffic request timed out")));
      req.once("error", reject);
      signal?.addEventListener("abort", () => req.destroy(new Error("Traffic request cancelled")), { once: true });
      req.end();
    });
    chain.push({ url: current, status: result.status });
    if (!result.location || result.status < 300 || result.status >= 400) break;
    current = new URL(result.location, current).toString();
  }
  return chain;
}

function readSites() {
  const fallback: SitesState = { sites: [], suffix: "" };
  try {
    const raw = JSON.parse(readFileSync(SITES_FILE, "utf8"));
    const rawSites: unknown[] = Array.isArray((raw as Record<string, unknown>).sites)
      ? (raw as Record<string, unknown>).sites as unknown[]
      : [];
    const sites = rawSites
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const source = item as Record<string, unknown>;
        const normalized = normalizeSiteUrl(source.url);
        if (!normalized) return null;
        return {
          url: normalized,
          tags: sanitizeTags(source.tags),
          active: source.active === true || source.active === false ? source.active : true,
          addedAt: typeof source.addedAt === "number" && Number.isFinite(source.addedAt) && source.addedAt > 0 ? Math.min(Date.now(), source.addedAt) : Date.now(),
        } satisfies SiteRecord;
      })
      .filter((item): item is SiteRecord => item !== null);

    return {
      sites,
      suffix: toText((raw as Record<string, unknown>).suffix, 2048),
    };
  } catch { return fallback; }
}

function writeSites(data: unknown) {
  try {
    const rawState = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    const sites = Array.isArray(rawState.sites) ? rawState.sites : [];
    const cleanSites = sites
      .slice(0, MAX_SITES)
      .map((item) => {
        const record = item as Record<string, unknown>;
        const normalized = normalizeSiteUrl(record.url);
        if (!normalized) return null;
        return {
          url: normalized,
          tags: sanitizeTags(record.tags),
          active: record.active === false ? false : true,
          addedAt: typeof record.addedAt === "number" && Number.isFinite(record.addedAt) && record.addedAt > 0 ? Math.min(Date.now(), Math.max(record.addedAt, 0)) : Date.now(),
        } as SiteRecord;
      })
      .filter((item): item is SiteRecord => Boolean(item));

    atomicWriteJsonSync(SITES_FILE, { sites: cleanSites, suffix: toText(rawState.suffix, 2048) });
  } catch { /* ignore */ }
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function writeState(data: unknown) {
  atomicWriteJsonSync(STATE_FILE, data);
}

function normalizeSuffix(value: string) {
  return value.startsWith("?") ? value.slice(1) : value;
}

function extractSuffixFromRedirectChain(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) return "";
  const last = raw.at(-1) as Record<string, unknown> | undefined;
  const candidate = last?.url;
  if (typeof candidate !== "string") return "";
  return extractExactQuerySuffix(candidate);
}

function persistCapture(redirectChain: Array<{ url: string; status: number }>, fallbackUrl?: string) {
  // Only persist URLs for which a response was actually observed. A Location
  // header alone is not evidence that the redirected page was opened.
  const visitedChain = redirectChain.filter((entry) => Number.isInteger(entry.status) && entry.status > 0);
  const state = readState() as Record<string, unknown>;
  const redirectSuffix = extractSuffixFromRedirectChain(visitedChain);
  let suffix = redirectSuffix;
  if (!suffix && fallbackUrl) {
    try {
      suffix = extractExactQuerySuffix(fallbackUrl);
    } catch { /* ignore */ }
  }
  state.capturedChain = visitedChain;
  state.capturedAt = new Date().toISOString();
  if (suffix) {
    state.suffix = suffix;
    state.finalQuery = suffix;
  }
  writeState(state);
  return suffix;
}

function buildTargetUrl(base: string, suffix: string, path = "/", qs?: Record<string, string>) {
  try {
    const u = new URL(base);
    const sep = u.pathname.endsWith("/") ? "" : "/";
    u.pathname = `${u.pathname}${sep}${path}`;
    if (suffix) {
      if (suffix.startsWith("?")) {
        const sp = new URLSearchParams(suffix.slice(1));
        for (const [k, v] of sp) u.searchParams.set(k, v);
      } else {
        u.pathname += suffix;
      }
    }
    if (qs) {
      for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
    }
    return u.toString();
  } catch { return base; }
}

function toText(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, Math.max(1, Math.min(max, 2048)));
}

function toPositiveInt(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : NaN;
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min || i > max) return fallback;
  return i;
}

function normalizeTrafficTarget(raw: unknown, keepPath = false) {
  const input = toText(raw, 1024);
  if (!input) return "";

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const parsed = new URL(withScheme);
    if (!trafficHostAllowed(parsed.hostname)) return "";
    const host = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    if (keepPath) {
      const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "";
      return `${host}${path || ""}${parsed.search || ""}`;
    }
    return host;
  } catch {
    return "";
  }
}

function normalizeSiteUrl(raw: unknown) {
  const input = toText(raw, 1024);
  if (!input) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const parsed = new URL(withScheme);
    if (!trafficHostAllowed(parsed.hostname)) return "";
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const query = parsed.search ? parsed.search : "";
    return `${parsed.protocol}//${parsed.host}${pathname}${query}`;
  } catch { return ""; }
}

function normalizeSiteEntry(siteUrl: string) {
  const normalized = normalizeSiteUrl(siteUrl);
  const uniqueKey = normalized.toLowerCase();
  return { normalized, uniqueKey };
}

function sanitizeTags(value: unknown) {
  const list = Array.isArray(value) ? value : [];
  const cleaned = list
    .map((tag) => toText(tag, 32).toLowerCase())
    .filter(Boolean);
  const unique: string[] = [];
  for (const tag of cleaned) {
    if (!unique.includes(tag)) unique.push(tag);
  }
  return unique;
}

export async function GET(req: Request) {
  const requestId = newRequestId(req);
  emitStructuredLog({ event: "traffic.api.start", requestId, component: "traffic-api", action: "get", details: { url: req.url } });
  const rateLimit = await checkRateLimit(req, API_POLICIES.traffic.rateLimit);
  if (!rateLimit.ok) {
    emitStructuredLog({ event: "traffic.api.rate_limit", requestId, component: "traffic-api", action: "get", details: { retryAfterMs: rateLimit.retryAfterMs } });
    return NextResponse.json(
      { error: "Rate limit exceeded. Retry later." },
      { status: 429, headers: buildRateLimitHeaders(rateLimit) }
    );
  }
  if (!hasValidApiAuth(req, API_POLICIES.traffic.auth)) return withRateLimitHeaders(unauthorizedResponse(), rateLimit);
  return withRateLimitHeaders(handleGet(req, requestId), rateLimit);
}

function handleGet(req: Request, requestId: string) {
  const url = new URL(req.url);
  const validation = validateTrafficGet(url.searchParams);
  if (!validation.ok) {
    emitStructuredLog({ event: "traffic.api.error", requestId, component: "traffic-api", action: "get_validation", error: formatValidationError(validation), details: { action: url.searchParams.get("action") } });
    return NextResponse.json({ error: "Invalid GET action", details: formatValidationError(validation) }, { status: 400 });
  }
  const action = validation.value!.action;

  if (action === "stats") {
    return NextResponse.json({ sessionStats: getSessionStats(), trafficStats: getTrafficStats(), traffic: getTraffic(200) });
  }
  if (action === "sessions") {
    return NextResponse.json({ sessions: listSessions() });
  }
  if (action === "sites") {
    return NextResponse.json(readSites());
  }

  return NextResponse.json({ error: "Unknown GET action" }, { status: 400 });
}

async function postUnlocked(req: Request) {
  const requestId = newRequestId(req);
  emitStructuredLog({ event: "traffic.api.start", requestId, component: "traffic-api", action: "post" });
  const rateLimit = await checkRateLimit(req, API_POLICIES.traffic.rateLimit);
  if (!rateLimit.ok) {
    emitStructuredLog({ event: "traffic.api.rate_limit", requestId, component: "traffic-api", action: "post", details: { retryAfterMs: rateLimit.retryAfterMs } });
    return NextResponse.json(
      { error: "Rate limit exceeded. Retry later." },
      { status: 429, headers: buildRateLimitHeaders(rateLimit) }
    );
  }
  if (!hasValidApiAuth(req, API_POLICIES.traffic.auth)) return withRateLimitHeaders(unauthorizedResponse(), rateLimit);
  return withRateLimitHeaders(await handlePost(req, requestId), rateLimit);
}

async function handlePost(req: Request, requestId: string) {
  const raw = await req.json().catch(() => null);
  const validation = validateTrafficPost(raw);
  if (!validation.ok) return NextResponse.json({ error: "Invalid JSON payload", details: formatValidationError(validation) }, { status: 400 });
  const body = validation.value!;

  const sites = readSites();
  const list = Array.isArray(sites.sites) ? sites.sites : [];

  if (body.action === "start_traffic") {
    emitStructuredLog({ event: "traffic.session.start", requestId, component: "traffic-api", action: "start_traffic", details: { country: body.country, state: body.state, city: body.city, sessions: body.sessions, durationSec: body.durationSec, target: body.targetUrl || "httpbin.org" } });
    const geo = toText(body.geo, 32) || "auto";
    const country = toText(body.country, 8).toUpperCase();
    const state = toText(body.state, 80);
    const city = toText(body.city, 120);
    const sessionCount = body.sessions || 1;
    const durationSec = body.durationSec || 120;
    const target = normalizeTrafficTarget(body.targetUrl, true) || "httpbin.org";
    const started = Date.now();
    const trafficId = `traffic_${requestId}`;
    const controller = new AbortController();
    trafficControllers.set(trafficId, controller);

    for (let i = 0; i < sessionCount; i++) {
      void startSession(
        { country, state, city },
        { requestId, action: "start_traffic", target, country, state, city, startedAt: started },
      ).catch(() => { /* ignored for async warm-up */ });
    }

    const settleMs = 4000;
    setTimeout(() => {
      void fireAutoTraffic({ geo, country, state, city, sessions: sessionCount, durationSec, targetBase: target, signal: controller.signal }, requestId)
        .finally(() => trafficControllers.delete(trafficId));
    }, settleMs);

    return NextResponse.json({ ok: true, trafficId, queued: sessionCount, settleMs });
  }

  if (body.action === "fire_one") {
    const assignAt = Date.now();
    const session = await assignSession(toText(body.country, 8), toText(body.state, 80), toText(body.city, 120), { requestId, action: "fire_one" }).catch(() => null);
    emitStructuredLog({ event: "traffic.session.assign", requestId, component: "traffic-api", action: "fire_one", durationMs: Date.now() - assignAt, details: { assigned: Boolean(session), sessionId: session?.id, country: body.country, state: body.state, city: body.city } });
    if (!session) {
      return NextResponse.json({ error: "No proxy session available" }, { status: 503 });
    }

    const host = toText(body.country, 8) || session.country;
    const st = toText(body.state, 80) || session.state;
    const ci = toText(body.city, 120) || session.city;
    const target = buildTargetUrl(`https://${normalizeTrafficTarget(body.targetUrl, true) || "httpbin.org"}`, "", "", {
      from: session.id,
      geo: `${toText(body.geo, 32) || "auto"}-${host}-${st}-${ci}`,
      _: Date.now().toString(),
    });
    const proxyUrl = `http://127.0.0.1:${session.localPort}`;
    const agent = new (ProxyAgent as unknown as { new (value: string): unknown }) (proxyUrl) as unknown as http.Agent;

    try {
      const redirectChain = await followRedirects(target, agent);
      const final = redirectChain.at(-1);
      const finalSuffix = persistCapture(redirectChain, target);
      logTraffic({ id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, sessionId: session.id, url: target, method: "GET", status: final?.status ?? 0, redirectChain, finalQuery: finalSuffix ? `?${finalSuffix}` : undefined, suffix: finalSuffix || undefined, requestId, ts: Date.now() });
      return NextResponse.json({ ok: true, sessionId: session.id, url: target, finalUrl: final?.url, redirectChain, suffix: finalSuffix });
    } catch (error) {
      emitStructuredLog({ event: "traffic.error", requestId, component: "traffic-api", action: "fire_one", error: error instanceof Error ? error.message : String(error), details: { sessionId: session.id } });
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }
  }

  if (body.action === "stop_traffic") {
    const trafficId = toText((body as unknown as Record<string, unknown>).trafficId, 120);
    if (trafficId) {
      trafficControllers.get(trafficId)?.abort();
      trafficControllers.delete(trafficId);
    } else {
      for (const controller of trafficControllers.values()) controller.abort();
      trafficControllers.clear();
    }
    const sessionId = toText(body.sessionId, 24);
    if (sessionId) {
      stopSession(sessionId, { requestId, action: "stop_traffic" });
      emitStructuredLog({ event: "traffic.session.stop", requestId, component: "traffic-api", action: "stop_traffic", details: { sessionId } });
      return NextResponse.json({ ok: true, action: "stop_traffic", sessionId });
    }

    return NextResponse.json({ ok: true, note: "No sessionId supplied" });
  }

  if (body.action === "add_site") {
    emitStructuredLog({ event: "traffic.sites.write", requestId, component: "traffic-api", action: "add_site", details: { url: body.url } });
    const siteUrl = normalizeSiteUrl(body.url);
    if (!siteUrl) {
      return NextResponse.json({ error: "url required" }, { status: 400 });
    }

    if (list.length >= MAX_SITES) {
      return NextResponse.json({ error: `Maximum sites reached (${MAX_SITES})` }, { status: 429 });
    }

    const normalized = normalizeSiteEntry(siteUrl);
    const existing = list.find((item: { url?: string }) => {
      const current = normalizeSiteUrl(item.url);
      return current && current.toLowerCase() === normalized.uniqueKey;
    });

    if (existing) {
      return NextResponse.json({ ok: false, error: "Site already exists", sites: list }, { status: 409 });
    }

    list.push({
      url: siteUrl,
      tags: sanitizeTags(body.tags),
      active: body.active === false ? false : true,
      addedAt: Date.now(),
    });
    writeSites({ ...sites, sites: list, suffix: sites.suffix });
    return NextResponse.json({ ok: true, sites: list });
  }

  if (body.action === "remove_site") {
    emitStructuredLog({ event: "traffic.sites.write", requestId, component: "traffic-api", action: "remove_site", details: { index: body.index } });
    const index = toPositiveInt(body.index, 0, Number.MAX_SAFE_INTEGER, -1);
    if (index < 0 || index >= list.length) {
      return NextResponse.json({ error: "index required" }, { status: 400 });
    }
    list.splice(index, 1);
    writeSites({ ...sites, sites: list, suffix: sites.suffix });
    return NextResponse.json({ ok: true, sites: list });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function fireAutoTraffic(opts: {
  geo: string;
  country?: string;
  state?: string;
  city?: string;
  sessions: number;
  durationSec: number;
  targetBase: string;
  signal: AbortSignal;
}, requestId: string) {
  const { geo, country, state, city, sessions: sessCount, durationSec, targetBase, signal } = opts;
  const deadline = Date.now() + durationSec * 1000;

  async function fireBatch() {
    if (signal.aborted) return;
    const ready = listSessions().filter(s => s.status === "ready");
    if (!ready.length) return;

    for (const session of ready.slice(0, sessCount)) {
      if (signal.aborted) break;
      emitStructuredLog({ event: "traffic.session.assign", requestId, component: "traffic-api", action: "auto_fire", details: { sessionId: session.id } });
      const host = country || session.country;
      const st = state || session.state;
      const ci = city || session.city;
      const target = buildTargetUrl(`https://${targetBase}`, "", "", {
        from: session.id,
        geo: `${geo}-${host}-${st}-${ci}`,
        _: Date.now().toString()
      });
      const t0 = Date.now();
      const proxyUrl = `http://127.0.0.1:${session.localPort}`;

      await new Promise<void>((resolve) => {
        const agent = new (ProxyAgent as unknown as { new (value: string): unknown }) (proxyUrl) as unknown as http.Agent;
        const redirectChain: Array<{ url: string; status: number }> = [{ url: target, status: 0 }];
        const req = https.request(target, { agent, timeout: 15000 }, (res) => {
          const location = res.headers.location;
          const statusCode = res.statusCode ?? 0;
          emitStructuredLog({ event: "traffic.request.fire", requestId, component: "traffic-api", action: "fire_auto", details: { sessionId: session.id, target, status: statusCode } });
          if (location && statusCode >= 300 && statusCode < 400) {
            try {
              if (!redirectChain.find((step) => step.url === target)) {
                redirectChain.push({ url: target, status: statusCode });
              }
              redirectChain.push({ url: new URL(location, target).toString(), status: statusCode });
            } catch { /* skip bad URL */ }
          }
          redirectChain[0].status = statusCode;
          const finalSuffix = persistCapture(redirectChain, target);

          logTraffic({
            id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            sessionId: session.id,
            url: target,
            method: "GET",
            status: statusCode,
            latencyMs: Date.now() - t0,
            requestId,
            ts: Date.now(),
            redirectChain: redirectChain.length > 1 ? redirectChain : undefined,
            finalQuery: finalSuffix ? `?${finalSuffix}` : undefined,
            suffix: finalSuffix || undefined,
          });
          res.on("data", () => {});
          res.on("end", resolve);
        });
        req.on("timeout", () => { req.destroy(); resolve(); });
        signal.addEventListener("abort", () => { req.destroy(); resolve(); }, { once: true });
        req.on("error", (error) => {
          emitStructuredLog({ event: "traffic.error", requestId, component: "traffic-api", action: "fire_auto", error: error instanceof Error ? error.message : String(error), details: { sessionId: session.id, target } });
          logTraffic({
            id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            sessionId: session.id,
            url: target,
            method: "GET",
            status: 0,
            requestId,
            latencyMs: undefined,
            ts: Date.now(),
          });
          resolve();
        });
        req.end();
      });
    }

    if (!signal.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 3000 + Math.random() * 4000);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      await fireBatch();
    }
  }

  await fireBatch();
}

export async function POST(request: Parameters<typeof postUnlocked>[0]) {
  try {
    const preview = await request.clone().json() as { action?: unknown };
    if (preview.action === "start_traffic") {
      return Response.json({
        error: "The legacy HTTP traffic simulator is retired. Launch an authorized L4 browser campaign through the control plane so redirects are actually visited before a suffix is captured.",
      }, { status: 410 });
    }
  } catch { /* the existing route returns the canonical validation error */ }
  return withCrossProcessLock("ads-state", () => postUnlocked(request));
}
