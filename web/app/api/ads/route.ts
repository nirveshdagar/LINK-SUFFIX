import { withCrossProcessLock } from "@/lib/cross-process-lock";
import { NextResponse } from "next/server";
import { GoogleAdsApiError, GoogleAdsMutationIntervalError, GoogleAdsUpdater } from "@tah/google-ads";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { hasValidApiAuth, unauthorizedResponse } from "@/lib/api-auth";
import { API_POLICIES } from "@/lib/api-policy";
import { emitStructuredLog, newRequestId } from "@/lib/observability";
import { formatValidationError, validateAdsGet, validateAdsPost } from "@/lib/endpoint-schemas";
import { buildRateLimitHeaders, checkRateLimit, withRateLimitHeaders } from "@/lib/rate-limit";
import { readEncryptedJsonSync, writeEncryptedJsonSync } from "@/lib/secure-state";
import { extractExactQuerySuffix } from "@/lib/url-security";

export const runtime = "nodejs";
const ROOT = process.env.WORKSPACE_ROOT ? path.join(process.env.WORKSPACE_ROOT, "web") : process.cwd();
const RUNTIME_ROOT = process.env.WORKSPACE_ROOT || path.resolve(ROOT, "..");
const STATE_FILE = path.join(ROOT, "ads-state.json");
const CAPTURE_STATE_FILE = process.env.TAH_ADS_CAPTURE_STATE_PATH || path.join(RUNTIME_ROOT, "runs", "ads-capture-state.json");
const MAX_TEXT = 2048;
const MAX_HISTORY = Math.max(20, Math.min(500, Number(process.env.TAH_ADS_MAX_PUSH_HISTORY) || 100));

interface AdsSyncState {
  campaignId?: string;
  customerId?: string;
  loginCustomerId?: string;
  clientId?: string;
  clientSecret?: string;
  developerToken?: string;
  refreshToken?: string;
  lastSuffix?: string;
  lastPushedAt?: string;
  lastError?: string;
  pushHistory: Array<{ at: string; suffix: string; customerId?: string; campaignId?: string; requestId?: string; result?: string; error?: string }>;
}

type RawState = Record<string, unknown>;

function readState(): AdsSyncState {
  if (!existsSync(STATE_FILE)) return { pushHistory: [] };
  const raw = readEncryptedJsonSync<RawState>(STATE_FILE, {}, "google-ads-state");
  return {
    campaignId: toStringIf(raw.campaignId),
    customerId: toStringIf(raw.customerId),
    loginCustomerId: toStringIf(raw.loginCustomerId),
    clientId: toStringIf(raw.clientId),
    clientSecret: toStringIf(raw.clientSecret),
    developerToken: toStringIf(raw.developerToken),
    refreshToken: toStringIf(raw.refreshToken),
    lastSuffix: inferCurrentSuffix(raw),
    lastPushedAt: toStringIf(raw.lastPushedAt),
    lastError: toStringIf(raw.lastError),
    pushHistory: Array.isArray(raw.pushHistory) ? raw.pushHistory : [],
  };
}

function writeState(state: AdsSyncState) {
  const trackState = readTrackState();
  const trackSuffix = normalizeSuffix((trackState as Record<string, unknown>).suffix);
  const mergedSuffix = normalizeSuffix(state.lastSuffix) || trackSuffix;
  const merged = {
    ...trackState,
    campaignId: state.campaignId,
    customerId: state.customerId,
    loginCustomerId: state.loginCustomerId,
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    developerToken: state.developerToken,
    refreshToken: state.refreshToken,
    suffix: mergedSuffix,
    lastSuffix: state.lastSuffix,
    lastPushedAt: state.lastPushedAt,
    lastError: state.lastError,
    pushHistory: state.pushHistory,
  };
  writeEncryptedJsonSync(STATE_FILE, merged, "google-ads-state");
}

