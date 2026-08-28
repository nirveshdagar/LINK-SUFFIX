import { NextResponse } from "next/server";

import {
  capacityInputFromEnvironment,
  planCapacity,
  type CapacityInputs,
} from "../../../lib/capacity-planner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function queryNumber(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be numeric`);
  return value;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const queryOverrides: Partial<CapacityInputs> = {};
    const mappings: Array<[keyof CapacityInputs, string]> = [
      ["campaigns", "campaigns"],
      ["activeCampaignLimit", "activeLimit"],
      ["browserWorkers", "browserWorkers"],
      ["dedicatedGatewayPorts", "gatewayPorts"],
      ["configuredShardCount", "shards"],
      ["fleetActiveSecondsPerHour", "fleetActiveSeconds"],
      ["averagePageMegabytes", "averagePageMb"],
      ["availableMemoryMb", "availableMemoryMb"],
      ["availableNetworkMbps", "availableNetworkMbps"],
      ["measuredDatabaseWritesPerSecond", "databaseWritesPerSecond"],
      ["soakTestHours", "soakHours"],
    ];

    for (const [key, queryName] of mappings) {
      const value = queryNumber(url, queryName);
      if (value !== undefined) {
        (queryOverrides as Record<string, number>)[key] = value;
      }
    }

    const plan = planCapacity(capacityInputFromEnvironment(process.env, queryOverrides));
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), plan },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid capacity request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
