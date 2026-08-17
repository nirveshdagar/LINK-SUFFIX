import type { VerdictStrategy } from '../types.js';

export const httpStatusStrategy: VerdictStrategy = {
  name: 'http_status',
  enabled: true,
  vote(input) {
    if ([403, 503, 502].includes(input.status)) return 'block';
    if (input.status === 200 && input.responseBodySnippet.trim().length === 0) return 'block';
    return 'allow';
  },
};