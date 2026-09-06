import { NextResponse } from "next/server";
import { hasValidApiAuth } from "@/lib/api-auth-core";
import { configuredProxyProviderService } from "../../../server/proxy-provider-store.mjs";
import { saveProviderSetup, saveCampaignProxy } from "../../../server/proxy-provider-setup.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const AUTH = { envVarName: "CONTROL_TOKEN", fallbackEnvVarName: "TAH_API_BEARER_TOKEN", scope: "control" } as const;
const HEADERS = { "cache-control": "no-store" };
function unauthorized() { return NextResponse.json({ error: "Control authentication required" }, { status: 401, headers: HEADERS }); }
async function serviceResponse() {
  const service = await configuredProxyProviderService();
  if (!service) return { service: null, response: NextResponse.json({ configured: false, error: "DATABASE_URL is required" }, { status: 503, headers: HEADERS }) };
  if (!(await service.status()).migrated) return { service: null, response: NextResponse.json({ configured: true, migrated: false, error: "Universal proxy migration 006 has not been applied" }, { status: 503, headers: HEADERS }) };
  return { service, response: null };
}
export async function GET(request: Request) {
  if (!hasValidApiAuth(request, AUTH)) return unauthorized();
  try {
    const resolved = await serviceResponse();
    if (resolved.response) return resolved.response;
    return NextResponse.json({ ...await resolved.service!.overview(), runtimeEnabled: ["1", "true"].includes(String(process.env.TAH_UNIVERSAL_PROXY_ENABLED || "").toLowerCase()) }, { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Proxy registry is unavailable" }, { status: 503, headers: HEADERS });
  }
}
export async function POST(request: Request) {
  if (!hasValidApiAuth(request, AUTH)) return unauthorized();
  try {
    if (Number(request.headers.get("content-length") || 0) > 128000) throw new Error("Request body is too large");
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 128000) throw new Error("Request body is too large");
    const payload = raw ? JSON.parse(raw) : {};
    const resolved = await serviceResponse();
    if (resolved.response) return resolved.response;
    const service = resolved.service!;
    switch (String(payload.action || "")) {
      case "save_provider":
        return NextResponse.json({ ok: true, ...await saveProviderSetup(payload.provider, payload.secret) }, { status: 201, headers: HEADERS });
      case "save_secret": {
        const provider = await service.repository.getProvider(String(payload.providerId || ""));
        if (!provider) throw new Error("Provider was not found");
        await saveProviderSetup(provider, payload.secret);
        return NextResponse.json({ ok: true, providerId: provider.providerId, secretConfigured: true }, { headers: HEADERS });
      }
      case "save_pool":
        return NextResponse.json({ ok: true, pool: await service.savePool(payload.pool) }, { status: 201, headers: HEADERS });
      case "save_campaign_proxy":
      case "assign_policy":
        return NextResponse.json({ ok: true, policy: await saveCampaignProxy(payload.policy) }, { headers: HEADERS });
      case "set_provider_enabled":
        return NextResponse.json({ ok: true, provider: await service.setProviderEnabled(String(payload.providerId || ""), payload.enabled === true) }, { headers: HEADERS });
      case "reset_circuit":
        await service.resetCircuit(String(payload.providerId || ""), payload.poolId ? String(payload.poolId) : undefined);
        return NextResponse.json({ ok: true }, { headers: HEADERS });
      default: return NextResponse.json({ error: "Unsupported action" }, { status: 400, headers: HEADERS });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proxy registry operation failed";
    return NextResponse.json({ error: message }, { status: /Stop the campaign/.test(message) ? 409 : /required|invalid|unsupported|not found|match|ports|differ|too large|select|template|mode/i.test(message) ? 400 : 503, headers: HEADERS });
  }
}
