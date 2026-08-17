from __future__ import annotations
import json, csv, sys, pathlib, urllib.request, os
import maxminddb

def main():
    run_dir = pathlib.Path(sys.argv[1])
    events_path = run_dir / 'scenarios.jsonl'
    out_csv = run_dir / 'mismatches.csv'
    out_resolved = run_dir / 'geo_resolved.jsonl'
    db_path = os.environ['MAXMIND_DB_PATH']
    if not db_path:
        raise SystemExit('MAXMIND_DB_PATH not set')
    reader = maxminddb.open_database(db_path)
    rows = []
    resolved_rows = []
    for line in events_path.read_text(encoding='utf-8').splitlines():
        if not line.strip(): continue
        e = json.loads(line)
        ip = (e.get('geo_resolved') or {}).get('ip')
        if not ip:
            continue
        rec = reader.get(ip)
        if not rec:
            # No DB record. Emit a resolved entry with verified=False so
            # downstream consumers know the IP was seen but not classifiable.
            resolved_rows.append({
                'scenario_id': e.get('scenario_id'),
                'repeat_index': e.get('repeat_index'),
                'ip': ip,
                'country': '',
                'state': '',
                'city': '',
                'verified': False,
            })
            continue
        city = (rec.get('city') or {}).get('names', {}).get('en', '')
        country = (rec.get('country') or {}).get('iso_code', '')
        subs = (rec.get('subdivisions') or [{}])[0].get('iso_code', '') if rec.get('subdivisions') else ''
        req = e['geo_requested']
        resolved_rows.append({
            'scenario_id': e.get('scenario_id'),
            'repeat_index': e.get('repeat_index'),
            'ip': ip,
            'country': country,
            'state': subs,
            'city': city,
            'verified': True,
        })
        if (req['country'], req.get('state',''), req.get('city','')) != (country, subs, city):
            rows.append([e['scenario_id'], ip, req['country'], req.get('state',''), req.get('city',''), country, subs, city])
    with out_csv.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['scenario_id','ip','requested_country','requested_state','requested_city','resolved_country','resolved_state','resolved_city'])
        w.writerows(rows)
    # Emit a parallel informational file mapping each event to its resolved
    # geo. The orchestrator doesn't populate geo_resolved at runtime (no live
    # ipify), but post-run we can attach one with the offline DB and surface
    # it as `geo_resolved.jsonl` for the next iteration and for analysts.
    with out_resolved.open('w', encoding='utf-8') as f:
        for r in resolved_rows:
            f.write(json.dumps(r) + '\n')
    print(f'wrote {len(rows)} mismatches, {len(resolved_rows)} resolved entries')

if __name__ == '__main__':
    main()