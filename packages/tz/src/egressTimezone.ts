import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ProxyAgent, request } from "undici";

export type ProxyEgressFailureCode = "proxy_auth_failed" | "proxy_connect_failed" | "proxy_timeout" | "ip_lookup_failed" | "timezone_lookup_failed";
export type ProxyProbeAttempt = { provider: string; stage: "egress" | "timezone"; ok: boolean; statusCode?: number; error?: string };
export type ProxyEgressIdentity = {
  ip: string | null; timezone: string | null; country?: string; state?: string; city?: string;
  asn?: number; organization?: string; isp?: string;
  verified: boolean; provider?: string; attempts: ProxyProbeAttempt[];
};

export class ProxyEgressResolutionError extends Error {
  constructor(readonly code: ProxyEgressFailureCode, message: string, readonly attempts: ProxyProbeAttempt[], readonly ip: string | null = null) {
    super(message);
    this.name = "ProxyEgressResolutionError";
  }
}

type CacheEntry = { expiresAt: number; promise: Promise<ProxyEgressIdentity> };
type TimezoneCacheEntry = { expiresAt: number; promise: Promise<string | null> };
const cache = new Map<string, CacheEntry>();
const timezoneCache = new Map<string, TimezoneCacheEntry>();
const TIMEOUT = 7_000;
const MAX_PROVIDER_BODY_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = Math.max(32, Number(process.env.TAH_GEO_CACHE_MAX_ENTRIES || 1_000));

function putBounded<K, V>(target: Map<K, V>, key: K, value: V): void {
  if (!target.has(key) && target.size >= MAX_CACHE_ENTRIES) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest !== undefined) target.delete(oldest);
  }
  target.set(key, value);
}

function validTimezone(timezone: string | null): string | null {
  if (!timezone || timezone.length > 80) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return null;
  }
}

function normalizeParsed(parsed: Parsed): Parsed {
  return {
    ...parsed,
    ip: parsed.ip && isIP(parsed.ip) ? parsed.ip : null,
    timezone: validTimezone(parsed.timezone),
    country: parsed.country?.slice(0, 2).toUpperCase(),
    state: parsed.state?.slice(0, 120),
    city: parsed.city?.slice(0, 160),
    asn: Number.isSafeInteger(parsed.asn) && Number(parsed.asn) > 0 && Number(parsed.asn) <= 4_294_967_295
      ? Number(parsed.asn)
      : undefined,
    organization: parsed.organization?.slice(0, 240),
    isp: parsed.isp?.slice(0, 240),
  };
}
const cleanError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/https?:\/\/[^\s@]+@/gi, "http://***:***@").slice(0, 240);
const statusOf = (error: unknown) => typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode: unknown }).statusCode) : undefined;
const value = (input: unknown) => typeof input === "string" && input.trim() ? input.trim() : undefined;
const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const asnValue = (input: unknown): number | undefined => {
  const match = String(input ?? "").trim().match(/^(?:AS)?(\d{1,10})\b/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 4_294_967_295 ? parsed : undefined;
};
const ipInfoNetwork = (input: unknown) => {
  const raw = value(input);
  const match = raw?.match(/^AS(\d{1,10})\s*(.*)$/i);
  return { asn: asnValue(match?.[1]), organization: value(match?.[2]) };
};
const messageFor = (code: ProxyEgressFailureCode) => ({
  proxy_auth_failed: "IPRoyal rejected the proxy credentials or routing parameters (HTTP 407). Check the username, password, country, state, and city.",
  proxy_connect_failed: "The IPRoyal gateway could not be reached. Check the proxy host, port, network, and provider availability.",
  proxy_timeout: "The IPRoyal gateway did not respond before the proxy verification timeout.",
  ip_lookup_failed: "The proxy responded, but no residential exit IP could be verified.",
  timezone_lookup_failed: "The residential exit IP was verified, but its timezone could not be resolved.",
})[code];
const classify = (attempts: ProxyProbeAttempt[]): ProxyEgressFailureCode => {
  const errors = attempts.map((attempt) => attempt.error ?? "").join(" ");
  if (attempts.some((attempt) => attempt.statusCode === 407) || /\b407\b|proxy authentication/i.test(errors)) return "proxy_auth_failed";
  if (/timeout|timed out|abort/i.test(errors)) return "proxy_timeout";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|connect|tunnel|socket/i.test(errors)) return "proxy_connect_failed";
  return "ip_lookup_failed";
};

