import { describe, it, expect, beforeEach, vi } from 'vitest';
import { timeZoneFromIP, resetTzCache } from './egressTimezone.js';

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(async (url: string) => {
    const timezone = url.includes('203.0.113.42')
      ? 'Asia/Kolkata'
      : url.includes('198.51.100.5')
        ? 'America/New_York'
        : undefined;
    return {
      statusCode: 200,
      body: {
        json: async () => ({ timezone }),
        dump: async () => undefined,
      },
    };
  }),
}));

vi.mock('undici', () => ({
  request: requestMock,
  ProxyAgent: class {
    close = async () => undefined;
  },
}));

describe('timeZoneFromIP', () => {
  beforeEach(() => resetTzCache());

  it('returns Asia/Kolkata for Mumbai IP', async () => {
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
    requestMock.mockClear();
    const t1 = await timeZoneFromIP('203.0.113.42');
    const t2 = await timeZoneFromIP('203.0.113.42');
    expect(t1).toBe(t2);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
