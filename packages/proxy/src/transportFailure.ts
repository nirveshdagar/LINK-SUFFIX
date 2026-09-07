export type ProxyTransportCode = 'connection_refused' | 'connection_reset' | 'network_unreachable' | 'connect_timeout' | 'node_unavailable';
const PREFIX = 'Proxy transport failure: ';
export class ProxyTransportError extends Error {
  constructor(readonly transportCode: ProxyTransportCode) {
    super(PREFIX + transportCode);
    this.name = 'ProxyTransportError';
  }
}
// HTTP policy/authentication responses are not transport outages.
export class ProxyResponseError extends Error {
  constructor(readonly status: number, readonly retryAfter = '', readonly rayId = '') {
    super('Upstream proxy returned HTTP ' + status);
    this.name = 'ProxyResponseError';
  }
}
export function isProxyTransportFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return /^Proxy transport failure: (?:connection_refused|connection_reset|network_unreachable|connect_timeout|node_unavailable)$/.test(message);
}
// Call only inside the upstream connection/CONNECT boundary, never around an
// application request, database operation, TLS validation or page evaluation.
export function classifyProxyConnectError(error: unknown): ProxyTransportError | undefined {
  if (error instanceof ProxyTransportError) return error;
  if (!(error instanceof Error) || error instanceof ProxyResponseError) return undefined;
  const code = String((error as Error & { code?: string }).code ?? '');
  if (code === 'ECONNREFUSED') return new ProxyTransportError('connection_refused');
  if (code === 'ECONNRESET' || code === 'EPIPE') return new ProxyTransportError('connection_reset');
  if (['ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return new ProxyTransportError('network_unreachable');
  if (code === 'ETIMEDOUT' || error.message === 'Operation deadline exceeded') return new ProxyTransportError('connect_timeout');
  if (error.message === 'Proxy closed during handshake') return new ProxyTransportError('node_unavailable');
  return undefined;
}
