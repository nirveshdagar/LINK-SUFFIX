// Proxies Fastify /events SSE and reshapes each event into v0 dashboard's
// event shape: { id, time, verdict, tier, scenario, region, latency, flags }.
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const VERDICT_MAP: Record<string, "PASS" | "WARN" | "BLOCK"> = {
  allow: "PASS",
  challenge: "WARN",
  block: "BLOCK",
  unsure: "WARN",
  error: "BLOCK",
};

export async function GET(req: NextRequest) {
  const upstream = process.env.TAH_BACKEND_URL ?? "http://127.0.0.1:7474";
  const upstreamRes = await fetch(`${upstream}/events`, {
    headers: { Accept: "text/event-stream" },
  }).catch((e) => new Response(`upstream error: ${(e as Error).message}`, { status: 502 }));

  if (!(upstreamRes instanceof Response) || !upstreamRes.ok || !upstreamRes.body) {
    return new Response("upstream unavailable", { status: 502 });
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";
  let evCount = 0;

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (!frame.startsWith("data:")) continue;
        const payload = frame.slice(5).trim();
        try {
          const msg = JSON.parse(payload);
          if (msg.type !== "request") continue;
          const r = msg.payload;
          if (!r?.events?.length) continue;
          const last = r.events[r.events.length - 1];
          const v = r.final_verdict as string;
          const item = {
            id: `evt_${evCount++}`,
            time: new Date(r.started_at ?? Date.now()).toISOString().slice(11, 23),
            verdict: VERDICT_MAP[v] ?? "WARN",
            tier: r.tier,
            scenario: r.scenario_id,
            region: [r.geo_requested?.country, r.geo_requested?.state, r.geo_requested?.city].filter(Boolean).join("-") || "—",
            latency: last?.time_ms ?? 0,
            flags: Object.keys(last?.ta_signal ?? {}).slice(0, 4),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
        } catch {
          /* ignore non-JSON frames */
        }
      }
    },
    cancel() {
      try { reader.cancel(); } catch { /* ignore */ }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}