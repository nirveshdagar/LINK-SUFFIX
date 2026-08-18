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

export function buildProxyEndpoint(
  geo: GeoTarget,
  mode: ProxyMode,
  creds: { user: string; pass: string },
  sessionId?: string,
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

  const pathParts: string[] = [];
  if (geo.country) {
    pathParts.push(`country-${geo.country.toUpperCase()}`);
    if (geo.state) pathParts.push(`state-${encodeURIComponent(geo.state.replace(/\s+/g, '-'))}`);
    if (geo.city) pathParts.push(`city-${encodeURIComponent(geo.city.replace(/\s+/g, '-'))}`);
  }
  if (sessionId) pathParts.push(`session-${encodeURIComponent(sessionId)}`);

  const geoPath = pathParts.length > 0 ? `/${pathParts.join('/')}` : '';
  const url = new URL(`http://${HOSTNAMES[mode]}:${PROXY_PORT}${geoPath}`);
  url.username = creds.user;
  url.password = creds.pass;
  return { url, mode, sessionId };
}