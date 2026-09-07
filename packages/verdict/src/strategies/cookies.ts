import type { VerdictStrategy } from '../types.js';
import type { SignatureName } from '../signatures.js';

export function cookieStrategy(_signatureNames: SignatureName[]): VerdictStrategy {
  return {
    name: 'cookies',
    enabled: true,
    vote() {
      // Security cookies can accompany a successful page or completed check.
      // Keep vendor identification in telemetry; never veto a capture solely
      // because a response sets a cookie.
      return null;
    },
  };
}
