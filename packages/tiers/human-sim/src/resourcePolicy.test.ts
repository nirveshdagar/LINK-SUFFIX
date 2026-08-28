import { describe, expect, it } from 'vitest';

import {
  findExactSuffixUrl,
  resourcePolicyFromEnvironment,
  shouldAbortResource,
  shouldCaptureResponseBody,
} from './resourcePolicy.js';

describe('human journey resource policy', () => {
  it('blocks heavy subresources while preserving navigations and scripts', () => {
    const policy = resourcePolicyFromEnvironment({});
    expect(shouldAbortResource(policy, 'image', false)).toBe(true);
    expect(shouldAbortResource(policy, 'media', false)).toBe(true);
    expect(shouldAbortResource(policy, 'font', false)).toBe(true);
    expect(shouldAbortResource(policy, 'document', true)).toBe(false);
    expect(shouldAbortResource(policy, 'script', false)).toBe(false);
  });

  it('captures bodies only for bounded decision-relevant response types', () => {
    const policy = resourcePolicyFromEnvironment({});
    expect(policy.maxResponseBodyBytes).toBe(262_144);
    expect(shouldCaptureResponseBody(policy, 'document')).toBe(true);
    expect(shouldCaptureResponseBody(policy, 'xhr')).toBe(true);
    expect(shouldCaptureResponseBody(policy, 'image')).toBe(false);
  });

  it('returns the original encoded landing URL without normalization', () => {
    const exact = 'https://example.test/path?b=2&a=%2F&a=three%20words#fragment';
    expect(findExactSuffixUrl(['about:blank', exact])).toBe(exact);
    expect(findExactSuffixUrl(['https://example.test/path?', 'not a url'])).toBeUndefined();
  });
});
