import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
// undici's Connector type: (options, cb) => socket, where cb is (err, socket).
// We hand-roll the type to avoid importing from a non-types entry point.
export type Connector = (options: any, cb: (err: Error | null, socket: any) => void) => any;

export interface TlsFingerprint {
  tls_version?: string;
  cipher?: string;
  alpn?: string;
  server_cert_subject?: string;
  server_cert_issuer?: string;
}

// Minimal undici-compatible connector that captures TLS handshake details.
// The returned function follows undici's `connector` signature:
//   (options, cb) => socket   — we wrap tls.connect so we can read state on
// secureConnect.
export function makeJa3Connector(
  sink: { capture: (fp: TlsFingerprint) => void },
  tlsOptions: { ca?: Buffer | string } = {},
): Connector {
  return (options: any, cb: any) => {
    const opts = { ...options, ca: tlsOptions.ca ?? options.ca } as ConnectionOptions;
    const socket = tlsConnect(opts);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate() as any;
      const fp: TlsFingerprint = {
        tls_version: socket.getProtocol() || undefined,
        cipher: socket.getCipher()?.name,
        alpn: socket.alpnProtocol || undefined,
        server_cert_subject: cert?.subject?.CN,
        server_cert_issuer: cert?.issuer?.CN,
      };
      sink.capture(fp);
    });
    socket.once('connect', () => cb(null, socket));
    socket.once('error', (err: Error) => cb(err, null));
    return socket as any;
  };
}
