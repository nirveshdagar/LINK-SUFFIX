import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateTrafficGet, validateTrafficPost, validateTrafficSitesState, formatValidationError } from "../lib/endpoint-schemas.ts";

describe("traffic schema validation", () => {
  it("accepts start_traffic with valid payload", () => {
    const result = validateTrafficPost({
      action: "start_traffic",
      geo: "auto",
      country: "US",
      state: "CA",
      city: "LA",
      sessions: 5,
      durationSec: 120,
      targetUrl: "httpbin.org",
    });
    assert.equal(result.ok, true);
    assert.equal(formatValidationError(result), "");
  });

  it("rejects stop_traffic with malformed sessions", () => {
    const result = validateTrafficPost({ action: "start_traffic", sessions: 9999 });
    assert.equal(result.ok, false);
    assert.ok(formatValidationError(result).includes("sessions"));
  });

  it("validates traffic sites state shape", () => {
    const result = validateTrafficSitesState({
      sites: [{ url: "https://example.com", tags: ["a"], active: true, addedAt: Date.now() }],
      suffix: "?utm=abc",
    });
    assert.equal(result.ok, true);
    assert.equal(result.value?.sites.length, 1);
  });

  it("validates traffic GET query", () => {
    const result = validateTrafficGet({ action: "stats" });
    assert.equal(result.ok, true);
    assert.equal(result.value?.action, "stats");
  });
});
