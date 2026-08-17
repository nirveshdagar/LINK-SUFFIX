import { describe, it, expect } from 'vitest';
import { loadProfile, listProfiles } from './loader.js';

describe('profiles', () => {
  it('lists 5 default profiles', () => {
    expect(listProfiles()).toHaveLength(5);
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