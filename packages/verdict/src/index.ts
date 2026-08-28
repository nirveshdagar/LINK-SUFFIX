export * from './types.js';
export * from './aggregate.js';
export { DEFAULT_SIGNATURES, signatureMatches, type SignatureName } from './signatures.js';
import { httpStatusStrategy } from './strategies/httpStatus.js';
import { challengeHtmlStrategy } from './strategies/challengeHtml.js';
import { headerSignalsStrategy } from './strategies/headerSignals.js';
import { cookieStrategy } from './strategies/cookies.js';
import { timingStrategy } from './strategies/timing.js';

import type { SignatureName } from './signatures.js';
import type { VerdictStrategy } from './types.js';

export function defaultStrategies(signatureNames: SignatureName[] = [
  'cloudflare', 'hcaptcha', 'datadome', 'perimeterx', 'akamai', 'kasada', 'shape', 'fingerprintjs', 'generic',
]): VerdictStrategy[] {
  return [
    httpStatusStrategy,
    challengeHtmlStrategy(signatureNames),
    headerSignalsStrategy(signatureNames),
    cookieStrategy(signatureNames),
    timingStrategy,
  ];
}
