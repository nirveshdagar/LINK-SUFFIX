import { NextResponse, type NextRequest } from "next/server";
import { hasValidApiAuth } from "@/lib/api-auth-core";

const ROUTE_SCOPED_PREFIXES = [
  "/api/ads",
  "/api/campaign-ads",
  "/api/script-bridge/jobs",
  "/api/auth/session",
];

function isRouteScoped(pathname: string) {
  return ROUTE_SCOPED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (!pathname.startsWith("/api/") || isRouteScoped(pathname)) return NextResponse.next();

  if (hasValidApiAuth(request, { envVarName: "TAH_API_BEARER_TOKEN", scope: "control" })) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { error: "Authentication required" },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'Bearer realm="traffic-armour"',
      },
    },
  );
}

export default proxy;

export const config = { matcher: ["/api/:path*"] };
