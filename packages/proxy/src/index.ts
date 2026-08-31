import { IPROYAL_USERNAME_REGEX, HOSTNAMES, PROXY_PORT } from './grammar.js';

export { IPROYAL_USERNAME_REGEX, HOSTNAMES, PROXY_PORT } from './grammar.js';

export type ProxyMode = 'rotating-residential' | 'sticky-residential';

export interface GeoTarget {
  country: string;
  state?: string;
  city?: string;
}

export interface ProxyEndpoint {
  url: URL;
  mode: ProxyMode;
  sessionId?: string;
}

export interface ProxyGatewayOverride {
  hostname?: string;
  port?: number;
}

export type ProxyProtocol = 'http' | 'https' | 'socks5';
export type ProxyProviderKind = 'iproyal' | 'universal' | 'custom';
export type ProxyAuthMode = 'username-password' | 'token' | 'ip-allowlist';
export type ProxyRotationMode = 'per-request' | 'sticky-session' | 'port-pool' | 'provider-managed';

export interface ProxyProviderCapabilities {
  country?: boolean;
  state?: boolean;
  city?: boolean;
  asn?: boolean;
  stickySession?: boolean;
  maximumSessionSeconds?: number;
}

export interface ProxyProviderDefinition {
  id: string;
  name: string;
  kind: ProxyProviderKind;
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  ports: number[];
  authMode: ProxyAuthMode;
  usernameTemplate?: string;
  passwordTemplate?: string;
  rotationModes: ProxyRotationMode[];
  capabilities: ProxyProviderCapabilities;
}

export interface ProxyProviderSecret {
  username?: string;
  password?: string;
  token?: string;
}

export interface ProxyLeaseRequest {
  campaignId: string;
  geo: GeoTarget;
  rotationMode: ProxyRotationMode;
  sessionId?: string;
  ttlSeconds?: number;
  port?: number;
  asn?: string;
}

export interface ProviderProxyEndpoint extends ProxyEndpoint {
  providerId: string;
  protocol: ProxyProtocol;
  rotationMode: ProxyRotationMode;
  port: number;
}

export interface ProxyProviderAdapter {
  kind: ProxyProviderKind;
  buildEndpoint(
    provider: ProxyProviderDefinition,
    secret: ProxyProviderSecret,
    request: ProxyLeaseRequest,
  ): ProviderProxyEndpoint;
}

export class InvalidProxyGeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProxyGeoError';
  }
}

const US_STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "newhampshire", nj: "newjersey",
  nm: "newmexico", ny: "newyork", nc: "northcarolina", nd: "northdakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhodeisland", sc: "southcarolina",
  sd: "southdakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "westvirginia", wi: "wisconsin", wy: "wyoming", dc: "districtofcolumbia",
};

export function buildProxyEndpoint(
  geo: GeoTarget,
  mode: ProxyMode,
  creds: { user: string; pass: string },
  sessionId?: string,
  gateway: ProxyGatewayOverride = {},
): ProxyEndpoint {
  // IP Royal residential proxy URL format:
  //   http://<accountUser>:<accountPass>@<host>:<port>
  //     /country-XX[-state-...][-city-...]/<sessionToken>
  //
  // The geo + session are in the URL path, NOT the username. The account
  // username is the literal account name (e.g. "iproyal1365").
  if (!IPROYAL_USERNAME_REGEX.test(creds.user)) {
    throw new InvalidProxyGeoError(
      `Invalid IP Royal account username (must be alphanumeric): ${creds.user}`,
    );
  }

  const token = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  // Accept either the base password or a formatted proxy password copied from
  // IPRoyal, then apply this run's routing exactly once.
  let password = creds.pass.replace(/_(?:country|state|city|session|lifetime|streaming)-.*$/i, '');
  if (geo.country) {
    password += `_country-${token(geo.country)}`;
  if (geo.state) {
    const state = token(geo.state);
    password += `_state-${geo.country.toLowerCase() === "us" ? (US_STATES[state] ?? state) : state}`;
  }
    if (geo.city) password += `_city-${token(geo.city)}`;
  }
  if (mode === 'sticky-residential') {
    const stickySession = token(sessionId ?? '');
    if (!/^[a-z0-9]{8}$/.test(stickySession)) {
      throw new InvalidProxyGeoError('IPRoyal sticky session IDs must contain exactly 8 alphanumeric characters');
    }
    password += `_session-${stickySession}_lifetime-1h`;
  }

  const hostname = String(gateway.hostname ?? HOSTNAMES[mode]).trim().toLowerCase();
  const port = Number(gateway.port ?? PROXY_PORT);
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(hostname)) throw new InvalidProxyGeoError("Invalid proxy gateway hostname");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidProxyGeoError("Invalid proxy gateway port");
  const url = new URL(`http://${hostname}:${port}`);
  url.username = creds.user;
  url.password = password;
  return { url, mode, sessionId };
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const GATEWAY_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const TEMPLATE_TOKEN_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const ALLOWED_TEMPLATE_TOKENS = new Set([
  'username', 'password', 'token', 'country', 'state', 'city', 'asn', 'sessionId', 'ttl',
]);

