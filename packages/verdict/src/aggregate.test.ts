import { describe, it, expect } from 'vitest';
import { aggregateVerdict } from './aggregate.js';
import type { VerdictInput } from './types.js';

const base: VerdictInput = {
  url: 'https://example.test/',
  status: 200,
  responseHeaders: {},
  responseBodySnippet: '',
  setCookies: [],
};

describe('aggregateVerdict', () => {
  it('returns allow when nothing fires', () => {
    expect(aggregateVerdict(base, ['http_status', 'cookies']).final).toBe('allow');
  });
  it('precedence: block > challenge', () => {
    const v = aggregateVerdict({ ...base, status: 403 }, ['http_status', 'challenge_html']);
    expect(v.final).toBe('block');
  });
  it('surfaces per-strategy votes', () => {
    const v = aggregateVerdict({ ...base, status: 403 }, ['http_status', 'cookies']);
    expect(v.byStrategy['http_status']).toBe('block');
    expect(v.byStrategy['cookies']).toBe('allow');
  });
  it('treats missing strategy as abstain', () => {
    const v = aggregateVerdict(base, []);
    expect(v.final).toBe('allow');
  });
});