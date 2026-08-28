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
  const creds = { user: 'iproyal1365', pass: 'FuuyV5rj' };

  it('builds a rotating endpoint with geo in the password', () => {
    const ep = buildProxyEndpoint({ country: 'US' }, 'rotating-residential', creds);
    expect(ep.url.username).toBe('iproyal1365');
    expect(ep.url.password).toBe('FuuyV5rj_country-us');
    expect(ep.url.pathname).toBe('/');
    expect(ep.mode).toBe('rotating-residential');
  });

  it('builds a sticky endpoint with state, city, and session in the password', () => {
    const ep = buildProxyEndpoint(
      { country: 'US', state: 'CA', city: 'LosAngeles' },
      'sticky-residential',
      creds,
      'sess0001'
    );
    expect(ep.url.password).toBe('FuuyV5rj_country-us_state-california_city-losangeles_session-sess0001_lifetime-1h');
    expect(ep.sessionId).toBe('sess0001');
  });

  it('normalizes spaces in state and city', () => {
    const ep = buildProxyEndpoint(
      { country: 'US', state: 'New York', city: 'New York' },
      'sticky-residential',
      creds,
      'newyork1',
    );
    expect(ep.url.password).toContain('_state-new-york');
    expect(ep.url.password).toContain('_city-new-york');
  });

  it('throws on invalid account username', () => {
    expect(() =>
      buildProxyEndpoint({ country: 'US' }, 'rotating-residential', { user: 'bad user', pass: 'x' })
    ).toThrow(InvalidProxyGeoError);
  });

  it('rejects sticky session IDs that are not exactly eight characters', () => {
    expect(() =>
      buildProxyEndpoint({ country: 'US' }, 'sticky-residential', creds, 'short')
    ).toThrow(/exactly 8/);
  });

  it('replaces routing suffixes from a formatted password instead of duplicating them', () => {
    const ep = buildProxyEndpoint(
      { country: 'DE', city: 'Berlin' },
      'rotating-residential',
      { user: 'iproyal1365', pass: 'FuuyV5rj_country-us_city-new-york' },
    );
    expect(ep.url.password).toBe('FuuyV5rj_country-de_city-berlin');
  });
});
