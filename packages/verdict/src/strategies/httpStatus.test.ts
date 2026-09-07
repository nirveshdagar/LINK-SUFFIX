import { describe, expect, it } from 'vitest';
import { httpStatusStrategy } from './httpStatus.js';

const input = {
  url: 'https://destination.example/?im_ref=fixture&sharedid=',
  status: 200,
  responseHeaders: {},
  responseBodySnippet: '',
  setCookies: [],
};

describe('headers-only capture status classification', () => {
  it('does not invent a block when an HTTP 200 body was not collected', () => {
    expect(httpStatusStrategy.vote(input)).toBe('allow');
  });
  it.each([403, 502, 503])('preserves an explicit HTTP %s failure', status => {
    expect(httpStatusStrategy.vote({ ...input, status })).toBe('block');
  });
});
