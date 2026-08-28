import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildRateLimitHeaders,
  checkRateLimit,
  resetRateLimitStateForTests,
  withRateLimitHeaders,
} from "../lib/rate-limit.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env.TAH_RATE_LIMIT_REDIS_REST_URL;
  delete process.env.TAH_RATE_LIMIT_REDIS_REST_TOKEN;
  delete process.env.TAH_RATE_LIMIT_FAIL_CLOSED;
  globalThis.fetch = originalFetch;
  resetRateLimitStateForTests();
});

describe("rate limiting", () => {
  it("enforces a local fixed window per identity", async () => {
    const request = new Request("http://localhost/api/test", {
      headers: { authorization: "Bearer local-test-token" },
    });
    const config = { namespace: "test-local", limit: 2, windowMs: 60_000 };

    assert.equal((await checkRateLimit(request, config)).ok, true);
    assert.equal((await checkRateLimit(request, config)).ok, true);
    const denied = await checkRateLimit(request, config);
    assert.equal(denied.ok, false);
    assert.equal(denied.remaining, 0);
    assert.equal(denied.backend, "memory");
  });

  it("uses an atomic Redis script when distributed storage is configured", async () => {
    process.env.TAH_RATE_LIMIT_REDIS_REST_URL = "https://redis.example.test";
    process.env.TAH_RATE_LIMIT_REDIS_REST_TOKEN = "redis-token";
    let command: unknown;
    globalThis.fetch = async (_input, init) => {
      command = JSON.parse(String(init?.body));
      return Response.json({ result: [3, 42_000] });
    };

    const result = await checkRateLimit(new Request("http://localhost/api/test"), {
      namespace: "test-redis",
      limit: 2,
      windowMs: 60_000,
    });

    assert.equal(result.backend, "redis");
    assert.equal(result.ok, false);
    assert.equal(Array.isArray(command), true);
    assert.equal((command as unknown[])[0], "EVAL");
  });

  it("adds policy headers to successful and rejected responses", async () => {
    const result = await checkRateLimit(new Request("http://localhost/api/test"), {
      namespace: "test-headers",
      limit: 5,
      windowMs: 60_000,
    });
    const response = withRateLimitHeaders(Response.json({ ok: true }), result);
    const headers = buildRateLimitHeaders(result);

    assert.equal(response.headers.get("x-ratelimit-limit"), "5");
    assert.equal(response.headers.get("x-ratelimit-remaining"), "4");
    assert.equal(headers["Retry-After"], undefined);
  });
});
