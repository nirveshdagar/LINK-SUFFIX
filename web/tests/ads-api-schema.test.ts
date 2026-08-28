import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateAdsPost, validateAdsGet } from "../lib/endpoint-schemas.ts";

describe("ads schema validation", () => {
  it("accepts configure payload with campaign id", () => {
    const result = validateAdsPost({
      action: "configure",
      campaignId: "1234567890",
      customerId: "456",
    });
    assert.equal(result.ok, true);
  });

  it("rejects configure payload without configuration fields", () => {
    const result = validateAdsPost({ action: "configure" });
    assert.equal(result.ok, false);
  });

  it("accepts refresh suffix response shape", () => {
    const result = validateAdsGet({
      campaignId: "123",
      customerId: "456",
      clientId: "••••abcd",
      clientSecret: "••••efgh",
      developerToken: "••••ijkl",
      refreshToken: "••••mnop",
      hasCredentials: true,
      pushHistory: [],
    });
    assert.equal(result.ok, true);
  });
});
