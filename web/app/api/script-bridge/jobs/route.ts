import { NextResponse } from "next/server";
import {
  acknowledgeBridgeJob,
  authenticateBridgeShard,
  bridgeDatabaseConfigured,
  bridgeShardManifest,
  completeBridgeInvocation,
  leaseBridgeJobs,
  renewBridgeLeases,
  registerBridgeShard,
} from "@/lib/script-bridge-store";
import { readBridgeState, verifyBridgeToken } from "@/lib/google-ads-script-bridge";
import { checkRateLimit, withRateLimitHeaders } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_PROTOCOL = "fleet-two-phase-adaptive-relay-v9";
const LEGACY_PROTOCOLS = new Set(["fleet-two-phase-durable-relay-v8", "fleet-two-phase-hot-add-relay-v7", "fleet-hot-add-relay-v6", "fleet-hourly-relay-v5"]);
const ACTIVE_CONTRACT = "relational-lease-v2";
const SCRIPT_JOB_REQUESTS_PER_MINUTE = 6_000;

function bearer(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    || request.headers.get("x-api-key")?.trim()
    || "";
}

async function jsonBody(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 2_000_000) throw new Error("Request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text) > 2_000_000) throw new Error("Request body is too large");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function protocolAllowed(value: unknown) {
  const protocol = String(value || "");
  return protocol === ACTIVE_PROTOCOL || LEGACY_PROTOCOLS.has(protocol);
}

function contractAllowed(value: unknown) {
  return String(value || "") === ACTIVE_CONTRACT;
}

async function authenticate(request: Request, shardId: string) {
  const token = bearer(request);
  if (!shardId || !token) return false;
  if (await authenticateBridgeShard(shardId, token)) return true;
  try {
    const legacyState = await readBridgeState();
    if (await verifyBridgeToken(legacyState, token, shardId)) {
      await registerBridgeShard(shardId, token);
      return true;
    }
  } catch { /* no legacy bridge state */ }
  return false;
}