function templateTokens(template: string) {
  return [...template.matchAll(TEMPLATE_TOKEN_PATTERN)]
    .map((match) => match[1])
    .filter((token): token is string => token !== undefined);
}

function validateTemplate(template: string | undefined, field: string) {
  if (template === undefined) return;
  if (template.length > 512) throw new InvalidProxyGeoError(`${field} exceeds 512 characters`);
  for (const token of templateTokens(template)) {
    if (!ALLOWED_TEMPLATE_TOKENS.has(token)) throw new InvalidProxyGeoError(`${field} contains unsupported token {${token}}`);
  }
  const remainder = template.replace(TEMPLATE_TOKEN_PATTERN, '');
  if (/[{}]/.test(remainder)) throw new InvalidProxyGeoError(`${field} contains malformed template syntax`);
}

export function validateProxyProvider(provider: ProxyProviderDefinition) {
  if (!PROVIDER_ID_PATTERN.test(provider.id)) throw new InvalidProxyGeoError('Provider ID must contain 2-64 lowercase letters, numbers, dots, underscores, or hyphens');
  if (!provider.name.trim() || provider.name.length > 120) throw new InvalidProxyGeoError('Provider name is required and must not exceed 120 characters');
  if (!['iproyal', 'universal', 'custom'].includes(provider.kind)) throw new InvalidProxyGeoError('Unsupported proxy provider kind');
  if (!['http', 'https', 'socks5'].includes(provider.protocol)) throw new InvalidProxyGeoError('Unsupported proxy protocol');
  if (!GATEWAY_HOST_PATTERN.test(provider.host.trim().toLowerCase())) throw new InvalidProxyGeoError('Invalid proxy gateway hostname');
  if (!provider.ports.length || provider.ports.length > 5_000) throw new InvalidProxyGeoError('Provider must define between 1 and 5,000 gateway ports');
  if (new Set(provider.ports).size !== provider.ports.length || provider.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new InvalidProxyGeoError('Provider gateway ports must be unique integers between 1 and 65535');
  }
  if (!['username-password', 'token', 'ip-allowlist'].includes(provider.authMode)) throw new InvalidProxyGeoError('Unsupported proxy authentication mode');
  if (!provider.rotationModes.length || new Set(provider.rotationModes).size !== provider.rotationModes.length) throw new InvalidProxyGeoError('Provider must define unique rotation modes');
  if (provider.rotationModes.some((mode) => !['per-request', 'sticky-session', 'port-pool', 'provider-managed'].includes(mode))) {
    throw new InvalidProxyGeoError('Unsupported provider rotation mode');
  }
  if (provider.rotationModes.includes('sticky-session') && provider.capabilities.stickySession === false) {
    throw new InvalidProxyGeoError('Sticky rotation requires sticky-session capability');
  }
  validateTemplate(provider.usernameTemplate, 'Username template');
  validateTemplate(provider.passwordTemplate, 'Password template');
  return provider;
}

function normalizedTemplateToken(value: string | undefined) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-');
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(TEMPLATE_TOKEN_PATTERN, (_match, token: string) => {
    if (!ALLOWED_TEMPLATE_TOKENS.has(token)) throw new InvalidProxyGeoError(`Unsupported proxy template token {${token}}`);
    const value = values[token];
    if (value === undefined) throw new InvalidProxyGeoError(`Proxy template requires ${token}`);
    return value;
  });
}

