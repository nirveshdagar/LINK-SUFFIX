import { timingSafeEqual } from "node:crypto";
import { createSessionToken, verifySessionToken } from "./session-token.mjs";

export const API_SESSION_COOKIE = "tah_session";
const SESSION_TTL_SECONDS = Math.max(300, Number(process.env.TAH_SESSION_TTL_SECONDS) || 8 * 60 * 60);

export interface ApiAuthOptions {
  envVarName: string;
  fallbackEnvVarName?: string;
  scope?: string;
  allowSession?: boolean;
}

function isLoopback(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function insecureLocalDevAllowed(request: Request) {
  if (!["1", "true"].includes(process.env.TAH_ALLOW_INSECURE_LOCAL_DEV?.toLowerCase() || "")) return false;
  try {
    const host = request.headers.get("host");
    if (!host) return false;
    return isLoopback(new URL(request.url).hostname) && isLoopback(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request: Request) {
  const match = (request.headers.get("authorization")?.trim() ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function cookieValue(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return "";
}

function sessionSecret() {
  return process.env.TAH_SESSION_SECRET?.trim() || process.env.TAH_API_BEARER_TOKEN?.trim() || process.env.CONTROL_TOKEN?.trim() || "";
}

export function createApiSession(scopes: string[] = ["control", "ads", "read"]) {
  const secret = sessionSecret();
  if (!secret) throw new Error("TAH_SESSION_SECRET, TAH_API_BEARER_TOKEN, or CONTROL_TOKEN must be configured");
  return createSessionToken(scopes, secret, SESSION_TTL_SECONDS);
}

export function verifyApiSession(token: string, requiredScope?: string) {
  const secret = sessionSecret();
  return verifySessionToken(token, secret, requiredScope);
}

export function isValidTokenForEnv(token: string, envVarName: string, fallbackEnvVarName?: string) {
  if (!token) return false;
  const expected = [process.env[envVarName], fallbackEnvVarName ? process.env[fallbackEnvVarName] : undefined]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
  return expected.some((value) => safeEqual(token, value));
}

export function hasValidApiAuth(request: Request, options: ApiAuthOptions) {
  const configured = Boolean(
    process.env[options.envVarName]?.trim()
    || (options.fallbackEnvVarName && process.env[options.fallbackEnvVarName]?.trim()),
  );
  if (!configured) return insecureLocalDevAllowed(request);

  const candidates = [bearerToken(request), request.headers.get("x-api-key")?.trim() ?? ""].filter(Boolean);
  if (candidates.some((token) => isValidTokenForEnv(token, options.envVarName, options.fallbackEnvVarName))) return true;
  return options.allowSession !== false && verifyApiSession(cookieValue(request, API_SESSION_COOKIE), options.scope);
}

export function apiSessionCookie(token: string, requestUrl: string) {
  const secure = new URL(requestUrl).protocol === "https:";
  return [
    `${API_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearApiSessionCookie(requestUrl: string) {
  const secure = new URL(requestUrl).protocol === "https:";
  return [
    `${API_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}
