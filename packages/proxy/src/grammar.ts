// IP Royal auth: just your account username + password. Geo targeting is
// configured per-session inside the proxy URL path via IP Royal's session
// router (e.g. /country-US-state-CA-city-LosAngeles/), or via the account
// dashboard. The username is the literal account name.
export const IPROYAL_USERNAME_REGEX = /^[A-Za-z0-9_-]+$/;

export interface Hostnames {
  'rotating-residential': string;
  'sticky-residential': string;
}

const DEFAULT_IPROYAL_HOSTNAME = 'geo.iproyal.com';

export const HOSTNAMES: Hostnames = {
  'rotating-residential': process.env.IPROYAL_HOSTNAME ?? DEFAULT_IPROYAL_HOSTNAME,
  'sticky-residential': process.env.IPROYAL_HOSTNAME ?? DEFAULT_IPROYAL_HOSTNAME,
};

export const PROXY_PORT = 51230;