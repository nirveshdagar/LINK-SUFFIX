// Curated fingerprint profiles inspired by antidetect browser defaults
// (Multilogin, GoLogin, AdsPower). We do NOT call any vendor API; these
// profiles are entirely self-contained and can be picked by tier.

export interface CuratedFingerprint {
  id: string;
  family: 'mimic-multilogin' | 'mimic-gologin' | 'mimic-adspower';
  ua: string;
  viewport: { w: number; h: number };
  locale: string;
  hardware: { cores: number; memoryGb: number };
  webglVendor: string;
  webglRenderer: string;
}

export const CURATED_FINGERPRINTS: readonly CuratedFingerprint[] = [
  {
    id: 'multilogin-mimic-1',
    family: 'mimic-multilogin',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { w: 1920, h: 1080 },
    locale: 'en-US',
    hardware: { cores: 16, memoryGb: 32 },
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
  },
  {
    id: 'gologin-mimic-1',
    family: 'mimic-gologin',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    viewport: { w: 1440, h: 900 },
    locale: 'en-US',
    hardware: { cores: 10, memoryGb: 16 },
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple M2 Pro',
  },
  {
    id: 'adspower-mimic-1',
    family: 'mimic-adspower',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { w: 1680, h: 1050 },
    locale: 'en-GB',
    hardware: { cores: 8, memoryGb: 16 },
    webglVendor: 'Mesa',
    webglRenderer: 'Mesa DRI Intel(R) HD Graphics',
  },
];

export function pickFingerprint(family: CuratedFingerprint['family']): CuratedFingerprint {
  const matches = CURATED_FINGERPRINTS.filter((f) => f.family === family);
  if (matches.length === 0) {
    return CURATED_FINGERPRINTS[0]!;
  }
  return matches[Math.floor(Math.random() * matches.length)]!;
}
