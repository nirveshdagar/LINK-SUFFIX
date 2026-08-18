import { describe, it, expect } from 'vitest';
import {
  buildProxyEndpoint,
  InvalidProxyGeoError,
  IPROYAL_USERNAME_REGEX,
} from './index.js';

describe('IPROYAL_USERNAME_REGEX', () => {
  it('accepts plain alphanumeric account names', () => {
    expect(IPROYAL_USERNAME_REGEX.test('iproyal1365')).toBe(true);
    expect(IPROYAL_USERNAME_REGEX.test('user_name-1')).toBe(true);
  });

  it('rejects empty or invalid usernames', () => {
    expect(IPROYAL_USERNAME_REGEX.test('')).toBe(false);
    expect(IPROYAL_USERNAME_REGEX.test('bad user')).toBe(false);
    expect(IPROYAL_USERNAME_REGEX.test('user@host')).toBe(false);
  });
});

describe('buildProxyEndpoint', () => {
  const creds = { user: 'iproyal1365', pass: 'FuuyV5rj_country-us' };

  it('builds a rotating endpoint with geo in path', () => {
    const ep = buildProxyEndpoint({ country: 'US' }, 'rotating-residential', creds);
    expect(ep.url.username).toBe('iproyal1365');
    expect(ep.url.password).toBe('FuuyV5rj_country-us');
    expect(ep.url.pathname).toBe('/country-US');
    expect(ep.mode).toBe('rotating-residential');
  });

  it('builds a sticky endpoint with state+city+session in path', () => {
    const ep = buildProxyEndpoint(
      { country: 'US', state: 'CA', city: 'LosAngeles' },
      'sticky-residential',
      creds,
      'sess1'
    );
    expect(ep.url.pathname).toBe('/country-US/state-CA/city-LosAngeles/session-sess1');
    expect(ep.sessionId).toBe('sess1');
  });

  it('URL-encodes spaces in state and city', () => {
    const ep = buildProxyEndpoint(
      { country: 'US', state: 'New York', city: 'New York' },
      'sticky-residential',
      creds,
    );
    expect(ep.url.pathname).toContain('state-New-York');
    expect(ep.url.pathname).toContain('city-New-York');
  });

  it('throws on invalid account username', () => {
    expect(() =>
      buildProxyEndpoint({ country: 'US' }, 'rotating-residential', { user: 'bad user', pass: 'x' })
    ).toThrow(InvalidProxyGeoError);
  });
});
