import assert from "node:assert/strict";
import test from "node:test";
import { extractExactQuerySuffix, isBlockedAddress } from "../lib/url-security.ts";

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
