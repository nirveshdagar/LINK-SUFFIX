import { describe, it, expect, beforeEach, vi } from 'vitest';
import { timeZoneFromIP, resetTzCache } from './egressTimezone.js';

// We mock the entire geoip2-lite module because we don't ship a real .mmdb.
vi.mock('geoip2-lite', () => ({
  default: {
    get: (ip: string) => {
      if (ip === '203.0.113.42') {
        return {
          country: { iso_code: 'IN' },
          subdivisions: [{ iso_code: 'Maharashtra' }],
          city: { names: { en: 'Mumbai' } },
        };
      }
      if (ip === '198.51.100.5') {
        return {
          country: { iso_code: 'US' },
          subdivisions: [{ iso_code: 'NY' }],
          city: { names: { en: 'New York' } },
        };
      }
      return null;
    },
  },
}));

describe('timeZoneFromIP', () => {
  beforeEach(() => resetTzCache());

  it('returns Asia/Kolkata for Mumbai IP', async () => {
    const buf = Buffer.from('');
    const tz = await timeZoneFromIP('203.0.113.42');
    expect(tz).toBe('Asia/Kolkata');
  });

  it('returns America/New_York for NY IP', async () => {
    const tz = await timeZoneFromIP('198.51.100.5');
    expect(tz).toBe('America/New_York');
  });

  it('returns null when ip has no record', async () => {
    const tz = await timeZoneFromIP('203.0.113.99');
    expect(tz).toBeNull();
  });

  it('caches result per IP within session', async () => {
    // First call caches, second call uses cache (no mock call)
    const t1 = await timeZoneFromIP('203.0.113.42');
    const t2 = await timeZoneFromIP('203.0.113.42');
    expect(t1).toBe(t2);
  });
});
