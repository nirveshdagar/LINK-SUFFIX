#!/usr/bin/env python3
"""Pool-exhaustion check (spec §9).

Reads `mismatches.csv` produced by `verify_geo.py`. If any city has 3 or
more *consecutive* mismatches (i.e. the proxy pool is returning IPs whose
geo no longer matches the requested city), exit 2 so the orchestrator CLI
can surface pool exhaustion distinctly from a clean run.

A "consecutive mismatch" is two or more mismatches in adjacent rows for
the same requested (country, state, city) triple. Three or more in a row
across the file is the abort threshold.
"""
from __future__ import annotations
import csv
import pathlib
import sys


def main() -> int:
    run_dir = pathlib.Path(sys.argv[1])
    csv_path = run_dir / 'mismatches.csv'
    if not csv_path.exists():
        return 0

    rows: list[dict[str, str]] = []
    with csv_path.open('r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)

    # Track the most recent requested-city key per row. We consider
    # "consecutive" to mean same requested (country, state, city) with no
    # clean event in between. The CSV is already in run order.
    prev_key: tuple[str, str, str] | None = None
    streak = 0
    for r in rows:
        key = (
            r.get('requested_country', ''),
            r.get('requested_state', ''),
            r.get('requested_city', ''),
        )
        if key == prev_key:
            streak += 1
        else:
            streak = 1
            prev_key = key
        if streak >= 3:
            city = key[2] or '(unknown)'
            country = key[0] or '(unknown)'
            print(
                f'pool exhausted for {country}-{key[1]}-{city}: {streak} consecutive mismatches',
                file=sys.stderr,
            )
            return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