function readTrackState(): RawState {
  let state: RawState = { suffix: "", history: [] };
  try {
    if (existsSync(STATE_FILE)) {
      state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as RawState;
    }
  } catch { /* ignore */ }
  try {
    if (existsSync(CAPTURE_STATE_FILE)) {
      const captureState = JSON.parse(readFileSync(CAPTURE_STATE_FILE, "utf8")) as RawState;
      return { ...state, ...captureState };
    }
  } catch { /* ignore */ }
  return state;
}

function normalizeSuffix(raw: unknown) {
  const text = toStringIf(raw);
  return text.startsWith("?") ? text.slice(1) : text;
}

function toStringIf(value: unknown) {
  return typeof value === "string" ? value : "";
}

function toText(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  return text.slice(0, Math.max(1, Math.min(max, MAX_TEXT)));
}

function applyConfiguredState(state: AdsSyncState, body: Record<string, unknown>) {
  const next = { ...state };
  const campaignId = toText(body.campaignId, 120);
  const customerId = toText(body.customerId, 30);
  const loginCustomerId = toText(body.loginCustomerId, 30);
  const clientId = toText(body.clientId, 200);
  const clientSecret = toText(body.clientSecret, 200);
  const developerToken = toText(body.developerToken, 200);
  const refreshToken = toText(body.refreshToken, 500);

  if (Object.prototype.hasOwnProperty.call(body, "campaignId")) next.campaignId = campaignId || undefined;
  if (Object.prototype.hasOwnProperty.call(body, "customerId")) next.customerId = customerId || undefined;
  if (Object.prototype.hasOwnProperty.call(body, "loginCustomerId")) next.loginCustomerId = loginCustomerId || undefined;
  if (Object.prototype.hasOwnProperty.call(body, "clientId")) next.clientId = clientId || undefined;
  if (Object.prototype.hasOwnProperty.call(body, "clientSecret")) next.clientSecret = clientSecret || undefined;
  if (Object.prototype.hasOwnProperty.call(body, "developerToken")) next.developerToken = developerToken || undefined;
  if (Object.prototype.hasOwnProperty.call(body, "refreshToken")) next.refreshToken = refreshToken || undefined;

  return next;
}

function hasConfigPayload(body: Record<string, unknown>) {
  return (
    Object.prototype.hasOwnProperty.call(body, "campaignId") ||
    Object.prototype.hasOwnProperty.call(body, "customerId") ||
    Object.prototype.hasOwnProperty.call(body, "loginCustomerId") ||
    Object.prototype.hasOwnProperty.call(body, "clientId") ||
    Object.prototype.hasOwnProperty.call(body, "clientSecret") ||
    Object.prototype.hasOwnProperty.call(body, "developerToken") ||
    Object.prototype.hasOwnProperty.call(body, "refreshToken")
  );
}

function inferSuffixFromRedirectChain(chain: unknown) {
  if (!Array.isArray(chain) || chain.length === 0) return "";
  const last = chain.at(-1) as Record<string, unknown> | undefined;
  const candidate = typeof last?.url === "string" ? last.url : "";
  if (!candidate) return "";
  try {
    return extractExactQuerySuffix(candidate);
  } catch {
    return "";
  }
}

function inferCurrentSuffix(state: RawState) {
  return (
    normalizeSuffix(state.suffix) ||
    normalizeSuffix(state.lastSuffix) ||
    normalizeSuffix(state.finalQuery) ||
    inferSuffixFromRedirectChain(state.capturedChain)
  );
}

function getLatestSuffix(): string {
  return inferCurrentSuffix(readTrackState());
}

function hasRequiredCredentials(state: AdsSyncState) {
  return Boolean(state.clientId && state.clientSecret && state.developerToken && state.refreshToken);
}

function hasRequiredCampaign(state: AdsSyncState) {
  return Boolean(state.customerId && state.campaignId);
}

function hasStoredCredentials(state: AdsSyncState) {
  return {
    clientIdStored: Boolean(state.clientId),
    clientSecretStored: Boolean(state.clientSecret),
    developerTokenStored: Boolean(state.developerToken),
    refreshTokenStored: Boolean(state.refreshToken),
  };
}

