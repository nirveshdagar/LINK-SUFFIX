import { describe, it, expect } from 'vitest';
import { pickFingerprint } from './customFingerprint.js';

describe('pickFingerprint', () => {
  it('returns a fingerprint for each family', () => {
    expect(pickFingerprint('mimic-multilogin').family).toBe('mimic-multilogin');
    expect(pickFingerprint('mimic-gologin').family).toBe('mimic-gologin');
    expect(pickFingerprint('mimic-adspower').family).toBe('mimic-adspower');
  });
  it('falls back to a known family for unknown input', () => {
    // @ts-expect-error: intentionally bad input
    const fp = pickFingerprint('unknown');
    expect(fp.family).toBeTruthy();
  });
});
