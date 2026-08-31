import { NextResponse } from "next/server";
import { hasValidApiAuth } from "@/lib/api-auth-core";
import {
  bridgeDatabaseConfigured,
  bridgeShardStatus,
  bridgeStoreSummary,
  bridgeTargetReadiness,
  createBridgeShard,
  deleteBridgeTarget,
  enqueueBridgeCapture,
  listBridgeTargets,
  queueLatestBridgeCapture,
  setBridgeTargetEnabled,
  upsertBridgeTarget,
} from "@/lib/script-bridge-store";
import { buildRelationalFleetV11Worker } from "@/lib/relational-fleet-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizePublicBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("A public HTTPS base URL is required for Google Ads Scripts");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function workerScript(baseUrl: string, shardId: string, token: string) {
  return buildRelationalFleetV11Worker(
    `${baseUrl}/api/script-bridge/jobs`,
    token,
    shardId,
  );
}

async function parseBody(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 512_000) throw new Error("Request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text) > 512_000) throw new Error("Request body is too large");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

export async function GET(request: Request) {
  if (!bridgeDatabaseConfigured()) return NextResponse.json({ configured: false, error: "DATABASE_URL is required" }, { status: 503 });
  try {
    const url = new URL(request.url);
    const [summary, campaigns, shards] = await Promise.all([
      bridgeStoreSummary(),
      listBridgeTargets({ query: url.searchParams.get("q") || "", page: Number(url.searchParams.get("page") || 1), pageSize: Number(url.searchParams.get("pageSize") || 25) }),
      bridgeShardStatus(),
    ]);
    return NextResponse.json({ configured: true, summary, campaigns, shards }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ configured: false, error: error instanceof Error ? error.message : "Bridge status failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!bridgeDatabaseConfigured()) return NextResponse.json({ error: "DATABASE_URL is required" }, { status: 503 });
  try {
    const body = await parseBody(request);
    const action = String(body.action || "");
    if (["enqueue", "capture", "queue", "publish", "enqueue-suffix", "fleet-enqueue"].includes(action)) {
      const campaign = body.campaign && typeof body.campaign === "object" ? body.campaign as Record<string, unknown> : {};
      const capture = body.capture && typeof body.capture === "object" ? body.capture as Record<string, unknown> : {};
      const result = await enqueueBridgeCapture({
        campaignRecordId: String(body.campaignRecordId || campaign.id || campaign.campaignRecordId || ""),
        campaignName: String(body.campaignName || campaign.name || body.campaignRecordId || campaign.id || "Campaign"),
        managerCustomerId: String(body.managerCustomerId || body.loginCustomerId || campaign.managerCustomerId || campaign.loginCustomerId || ""),
        customerId: String(body.customerId || campaign.customerId || ""),
        googleCampaignId: String(body.googleCampaignId || body.campaignId || campaign.googleCampaignId || campaign.campaignId || ""),
        shardId: String(body.shardId || campaign.shardId || "default"),
        exactSuffix: String(body.exactSuffix ?? body.suffix ?? capture.exactSuffix ?? capture.suffix ?? ""),
        version: Number(body.version || capture.version || Date.now()),
        sourceRunId: String(body.sourceRunId || body.runId || capture.runId || "") || undefined,
      });
      return NextResponse.json({ ok: true, ...result }, { status: 202 });
    }
    if (action === "register-target") {
      if (!hasValidApiAuth(request, { envVarName: "TAH_API_BEARER_TOKEN", scope: "control" })) {
        return NextResponse.json({ error: "Control authentication required" }, { status: 401 });
      }
      const assignment = await upsertBridgeTarget({
        campaignRecordId: String(body.campaignRecordId || ""),
        campaignName: String(body.campaignName || body.campaignRecordId || "Campaign"),
        managerCustomerId: String(body.managerCustomerId || body.loginCustomerId || ""),
        customerId: String(body.customerId || ""),
        googleCampaignId: String(body.googleCampaignId || body.campaignId || ""),
        shardId: String(body.shardId || "default"),
      });
      const delivery = await queueLatestBridgeCapture(String(body.campaignRecordId || ""));
      const readiness = await bridgeTargetReadiness(String(body.campaignRecordId || ""));
      return NextResponse.json({ ok: true, ...assignment, state: "enrolled", delivery, readiness }, { status: 201 });
    }
    if (action === "target-readiness") {
      if (!hasValidApiAuth(request, { envVarName: "TAH_API_BEARER_TOKEN", scope: "control" })) {
        return NextResponse.json({ error: "Control authentication required" }, { status: 401 });
      }
      const readiness = await bridgeTargetReadiness(String(body.campaignRecordId || ""));
      return NextResponse.json({ ok: true, ...readiness }, { headers: { "cache-control": "no-store" } });
    }
    if (action === "set-enabled") {
      if (!hasValidApiAuth(request, { envVarName: "TAH_API_BEARER_TOKEN", scope: "control" })) {
        return NextResponse.json({ error: "Control authentication required" }, { status: 401 });
      }
      const campaignRecordId = String(body.campaignRecordId || "");
      const enabled = body.enabled === true;
      await setBridgeTargetEnabled(campaignRecordId, enabled);
      const delivery = enabled ? await queueLatestBridgeCapture(campaignRecordId) : undefined;
      return NextResponse.json({ ok: true, delivery });
    }
    if (action === "delete-target") {
      if (!hasValidApiAuth(request, { envVarName: "TAH_API_BEARER_TOKEN", scope: "control" })) {
        return NextResponse.json({ error: "Control authentication required" }, { status: 401 });
      }
      const result = await deleteBridgeTarget({
        targetId: String(body.targetId || ""),
        campaignRecordId: String(body.campaignRecordId || ""),
      });
      return NextResponse.json({ ok: true, ...result, state: result.deleted ? "deleted" : "not_found" });
    }
    if (action === "generate-worker") {
      if (!hasValidApiAuth(request, { envVarName: "TAH_API_BEARER_TOKEN", scope: "control" })) return NextResponse.json({ error: "Control authentication required" }, { status: 401 });
      const shardId = String(body.shardId || "default").trim();
      const baseUrl = normalizePublicBaseUrl(String(body.publicBaseUrl || process.env.TAH_PUBLIC_BASE_URL || ""));
      const shard = await createBridgeShard(shardId);
      return NextResponse.json({ ok: true, shardId, token: shard.token, script: workerScript(baseUrl, shardId, shard.token) }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bridge operation failed";
    return NextResponse.json({ error: message }, { status: /required|invalid|already owns|not found|too large|full|at most 40|MCC|belongs/i.test(message) ? 400 : 500 });
  }
}
