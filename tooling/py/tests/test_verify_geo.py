"""Tests for verify_geo.py using a mocked MaxMind reader.

These tests do NOT require a real .mmdb file. The MaxMind reader is
mocked so we can deterministically assert what verify_geo writes to
mismatches.csv given a scenarios.jsonl input.
"""
from __future__ import annotations

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Add tooling/py to sys.path so `import verify_geo` resolves.
_PY_DIR = str(Path(__file__).resolve().parents[1])
if _PY_DIR not in sys.path:
    sys.path.insert(0, _PY_DIR)

import verify_geo  # noqa: E402


class FakeReader:
    """Minimal stand-in for maxminddb.open_database()."""

    def __init__(self, table):
        self._table = table

    def get(self, ip):
        return self._table.get(ip)

    def close(self):
        pass


def _run(run_dir: Path, events, mmdb_table) -> Path:
    """Invoke verify_geo.main() against `run_dir` with the given events."""
    (run_dir / "scenarios.jsonl").write_text(
        "\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8"
    )
    with mock.patch.object(
        verify_geo.maxminddb, "open_database", lambda _p: FakeReader(mmdb_table)
    ):
        with mock.patch.dict("os.environ", {"MAXMIND_DB_PATH": "/tmp/fake.mmdb"}):
            with mock.patch.object(sys, "argv", ["verify_geo", str(run_dir)]):
                verify_geo.main()
    return run_dir / "mismatches.csv"


class VerifyGeoTests(unittest.TestCase):
    def test_mismatch_is_written(self):
        events = [
            {
                "scenario_id": "scn-1",
                "geo_requested": {"country": "US", "state": "CA", "city": "San Francisco"},
                "geo_resolved": {"ip": "1.2.3.4"},
            }
        ]
        # Resolved says DE/BE/Cologne - mismatch.
        mmdb = {
            "1.2.3.4": {
                "country": {"iso_code": "DE"},
                "city": {"names": {"en": "Cologne"}},
                "subdivisions": [{"iso_code": "BE"}],
            }
        }
        with tempfile.TemporaryDirectory() as td:
            out_csv = _run(Path(td), events, mmdb)
            self.assertTrue(out_csv.exists())
            with out_csv.open(encoding="utf-8") as f:
                rows = list(csv.reader(f))
            self.assertEqual(
                rows[0],
                [
                    "scenario_id", "ip", "requested_country", "requested_state",
                    "requested_city", "resolved_country", "resolved_state", "resolved_city",
                ],
            )
            self.assertEqual(rows[1][0], "scn-1")
            self.assertEqual(rows[1][1], "1.2.3.4")
            self.assertEqual(rows[1][2], "US")
            self.assertEqual(rows[1][3], "CA")
            self.assertEqual(rows[1][4], "San Francisco")
            self.assertEqual(rows[1][5], "DE")
            self.assertEqual(rows[1][6], "BE")
            self.assertEqual(rows[1][7], "Cologne")

    def test_match_is_not_written(self):
        events = [
            {
                "scenario_id": "scn-2",
                "geo_requested": {"country": "US", "state": "CA", "city": "San Francisco"},
                "geo_resolved": {"ip": "5.6.7.8"},
            }
        ]
        mmdb = {
            "5.6.7.8": {
                "country": {"iso_code": "US"},
                "city": {"names": {"en": "San Francisco"}},
                "subdivisions": [{"iso_code": "CA"}],
            }
        }
        with tempfile.TemporaryDirectory() as td:
            out_csv = _run(Path(td), events, mmdb)
            self.assertTrue(out_csv.exists())
            with out_csv.open(encoding="utf-8") as f:
                rows = list(csv.reader(f))
            # Only the header should be present.
            self.assertEqual(len(rows), 1)

    def test_missing_ip_is_skipped(self):
        events = [
            {
                "scenario_id": "scn-3",
                "geo_requested": {"country": "US"},
                # no geo_resolved
            }
        ]
        with tempfile.TemporaryDirectory() as td:
            out_csv = _run(Path(td), events, {})
            self.assertTrue(out_csv.exists())
            with out_csv.open(encoding="utf-8") as f:
                rows = list(csv.reader(f))
            # Only the header should be present.
            self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()