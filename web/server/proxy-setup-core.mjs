import { createHash } from "node:crypto";

const EVOMI_HOSTS = new Set(["core-residential.evomi.com", "premium-residential.evomi.com", "rp.evomi.com", "rp.evomi-proxy.com"]);
export function isEvomi(provider) { return EVOMI_HOSTS.has(String(provider.gatewayHost || "").toLowerCase()); }

export function defaultPoolId(id) {
  return id.length <= 56 ? id + "-default" : id.slice(0, 44) + "-" + createHash("sha256").update(id).digest("hex").slice(0, 8) + "-default";
}

export function credentialInput(provider, supplied = {}, previous = {}) {
  const secret = { ...previous };
  for (const field of ["username", "password", "token"]) {
    const value = supplied?.[field];
    if (value !== undefined && typeof value !== "string") throw new Error("Credential values must be strings");
    if (typeof value === "string" && value.length) secret[field] = value;
  }
  if (provider.authMode === "username-password") {
    if (!secret.username || !secret.password) throw new Error("Username and password are required in the encrypted credential fields, not template fields");
    if (!String(provider.usernameTemplate || "{username}").includes("{username}") ||
        !String(provider.passwordTemplate || "{password}").includes("{password}")) {
      throw new Error("Use {username} and {password} in templates. Put actual login details in the encrypted credential fields");
    }
  } else if (provider.authMode === "token" && !secret.token) {
    throw new Error("A token is required in the encrypted credential field");
  }
  return provider.authMode === "ip-allowlist" ? undefined : secret;
}

export function automaticPool(provider, existing) {
  const evomi = isEvomi(provider);
  const sticky = provider.rotationModes.includes("sticky-session");
  const mode = evomi ? "sticky-session" : sticky ? "sticky-session" : provider.rotationModes[0];
  if (evomi && !sticky) throw new Error("EVOMI browser journeys require sticky-session mode; a new session is assigned to each browser context");
  if (existing && existing.config?.autoManaged !== true) return existing;
  const sessionShared = sticky && evomi;
  return {
    poolId: defaultPoolId(provider.providerId), providerId: provider.providerId,
    name: provider.name + " / Automatic", enabled: true, endpointPorts: provider.gatewayPorts,
    defaultRotationMode: mode, maxConcurrentPerEndpoint: 1,
    config: { autoManaged: true, sessionSharedGateway: sessionShared, sessionCapacity: 100 },
  };
}

export function physicalEndpointKey(key) {
  return String(key).replace(/~[a-z0-9._-]+~[0-9]+(?=:[0-9]+$)/, "");
}

export function leaseEndpointKeys(pool, host, rotationMode, sessionId = "") {
  const ports = pool.endpointPorts || [];
  if (!EVOMI_HOSTS.has(String(host).toLowerCase()) || !pool.config?.sessionSharedGateway || rotationMode !== "sticky-session") return ports.map(port => host + ":" + port);
  const slots = Math.max(1, Math.min(500, Number(pool.config.sessionCapacity) || 100));
  if (!Number.isInteger(slots) || slots * ports.length > 5000) throw new Error("Shared gateway capacity exceeds the bounded lease limit");
  const offset = createHash("sha256").update(String(sessionId)).digest().readUInt32BE(0) % slots;
  return ports.flatMap(port => Array.from({ length: slots }, (_, index) => host + "~" + pool.poolId + "~" + ((index + offset) % slots) + ":" + port));
}

function geoToken(value, field) {
  const token = String(value || "").trim().toLowerCase().replace(/\s+/g, ".");
  if (token && !/^[a-z0-9.]+$/.test(token)) throw new Error("Invalid EVOMI " + field + "; use the value from the provider location list");
  return token;
}

export function buildEvomiEndpoint(provider, secret, request) {
  if (!isEvomi(provider) || !provider.enabled) throw new Error("EVOMI provider is disabled or invalid");
  if (!secret.username || !secret.password) throw new Error("EVOMI credentials are required");
  const port = Number(request.port || provider.gatewayPorts[0]);
  if (!provider.gatewayPorts.includes(port)) throw new Error("EVOMI port is not part of the provider");
  const expected = { http: 1000, https: 1001, socks5: 1002 }[provider.protocol];
  if (port !== expected) throw new Error("EVOMI port must match its HTTP, HTTPS or SOCKS5 protocol");
  if (provider.protocol === "https" && provider.gatewayHost !== "rp.evomi-proxy.com") throw new Error("EVOMI HTTPS requires the certificate hostname rp.evomi-proxy.com");
  if (request.rotationMode !== "sticky-session") throw new Error("EVOMI browser journeys require sticky-session rotation");
  if (!request.sessionId) throw new Error("A browser session ID is required for EVOMI");
  if (request.asn) throw new Error("EVOMI ASN selection is not enabled in this preset");
  const country = String(request.geo?.country || "").trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("EVOMI country requires a two-letter ISO code");
  const region = geoToken(request.geo?.state, "region");
  const city = geoToken(request.geo?.city, "city");
  const sessionId = createHash("sha256").update(provider.providerId + ":" + String(request.campaignId || "") + ":" + request.sessionId).digest("hex").slice(0, 10);
  const seconds = Number(request.ttlSeconds || 1800);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 86400) throw new Error("EVOMI session duration must be between 60 and 86400 seconds");
  const lifetime = Math.ceil(seconds / 60);
  let password = secret.password;
  if (country) password += "_country-" + country;
  if (region) password += "_region-" + region;
  if (city) password += "_city-" + city;
  password += "_session-" + sessionId + "_lifetime-" + lifetime;
  const url = new URL(provider.protocol + "://" + provider.gatewayHost + ":" + port);
  url.username = secret.username;
  url.password = password;
  return { url, mode: "sticky-residential", sessionId, providerId: provider.providerId, protocol: provider.protocol, rotationMode: "sticky-session", port };
}

export function requireBrowserSessionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("A valid browser session ID is required; a campaign ID is not a fallback");
  return value;
}
