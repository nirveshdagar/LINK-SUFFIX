import { isProxyTransportFailure } from '@tah/proxy';
export function classifyAttemptOutcome(succeeded: boolean, reason: string, cancelled = false) {
  if (cancelled) return { healthy: false, reason: 'cancelled', failureDomain: 'cancelled' as const };
  if (succeeded) return { healthy: true, failureDomain: undefined };
  if (reason.startsWith('Target rejected capture:')) return { healthy: false, reason, failureDomain: 'target' as const };
  // Reporting a proxy error never authorizes another journey.
  const proxyFailure = isProxyTransportFailure(reason) || /\bERR_PROXY_CONNECTION_FAILED\b/.test(reason);
  return { healthy: false, reason: reason || 'Journey failed without a transport diagnosis', failureDomain: proxyFailure ? 'proxy' as const : 'unknown' as const };
}
