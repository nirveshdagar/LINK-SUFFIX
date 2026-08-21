// Proxies Fastify /summary and reshapes to v0 dashboard's expected shape.
// v0 expects tiers: {name: {pass, warn, block}} (percents) and regions: [{name, requests, pass, warn, block}].
import { NextResponse } from "next/server";

const UPSTREAM = process.env.TAH_BACKEND_URL ?? "http://127.0.0.1:7474";

function toPct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 100);
}

export async function GET() {
  let raw: any;
  try {
    const res = await fetch(`${UPSTREAM}/summary`, { cache: "no-store" });
    raw = await res.json();
  } catch (e) {
    return NextResponse.json(
      {
        tiers: { trivial_http: { pass: 0, warn: 0, block: 0 }, headless: { pass: 0, warn: 0, block: 0 }, stealth: { pass: 0, warn: 0, block: 0 }, human: { pass: 0, warn: 0, block: 0 } },
        regions: [],
        scenarios: [],
        connected: false,
      },
      { status: 200 },
    );
  }

  const tierMap = (raw.byTierVerdict ?? {}) as Record<string, Record<string, number>>;
  const tiers: Record<string, { pass: number; warn: number; block: number }> = {};
  for (const [tier, c] of Object.entries(tierMap)) {
    const allow = c.allow ?? 0;
    const block = c.block ?? 0;
    const other = (c.challenge ?? 0) + (c.unsure ?? 0) + (c.error ?? 0);
    const total = allow + block + other || 1;
    tiers[tier.replace("-", "_")] = {
      pass: toPct(allow, total),
      warn: toPct(other, total),
      block: toPct(block, total),
    };
  }
  for (const t of ["trivial_http", "headless", "stealth", "human"]) {
    if (!tiers[t]) tiers[t] = { pass: 0, warn: 0, block: 0 };
  }

  const regions = Object.entries((raw.byCity ?? {}) as Record<string, any>).map(([k, c]) => {
    const allow = c.allow ?? 0;
    const block = c.block ?? 0;
    const other = (c.challenge ?? 0) + (c.unsure ?? 0);
    const total = allow + block + other || 1;
    return {
      name: k,
      requests: total,
      pass: toPct(allow, total),
      warn: toPct(other, total),
      block: toPct(block, total),
    };
  });

  const scenarios = Object.entries((raw.scenarios ?? {}) as Record<string, any>).map(([id, s]) => ({
    id,
    name: id,
    status: s.status === "done" ? ("active" as const) : ("paused" as const),
    events: 0,
    rate: "—",
  }));

  return NextResponse.json({ tiers, regions, scenarios, connected: true, totalRequests: raw.totalRequests ?? 0 });
}