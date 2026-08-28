import { NextResponse } from "next/server";
import { hasValidApiAuth } from "@/lib/api-auth-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function insecureLoopbackAllowed(request: Request) {
  if (process.env.NODE_ENV === "production" || !["1", "true"].includes(String(process.env.TAH_ALLOW_INSECURE_LOCAL_DEV || "").toLowerCase())) return false;
  try {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function controlBaseUrl() {
  const raw = process.env.TAH_CONTROL_INTERNAL_URL?.trim() || "http://127.0.0.1:3101";
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("TAH_CONTROL_INTERNAL_URL must use HTTP or HTTPS");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function GET(request: Request) {
  if (!insecureLoopbackAllowed(request) && !hasValidApiAuth(request, { envVarName: "TAH_API_BEARER_TOKEN", fallbackEnvVarName: "CONTROL_TOKEN", scope: "control" })) {
    return NextResponse.json({ error: "Control authentication required" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  try {
    const token = process.env.CONTROL_TOKEN?.trim() || "";
    const response = await fetch(`${controlBaseUrl()}/capacity`, {
      cache: "no-store",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json().catch(() => ({ error: "Control service returned an invalid response" }));
    return NextResponse.json(payload, { status: response.status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Control service is unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
