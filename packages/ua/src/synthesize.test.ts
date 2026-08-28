import { describe, it, expect } from 'vitest';
import { synthesizeUA } from './synthesize.js';
import { TEMPLATES } from './templates.js';
import type { UaTemplate } from './types.js';

const sampleIphone = TEMPLATES.find((t) => t.id === 'iphone-15-safari')!;
const sampleChrome = TEMPLATES.find((t) => t.id === 'windows-chrome-124')!;

describe('synthesizeUA', () => {
  it('replaces __BUILD__ with formatted ${major}_${minor}', () => {
    const out = synthesizeUA(sampleIphone, { build: '17_5' });
    expect(out.ua).toContain('CPU iPhone OS 17_5 like');
    expect(out.ua).not.toContain('__BUILD__');
    expect(out.build).toBe('17_5');
  });
  it('generates a valid four-part Chrome version within the template range', () => {
    const out = synthesizeUA(sampleChrome);
    const [maj, branch, build, patch] = out.build.split('.').map(Number);
    expect(maj).toBe(124);
    expect(branch).toBe(0);
    expect(build).toBeGreaterThanOrEqual(sampleChrome.buildRange.minMinor);
    expect(build).toBeLessThanOrEqual(sampleChrome.buildRange.maxMinor);
    expect(patch).toBeGreaterThanOrEqual(40);
    expect(patch).toBeLessThanOrEqual(199);
  });
  it('produces fingerprint fields within template ranges', () => {
    const out = synthesizeUA(sampleIphone);
    expect(out.fingerprint.viewport.w).toBe(sampleIphone.viewport.w);
    expect(out.fingerprint.hardware.cores).toBeGreaterThanOrEqual(sampleIphone.hardware.cores[0]);
    expect(out.fingerprint.hardware.cores).toBeLessThanOrEqual(sampleIphone.hardware.cores[1]);
    expect(out.fingerprint.webgl.vendor).toMatch(/^Apple/);
    expect(out.fingerprint.locale).toBe(sampleIphone.locale);
    expect(out.fingerprint.languages).toEqual(sampleIphone.languages);
  });
  it('uses timezone override when provided', () => {
    const out = synthesizeUA(sampleChrome, { timezone: 'Asia/Kolkata' });
    expect(out.fingerprint.timezone).toBe('Asia/Kolkata');
  });
  it('defaults timezone to UTC when not provided', () => {
    const out = synthesizeUA(sampleChrome);
    expect(out.fingerprint.timezone).toBe('UTC');
  });
  it('UA contains correct OS marker for iphone', () => {
    const out = synthesizeUA(sampleIphone, { build: '17_4' });
    expect(out.ua).toMatch(/iPhone; CPU iPhone OS 17_4/);
    expect(out.ua).toContain('Safari/');
  });
  it('UA contains correct OS marker for windows', () => {
    const out = synthesizeUA(sampleChrome, { build: '124' });
    expect(out.ua).toMatch(/Windows NT 10\.0; Win64; x64/);
    expect(out.ua).toContain('Chrome/124.');
  });
});
