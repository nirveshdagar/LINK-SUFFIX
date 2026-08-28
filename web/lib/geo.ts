import { createHash } from "node:crypto";
import { isIP } from "node:net";

export interface GeoInfo {
  country?: string;
  state?: string;
  city?: string;
}

type CacheEntry = { expiresAt: number; value: GeoInfo };

const CACHE_TTL_MS = 30 * 60_000;
const EMPTY_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = Math.max(32, Number(process.env.TAH_GEO_CACHE_MAX_ENTRIES || 1_000));
const MAX_RESPONSE_BYTES = 64 * 1024;
const cache = new Map<string, CacheEntry>();

function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (!version) return false;
  if (version === 6) {
    const lower = ip.toLowerCase();
    return !(
      lower === "::1"
      || lower === "::"
      || lower.startsWith("fc")
      || lower.startsWith("fd")
      || /^fe[89ab]/.test(lower)
      || lower.startsWith("ff")
      || lower.startsWith("2001:db8:")
    );
  }
  const octets = ip.split(".").map(Number);
  const [a, b] = octets;
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
  );
}

function putCache(key: string, value: GeoInfo): void {
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, {
    expiresAt: Date.now() + (Object.keys(value).length ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS),
    value,
  });
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

async function fetchJson(url: string, timeoutMs = 7_000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "traffic-armour-geo/1.0",
      },
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new Error(`Geo provider returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Geo provider response exceeded the configured limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveGeo(ip: string): Promise<GeoInfo> {
  if (process.env.TAH_GEO_LOOKUP_ENABLED === "false" || !isPublicIp(ip)) return {};
  const key = createHash("sha256").update(ip).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return { ...hit.value };

  const providers = [
    async () => {
      const data = await fetchJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
      return {
        country: text(data.country_code, 2)?.toUpperCase(),
        state: text(data.region_code, 120) ?? text(data.region, 120),
        city: text(data.city, 160),
      };
    },
    async () => {
      const data = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
      if (data.success === false) throw new Error("Geo provider rejected the IP");
      return {
        country: text(data.country_code, 2)?.toUpperCase(),
        state: text(data.region_code, 120) ?? text(data.region, 120),
        city: text(data.city, 160),
      };
    },
  ];

  for (const provider of providers) {
    try {
      const value = await provider();
      if (value.country || value.state || value.city) {
        putCache(key, value);
        return { ...value };
      }
    } catch {
      // Try the next independent HTTPS provider.
    }
  }
  putCache(key, {});
  return {};
}
