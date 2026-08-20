# mitmproxy addon: capture TLS ClientHello per TLS connection.
# Writes one JSONL line per ClientHello to TAH_JA3_RECORDER env var path.

import hashlib
import json
import os
import sys

from mitmproxy.tls import ClientHelloData

RECORDER_PATH = os.environ.get('TAH_JA3_RECORDER', '')


def tls_client_hello(data: ClientHelloData):
    """mitmproxy fires this for every TLS ClientHello observed."""
    if not RECORDER_PATH:
        return
    try:
        msg = data.message
        cipher_suites = ','.join(str(c) for c in msg.cipher_suites)
        extensions = ','.join(str(e.type) for e in msg.extensions)
        ec_curves = ''
        for ext in msg.extensions:
            if hasattr(ext, 'elliptic_curves') and ext.elliptic_curves is not None:
                ec_curves = ','.join(str(c) for c in ext.elliptic_curves)
                break
        ja3_raw = f'{cipher_suites},{extensions},{ec_curves}'
        ja3_hash = hashlib.md5(ja3_raw.encode('utf-8')).hexdigest()
        record = {
            'timestamp': data.timestamp,
            'client_address': str(data.context.client.peername) if data.context.client.peername else None,
            'host': str(data.context.client.peername[0]) if data.context.client.peername else None,
            'sni': msg.server_name,
            'tls_version': msg.version,
            'cipher_suites': cipher_suites,
            'extensions': extensions,
            'ec_curves': ec_curves,
            'ja3': ja3_hash,
        }
        with open(RECORDER_PATH, 'a', encoding='utf-8') as f:
            f.write(json.dumps(record) + '\n')
    except Exception as e:
        sys.stderr.write(f'ja3_addon error: {e}\n')


addons = [tls_client_hello]
