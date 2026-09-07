import type { VerdictStrategy } from '../types.js';
import type { SignatureName } from '../signatures.js';
import { activeHeaderChallenge } from '../challengeEvidence.js';

export function headerSignalsStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'header_signals',
    enabled: true,
    vote(input) {
      return activeHeaderChallenge(input.responseHeaders, signatureNames) ? 'challenge' : 'allow';
    },
  };
}
