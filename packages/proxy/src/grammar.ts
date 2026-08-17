export const IPROYAL_USERNAME_REGEX =
  /^user-country-[A-Z]{2}(-state-[A-Za-z]+)?(-city-[A-Za-z -]+)?(-sessionid-[A-Za-z0-9]+)?$/;

export interface Hostnames {
  'rotating-residential': string;
  'sticky-residential': string;
}

const DEFAULT_IPROYAL_HOSTNAME = 'geo.iproyal.com';

export const HOSTNAMES: Hostnames = {
  'rotating-residential': process.env.IPROYAL_HOSTNAME ?? DEFAULT_IPROYAL_HOSTNAME,
  'sticky-residential': process.env.IPROYAL_HOSTNAME ?? DEFAULT_IPROYAL_HOSTNAME,
};

export const PROXY_PORT = 12321;