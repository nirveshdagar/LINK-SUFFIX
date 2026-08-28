import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const MAX_TOKEN_LENGTH = 8_192;

const sign = (payload, secret) => createHmac("sha256", secret).update(payload).digest("base64url");

export function createSessionToken(scopes, secret, ttlSeconds) {
  if (!secret) throw new Error("A session signing secret is required");
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1_000) + Math.max(300, Number(ttlSeconds) || 0),
    scopes: [...new Set((Array.isArray(scopes) ? scopes : []).filter(value => typeof value === "string" && value))],
    version: VERSION,
  })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token, secret, requiredScope) {
  if (!secret || typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [payload, suppliedSignature] = parts;
  const expectedSignature = sign(payload, secret);
  const actual = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims?.version === VERSION
      && Number.isFinite(claims.exp)
      && claims.exp > Math.floor(Date.now() / 1_000)
      && Array.isArray(claims.scopes)
      && (!requiredScope || claims.scopes.includes(requiredScope) || claims.scopes.includes("admin"));
  } catch {
    return false;
  }
}
