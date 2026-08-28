import http from "node:http";

const port = Math.max(1, Number(process.env.TAH_ALERT_DISPATCHER_PORT) || 3199);
const destination = process.env.TAH_ALERT_WEBHOOK_URL || "";
const secret = process.env.TAH_ALERT_WEBHOOK_SECRET || "";

const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/alerts") {
    response.writeHead(404).end();
    return;
  }
  let size = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 512_000) request.destroy(new Error("Alert payload too large"));
    else chunks.push(chunk);
  });
  request.on("error", () => { if (!response.headersSent) response.writeHead(413).end(); });
  request.on("end", async () => {
    if (!destination) {
      process.stderr.write("TAH_ALERT_WEBHOOK_URL is not configured\n");
      response.writeHead(503).end();
      return;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const upstream = await fetch(destination, {
        method: "POST",
        headers: { "content-type": request.headers["content-type"] || "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
        body: Buffer.concat(chunks),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      response.writeHead(upstream.ok ? 204 : 502).end();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      response.writeHead(502).end();
    }
  });
});

server.headersTimeout = 15_000;
server.requestTimeout = 20_000;
server.listen(port, "0.0.0.0", () => process.stdout.write(`Alert dispatcher listening on ${port}\n`));
