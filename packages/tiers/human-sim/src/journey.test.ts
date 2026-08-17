import { describe, it, expect } from 'vitest';
import { pickNextUrl } from './journey.js';

describe('pickNextUrl', () => {
  it('avoids revisiting when links have counts', () => {
    const a = new URL('https://e.test/a');
    const b = new URL('https://e.test/b');
    const counts = new Map<string, number>([[a.toString(), 1]]);
    for (let i = 0; i < 100; i++) {
      const chosen = pickNextUrl([a, b], counts);
      expect(chosen!.toString()).toBe(b.toString());
    }
  });

  it('returns null on empty link list', () => {
    expect(pickNextUrl([], new Map())).toBeNull();
  });

  it('returns the only link when given a single candidate', () => {
    const a = new URL('https://e.test/a');
    expect(pickNextUrl([a], new Map())?.toString()).toBe(a.toString());
  });

  it('prefers unseen links on first draw', () => {
    const a = new URL('https://e.test/a');
    const b = new URL('https://e.test/b');
    // both have count 0 -> equal weight; on first draw either is allowed.
    // The contract is "no bias toward visited", so we just assert the result is in the set.
    const chosen = pickNextUrl([a, b], new Map());
    expect([a.toString(), b.toString()]).toContain(chosen!.toString());
  });
});