function latestRecentSuccessPush(history: AdsSyncState["pushHistory"], customerId: string, campaignId: string) {
  const now = Date.now();
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry || entry.result !== "success") continue;
    if (entry.customerId && entry.customerId.replace(/-/g, "") !== customerId.replace(/-/g, "")) continue;
    if (entry.campaignId && entry.campaignId !== campaignId) continue;
    const ts = Date.parse(entry.at ?? "");
    if (!Number.isFinite(ts)) continue;
    if (now - ts <= 58_000) return entry;
  }
  return undefined;
}

export async function GET(req: Request) {
  const requestId = newRequestId(req);
  emitStructuredLog({ event: "ads.api.start", requestId, component: "ads-api", action: "get" });
  const rateLimit = await checkRateLimit(req, API_POLICIES.ads.rateLimit);
  if (!rateLimit.ok) {
    emitStructuredLog({ event: "ads.api.rate_limit", requestId, component: "ads-api", action: "get", details: { retryAfterMs: rateLimit.retryAfterMs } });
    return NextResponse.json(
      { error: "Rate limit exceeded. Retry later." },
      { status: 429, headers: buildRateLimitHeaders(rateLimit) }
    );
  }
  if (!hasValidApiAuth(req, API_POLICIES.ads.auth)) return withRateLimitHeaders(unauthorizedResponse(), rateLimit);
  const state = readState();
  const suffix = getLatestSuffix();
  const creds = hasStoredCredentials(state);
  const response = {
    campaignId: state.campaignId ?? "",
    customerId: state.customerId ?? "",
    loginCustomerId: state.loginCustomerId ?? "",
    clientId: state.clientId ? `••••${state.clientId.slice(-4)}` : "",
    clientSecret: state.clientSecret ? `••••${state.clientSecret.slice(-4)}` : "",
    developerToken: state.developerToken ? `••••${state.developerToken.slice(-4)}` : "",
    refreshToken: state.refreshToken ? `••••${state.refreshToken.slice(-4)}` : "",
    ...creds,
    hasCredentials: hasRequiredCredentials(state),
    currentSuffix: suffix,
    lastSuffix: state.lastSuffix ?? "",
    lastPushedAt: state.lastPushedAt ?? "",
    lastError: state.lastError ?? "",
    pushHistory: state.pushHistory.slice(-20),
  };
  const validation = validateAdsGet(response);
  if (!validation.ok) {
    emitStructuredLog({ event: "ads.api.error", requestId, component: "ads-api", action: "response_schema", error: formatValidationError(validation) });
  }
  return withRateLimitHeaders(NextResponse.json(response), rateLimit);
}

async function postUnlocked(req: Request) {
  const requestId = newRequestId(req);
  emitStructuredLog({ event: "ads.api.start", requestId, component: "ads-api", action: "post" });
  const rateLimit = await checkRateLimit(req, API_POLICIES.ads.rateLimit);
  if (!rateLimit.ok) {
    emitStructuredLog({ event: "ads.api.rate_limit", requestId, component: "ads-api", action: "post", details: { retryAfterMs: rateLimit.retryAfterMs } });
    return NextResponse.json(
      { error: "Rate limit exceeded. Retry later." },
      { status: 429, headers: buildRateLimitHeaders(rateLimit) }
    );
  }
  if (!hasValidApiAuth(req, API_POLICIES.ads.auth)) return withRateLimitHeaders(unauthorizedResponse(), rateLimit);
  return withRateLimitHeaders(await handlePost(req, requestId), rateLimit);
}

