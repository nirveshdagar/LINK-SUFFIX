#!/usr/bin/env node
"use strict";

const net = require("node:net");

const MAX_HEADER_BYTES = 64 * 1024;
const SOCKET_TIMEOUT_MS = Number(process.env.TAH_PROXY_SOCKET_TIMEOUT_MS || 45_000);
const LOCAL_PORT = Number.parseInt(process.argv[2], 10);

function rejectControlCharacters(value, label) {
  const text = String(value ?? "");
  if (/[\0\r\n]/.test(text)) throw new Error(`${label} contains forbidden control characters`);
  return text;
}

function sanitizeHost(value) {
  const host = rejectControlCharacters(value, "Proxy host").trim();
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])$/i.test(host)) {
    throw new Error("Invalid proxy host");
  }
  return host;
}

function sanitizeGeo(value) {
  return rejectControlCharacters(value, "Geo value")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

if (!Number.isInteger(LOCAL_PORT) || LOCAL_PORT < 1024 || LOCAL_PORT > 65_535) {
  throw new Error("A valid unprivileged local proxy port is required");
}

const ROYAL_HOST = sanitizeHost(process.argv[3] || "geo.iproyal.com");
const ROYAL_PORT = Number.parseInt(process.argv[4], 10) || 12321;
const COUNTRY = sanitizeGeo(process.argv[5] || "US");
const STATE = sanitizeGeo(process.argv[6] || "");
const CITY = sanitizeGeo(process.argv[7] || "");
const ROYAL_USER = rejectControlCharacters(
  process.env.IPROYAL_USERNAME || process.env.IPROYAL_USER || "royal",
  "Proxy username",
);
const ROYAL_PASS = rejectControlCharacters(
  process.env.IPROYAL_PASSWORD || process.env.IPROYAL_PASS || "",
  "Proxy password",
);

if (!Number.isInteger(ROYAL_PORT) || ROYAL_PORT < 1 || ROYAL_PORT > 65_535) {
  throw new Error("Invalid upstream proxy port");
}
if (!ROYAL_PASS) throw new Error("IPRoyal proxy password is required");

function buildProxyAuth(username, password) {
  const basePass = password.match(/^(.+?)(?:_country-|$)/)?.[1] || password;
  const geo = `country-${COUNTRY}${STATE ? `-state-${STATE}` : ""}${CITY ? `-city-${CITY}` : ""}`;
  return `${geo}-${username}:${basePass}_${geo}`;
}

const AUTHORIZATION = `Basic ${Buffer.from(buildProxyAuth(ROYAL_USER, ROYAL_PASS), "utf8").toString("base64")}`;

function readHeader(socket, onHeader) {
  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_HEADER_BYTES) {
      cleanup();
      socket.destroy(new Error("Proxy header exceeded the configured limit"));
      return;
    }
    const boundary = buffered.indexOf("\r\n\r\n");
    if (boundary === -1) return;
    cleanup();
    onHeader(buffered.subarray(0, boundary + 4), buffered.subarray(boundary + 4));
  };
  const onEnd = () => cleanup();
  const onError = () => cleanup();
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("error", onError);
  };
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("error", onError);
}

function parseRequestHeader(header) {
  const text = header.toString("latin1");
  const lines = text.slice(0, -4).split("\r\n");
  const requestLine = lines.shift() || "";
  const match = requestLine.match(/^([A-Z]+)\s+(\S+)\s+(HTTP\/\d\.\d)$/);
  if (!match) throw new Error("Malformed proxy request line");
  return { method: match[1], target: match[2], version: match[3], lines };
}

function withProxyAuthorization(request) {
  const filtered = request.lines.filter((line) => !/^proxy-authorization\s*:/i.test(line));
  return Buffer.from(
    [`${request.method} ${request.target} ${request.version}`, ...filtered, `Proxy-Authorization: ${AUTHORIZATION}`, "", ""].join("\r\n"),
    "latin1",
  );
}

function connectUpstream(client, onConnected) {
  const upstream = net.createConnection({ host: ROYAL_HOST, port: ROYAL_PORT });
  upstream.setTimeout(SOCKET_TIMEOUT_MS, () => upstream.destroy(new Error("Upstream proxy timed out")));
  upstream.setNoDelay(true);
  upstream.once("connect", () => onConnected(upstream));
  upstream.once("error", (error) => {
    if (!client.destroyed) {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    console.error(JSON.stringify({ type: "tunnel-upstream-error", message: error.message }));
  });
  const closePeer = () => {
    if (!upstream.destroyed) upstream.destroy();
  };
  client.once("close", closePeer);
  upstream.once("close", () => {
    client.off("close", closePeer);
    if (!client.destroyed) client.destroy();
  });
  return upstream;
}

function handleConnect(client, request, remainder) {
  connectUpstream(client, (upstream) => {
    upstream.write(withProxyAuthorization(request));
    readHeader(upstream, (responseHeader, upstreamRemainder) => {
      const statusLine = responseHeader.toString("latin1", 0, responseHeader.indexOf("\r\n"));
      if (!/^HTTP\/\d\.\d 2\d\d(?:\s|$)/.test(statusLine)) {
        client.end(responseHeader);
        upstream.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: traffic-armour\r\n\r\n");
      if (upstreamRemainder.length) client.write(upstreamRemainder);
      if (remainder.length) upstream.write(remainder);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
}

function handleHttp(client, request, remainder) {
  connectUpstream(client, (upstream) => {
    upstream.write(withProxyAuthorization(request));
    if (remainder.length) upstream.write(remainder);
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

const clients = new Set();
const server = net.createServer((client) => {
  clients.add(client);
  client.setTimeout(SOCKET_TIMEOUT_MS, () => client.destroy(new Error("Local proxy client timed out")));
  client.setNoDelay(true);
  client.once("close", () => clients.delete(client));
  client.once("error", (error) => {
    console.error(JSON.stringify({ type: "tunnel-client-error", message: error.message }));
  });
  readHeader(client, (header, remainder) => {
    try {
      const request = parseRequestHeader(header);
      if (request.method === "CONNECT") handleConnect(client, request, remainder);
      else handleHttp(client, request, remainder);
    } catch (error) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      console.error(JSON.stringify({ type: "tunnel-request-error", message: error.message }));
    }
  });
});

server.on("error", (error) => {
  console.error(JSON.stringify({ type: "tunnel-server-error", message: error.message }));
  process.exitCode = 1;
});

server.listen(LOCAL_PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({
    type: "tunnel-ready",
    port: LOCAL_PORT,
    country: COUNTRY,
    state: STATE,
    city: CITY,
    royalHost: ROYAL_HOST,
    royalPort: ROYAL_PORT,
  }));
});

function shutdown() {
  server.close(() => process.exit(0));
  for (const client of clients) client.destroy();
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
