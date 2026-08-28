import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API_POLICIES } from "../lib/api-policy.ts";

describe("API security policies", () => {
  it("keeps auth and rate-limit configuration centralized", () => {
    assert.equal(API_POLICIES.ads.auth.envVarName, "TAH_ADS_API_TOKEN");
    assert.equal(API_POLICIES.traffic.auth.envVarName, "TAH_API_BEARER_TOKEN");
    assert.equal(API_POLICIES.track.auth.fallbackEnvVarName, "TAH_API_BEARER_TOKEN");
    assert.equal(API_POLICIES.ads.rateLimit.namespace, "ads");
    assert.equal(API_POLICIES.traffic.rateLimit.namespace, "traffic");
    assert.equal(API_POLICIES.track.rateLimit.namespace, "track");
  });
});
