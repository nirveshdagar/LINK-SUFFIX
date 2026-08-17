import { describe, it, expect } from 'vitest';
import {
  buildProxyEndpoint,
  InvalidProxyGeoError,
  IPROYAL_USERNAME_REGEX,
} from './index.js';

describe('IPROYAL_USERNAME_REGEX', () => {
  it('accepts country-only', () => {
    expect(IPROYAL_USERNAME_REGEX.test('user-country-US')).toBe(true);
  });
  it('accepts country+state+city', () => {
    expect(IPROYAL_USERNAME_REGEX.test('user-country-IN-state-Maharashtra-city-Mumbai')).toBe(true);
  });
  it('accepts with sessionid', () => {
    expect(IPROYAL_USERNAME_REGEX.test('user-country-IN-state-MH-city-Mumbai-sessionid-abc123')).toBe(true);
  });
  it('rejects lowercase country', () => {
    expect(IPROYAL_USERNAME_REGEX.test('user-country-us')).toBe(false);
  });
});

describe('buildProxyEndpoint', () => {
  const creds = { user: 'alice', pass: 'secret' };

  it('builds a rotating endpoint', () => {
    const ep = buildProxyEndpoint({ country: 'US' }, 'rotating-residential', creds);
    expect(ep.url.username).toBe('user-country-US');
    expect(ep.url.password).toBe('secret');
    expect(ep.mode).toBe('rotating-residential');
  });

  it('builds a sticky endpoint with session id', () => {
    const ep = buildProxyEndpoint(
      { country: 'IN', state: 'Maharashtra', city: 'Mumbai' },
      'sticky-residential',
      creds,
      'sess1'
    );
    expect(ep.url.username).toBe('user-country-IN-state-Maharashtra-city-Mumbai-sessionid-sess1');
    expect(ep.sessionId).toBe('sess1');
  });

  it('throws InvalidProxyGeoError on bad country code', () => {
    expect(() =>
      buildProxyEndpoint({ country: 'usa' }, 'rotating-residential', creds),
    ).toThrow(InvalidProxyGeoError);
  });

  it('state code is taken verbatim (no expansion, no codename table)', () => {
    // Locked-in contract: callers pass the human-readable state name verbatim.
    // Two-letter codes like 'MH' are valid input — they're just used as-is in the username
    // (spaces→dashes, no ISO expansion, no codename mapping).
    const ep = buildProxyEndpoint(
      { country: 'IN', state: 'MH', city: 'Mumbai' },
      'sticky-residential',
      creds,
      'sess1'
    );
    expect(ep.url.username).toBe('user-country-IN-state-MH-city-Mumbai-sessionid-sess1');
  });

  it('throws on hyphenated sessionid (regex contract is alphanumeric only)', () => {
    // Locked-in contract: IPROYAL_USERNAME_REGEX requires sessionid to match [A-Za-z0-9]+.
    // Hyphens (e.g. 'sess-1') are rejected — callers must strip/sanitize sessionids
    // before passing them in. Do NOT relax the regex to accept hyphens.
    expect(() =>
      buildProxyEndpoint(
        { country: 'US' },
        'sticky-residential',
        creds,
        'sess-1' // hyphen in sessionid
      )
    ).toThrow(InvalidProxyGeoError);
  });
});