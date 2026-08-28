"""Capture standards-shaped JA3 data and correlate it to one harness request."""

import hashlib
import json
import os
import struct
import sys
import time

from mitmproxy import ctx, http, tls


RECORDER_PATH = os.environ.get("TAH_JA3_RECORDER", "")
GREASE = {0x0A0A + (0x1010 * i) for i in range(16)}


def _u16(data, offset):
    return struct.unpack_from("!H", data, offset)[0]


def _without_grease(values):
    return [value for value in values if value not in GREASE]


def _parse_client_hello(message):
    raw = message.raw_bytes(wrap_in_record=False)
    version = _u16(raw, 0)
    offset = 34
    session_length = raw[offset]
    offset += 1 + session_length
    cipher_length = _u16(raw, offset)
    offset += 2
    ciphers = [_u16(raw, index) for index in range(offset, offset + cipher_length, 2)]
    offset += cipher_length
    compression_length = raw[offset]
    offset += 1 + compression_length

    extensions = []
    groups = []
    point_formats = []
    if offset + 2 <= len(raw):
        extensions_length = _u16(raw, offset)
        offset += 2
        end = min(len(raw), offset + extensions_length)
        while offset + 4 <= end:
            extension_type = _u16(raw, offset)
            extension_length = _u16(raw, offset + 2)
            body = raw[offset + 4:offset + 4 + extension_length]
            extensions.append(extension_type)
            if extension_type == 10 and len(body) >= 2:
                group_length = _u16(body, 0)
                groups = [_u16(body, index) for index in range(2, min(len(body), 2 + group_length), 2)]
            elif extension_type == 11 and body:
                point_formats = list(body[1:1 + body[0]])
            offset += 4 + extension_length

    ciphers = _without_grease(ciphers)
    extensions = _without_grease(extensions)
    groups = _without_grease(groups)
    ja3_raw = ",".join([
        str(version),
        "-".join(map(str, ciphers)),
        "-".join(map(str, extensions)),
        "-".join(map(str, groups)),
        "-".join(map(str, point_formats)),
    ])
    return {
        "tls_version": str(version),
        "cipher_suites": ciphers,
        "extensions": extensions,
        "elliptic_curves": groups,
        "ec_point_formats": point_formats,
        "ja3_raw": ja3_raw,
        "ja3_hash": hashlib.md5(ja3_raw.encode("ascii")).hexdigest(),
    }


def _client_key(client):
    return str(client.peername) if client and client.peername else None


class Ja3Recorder:
    def __init__(self):
        self.fingerprints = {}

    def tls_clienthello(self, data: tls.ClientHelloData):
        if not RECORDER_PATH:
            return
        try:
            fingerprint = _parse_client_hello(data.client_hello)
            fingerprint.update({
                "timestamp": time.time(),
                "client_address": _client_key(data.context.client),
                "sni": data.client_hello.sni,
            })
            self.fingerprints[_client_key(data.context.client)] = fingerprint
        except Exception as error:
            sys.stderr.write(f"ja3_addon parse error: {error}\n")

    def request(self, flow: http.HTTPFlow):
        correlation_id = flow.request.headers.pop("x-tah-correlation-id", None)
        if not correlation_id or not RECORDER_PATH:
            return
        fingerprint = self.fingerprints.get(_client_key(flow.client_conn))
        if not fingerprint:
            return
        record = dict(fingerprint)
        record.update({"correlation_id": correlation_id, "url": flow.request.pretty_url})
        try:
            with open(RECORDER_PATH, "a", encoding="utf-8") as output:
                output.write(json.dumps(record, separators=(",", ":")) + "\n")
                output.flush()
        except Exception as error:
            sys.stderr.write(f"ja3_addon write error: {error}\n")

    def running(self):
        upstream_auth = os.environ.pop("TAH_MITM_UPSTREAM_AUTH", "")
        if upstream_auth:
            ctx.options.upstream_auth = upstream_auth


addons = [Ja3Recorder()]