async function handlePost(req: Request, requestId: string) {
  const raw = await req.json().catch(() => null);
  const validation = validateAdsPost(raw);
  if (!validation.ok) {
    emitStructuredLog({ event: "ads.api.error", requestId, component: "ads-api", action: "post_validation", error: formatValidationError(validation) });
    return NextResponse.json({ error: "Invalid or missing action", details: formatValidationError(validation) }, { status: 400 });
  }

  const body = validation.value!;

  let state = readState();

  if (body.action === "configure") {
    const bodyRecord = body as unknown as Record<string, unknown>;
    emitStructuredLog({ event: "ads.api.configure", requestId, component: "ads-api", action: "save", details: { hasCampaign: Boolean(bodyRecord.campaignId), hasCustomer: Boolean(bodyRecord.customerId) } });
    if (!hasConfigPayload(bodyRecord)) {
      return NextResponse.json({ error: "No configuration fields provided" }, { status: 400 });
    }

    state = applyConfiguredState(state, bodyRecord);
    writeState(state);
    return NextResponse.json({
      ok: true,
      campaignId: state.campaignId,
      customerId: state.customerId,
      hasCredentials: hasRequiredCredentials(state),
    });
  }

  if (body.action === "refresh_suffix") {
    emitStructuredLog({ event: "ads.api.refresh_suffix", requestId, component: "ads-api", action: "fetch" });
    const suffix = getLatestSuffix();
    state.lastSuffix = suffix;
    state.lastError = suffix ? undefined : "No suffix captured yet — send traffic through /api/track first.";
    writeState(state);
    return NextResponse.json({ ok: true, suffix });
  }

  if (body.action === "push_to_ads") {
    emitStructuredLog({ event: "ads.api.push_to_ads", requestId, component: "ads-api", action: "attempt", details: { customerId: state.customerId, campaignId: state.campaignId } });
    const suffix = getLatestSuffix();
    if (!suffix) {
      const err = "No suffix to push — run traffic first to capture a redirect chain.";
      state.lastError = err;
      writeState(state);
      return NextResponse.json({ ok: false, error: err }, { status: 400 });
    }

    if (!hasRequiredCampaign(state)) {
      const err = "Campaign/customer IDs are not fully configured.";
      state.lastError = err;
      writeState(state);
      return NextResponse.json({ ok: false, error: err }, { status: 400 });
    }

    if (!hasRequiredCredentials(state)) {
      const err = "Google Ads credentials are incomplete.";
      state.lastError = err;
      writeState(state);
      return NextResponse.json({ ok: false, error: err }, { status: 400 });
    }

    const recent = latestRecentSuccessPush(state.pushHistory, state.customerId!, state.campaignId!);
    if (recent) {
      state.lastError = undefined;
      state.lastSuffix = suffix;
      writeState(state);
      return NextResponse.json({
        ok: true,
        skipped: true,
        at: recent.at,
        suffix,
        note: "Recent identical suffix already pushed.",
      });
    }

    const at = new Date().toISOString();
    try {
      const updater = new GoogleAdsUpdater({
        developerToken: state.developerToken!,
        clientId: state.clientId!,
        clientSecret: state.clientSecret!,
        refreshToken: state.refreshToken!,
        customerId: state.customerId!,
        loginCustomerId: state.loginCustomerId,
      });
      const result = await updater.updateCampaignSuffix(state.customerId!, state.campaignId!, suffix);
      state.lastSuffix = suffix;
      state.lastPushedAt = at;
      state.lastError = undefined;
      state.pushHistory.push({ at, suffix, customerId: state.customerId, campaignId: state.campaignId, requestId: result.requestId, result: "success", error: undefined });
      state.pushHistory = state.pushHistory.slice(-MAX_HISTORY);
      writeState(state);

      return NextResponse.json({
        ok: true,
        pushed: true,
        suffix,
        at,
        result,
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      emitStructuredLog({ event: "ads.api.push_to_ads", requestId, component: "ads-api", action: "error", error: err });
      state.lastError = err;
      const googleError = error instanceof GoogleAdsApiError ? error : undefined;
      state.pushHistory.push({ at, suffix, customerId: state.customerId, campaignId: state.campaignId, requestId: googleError?.requestId, result: "error", error: err });
      state.pushHistory = state.pushHistory.slice(-MAX_HISTORY);
      writeState(state);
      if (error instanceof GoogleAdsMutationIntervalError) {
        const retryAfter = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
        return NextResponse.json({ ok: false, error: err, retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
      }
      return NextResponse.json({ ok: false, error: err, requestId: googleError?.requestId }, { status: googleError?.retryable ? 503 : 502 });
    }
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}

export async function POST(request: Parameters<typeof postUnlocked>[0]) {
  return withCrossProcessLock("ads-state", () => postUnlocked(request));
}
