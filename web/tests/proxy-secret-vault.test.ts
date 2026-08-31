import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptProxySecret, encryptProxySecret, proxySecretSummary } from "../server/proxy-secret-vault.mjs";

test("proxy provider secrets round-trip through authenticated encryption", () => {
  const key = randomBytes(32);
  const secret = { username: "provider-user", password: "provider-password", token: "provider-token" };
  const envelope = encryptProxySecret(secret, key, "test-key");
  assert.equal(envelope.version, 1);
  assert.equal(JSON.stringify(envelope).includes("provider-password"), false);
  assert.deepEqual(decryptProxySecret(envelope, key), secret);
  assert.deepEqual(proxySecretSummary(secret), { configured: true, hasUsername: true, hasPassword: true, hasToken: true });
});

test("proxy provider secret decryption fails after ciphertext tampering", () => {
  const key = randomBytes(32);
  const envelope = encryptProxySecret({ password: "secret" }, key);
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  ciphertext[0] ^= 1;
  assert.throws(() => decryptProxySecret({ ...envelope, ciphertext: ciphertext.toString("base64") }, key));
});

test("proxy secret vault rejects invalid keys and never returns secret values in summaries", () => {
  assert.throws(() => encryptProxySecret({ password: "secret" }, Buffer.alloc(16)), /32 bytes/);
  const summary = proxySecretSummary({ username: "visible-only-server-side", password: "never-return" });
  assert.deepEqual(Object.keys(summary).sort(), ["configured", "hasPassword", "hasToken", "hasUsername"]);
  assert.equal(JSON.stringify(summary).includes("never-return"), false);
});
