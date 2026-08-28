import { withCrossProcessLock } from "@/lib/cross-process-lock";
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hasValidApiAuth, unauthorizedResponse } from "@/lib/api-auth";
import { API_POLICIES } from "@/lib/api-policy";
import { emitStructuredLog, newRequestId } from "@/lib/observability";
import { formatValidationError, validateTrackPost } from "@/lib/endpoint-schemas";
import { buildRateLimitHeaders, checkRateLimit, withRateLimitHeaders } from "@/lib/rate-limit";
import { assertSafeOutboundUrl, extractExactQuerySuffix } from "@/lib/url-security";
import { atomicWriteJsonSync } from "@/lib/atomic-json";

export const runtime = "nodejs";
const ROOT = process.env.WORKSPACE_ROOT ? path.join(process.env.WORKSPACE_ROOT, "web") : process.cwd();
const REDIRECT_LOG_FILE = path.join(ROOT, "ads-state.json");

export const dynamic = "force-dynamic";

function readState() {
  try { return JSON.parse(readFileSync(REDIRECT_LOG_FILE, "utf8")); } catch { return {}; }
}
function writeState(data: unknown) {
  atomicWriteJsonSync(REDIRECT_LOG_FILE, data);
}

function normalizeSuffix(raw: string) {
  return raw.startsWith("?") ? raw.slice(1) : raw;
}

function inferSuffixFromRedirectChain(redirectChain: unknown) {
  if (!Array.isArray(redirectChain) || redirectChain.length === 0) return "";
  const last = redirectChain.at(-1) as Record<string, unknown> | undefined;
  const candidate = last?.url;
  if (typeof candidate !== "string") return "";
  try {
    return extractExactQuerySuffix(candidate);
  } catch { return ""; }
}

// GET /api/track?u=<url>
// Track a URL and capture the redirect chain and final query params
// This is used to capture the redirect chain from proxy traffic
export async function GET(req: Request) {
  const requestId = newRequestId(req);
  emitStructuredLog({ event: "track.get.start", requestId, component: "track-api", action: "get", details: { route: new URL(req.url).pathname } });
  const rateLimit = await checkRateLimit(req, API_POLICIES.track.rateLimit);
  if (!rateLimit.ok) {
    emitStructuredLog({ event: "track.api.rate_limit", requestId, component: "track-api", action: "get", details: { retryAfterMs: rateLimit.retryAfterMs } });
    return NextResponse.json(
      { error: "Rate limit exceeded. Retry later." },
      { status: 429, headers: buildRateLimitHeaders(rateLimit) }
    );
  }
  if (!hasValidApiAuth(req, API_POLICIES.track.auth)) return withRateLimitHeaders(unauthorizedResponse(), rateLimit);
  return withRateLimitHeaders(await handleGet(req, requestId), rateLimit);
}

async function handleGet(req: Request, requestId: string) {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("u");
  if (!targetUrl) {
    return NextResponse.json({ error: "Missing ?u=<url>" }, { status: 400 });
  }

  const http = (await import("node:http")).default;
  const https = (await import("node:https")).default;

  const redirects: Array<{ url: string; status: number }> = [];
  let currentUrl: string | undefined;
  try { currentUrl = (await assertSafeOutboundUrl(targetUrl)).toString(); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unsafe destination" }, { status: 400 }); }
  let depth = 0;

  while (currentUrl && depth < 10) {
    const requestUrl = currentUrl;
    const parsed = await assertSafeOutboundUrl(requestUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    await new Promise<void>((resolve) => {
      const outbound = lib.get(parsed, { timeout: 10000 }, (res) => {
        const loc = res.headers.location;
        const statusCode = res.statusCode ?? 0;
        redirects.push({ url: requestUrl, status: statusCode });

        if (loc && (statusCode >= 300 && statusCode < 400)) {
          try {
            currentUrl = new URL(loc, parsed).toString();
            depth++;
          } catch {
            currentUrl = undefined;
          }
        } else {
          currentUrl = undefined;
        }
        res.resume();
        resolve();
      });
      outbound.on("timeout", () => outbound.destroy(new Error("Redirect request timed out")));
      outbound.on("error", () => { currentUrl = undefined; resolve(); });
    });

    if (!currentUrl) break;
  }

  // Extract final query params as potential suffix
  const finalUrl = redirects[redirects.length - 1]?.url || targetUrl;
  const finalQuery = extractExactQuerySuffix(finalUrl);

  const result = {
    targetUrl,
    redirects,
    finalUrl,
    finalQuery,
    capturedAt: new Date().toISOString(),
  };
  emitStructuredLog({ event: "track.get.result", requestId, component: "track-api", action: "get", details: { suffix: finalQuery || "", redirects: redirects.length } });

  return NextResponse.json(result);
}

// POST /api/track
// Store a captured redirect chain (called by proxy session manager after traffic)
async function postUnlocked(req: Request) {
  const requestId = newRequestId(req);
  emitStructuredLog({ event: "track.post.start", requestId, component: "track-api", action: "post" });
  const rateLimit = await checkRateLimit(req, API_POLICIES.track.rateLimit);
  if (!rateLimit.ok) {
    emitStructuredLog({ event: "track.api.rate_limit", requestId, component: "track-api", action: "post", details: { retryAfterMs: rateLimit.retryAfterMs } });
    return NextResponse.json(
      { error: "Rate limit exceeded. Retry later." },
      { status: 429, headers: buildRateLimitHeaders(rateLimit) }
    );
  }
  if (!hasValidApiAuth(req, API_POLICIES.track.auth)) return withRateLimitHeaders(unauthorizedResponse(), rateLimit);
  return withRateLimitHeaders(await handlePost(req, requestId), rateLimit);
}

async function handlePost(req: Request, requestId: string) {
  const body = await req.json().catch(() => null);
  const validation = validateTrackPost(body);
  if (!validation.ok) {
    emitStructuredLog({ event: "track.post.error", requestId, component: "track-api", action: "validation", error: formatValidationError(validation) });
    return NextResponse.json({ error: "Invalid or missing redirectChain", details: formatValidationError(validation) }, { status: 400 });
  }

  const redirectChain = validation.value!.redirectChain;
  const state = readState() as Record<string, unknown>;
  const suffix = inferSuffixFromRedirectChain(redirectChain);
  state.capturedChain = redirectChain;
  state.capturedAt = new Date().toISOString();
  if (suffix) {
    state.suffix = suffix;
    state.finalQuery = suffix;
  }
  writeState(state);
  emitStructuredLog({ event: "track.post.result", requestId, component: "track-api", action: "persist", details: { suffix, redirectCount: redirectChain.length } });

  return NextResponse.json({ ok: true, capturedAt: state.capturedAt, suffix });
}

export async function POST(request: Parameters<typeof postUnlocked>[0]) {
  return withCrossProcessLock("ads-state", () => postUnlocked(request));
}