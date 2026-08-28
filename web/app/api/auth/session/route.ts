import { NextResponse } from "next/server";
import { apiSessionCookie, clearApiSessionCookie, createApiSession, isValidTokenForEnv } from "@/lib/api-auth-core";
import { checkRateLimit, withRateLimitHeaders } from "@/lib/rate-limit";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  try {
    const publicBaseUrl = process.env.TAH_PUBLIC_BASE_URL?.trim();
    return new URL(origin).origin === new URL(publicBaseUrl || request.url).origin;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const limit = await checkRateLimit(request, { namespace: "auth-session", limit: 5, windowMs: 60_000 });
  if (!limit.ok) return withRateLimitHeaders(NextResponse.json({ error: "Too many authentication attempts" }, { status: 429 }), limit);
  if (!sameOrigin(request)) return withRateLimitHeaders(NextResponse.json({ error: "Cross-origin authentication is not allowed" }, { status: 403 }), limit);

  let token = "";
  try {
    const body = await request.json() as { token?: unknown };
    token = typeof body.token === "string" ? body.token.trim() : "";
  } catch {
    return withRateLimitHeaders(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }), limit);
  }

  if (!isValidTokenForEnv(token, "TAH_API_BEARER_TOKEN", "CONTROL_TOKEN")) {
    return withRateLimitHeaders(NextResponse.json({ error: "Invalid control token" }, { status: 401 }), limit);
  }

  const response = NextResponse.json({ ok: true });
  response.headers.set("set-cookie", apiSessionCookie(createApiSession(), process.env.TAH_PUBLIC_BASE_URL?.trim() || request.url));
  response.headers.set("cache-control", "no-store");
  return withRateLimitHeaders(response, limit);
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  response.headers.set("set-cookie", clearApiSessionCookie(process.env.TAH_PUBLIC_BASE_URL?.trim() || request.url));
  response.headers.set("cache-control", "no-store");
  return response;
}
