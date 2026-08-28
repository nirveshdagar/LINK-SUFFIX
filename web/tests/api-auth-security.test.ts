import assert from "node:assert/strict";
import test from "node:test";
import { hasValidApiAuth } from "../lib/api-auth-core.ts";

const options = { envVarName: "TAH_TEST_API_TOKEN" };

test("API authentication fails closed when the server token is missing", () => {
  const env = process.env as Record<string, string | undefined>;
  const previousToken = process.env.TAH_TEST_API_TOKEN;
  const previousOptIn = process.env.TAH_ALLOW_INSECURE_LOCAL_DEV;
  const previousNodeEnv = env.NODE_ENV;
  delete process.env.TAH_TEST_API_TOKEN;
  delete process.env.TAH_ALLOW_INSECURE_LOCAL_DEV;
  env.NODE_ENV = "production";
  try {
    assert.equal(hasValidApiAuth(new Request("http://localhost/api/test"), options), false);
  } finally {
    if (previousToken === undefined) delete process.env.TAH_TEST_API_TOKEN; else process.env.TAH_TEST_API_TOKEN = previousToken;
    if (previousOptIn === undefined) delete process.env.TAH_ALLOW_INSECURE_LOCAL_DEV; else process.env.TAH_ALLOW_INSECURE_LOCAL_DEV = previousOptIn;
    if (previousNodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = previousNodeEnv;
  }
});

test("API authentication accepts only the configured token", () => {
  const previous = process.env.TAH_TEST_API_TOKEN;
  process.env.TAH_TEST_API_TOKEN = "correct-token";
  try {
    assert.equal(hasValidApiAuth(new Request("http://localhost/api/test", { headers: { authorization: "Bearer wrong-token" } }), options), false);
    assert.equal(hasValidApiAuth(new Request("http://localhost/api/test", { headers: { authorization: "Bearer correct-token" } }), options), true);
  } finally {
    if (previous === undefined) delete process.env.TAH_TEST_API_TOKEN; else process.env.TAH_TEST_API_TOKEN = previous;
  }
});
