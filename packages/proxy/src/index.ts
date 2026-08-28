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

  const url = new URL(`http://${HOSTNAMES[mode]}:${PROXY_PORT}`);
  url.username = creds.user;
  url.password = password;
  return { url, mode, sessionId };
}
