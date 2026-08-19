import { describe, it, expect } from 'vitest';
import { readJa3Records } from './launcher.js';

describe('readJa3Records', () => {
  it('returns empty array for missing file', () => {
    expect(readJa3Records('/nonexistent/path.jsonl')).toEqual([]);
  });
});