async function lease(request: Request, input: Record<string, unknown>) {
  const shardId = String(input.shardId || input.shard || "default").trim();
  const workerId = String(input.workerId || input.worker || "google-ads-script").trim().slice(0, 200);
  const protocol = String(input.protocol || "");
  if (!protocolAllowed(input.protocol) || !contractAllowed(input.contract)) {
    return NextResponse.json({ error: "Outdated Fleet worker. Regenerate and install the selected shard's v9 adaptive two-phase script." }, { status: 409 });
  }
  if (!await authenticate(request, shardId)) return NextResponse.json({ error: "Invalid shard credentials" }, { status: 401 });
  const wantsManifest = input.manifest === true || input.manifest === 1 || String(input.manifest || "") === "1";
  if (wantsManifest) {
    const preview = input.preview === true || input.preview === 1 || String(input.preview || "") === "1";
    const invocationId = String(input.invocationId || workerId.replace(/^manifest-/, "")).trim().slice(0, 200);
    return NextResponse.json(
      {
        ok: true,
        ...(await bridgeShardManifest(shardId, {
          invocationId,
          protocol,
          preview,
          adaptive: protocol === ACTIVE_PROTOCOL,
        })),
        protocol,
        serverTime: new Date().toISOString(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const customerId = String(input.customer || input.customerId || "").trim();
  const hotAddRequested = input.hotAdd === true || input.hotAdd === 1 || String(input.hotAdd || "") === "1";
  const jobs = await leaseBridgeJobs(
    shardId,
    workerId,
    Number(input.maxJobs || input.limit || 25),
    customerId,
    { protocol, hotAdd: hotAddRequested },
  );
  return NextResponse.json({ ok: true, protocol, contract: ACTIVE_CONTRACT, jobs, leases: jobs, serverTime: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  if (!bridgeDatabaseConfigured()) return NextResponse.json({ error: "Fleet database is not configured" }, { status: 503 });
  const limit = await checkRateLimit(request, {
    namespace: "script-jobs",
    limit: SCRIPT_JOB_REQUESTS_PER_MINUTE,
    windowMs: 60_000,
    envVarLimitName: "TAH_SCRIPT_JOBS_RATE_LIMIT_PER_MINUTE",
  });
  if (!limit.ok) return withRateLimitHeaders(NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }), limit);
  const url = new URL(request.url);
  try {
    return withRateLimitHeaders(await lease(request, Object.fromEntries(url.searchParams)), limit);
  } catch (error) {
    return withRateLimitHeaders(NextResponse.json({ error: error instanceof Error ? error.message : "Lease failed" }, { status: 500 }), limit);
  }
}

export async function POST(request: Request) {
  if (!bridgeDatabaseConfigured()) return NextResponse.json({ error: "Fleet database is not configured" }, { status: 503 });
  const limit = await checkRateLimit(request, {
    namespace: "script-jobs",
    limit: SCRIPT_JOB_REQUESTS_PER_MINUTE,
    windowMs: 60_000,
    envVarLimitName: "TAH_SCRIPT_JOBS_RATE_LIMIT_PER_MINUTE",
  });
  if (!limit.ok) return withRateLimitHeaders(NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }), limit);
  try {
    const input = await jsonBody(request);
    const action = String(input.action || "lease").toLowerCase();
    if (action === "lease" || action === "poll") return withRateLimitHeaders(await lease(request, input), limit);
    if (action === "complete") {
      if (!protocolAllowed(input.protocol) || !contractAllowed(input.contract)) {
        return withRateLimitHeaders(NextResponse.json({ error: "Outdated Fleet worker. Regenerate and install the selected shard's v9 adaptive two-phase script." }, { status: 409 }), limit);
      }
      const shardId = String(input.shardId || input.shard || "default").trim();
      if (!await authenticate(request, shardId)) return withRateLimitHeaders(NextResponse.json({ error: "Invalid shard credentials" }, { status: 401 }), limit);
      const completion = await completeBridgeInvocation({
        shardId,
        invocationId: String(input.invocationId || "").trim().slice(0, 200),
        status: String(input.status || "completed").toLowerCase(),
      });
      return withRateLimitHeaders(NextResponse.json({ ok: true, ...completion, serverTime: new Date().toISOString() }, { headers: { "cache-control": "no-store" } }), limit);
    }
    if (action === "renew") {
      if (!protocolAllowed(input.protocol) || !contractAllowed(input.contract)) {
        return withRateLimitHeaders(NextResponse.json({ error: "Outdated Fleet worker. Regenerate and install the selected shard's v9 adaptive two-phase script." }, { status: 409 }), limit);
      }
      const shardId = String(input.shardId || input.shard || "default").trim();
      const workerId = String(input.workerId || input.worker || "google-ads-script").trim().slice(0, 200);
      if (!await authenticate(request, shardId)) return withRateLimitHeaders(NextResponse.json({ error: "Invalid shard credentials" }, { status: 401 }), limit);
      const rawLeases = Array.isArray(input.leases) ? input.leases : [];
      if (rawLeases.length > 200) return withRateLimitHeaders(NextResponse.json({ error: "At most 200 leases can be renewed" }, { status: 400 }), limit);
      const renewal = await renewBridgeLeases({
        shardId,
        workerId,
        leases: rawLeases.map((raw) => {
          const lease = raw as Record<string, unknown>;
          return { jobId: String(lease.jobId || ""), leaseToken: String(lease.leaseToken || lease.lease || "") };
        }),
      });
      return withRateLimitHeaders(NextResponse.json({
        ok: true,
        allRenewed: renewal.staleJobIds.length === 0,
        renewed: renewal.renewedJobIds.length,
        staleJobIds: renewal.staleJobIds,
        leaseDurationMs: renewal.leaseDurationMs,
        serverTime: new Date().toISOString(),
      }, { headers: { "cache-control": "no-store" } }), limit);
    }
    if (action !== "ack" && action !== "acknowledge") {
      return withRateLimitHeaders(NextResponse.json({ error: "Unsupported action" }, { status: 400 }), limit);
    }
    if (!protocolAllowed(input.protocol) || !contractAllowed(input.contract)) {
      return withRateLimitHeaders(NextResponse.json({ error: "Outdated Fleet worker. Regenerate and install the selected shard's v9 adaptive two-phase script." }, { status: 409 }), limit);
    }
    const shardId = String(input.shardId || input.shard || "default").trim();
    const workerId = String(input.workerId || input.worker || "google-ads-script").trim().slice(0, 200);
    if (!await authenticate(request, shardId)) return withRateLimitHeaders(NextResponse.json({ error: "Invalid shard credentials" }, { status: 401 }), limit);
    const rawResults = Array.isArray(input.results) ? input.results : [input];
    if (rawResults.length > 200) return withRateLimitHeaders(NextResponse.json({ error: "At most 200 acknowledgements are accepted" }, { status: 400 }), limit);
    const results = [];
    for (const raw of rawResults) {
      const result = raw as Record<string, unknown>;
      results.push(await acknowledgeBridgeJob({
        shardId,
        workerId,
        jobId: String(result.jobId || ""),
        leaseToken: String(result.leaseToken || result.lease || ""),
        ok: result.ok === true || result.status === "applied" || result.status === "verified",
        appliedSuffix: typeof result.appliedSuffix === "string" ? result.appliedSuffix : typeof result.suffix === "string" ? result.suffix : undefined,
        error: typeof result.error === "string" ? result.error : undefined,
      }));
    }
    return withRateLimitHeaders(NextResponse.json({ ok: true, allApplied: results.every((result) => result.ok), results, serverTime: new Date().toISOString() }, { headers: { "cache-control": "no-store" } }), limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker request failed";
    const status = /invalid|expired|too large/i.test(message) ? 400 : 500;
    return withRateLimitHeaders(NextResponse.json({ error: message }, { status }), limit);
  }
}
