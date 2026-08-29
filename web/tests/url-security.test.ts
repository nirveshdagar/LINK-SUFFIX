import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeOutboundUrl, extractExactQuerySuffix, isBlockedAddress } from "../lib/url-security.ts";

test("extractExactQuerySuffix preserves order, encoding, and duplicate keys", () => {
  assert.equal(
    extractExactQuerySuffix("https://example.test/final?b=2&a=%2f&a=three%20words#fragment"),
    "b=2&a=%2f&a=three%20words",
  );
});

test("extractExactQuerySuffix returns an empty suffix when no query exists", () => {
  assert.equal(extractExactQuerySuffix("https://example.test/final#fragment"), "");
});

test("private and reserved addresses are blocked", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
});

test("public target policy accepts unlisted public targets but still blocks private targets", async (t) => {
  const previousPolicy = process.env.TAH_TARGET_POLICY;
  const previousAllowedHosts = process.env.TAH_TRAFFIC_ALLOWED_HOSTS;
  const previousNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    if (previousPolicy === undefined) delete process.env.TAH_TARGET_POLICY; else process.env.TAH_TARGET_POLICY = previousPolicy;
    if (previousAllowedHosts === undefined) delete process.env.TAH_TRAFFIC_ALLOWED_HOSTS; else process.env.TAH_TRAFFIC_ALLOWED_HOSTS = previousAllowedHosts;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  });
  process.env.TAH_TARGET_POLICY = "public";
  process.env.TAH_TRAFFIC_ALLOWED_HOSTS = "";
  process.env.NODE_ENV = "production";

  await assert.doesNotReject(() => assertSafeOutboundUrl("https://8.8.8.8/tracking"));
  await assert.rejects(() => assertSafeOutboundUrl("http://127.0.0.1/internal"), /Private, reserved/);
});
