import type { VerdictStrategy } from '../types.js';
import { DEFAULT_SIGNATURES, signatureMatches, type Signature, type SignatureName } from '../signatures.js';

export function cookieStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'cookies',
    enabled: true,
    vote(input) {
      for (const n of signatureNames) {
        const sig = DEFAULT_SIGNATURES[n];
        if (!sig) continue;
        const onlyCookies: Signature = { cookies: sig.cookies };
        const m = signatureMatches(
          { headers: {}, bodySnippet: '', setCookies: input.setCookies },
          onlyCookies,
        );
        if (m.matched) return 'challenge';
      }
      return 'allow';
    },
  };
}