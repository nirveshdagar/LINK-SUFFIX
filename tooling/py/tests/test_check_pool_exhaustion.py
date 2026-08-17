"""Tests for check_pool_exhaustion.py.

Mocks argv and the run dir; we just write a hand-crafted mismatches.csv
and assert the script exits 0 when there's <3 consecutive mismatches
for any single city and 2 when there is.
"""
from __future__ import annotations
import csv
import json
import pathlib
import sys
import tempfile
import unittest
from pathlib import Path

_PY_DIR = str(Path(__file__).resolve().parents[1])
if _PY_DIR not in sys.path:
    sys.path.insert(0, _PY_DIR)

import check_pool_exhaustion  # noqa: E402


class CheckPoolExhaustionTests(unittest.TestCase):
    def _run(self, csv_rows: list[list[str]]) -> int:
        with tempfile.TemporaryDirectory() as td:
            run = Path(td)
            with (run / "mismatches.csv").open("w", encoding="utf-8", newline="") as f:
                w = csv.writer(f)
                w.writerow(
                    [
                        "scenario_id",
                        "ip",
                        "requested_country",
                        "requested_state",
                        "requested_city",
                        "resolved_country",
                        "resolved_state",
                        "resolved_city",
                    ]
                )
                for r in csv_rows:
                    w.writerow(r)
            # The script uses sys.argv[1] to locate the run dir.
            old_argv = sys.argv
            try:
                sys.argv = ["check", str(run)]
                return check_pool_exhaustion.main()
            finally:
                sys.argv = old_argv

    def test_clean_csv_returns_zero(self):
        # One mismatch, single row -> not exhausted.
        rc = self._run([["scn", "1.2.3.4", "US", "CA", "SF", "DE", "BE", "Cologne"]])
        self.assertEqual(rc, 0)

    def test_three_consecutive_for_one_city_returns_two(self):
        # Same requested (US,CA,SF) three times in a row -> exit 2.
        rc = self._run(
            [
                ["scn1", "1.2.3.4", "US", "CA", "SF", "DE", "BE", "Cologne"],
                ["scn2", "1.2.3.5", "US", "CA", "SF", "DE", "BE", "Cologne"],
                ["scn3", "1.2.3.6", "US", "CA", "SF", "DE", "BE", "Cologne"],
            ]
        )
        self.assertEqual(rc, 2)

    def test_no_csv_returns_zero(self):
        # Missing csv -> no exhaustion signal.
        with tempfile.TemporaryDirectory() as td:
            old = sys.argv
            try:
                sys.argv = ["check", td]
                self.assertEqual(check_pool_exhaustion.main(), 0)
            finally:
                sys.argv = old


if __name__ == "__main__":
    unittest.main()
