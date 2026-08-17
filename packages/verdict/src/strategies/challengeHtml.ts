import type { VerdictStrategy } from '../types.js';
import { DEFAULT_SIGNATURES, signatureMatches, type SignatureName } from '../signatures.js';

export function challengeHtmlStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'challenge_html',
    enabled: true,
    vote(input) {
      for (const n of signatureNames) {
        const sig = DEFAULT_SIGNATURES[n] ?? {};
        const m = signatureMatches(
          { headers: input.responseHeaders, bodySnippet: input.responseBodySnippet, setCookies: input.setCookies },
          sig,
        );
        if (m.matched) return 'challenge';
      }
      return 'allow';
    },
  };
}