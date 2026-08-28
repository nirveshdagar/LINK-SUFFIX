import { describe, it, expect } from 'vitest';
import { loadProfile, listProfiles } from './loader.js';

describe('profiles', () => {
  it('lists the expanded desktop and mobile profile pool', () => {
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(20);
    expect(profiles.some((profile) => profile.touch)).toBe(true);
    expect(profiles.some((profile) => !profile.touch)).toBe(true);
  });
  it('loads iphone-15-safari', () => {
    const p = loadProfile('iphone-15-safari');
    expect(p.viewport.h).toBe(844);
    expect(p.touch).toBe(true);
  });
  it('throws on unknown id', () => {
    expect(() => loadProfile('nonexistent')).toThrow(/unknown profile/);
  });
});

describe('profiles with templateIds', () => {
  it('iphone-15-safari profile has templateIds array', () => {
    const p = loadProfile('iphone-15-safari');
    expect(Array.isArray(p.templateIds)).toBe(true);
    expect(p.templateIds.length).toBeGreaterThanOrEqual(5);
  });
  it('every profile has at least one templateId', () => {
    for (const p of listProfiles()) {
      expect(p.templateIds.length).toBeGreaterThan(0);
    }
  });
  it('loadProfile throws for unknown id with template ids intact', () => {
    expect(() => loadProfile('nonexistent')).toThrow(/unknown profile/);
  });
});
