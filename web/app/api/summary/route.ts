import { NextRequest, NextResponse } from "next/server";
import { resolveRunBackend } from '@/lib/run-registry';

export async function GET(request: NextRequest) {
  let raw: any;
  try {
    const upstream = resolveRunBackend(request.nextUrl.searchParams.get("run"));
    if (!upstream) throw new Error('no active run');
    const res = await fetch(`${upstream}/summary`, { cache: "no-store" });
    raw = await res.json();
  } catch (e) {
    return NextResponse.json(
      {
        connected: false,
        runId: null,
        elapsed_ms: 0,
        totalRequests: 0,
        byTierVerdict: {
          "trivial-http": { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 },
          headless: { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 },
          stealth: { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 },
          human: { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 },
        },
        byCity: {},
        scenarios: {},
      },
      { status: 200 },
    );
  }

  const byTierVerdict = (raw.byTierVerdict ?? {}) as Record<string, Record<string, number>>;
  const merged = {
    connected: true,
    runId: raw.runId ?? null,
    elapsed_ms: raw.elapsed_ms ?? 0,
    totalRequests: raw.totalRequests ?? 0,
    byTierVerdict: {
      "trivial-http": {
        allow: byTierVerdict["trivial-http"]?.allow ?? 0,
        challenge: byTierVerdict["trivial-http"]?.challenge ?? 0,
        block: byTierVerdict["trivial-http"]?.block ?? 0,
        unsure: byTierVerdict["trivial-http"]?.unsure ?? 0,
        error: byTierVerdict["trivial-http"]?.error ?? 0,
      },
      headless: {
        allow: byTierVerdict.headless?.allow ?? 0,
        challenge: byTierVerdict.headless?.challenge ?? 0,
        block: byTierVerdict.headless?.block ?? 0,
        unsure: byTierVerdict.headless?.unsure ?? 0,
        error: byTierVerdict.headless?.error ?? 0,
      },
      stealth: {
        allow: byTierVerdict.stealth?.allow ?? 0,
        challenge: byTierVerdict.stealth?.challenge ?? 0,
        block: byTierVerdict.stealth?.block ?? 0,
        unsure: byTierVerdict.stealth?.unsure ?? 0,
        error: byTierVerdict.stealth?.error ?? 0,
      },
      human: {
        allow: byTierVerdict.human?.allow ?? 0,
        challenge: byTierVerdict.human?.challenge ?? 0,
        block: byTierVerdict.human?.block ?? 0,
        unsure: byTierVerdict.human?.unsure ?? 0,
        error: byTierVerdict.human?.error ?? 0,
      },
    },
    byCity: raw.byCity ?? {},
    scenarios: raw.scenarios ?? {},
  };
  return NextResponse.json(merged);
}
