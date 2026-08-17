declare module 'geoip2-lite' {
  interface GeoRecord {
    country?: { iso_code?: string };
    subdivisions?: Array<{ iso_code?: string }>;
    city?: { names?: Record<string, string> };
  }
  function get(ip: string): GeoRecord | null;
  export default { get };
}