async function fetchBody(url: string, dispatcher?: ProxyAgent): Promise<{ statusCode: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await request(url, {
      dispatcher, signal: controller.signal, headersTimeout: TIMEOUT, bodyTimeout: TIMEOUT,
      headers: { "user-agent": "brain-proxy-egress-check/1.0", accept: "application/json, text/plain" },
    });
    const body = response.body as unknown as {
      text?: () => Promise<string>;
      json?: () => Promise<unknown>;
      destroy?: (error?: Error) => void;
      [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>;
    };
    let text: string;
    if (typeof body[Symbol.asyncIterator] === "function") {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_PROVIDER_BODY_BYTES) {
          body.destroy?.(new Error("Geo provider response exceeded the configured limit"));
          throw new Error("Geo provider response exceeded the configured limit");
        }
        chunks.push(buffer);
      }
      text = Buffer.concat(chunks, total).toString("utf8");
    } else if (typeof body.text === "function") {
      text = await body.text();
      if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_BODY_BYTES) {
        throw new Error("Geo provider response exceeded the configured limit");
      }
    } else if (typeof body.json === "function") {
      text = JSON.stringify(await body.json());
      if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_BODY_BYTES) {
        throw new Error("Geo provider response exceeded the configured limit");
      }
    } else {
      throw new Error("Geo provider returned an unreadable body");
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(new Error(`HTTP ${response.statusCode}`), { statusCode: response.statusCode });
    return { statusCode: response.statusCode, text };
  } finally { clearTimeout(timer); }
}

type Parsed = Omit<ProxyEgressIdentity, "verified" | "attempts">;
type Provider = { name: string; url: string; parse: (body: Record<string, unknown>) => Parsed };
const parsers = {
  ipapi: (body: Record<string, unknown>): Parsed => ({
    ip: value(body.ip) ?? null,
    timezone: value(body.timezone) ?? null,
    country: value(body.country_code),
    state: value(body.region_code) ?? value(body.region),
    city: value(body.city),
    asn: asnValue(body.asn),
    organization: value(body.org),
    isp: value(body.org),
  }),
  ipwhois: (body: Record<string, unknown>): Parsed => {
    const connection = record(body.connection);
    return {
      ip: value(body.ip) ?? null,
      timezone: body.timezone && typeof body.timezone === "object" ? value((body.timezone as Record<string, unknown>).id) ?? null : value(body.timezone) ?? null,
      country: value(body.country_code),
      state: value(body.region_code) ?? value(body.region),
      city: value(body.city),
      asn: asnValue(connection.asn),
      organization: value(connection.org),
      isp: value(connection.isp),
    };
  },
  ipinfo: (body: Record<string, unknown>): Parsed => {
    const network = ipInfoNetwork(body.org);
    return {
      ip: value(body.ip) ?? null,
      timezone: value(body.timezone) ?? null,
      country: value(body.country),
      state: value(body.region),
      city: value(body.city),
      asn: network.asn,
      organization: network.organization,
      isp: network.organization,
    };
  },
};
const egressProviders: Provider[] = [
  { name: "ipapi", url: "https://ipapi.co/json/", parse: parsers.ipapi },
  { name: "ipwhois", url: "https://ipwho.is/", parse: parsers.ipwhois },
  { name: "ipinfo", url: "https://ipinfo.io/json", parse: parsers.ipinfo },
];
const timezoneProviders = (ip: string): Provider[] => [
  { name: "ipwhois", url: `https://ipwho.is/${encodeURIComponent(ip)}`, parse: parsers.ipwhois },
  { name: "ipapi", url: `https://ipapi.co/${encodeURIComponent(ip)}/json/`, parse: parsers.ipapi },
  { name: "ipinfo", url: `https://ipinfo.io/${encodeURIComponent(ip)}/json`, parse: parsers.ipinfo },
];

async function runProvider(provider: Provider, stage: ProxyProbeAttempt["stage"], attempts: ProxyProbeAttempt[], dispatcher?: ProxyAgent): Promise<Parsed | null> {
  try {
    const response = await fetchBody(provider.url, dispatcher);
    const parsed = normalizeParsed(provider.parse(JSON.parse(response.text) as Record<string, unknown>));
    attempts.push({ provider: provider.name, stage, ok: stage === "egress" ? Boolean(parsed.ip) : Boolean(parsed.timezone), statusCode: response.statusCode });
    return parsed;
  } catch (error) {
    attempts.push({ provider: provider.name, stage, ok: false, statusCode: statusOf(error), error: cleanError(error) });
    return null;
  }
}