function assertRequestSupported(provider: ProxyProviderDefinition, request: ProxyLeaseRequest) {
  if (!provider.enabled) throw new InvalidProxyGeoError('Proxy provider is disabled');
  if (!provider.rotationModes.includes(request.rotationMode)) throw new InvalidProxyGeoError(`Provider does not support ${request.rotationMode} rotation`);
  if (request.geo.country && provider.capabilities.country === false) throw new InvalidProxyGeoError('Provider does not support country targeting');
  if (request.geo.state && !provider.capabilities.state) throw new InvalidProxyGeoError('Provider does not support state targeting');
  if (request.geo.city && !provider.capabilities.city) throw new InvalidProxyGeoError('Provider does not support city targeting');
  if (request.asn && !provider.capabilities.asn) throw new InvalidProxyGeoError('Provider does not support ASN targeting');
  if (request.rotationMode === 'sticky-session' && !request.sessionId?.trim()) throw new InvalidProxyGeoError('Sticky sessions require a session ID');
  if (request.ttlSeconds !== undefined) {
    const maximum = provider.capabilities.maximumSessionSeconds || 86_400;
    if (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds < 60 || request.ttlSeconds > maximum) {
      throw new InvalidProxyGeoError(`Session TTL must be between 60 and ${maximum} seconds`);
    }
  }
}

function firstProviderPort(provider: ProxyProviderDefinition) {
  const port = provider.ports[0];
  if (port === undefined) throw new InvalidProxyGeoError('Proxy provider has no gateway port');
  return port;
}

export const universalResidentialAdapter: ProxyProviderAdapter = {
  kind: 'universal',
  buildEndpoint(provider, secret, request) {
    validateProxyProvider(provider);
    assertRequestSupported(provider, request);
    const port = request.port ?? firstProviderPort(provider);
    if (!provider.ports.includes(port)) throw new InvalidProxyGeoError('Requested gateway port is not part of this provider');
    const values: Record<string, string> = {
      country: normalizedTemplateToken(request.geo.country),
      state: normalizedTemplateToken(request.geo.state),
      city: normalizedTemplateToken(request.geo.city),
      asn: normalizedTemplateToken(request.asn),
      sessionId: normalizedTemplateToken(request.sessionId),
      ttl: String(request.ttlSeconds ?? 3_600),
      username: String(secret.username ?? ''),
      password: String(secret.password ?? ''),
      token: String(secret.token ?? ''),
    };
    let username = '';
    let password = '';
    if (provider.authMode === 'username-password') {
      if (!secret.username || !secret.password) throw new InvalidProxyGeoError('Provider credentials are incomplete');
      username = renderTemplate(provider.usernameTemplate || '{username}', values);
      password = renderTemplate(provider.passwordTemplate || '{password}', values);
    } else if (provider.authMode === 'token') {
      if (!secret.token) throw new InvalidProxyGeoError('Provider token is missing');
      username = renderTemplate(provider.usernameTemplate || '{token}', values);
      password = renderTemplate(provider.passwordTemplate || '', values);
    }
    const url = new URL(`${provider.protocol}://${provider.host.trim().toLowerCase()}:${port}`);
    if (username) url.username = username;
    if (password) url.password = password;
    const mode: ProxyMode = request.rotationMode === 'sticky-session' ? 'sticky-residential' : 'rotating-residential';
    return { url, mode, sessionId: request.sessionId, providerId: provider.id, protocol: provider.protocol, rotationMode: request.rotationMode, port };
  },
};

export const ipRoyalProviderAdapter: ProxyProviderAdapter = {
  kind: 'iproyal',
  buildEndpoint(provider, secret, request) {
    validateProxyProvider(provider);
    assertRequestSupported(provider, request);
    if (!secret.username || !secret.password) throw new InvalidProxyGeoError('IPRoyal credentials are incomplete');
    const port = request.port ?? firstProviderPort(provider);
    if (!provider.ports.includes(port)) throw new InvalidProxyGeoError('Requested IPRoyal port is not part of this provider');
    const mode: ProxyMode = request.rotationMode === 'sticky-session' ? 'sticky-residential' : 'rotating-residential';
    const endpoint = buildProxyEndpoint(request.geo, mode, { user: secret.username, pass: secret.password }, request.sessionId, { hostname: provider.host, port });
    return { ...endpoint, providerId: provider.id, protocol: 'http', rotationMode: request.rotationMode, port };
  },
};

