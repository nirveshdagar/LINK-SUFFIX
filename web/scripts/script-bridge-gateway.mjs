import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Math.max(1024, Math.min(65_535, Number(process.env.TAH_SCRIPT_BRIDGE_GATEWAY_PORT ?? 3199) || 3199));
const upstreamUrl = process.env.TAH_SCRIPT_BRIDGE_UPSTREAM ?? "http://127.0.0.1:3100/api/script-bridge/jobs";
const maximumRequestBytes = Math.max(1024, Math.min(1_048_576, Number(process.env.TAH_SCRIPT_BRIDGE_GATEWAY_MAX_REQUEST_BYTES ?? 524_288) || 524_288));
const maximumResponseBytes = Math.max(1024, Math.min(10_485_760, Number(process.env.TAH_SCRIPT_BRIDGE_GATEWAY_MAX_RESPONSE_BYTES ?? 5_242_880) || 5_242_880));

function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

async function readBoundedBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumRequestBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://script-bridge.local");
  if (request.method === "GET" && requestUrl.pathname === "/healthz") {
    writeJson(response, 200, { ok: true, service: "script-bridge-gateway" });
    return;
  }
  if (requestUrl.pathname !== "/api/script-bridge/jobs") {
    writeJson(response, 404, { error: "Not found" });
    return;
  }
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("allow", "GET, POST");
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = request.method === "POST" ? await readBoundedBody(request) : undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const upstreamTarget = new URL(upstreamUrl);
    upstreamTarget.search = requestUrl.search;
    const upstream = await fetch(upstreamTarget, {
      method: request.method,
      headers: {
        accept: "application/json",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.headers["x-script-bridge-token"] ? { "x-script-bridge-token": String(request.headers["x-script-bridge-token"]) } : {}),
        ...(request.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    const declaredLength = Number(upstream.headers.get("content-length") ?? 0);
    if (declaredLength > maximumResponseBytes) throw new Error("RESPONSE_TOO_LARGE");
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (payload.length > maximumResponseBytes) throw new Error("RESPONSE_TOO_LARGE");
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "content-length": String(payload.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(payload);
  } catch (error) {
    if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
      writeJson(response, 413, { error: "Request body is too large" });
      return;
    }
    if (error instanceof Error && error.message === "RESPONSE_TOO_LARGE") {
      writeJson(response, 502, { error: "Upstream response is too large" });
      return;
    }
    writeJson(response, 502, { error: "Script Bridge upstream is unavailable" });
  }
});

server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
server.listen(port, host, () => {
  console.log(`restricted Script Bridge gateway listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
