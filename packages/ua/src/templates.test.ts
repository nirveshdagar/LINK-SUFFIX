import { describe, it, expect } from 'vitest';
import { TEMPLATES } from './templates.js';

describe('TEMPLATES', () => {
  it('has 25 entries', () => {
    expect(TEMPLATES.length).toBe(25);
  });
  it('every uaPattern contains __BUILD__ placeholder', () => {
    for (const t of TEMPLATES) {
      expect(t.uaPattern).toContain('__BUILD__');
    }
  });
  it('every template has unique id', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('buildRange is valid (min <= max for both major and minor)', () => {
    for (const t of TEMPLATES) {
      expect(t.buildRange.minMajor).toBeLessThanOrEqual(t.buildRange.maxMajor);
      expect(t.buildRange.minMinor).toBeLessThanOrEqual(t.buildRange.maxMinor);
    }
  });
  it('every template has at least one webgl vendor and renderer', () => {
    for (const t of TEMPLATES) {
      expect(t.webgl.vendors.length).toBeGreaterThan(0);
      expect(t.webgl.renderers.length).toBeGreaterThan(0);
    }
  });
  it('iphone templates use Apple WebGL family', () => {
    const iphones = TEMPLATES.filter((t) => t.family === 'iphone');
    expect(iphones.length).toBeGreaterThanOrEqual(5);
    for (const t of iphones) {
      expect(t.webgl.vendors).toContain('Apple Inc.');
    }
  });
  it('android templates have touch: true viewport shape', () => {
    const androids = TEMPLATES.filter((t) => t.family === 'android');
    expect(androids.length).toBeGreaterThanOrEqual(5);
    for (const t of androids) {
      // Android phones have small portrait viewports
      expect(t.viewport.w).toBeLessThan(500);
      expect(t.viewport.h).toBeGreaterThan(t.viewport.w);
    }
  });
});