export class ProxyAdapterRegistry {
  private readonly adapters = new Map<ProxyProviderKind, ProxyProviderAdapter>();

  constructor(adapters: ProxyProviderAdapter[] = [ipRoyalProviderAdapter, universalResidentialAdapter]) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProxyProviderAdapter) {
    if (this.adapters.has(adapter.kind)) throw new InvalidProxyGeoError(`Proxy adapter ${adapter.kind} is already registered`);
    this.adapters.set(adapter.kind, adapter);
    return this;
  }

  buildEndpoint(provider: ProxyProviderDefinition, secret: ProxyProviderSecret, request: ProxyLeaseRequest) {
    const adapter = this.adapters.get(provider.kind);
    if (!adapter) throw new InvalidProxyGeoError(`No adapter is registered for provider kind ${provider.kind}`);
    return adapter.buildEndpoint(provider, secret, request);
  }
}

export interface ProxyCircuitState {
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  openedAt?: number;
  openUntil?: number;
}

export interface ProxyCircuitConfig {
  failureThreshold: number;
  openMs: number;
  recoverySuccesses: number;
}

export const DEFAULT_PROXY_CIRCUIT: ProxyCircuitConfig = { failureThreshold: 5, openMs: 60_000, recoverySuccesses: 2 };

export function advanceProxyCircuit(state: ProxyCircuitState, now = Date.now()): ProxyCircuitState {
  if (state.state === 'open' && Number(state.openUntil || 0) <= now) return { ...state, state: 'half-open', halfOpenSuccesses: 0 };
  return state;
}

export function recordProxyCircuitResult(
  current: ProxyCircuitState,
  success: boolean,
  now = Date.now(),
  config: ProxyCircuitConfig = DEFAULT_PROXY_CIRCUIT,
): ProxyCircuitState {
  const state = advanceProxyCircuit(current, now);
  if (success) {
    if (state.state === 'half-open') {
      const halfOpenSuccesses = state.halfOpenSuccesses + 1;
      return halfOpenSuccesses >= config.recoverySuccesses
        ? { state: 'closed', consecutiveFailures: 0, halfOpenSuccesses: 0 }
        : { ...state, halfOpenSuccesses };
    }
    return { state: 'closed', consecutiveFailures: 0, halfOpenSuccesses: 0 };
  }
  const failures = state.consecutiveFailures + 1;
  if (state.state === 'half-open' || failures >= config.failureThreshold) {
    return { state: 'open', consecutiveFailures: failures, halfOpenSuccesses: 0, openedAt: now, openUntil: now + config.openMs };
  }
  return { ...state, consecutiveFailures: failures };
}

export function proxyCircuitAllowsRequest(state: ProxyCircuitState, now = Date.now()) {
  return advanceProxyCircuit(state, now).state !== 'open';
}

export interface ProxyMetricSample {
  success: boolean;
  latencyMs?: number;
  requestBytes?: number;
  responseBytes?: number;
  browserCpuMs?: number;
  browserMemoryBytes?: number;
  databaseLatencyMs?: number;
  redisLatencyMs?: number;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

export function summarizeProxyMetrics(samples: ProxyMetricSample[]) {
  const valid = (selector: (sample: ProxyMetricSample) => number | undefined) => samples.map(selector).filter((value): value is number => Number.isFinite(value));
  const latency = valid((sample) => sample.latencyMs);
  const browserMemory = valid((sample) => sample.browserMemoryBytes);
  const databaseLatency = valid((sample) => sample.databaseLatencyMs);
  const redisLatency = valid((sample) => sample.redisLatencyMs);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    attempts: samples.length,
    successes: samples.filter((sample) => sample.success).length,
    successRate: samples.length ? samples.filter((sample) => sample.success).length / samples.length : 0,
    latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), p99: percentile(latency, 0.99) },
    payloadBytes: { request: sum(valid((sample) => sample.requestBytes)), response: sum(valid((sample) => sample.responseBytes)) },
    browser: { cpuMs: sum(valid((sample) => sample.browserCpuMs)), memoryP95Bytes: percentile(browserMemory, 0.95) },
    databaseLatencyP95Ms: percentile(databaseLatency, 0.95),
    redisLatencyP95Ms: percentile(redisLatency, 0.95),
  };
}
