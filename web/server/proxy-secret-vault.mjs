import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = 1;
const MAX_SECRET_BYTES = 64 * 1024;

function keyBuffer(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new Error("Proxy secret key must contain exactly 32 bytes");
    return Buffer.from(value);
  }
  const text = String(value || "").trim();
  const decoded = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (decoded.length !== 32) throw new Error("TAH_PROXY_SECRET_KEY must be a 32-byte base64 or hexadecimal key");
  return decoded;
}

function encoded(value, field) {
  const buffer = Buffer.from(String(value || ""), "base64");
  if (!buffer.length) throw new Error(`Encrypted proxy secret ${field} is invalid`);
  return buffer;
}

export function encryptProxySecret(secret, key, keyId = "primary") {
  if (!secret || typeof secret !== "object" || Array.isArray(secret)) throw new Error("Proxy secret must be an object");
  const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
  if (plaintext.length > MAX_SECRET_BYTES) throw new Error("Proxy secret exceeds 64 KiB");
  const iv = randomBytes(12);
  const aad = Buffer.from(`tah-proxy-secret:${VERSION}:${keyId}`, "utf8");
  const cipher = createCipheriv(ALGORITHM, keyBuffer(key), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: VERSION,
    algorithm: ALGORITHM,
    keyId,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptProxySecret(envelope, key) {
  if (!envelope || envelope.version !== VERSION || envelope.algorithm !== ALGORITHM || !envelope.keyId) throw new Error("Unsupported encrypted proxy secret envelope");
  const aad = Buffer.from(`tah-proxy-secret:${VERSION}:${envelope.keyId}`, "utf8");
  const decipher = createDecipheriv(ALGORITHM, keyBuffer(key), encoded(envelope.iv, "IV"));
  decipher.setAAD(aad);
  decipher.setAuthTag(encoded(envelope.tag, "tag"));
  const plaintext = Buffer.concat([decipher.update(encoded(envelope.ciphertext, "ciphertext")), decipher.final()]);
  const secret = JSON.parse(plaintext.toString("utf8"));
  if (!secret || typeof secret !== "object" || Array.isArray(secret)) throw new Error("Decrypted proxy secret is invalid");
  return secret;
}

export function proxySecretSummary(secret) {
  return {
    configured: Boolean(secret && typeof secret === "object" && Object.values(secret).some((value) => String(value || "").length > 0)),
    hasUsername: Boolean(secret?.username),
    hasPassword: Boolean(secret?.password),
    hasToken: Boolean(secret?.token),
  };
}
