import type { VerdictStrategy } from '../types.js';
import { DEFAULT_SIGNATURES, signatureMatches, type SignatureName } from '../signatures.js';

export function headerSignalsStrategy(signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'header_signals',
    enabled: true,
    vote(input) {
      const headersOnly = signatureNames.map((n) => ({ ...(DEFAULT_SIGNATURES[n] ?? {}), cookies: undefined, body: undefined }));
      for (const sig of headersOnly) {
        const m = signatureMatches(
          { headers: input.responseHeaders, bodySnippet: '', setCookies: [] },
          sig,
        );
        if (m.matched) return 'challenge';
      }
      return 'allow';
    },
  };
}