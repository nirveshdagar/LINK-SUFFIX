# mitmproxy addon: capture JA3 / JA4 / TLS ClientHello per request.
# Writes one JSONL line per request to TAH_JA3_RECORDER env var path.

import json
import os
import sys

RECORDER_PATH = os.environ.get('TAH_JA3_RECORDER', '')

def ja3_from_client_hello(client_hello):
    """Build a JA3 string from a TLS ClientHello message."""
    try:
        # mitmproxy's tls.ClientHello exposes extension types as named attrs
        cipher_suites = [cs for cs in (client_hello.cipher_suites or [])]
        extensions = []
        elliptic_curves = []
        ec_point_formats = []
        for ext in (client_hello.extensions or []]:
            if hasattr(ext, 'type'):
                extensions.append(ext.type)
            if hasattr(ext, 'elliptic_curves'):
                elliptic_curves = list(ext.elliptic_curves or [])
            if hasattr(ext, 'ec_point_formats'):
                ec_point_formats = list(ext.ec_point_formats or [])
        ja3 = ','.join(str(x) for x in [client_hello.cipher_suites,
                                       extensions,
                                       elliptic_curves,
                                       ec_point_formats,
                                       client_hello.signature_algorithms or []])
        return ja3, ','.join(str(c) for c in cipher_suites), extensions
    except Exception:
        return None, None, None

def request(flow):
    if not RECORDER_PATH:
        return
    try:
        ch = flow.client_conn.tls_client_hello if hasattr(flow.client_conn, 'tls_client_hello') else None
        ja3_str, ciphers, exts = (None, [], [])
        if ch is not None:
            ja3_str, ciphers, exts = ja3_from_client_hello(ch)
        record = {
            'url': flow.request.pretty_url,
            'ja3': ja3_str,
            'ja3_hash': __import__('hashlib').md5(ja3_str.encode()).hexdigest() if ja3_str else None,
            'ja4': getattr(ch, 'ja4', None) if ch else None,
            'tls_version': flow.client_conn.tls_version if hasattr(flow.client_conn, 'tls_version') else None,
            'cipher_suites': ciphers or [],
            'extensions': exts or [],
        }
        with open(RECORDER_PATH, 'a') as f:
            f.write(json.dumps(record) + '\n')
    except Exception as e:
        sys.stderr.write(f'ja3_addon error: {e}\n')

addons = [request]