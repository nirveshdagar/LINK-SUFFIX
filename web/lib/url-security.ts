import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const DNS_TIMEOUT_MS = Math.max(500, Number(process.env.TAH_DNS_TIMEOUT_MS) || 5_000);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata.google", "instance-data", "kubernetes.default"]);

function ipv4Bytes(address: string) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map(Number);
  return bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? bytes : null;
}

function blockedIpv4(address: string) {
  const bytes = ipv4Bytes(address);
  if (!bytes) return true;
  const [a, b, c] = bytes;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function normalizedIpv6(address: string) {
  return address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
}

export function isBlockedAddress(address: string) {
  const version = isIP(address.replace(/^\[|\]$/g, "").split("%")[0]);
  if (version === 4) return blockedIpv4(address);
  if (version !== 6) return true;
  const normalized = normalizedIpv6(address);
  if (normalized === "::" || normalized === "::1") return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blockedIpv4(mapped[1]);
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || normalized.startsWith("2001:db8:");
}

function allowedHostname(hostname: string) {
  const allowlist = (process.env.TAH_TRAFFIC_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/^\*\./, "."))
    .filter(Boolean);
  if (!allowlist.length) {
    return process.env.NODE_ENV !== "production" && process.env.TAH_ALLOW_UNLISTED_LOCAL_TARGETS === "1";
  }
  return allowlist.some((entry) => entry.startsWith(".") ? hostname.endsWith(entry) && hostname.length > entry.length : hostname === entry);
}

async function resolveAll(hostname: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("DNS resolution timed out")), { once: true })),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function assertSafeOutboundUrl(input: string | URL) {
  let url: URL;
  try { url = input instanceof URL ? new URL(input.toString()) : new URL(input); }
  catch { throw new Error("Target must be a valid absolute URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS targets are allowed");
  if (url.username || url.password) throw new Error("Target URLs cannot contain embedded credentials");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || BLOCKED_HOSTS.has(hostname) || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) throw new Error("Local and internal target hosts are blocked");
  if (!allowedHostname(hostname)) throw new Error("Target hostname is not present in TAH_TRAFFIC_ALLOWED_HOSTS");

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error("Private, reserved, and non-routable targets are blocked");
  } else {
    const records = await resolveAll(hostname);
    if (!records.length) throw new Error("Target hostname did not resolve");
    if (records.some((record) => isBlockedAddress(record.address))) throw new Error("Target hostname resolves to a private, reserved, or non-routable address");
  }
  return url;
}

export function extractExactQuerySuffix(input: string) {
  const question = input.indexOf("?");
  if (question < 0) return "";
  const hash = input.indexOf("#", question + 1);
  return input.slice(question + 1, hash < 0 ? undefined : hash);
}
