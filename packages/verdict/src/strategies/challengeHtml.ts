import type { VerdictStrategy } from '../types.js';
import type { SignatureName } from '../signatures.js';
import { activeBodyChallenge } from '../challengeEvidence.js';

export function challengeHtmlStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'challenge_html',
    enabled: true,
    vote(input) {
      return activeBodyChallenge(input.responseBodySnippet, signatureNames) ? 'challenge' : 'allow';
    },
  };
}