export async function timeZoneFromIP(ip: string): Promise<string | null> {
  if (!isIP(ip)) return null;
  const key = createHash("sha256").update(ip).digest("hex");
  const now = Date.now();
  const hit = timezoneCache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;
  const lookup = (async () => {
    const attempts: ProxyProbeAttempt[] = [];
    for (const provider of timezoneProviders(ip)) {
      const result = await runProvider(provider, "timezone", attempts);
      if (result?.timezone) return result.timezone;
    }
    return null;
  })();
  putBounded(timezoneCache, key, { expiresAt: now + 10 * 60_000, promise: lookup });
  void lookup.then((timezone) => {
    if (!timezone && timezoneCache.get(key)?.promise === lookup) {
      putBounded(timezoneCache, key, { expiresAt: Date.now() + 15_000, promise: lookup });
    }
  });
  return lookup;
}

async function fetchProxyEgress(proxyUrl: URL): Promise<ProxyEgressIdentity> {
  const attempts: ProxyProbeAttempt[] = [];
  const dispatcher = new ProxyAgent({ uri: proxyUrl.toString() });
  try {
    let partial: Parsed | null = null;
    for (const provider of egressProviders) {
      partial = await runProvider(provider, "egress", attempts, dispatcher);
      if (partial?.ip) {
        if (partial.timezone && partial.asn && partial.organization) return { ...partial, verified: true, provider: provider.name, attempts };
        break;
      }
      if (classify(attempts) === "proxy_auth_failed") break;
    }
    if (!partial?.ip) {
      try {
        const response = await fetchBody("https://ipv4.icanhazip.com/", dispatcher);
        const ip = response.text.trim();
        attempts.push({ provider: "icanhazip", stage: "egress", ok: Boolean(ip), statusCode: response.statusCode });
        if (ip) partial = { ip, timezone: null };
      } catch (error) {
        attempts.push({ provider: "icanhazip", stage: "egress", ok: false, statusCode: statusOf(error), error: cleanError(error) });
      }
    }
    if (!partial?.ip) {
      const code = classify(attempts);
      throw new ProxyEgressResolutionError(code, messageFor(code), attempts);
    }
    for (const provider of timezoneProviders(partial.ip)) {
      const geo = await runProvider(provider, "timezone", attempts);
      if (geo?.timezone) return {
        ...partial,
        timezone: partial.timezone ?? geo.timezone,
        country: partial.country ?? geo.country,
        state: partial.state ?? geo.state,
        city: partial.city ?? geo.city,
        asn: partial.asn ?? geo.asn,
        organization: partial.organization ?? geo.organization,
        isp: partial.isp ?? geo.isp,
        verified: true,
        provider: provider.name,
        attempts,
      };
    }
    throw new ProxyEgressResolutionError("timezone_lookup_failed", messageFor("timezone_lookup_failed"), attempts, partial.ip);
  } finally { await dispatcher.close(); }
}

export async function resolveProxyEgress(proxyUrl: URL): Promise<ProxyEgressIdentity> {
  if (proxyUrl.protocol === "direct:") return { ip: null, timezone: null, verified: true, provider: "direct", attempts: [] };
  const key = createHash("sha256").update(proxyUrl.toString()).digest("hex");
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;
  const promise = fetchProxyEgress(proxyUrl);
  const entry = { expiresAt: now + 10 * 60_000, promise };
  putBounded(cache, key, entry);
  void promise.catch(() => { if (cache.get(key)?.promise === promise) entry.expiresAt = Date.now() + 15_000; });
  return promise;
}

export async function verifyProxyEgressStability(proxyUrl: URL, samples = 3): Promise<ProxyEgressIdentity> {
  if (proxyUrl.protocol === "direct:") return resolveProxyEgress(proxyUrl);
  const identities: ProxyEgressIdentity[] = [];
  for (let index = 0; index < Math.max(2, samples); index++) {
    identities.push(await fetchProxyEgress(proxyUrl));
  }
  const ips = new Set(identities.map((identity) => identity.ip).filter((ip): ip is string => Boolean(ip)));
  if (ips.size !== 1) {
    throw new ProxyEgressResolutionError(
      "ip_lookup_failed",
      `Residential sticky-session verification failed: ${ips.size || "no"} stable exit IPs were observed. Target traffic was blocked.`,
      identities.flatMap((identity) => identity.attempts),
    );
  }
  return identities[identities.length - 1]!;
}

export function resetTzCache(): void { cache.clear(); timezoneCache.clear(); }
