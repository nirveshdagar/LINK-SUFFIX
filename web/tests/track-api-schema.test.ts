import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateTrackPost } from "../lib/endpoint-schemas.ts";

describe("track schema validation", () => {
  it("accepts redirect chain payload", () => {
    const result = validateTrackPost({
      redirectChain: [
        { url: "https://a.example.com", status: 301 },
        { url: "https://b.example.com", status: 200 },
      ],
    });
    assert.equal(result.ok, true);
  });

  it("rejects redirect chain payload with bad items", () => {
    const result = validateTrackPost({
      redirectChain: [{ url: "", status: "200" }],
    });
    assert.equal(result.ok, false);
  });
});
