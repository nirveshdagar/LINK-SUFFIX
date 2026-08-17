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

export class InvalidProxyGeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProxyGeoError';
  }
}

function buildUsername(geo: GeoTarget, sessionId?: string): string {
  const parts = [`user-country-${geo.country.toUpperCase()}`];
  if (geo.state) parts.push(`state-${geo.state.replace(/\s+/g, '-')}`);
  if (geo.city) parts.push(`city-${geo.city.replace(/\s+/g, '-')}`);
  if (sessionId) parts.push(`sessionid-${sessionId}`);
  const u = parts.join('-');
  if (!IPROYAL_USERNAME_REGEX.test(u)) {
    throw new InvalidProxyGeoError(`Constructed IP Royal username does not match grammar: ${u}`);
  }
  return u;
}

/**
 * Build an IP Royal proxy endpoint URL for the given geo target.
 *
 * @param creds  Proxy credentials. `creds.user` is reserved for future use
 *               (e.g. per-user routing) and currently unused — only
 *               `creds.pass` is wired into the URL.
 */
export function buildProxyEndpoint(
  geo: GeoTarget,
  mode: ProxyMode,
  creds: { user: string; pass: string },
  sessionId?: string,
): ProxyEndpoint {
  const username = buildUsername(geo, sessionId);
  const url = new URL(`http://${HOSTNAMES[mode]}:${PROXY_PORT}`);
  url.username = username;
  url.password = creds.pass;
  return { url, mode, sessionId };
}