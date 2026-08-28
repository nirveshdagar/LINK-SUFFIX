// Proxies Fastify /events SSE and reshapes each frame into a compact dashboard event stream:
// { kind: "request", event: {...} } or { kind: "state", state: {...} }.
import { NextRequest } from "next/server";
import { resolveRunBackend } from '@/lib/run-registry';

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const upstream = resolveRunBackend(req.nextUrl.searchParams.get('run'));
  if (!upstream) return new Response('no active run', { status: 503 });
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
  let seq = 0;

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLine = frame
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (dataLine) {
          const payload = dataLine.slice(5).trim();
          try {
            const msg = JSON.parse(payload);
            if (msg.kind === "request" && msg.event) {
              const item = { kind: "request", event: msg.event, sequence: seq++ };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
            } else if (msg.kind === "state" && msg.state) {
              const state = msg.state;
              const passthrough = {
                kind: "state",
                state: {
                  connected: true,
                  runId: state.runId ?? null,
                  elapsed_ms: state.elapsed_ms ?? 0,
                  totalRequests: state.totalRequests ?? 0,
                  byTierVerdict: state.byTierVerdict ?? {},
                  byCity: state.byCity ?? {},
                  scenarios: state.scenarios ?? {},
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(passthrough)}\n\n`));
            }
          } catch {
            /* ignore non-JSON frames */
          }
        }
        boundary = buffer.indexOf("\n\n");
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
