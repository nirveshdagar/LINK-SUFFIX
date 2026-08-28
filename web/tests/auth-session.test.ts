import assert from "node:assert/strict";
import test from "node:test";
import { createApiSession, hasValidApiAuth, verifyApiSession } from "../lib/api-auth-core.ts";

test("independent bearer and API-key credentials can coexist", () => {
  const previousGlobal = process.env.TAH_API_BEARER_TOKEN;
  const previousAds = process.env.TAH_ADS_API_TOKEN;
  process.env.TAH_API_BEARER_TOKEN = "global-token-value";
  process.env.TAH_ADS_API_TOKEN = "ads-token-value";
  try {
    const request = new Request("https://example.test/api/ads", { headers: { authorization: "Bearer global-token-value", "x-api-key": "ads-token-value" } });
    assert.equal(hasValidApiAuth(request, { envVarName: "TAH_API_BEARER_TOKEN" }), true);
    assert.equal(hasValidApiAuth(request, { envVarName: "TAH_ADS_API_TOKEN" }), true);
  } finally {
    if (previousGlobal === undefined) delete process.env.TAH_API_BEARER_TOKEN; else process.env.TAH_API_BEARER_TOKEN = previousGlobal;
    if (previousAds === undefined) delete process.env.TAH_ADS_API_TOKEN; else process.env.TAH_ADS_API_TOKEN = previousAds;
  }
});

test("signed API sessions expire and enforce scopes", () => {
  const previousSecret = process.env.TAH_SESSION_SECRET;
  process.env.TAH_SESSION_SECRET = "test-session-secret-with-more-than-32-bytes";
  try {
    const token = createApiSession(["control"]);
    assert.equal(verifyApiSession(token, "control"), true);
    assert.equal(verifyApiSession(token, "ads"), false);
    assert.equal(verifyApiSession(`${token}x`, "control"), false);
  } finally {
    if (previousSecret === undefined) delete process.env.TAH_SESSION_SECRET; else process.env.TAH_SESSION_SECRET = previousSecret;
  }
});
