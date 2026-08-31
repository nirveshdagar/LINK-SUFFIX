import { NextResponse } from "next/server";
import { hasValidApiAuth } from "@/lib/api-auth-core";
import { configuredProxyProviderService } from "../../../server/proxy-provider-store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTH = { envVarName: "CONTROL_TOKEN", fallbackEnvVarName: "TAH_API_BEARER_TOKEN", scope: "control" } as const;

function unauthorized() {
  return NextResponse.json({ error: "Control authentication required" }, { status: 401, headers: { "cache-control": "no-store" } });
}

async function body(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 128_000) throw new Error("Request body is too large");
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 128_000) throw new Error("Request body is too large");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function serviceResponse() {
  const service = await configuredProxyProviderService();
  if (!service) return { service: null, response: NextResponse.json({ configured: false, error: "DATABASE_URL is required" }, { status: 503, headers: { "cache-control": "no-store" } }) };
  const status = await service.status();
  if (!status.migrated) return { service: null, response: NextResponse.json({ configured: true, migrated: false, error: "Universal proxy migration 006 has not been applied" }, { status: 503, headers: { "cache-control": "no-store" } }) };
  return { service, response: null };
}

export async function GET(request: Request) {
  if (!hasValidApiAuth(request, AUTH)) return unauthorized();
  try {
    const resolved = await serviceResponse();
    if (resolved.response) return resolved.response;
    const overview = await resolved.service!.overview();
    return NextResponse.json({ ...overview, runtimeEnabled: ["1", "true"].includes(String(process.env.TAH_UNIVERSAL_PROXY_ENABLED || "").toLowerCase()) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Proxy registry is unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

export async function POST(request: Request) {
  if (!hasValidApiAuth(request, AUTH)) return unauthorized();
  try {
    const payload = await body(request);
    const resolved = await serviceResponse();
    if (resolved.response) return resolved.response;
    const service = resolved.service!;
    const action = String(payload.action || "");
    if (action === "save_provider") {
      const provider = await service.saveProvider(payload.provider, payload.secret);
      return NextResponse.json({ ok: true, provider }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    if (action === "save_secret") {
      const result = await service.saveSecret(String(payload.providerId || ""), payload.secret);
      return NextResponse.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
    }
    if (action === "save_pool") {
      const pool = await service.savePool(payload.pool);
      return NextResponse.json({ ok: true, pool }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    if (action === "assign_policy") {
      const policy = await service.assignPolicy(payload.policy);
      return NextResponse.json({ ok: true, policy }, { status: 201, headers: { "cache-control": "no-store" } });
    }
    if (action === "set_provider_enabled") {
      const provider = await service.setProviderEnabled(String(payload.providerId || ""), payload.enabled === true);
      return NextResponse.json({ ok: true, provider }, { headers: { "cache-control": "no-store" } });
    }
    if (action === "reset_circuit") {
      await service.resetCircuit(String(payload.providerId || ""), payload.poolId ? String(payload.poolId) : undefined);
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: "Unsupported action" }, { status: 400, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proxy registry operation failed";
    return NextResponse.json({ error: message }, { status: /required|invalid|unsupported|not found|match|ports|differ|too large/i.test(message) ? 400 : 503, headers: { "cache-control": "no-store" } });
  }
}
