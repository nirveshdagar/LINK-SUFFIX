import { describe, it, expect } from 'vitest';
import { CITY_TIMEZONE, tzForGeo } from './cityTimezone.js';

describe('CITY_TIMEZONE', () => {
  it('has at least 2000 entries', () => {
    expect(CITY_TIMEZONE.length).toBeGreaterThanOrEqual(2000);
  });

  it('every entry matches { key: string; tz: string }', () => {
    for (const e of CITY_TIMEZONE) {
      expect(typeof e.key).toBe('string');
      expect(typeof e.tz).toBe('string');
      expect(e.key).toMatch(/^[A-Z]{2}-[A-Za-z]+(-[A-Za-z]+)*-[A-Za-z]+$/);
      expect(e.tz).toMatch(/^[A-Z][A-Za-z]+\/[A-Za-z_\/]+$/);
    }
  });

  it('has no duplicate keys', () => {
    const keys = new Set<string>();
    for (const e of CITY_TIMEZONE) {
      expect(keys.has(e.key)).toBe(false);
      keys.add(e.key);
    }
  });
});

describe('tzForGeo', () => {
  it('looks up US city directly', () => {
    expect(tzForGeo({ country: 'US', state: 'NY', city: 'New York' })).toBe('America/New_York');
    expect(tzForGeo({ country: 'US', state: 'CA', city: 'Los Angeles' })).toBe('America/Los_Angeles');
  });

  it('looks up Indian city', () => {
    expect(tzForGeo({ country: 'IN', state: 'Maharashtra', city: 'Mumbai' })).toBe('Asia/Kolkata');
    expect(tzForGeo({ country: 'IN', state: 'Delhi', city: 'New Delhi' })).toBe('Asia/Kolkata');
  });

  it('strips spaces in city names', () => {
    expect(tzForGeo({ country: 'US', state: 'TX', city: 'San Antonio' })).toBe('America/Chicago');
    expect(tzForGeo({ country: 'US', state: 'CA', city: 'San Diego' })).toBe('America/Los_Angeles');
  });

  it('returns undefined for unknown city', () => {
    expect(tzForGeo({ country: 'US', state: 'XX', city: 'NowhereVille' })).toBeUndefined();
    expect(tzForGeo({ country: 'ZZ', state: 'Foo', city: 'Bar' })).toBeUndefined();
  });
});