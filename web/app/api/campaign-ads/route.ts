import { withCrossProcessLock } from "@/lib/cross-process-lock";
import { NextResponse } from "next/server";
import { GoogleAdsApiError, GoogleAdsMutationIntervalError, GoogleAdsUpdater } from "@tah/google-ads";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { hasValidApiAuth, unauthorizedResponse } from "@/lib/api-auth";
import { API_POLICIES } from "@/lib/api-policy";
import { atomicWriteJsonSync } from "@/lib/atomic-json";
import { buildRateLimitHeaders, checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = process.env.WORKSPACE_ROOT ? path.join(process.env.WORKSPACE_ROOT, "web") : process.cwd();
const STATE_FILE = path.join(ROOT, "ads-state.json");

function credentials() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!state.clientId || !state.clientSecret || !state.developerToken || !state.refreshToken) return null;
    return state as { clientId: string; clientSecret: string; developerToken: string; refreshToken: string; loginCustomerId?: string; campaignMutationHistory?: Array<{ customerId?: string; campaignId: string; suffix: string; at: string; requestId?: string }> };
  } catch { return null; }
}

const mutationTails = new Map<string, Promise<void>>();
async function serializeMutation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  mutationTails.set(key, tail);
  await previous;
  try { return await task(); } finally {
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

async function postUnlocked(req: Request) {
  const rateLimit = await checkRateLimit(req, API_POLICIES.ads.rateLimit);
  if (!rateLimit.ok) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: buildRateLimitHeaders(rateLimit) });
  if (!hasValidApiAuth(req, API_POLICIES.ads.auth)) return unauthorizedResponse();
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const customerId = typeof body?.customerId === "string" ? body.customerId : "";
  const campaignId = typeof body?.campaignId === "string" ? body.campaignId : "";
  const loginCustomerId = typeof body?.loginCustomerId === "string" ? body.loginCustomerId : "";
  const suffix = typeof body?.suffix === "string" ? body.suffix : "";
  if (!/^\d{6,15}$/.test(customerId.replace(/-/g, "")) || !/^\d+$/.test(campaignId) || !suffix || suffix.length > 2048) {
    return NextResponse.json({ error: "Valid customerId, numeric campaignId, and exact suffix up to 2048 characters are required" }, { status: 400 });
  }
  const normalizedCustomerId = customerId.replace(/-/g, "");
  const normalizedLoginCustomerId = loginCustomerId.replace(/-/g, "");
  if (normalizedLoginCustomerId && !/^\d{10}$/.test(normalizedLoginCustomerId)) {
    return NextResponse.json({ error: "Manager account ID (MCC) must contain exactly 10 digits" }, { status: 400 });
  }
  const mutationKey = `${normalizedCustomerId}:${campaignId}`;
  return serializeMutation(mutationKey, async () => {
    const creds = credentials();
    if (!creds) return NextResponse.json({ error: "Global Google Ads OAuth credentials are not configured" }, { status: 400 });
    const history = Array.isArray(creds.campaignMutationHistory) ? creds.campaignMutationHistory : [];
    const previous = [...history].reverse().find((entry) => entry.campaignId === campaignId && (!entry.customerId || entry.customerId.replace(/-/g, "") === normalizedCustomerId));
    const elapsed = previous ? Date.now() - Date.parse(previous.at) : Number.POSITIVE_INFINITY;
    if (elapsed < 58_000) {
      const retryAfter = Math.max(1, Math.ceil((58_000 - elapsed) / 1000));
      return NextResponse.json({ error: "Campaign mutation interval has not elapsed", retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
    }
    try {
      const updater = new GoogleAdsUpdater({ ...creds, customerId: normalizedCustomerId, loginCustomerId: normalizedLoginCustomerId || creds.loginCustomerId?.replace(/-/g, "") });
      const result = await updater.updateCampaignSuffix(customerId, campaignId, suffix);
      const at = new Date().toISOString();
      const latest = credentials() ?? creds;
      const latestHistory = Array.isArray(latest.campaignMutationHistory) ? latest.campaignMutationHistory : [];
      atomicWriteJsonSync(STATE_FILE, { ...latest, campaignMutationHistory: [...latestHistory, { customerId: normalizedCustomerId, campaignId, suffix, at, requestId: result.requestId }].slice(-5000) });
      return NextResponse.json({ ok: true, pushed: true, suffix, at, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof GoogleAdsMutationIntervalError) {
        const retryAfter = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
        return NextResponse.json({ error: message, retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
      }
      const googleError = error instanceof GoogleAdsApiError ? error : undefined;
      return NextResponse.json({ error: message, requestId: googleError?.requestId }, { status: googleError?.retryable ? 503 : 502 });
    }
  });
}

export async function POST(request: Parameters<typeof postUnlocked>[0]) {
  return withCrossProcessLock("ads-state", () => postUnlocked(request));
}