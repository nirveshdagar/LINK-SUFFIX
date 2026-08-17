import type { VerdictStrategy } from '../types.js';

export const timingStrategy: VerdictStrategy = {
  name: 'timing',
  enabled: true,
  vote() {
    // Sub-100ms responses are *signals* not verdicts — never vote allow/block/challenge.
    return null;
  },
};