import maxmind from 'geoip2-lite';
import { tzForGeo } from './cityTimezone.js';

const cache = new Map<string, string | null>();

export async function timeZoneFromIP(ip: string): Promise<string | null> {
  if (cache.has(ip)) return cache.get(ip) ?? null;
  const rec = maxmind.get(ip);
  if (!rec) {
    cache.set(ip, null);
    return null;
  }
  const country = rec.country?.iso_code ?? '';
  const subs = rec.subdivisions?.[0]?.iso_code ?? '';
  const city = (rec.city?.names as Record<string, string> | undefined)?.en ?? '';
  const tz = tzForGeo({ country, state: subs, city }) ?? null;
  cache.set(ip, tz);
  return tz;
}

export function resetTzCache(): void {
  cache.clear();
}
