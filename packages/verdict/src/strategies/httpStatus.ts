import type { VerdictStrategy } from '../types.js';

export const httpStatusStrategy: VerdictStrategy = {
  name: 'http_status',
  enabled: true,
  vote(input) {
    if ([403, 503, 502].includes(input.status)) return 'block';
    // A headers-only capture has no body snippet. Absence of body evidence
    // is not evidence of a block; challenge/status guards decide separately.
    return 'allow';
  },
};
