import { createHash } from "node:crypto";

export interface RateLimitConfig {
  namespace: string;
  limit: number;
  windowMs: number;
  identity?: string;
  envVarName?: string;
  fallbackEnvVarName?: string;
  envVarWindowName?: string;
  envVarLimitName?: string;
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
  retryAfterSeconds: number;
  backend: "memory" | "redis" | "closed";
}

interface Bucket { count: number; resetAt: number }

const buckets = new Map<string, Bucket>();
const MAX_LOCAL_BUCKETS = Math.max(1_000, Number(process.env.TAH_RATE_LIMIT_MAX_BUCKETS) || 50_000);

const redisScript = [
  "local current = redis.call('INCR', KEYS[1])",
  "if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
  "local ttl = redis.call('PTTL', KEYS[1])",
  "return {current, ttl}",
].join("\n");

function clientIdentity(request: Request) {
  const raw = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("x-real-ip"),
    request.headers.get("x-forwarded-for")?.split(",")[0],
  ].find((value) => value?.trim())?.trim() || "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function keyFor(request: Request, config: RateLimitConfig) {
  const identity = config.identity?.trim() || clientIdentity(request);
  return `tah:rl:${config.namespace}:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function prune(now: number) {
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  if (buckets.size <= MAX_LOCAL_BUCKETS) return;
  const excess = buckets.size - MAX_LOCAL_BUCKETS;
  [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt).slice(0, excess).forEach(([key]) => buckets.delete(key));
}

function localLimit(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  prune(now);
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + config.windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  const resetMs = Math.max(0, bucket.resetAt - now);
  return {
    ok: bucket.count <= config.limit,
    limit: config.limit,
    remaining: Math.max(0, config.limit - bucket.count),
    resetMs,
    retryAfterMs: resetMs,
    retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
    backend: "memory",
  };
}

async function redisLimit(key: string, config: RateLimitConfig): Promise<RateLimitResult | null> {
  const url = process.env.TAH_RATE_LIMIT_REDIS_REST_URL?.replace(/\/$/, "");
  const token = process.env.TAH_RATE_LIMIT_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(10_000, Math.max(1_000, Number(process.env.TAH_RATE_LIMIT_REDIS_TIMEOUT_MS) || 3_000)));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(["EVAL", redisScript, "1", key, String(config.windowMs)]),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Redis rate-limit request failed (${response.status})`);
    const payload = await response.json() as { result?: [number, number] };
    const count = Number(payload.result?.[0]);
    const resetMs = Math.max(0, Number(payload.result?.[1]));
    if (!Number.isFinite(count) || !Number.isFinite(resetMs)) throw new Error("Invalid Redis rate-limit response");
    return {
      ok: count <= config.limit,
      limit: config.limit,
      remaining: Math.max(0, config.limit - count),
      resetMs,
      retryAfterMs: resetMs,
      retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
      backend: "redis",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkRateLimit(request: Request, config: RateLimitConfig): Promise<RateLimitResult> {
  const configuredLimit = Number(process.env[config.envVarLimitName || config.envVarName || ""]);
  const configuredWindow = Number(process.env[config.envVarWindowName || ""]);
  const normalized: RateLimitConfig = {
    ...config,
    limit: Math.max(1, Math.floor(Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : config.limit)),
    windowMs: Math.max(1_000, Math.floor(Number.isFinite(configuredWindow) && configuredWindow > 0 ? configuredWindow : config.windowMs)),
  };
  const key = keyFor(request, normalized);
  try {
    return await redisLimit(key, normalized) ?? localLimit(key, normalized);
  } catch {
    if (process.env.TAH_RATE_LIMIT_FAIL_CLOSED === "1") {
      return { ok: false, limit: normalized.limit, remaining: 0, resetMs: normalized.windowMs, retryAfterMs: normalized.windowMs, retryAfterSeconds: Math.ceil(normalized.windowMs / 1000), backend: "closed" };
    }
    return localLimit(key, normalized);
  }
}

export function buildRateLimitHeaders(result: RateLimitResult) {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil((Date.now() + result.resetMs) / 1000)),
    ...(result.ok ? {} : { "Retry-After": String(result.retryAfterSeconds) }),
  };
}

export function withRateLimitHeaders<T extends Response>(response: T, result: RateLimitResult): T {
  for (const [name, value] of Object.entries(buildRateLimitHeaders(result))) response.headers.set(name, value);
  return response;
}

export function resetRateLimitStateForTests() {
  buckets.clear();
}
