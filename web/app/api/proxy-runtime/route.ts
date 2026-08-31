import { NextResponse } from "next/server";
import { hasValidApiAuth } from "@/lib/api-auth-core";
import { configuredProxyRuntimeService, ProxyPolicyNotFoundError, ProxyRuntimeUnavailableError } from "../../../server/proxy-runtime-service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTH = { envVarName: "CONTROL_TOKEN", fallbackEnvVarName: "TAH_API_BEARER_TOKEN", scope: "control" } as const;
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

async function parseBody(request: Request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 32_000) throw new Error("Request body is too large");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

export async function POST(request: Request) {
  if (!hasValidApiAuth(request, AUTH)) return NextResponse.json({ error: "Control authentication required" }, { status: 401, headers: HEADERS });
  try {
    const runtimeService = await configuredProxyRuntimeService();
    if (!runtimeService) return NextResponse.json({ error: "Universal proxy runtime is disabled" }, { status: 409, headers: HEADERS });
    const body = await parseBody(request);
    const action = String(body.action || "");
    if (action === "lease") return NextResponse.json({ ok: true, lease: await runtimeService.resolve(body) }, { status: 201, headers: HEADERS });
    if (action === "renew") {
      const lease = await runtimeService.renew(String(body.leaseId || ""), Number(body.ttlMs) || undefined);
      return lease ? NextResponse.json({ ok: true, lease }, { headers: HEADERS }) : NextResponse.json({ error: "Lease is stale or expired" }, { status: 409, headers: HEADERS });
    }
    if (action === "report") return NextResponse.json({ ok: true, circuit: await runtimeService.report(body) }, { headers: HEADERS });
    if (action === "release") return NextResponse.json({ ok: await runtimeService.release(String(body.leaseId || ""), String(body.state || "released")) }, { headers: HEADERS });
    return NextResponse.json({ error: "Unsupported action" }, { status: 400, headers: HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proxy runtime operation failed";
    const status = error instanceof ProxyPolicyNotFoundError ? 404 : error instanceof ProxyRuntimeUnavailableError ? 503 : /required|invalid|too large/i.test(message) ? 400 : 503;
    return NextResponse.json({ error: message }, { status, headers: HEADERS });
  }
}
