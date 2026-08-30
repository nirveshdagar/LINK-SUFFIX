import { NextResponse } from "next/server";
import { hasValidApiAuth } from "@/lib/api-auth-core";
import {
  acknowledgeHealthAlert,
  evaluateHealthAlerts,
  listHealthAlerts,
  resolveHealthAlert,
} from "@/lib/health-alert-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTH = {
  envVarName: "CONTROL_TOKEN",
  fallbackEnvVarName: "TAH_API_BEARER_TOKEN",
  scope: "read",
};

function unauthorized() {
  return NextResponse.json({ error: "Authentication required" }, { status: 401 });
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Health operation failed";
  return NextResponse.json({ error: message }, { status: 503 });
}

export async function GET(request: Request) {
  if (!hasValidApiAuth(request, AUTH)) return unauthorized();
  const url = new URL(request.url);
  try {
    await evaluateHealthAlerts({ source: "dashboard" });
    const report = await listHealthAlerts({
      summaryOnly: url.searchParams.get("summary") === "1",
      includeResolved: url.searchParams.get("resolved") === "1",
    });
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  if (!hasValidApiAuth(request, AUTH)) return unauthorized();
  try {
    const body = await request.json() as { action?: string; fingerprint?: string };
    if (body.action === "evaluate") {
      const report = await evaluateHealthAlerts({
        force: true,
        source: request.headers.get("x-tah-watchdog") === "1" ? "watchdog" : "manual",
      });
      return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
    }
    if (!body.fingerprint?.trim()) return NextResponse.json({ error: "fingerprint is required" }, { status: 400 });
    if (body.action === "acknowledge") {
      const alert = await acknowledgeHealthAlert(body.fingerprint.trim());
      return alert ? NextResponse.json({ alert }) : NextResponse.json({ error: "Active alert not found" }, { status: 404 });
    }
    if (body.action === "resolve") {
      const alert = await resolveHealthAlert(body.fingerprint.trim());
      return alert ? NextResponse.json({ alert }) : NextResponse.json({ error: "Open alert not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}
