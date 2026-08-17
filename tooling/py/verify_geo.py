from __future__ import annotations
import json, csv, sys, pathlib, urllib.request, os
import maxminddb

def main():
    run_dir = pathlib.Path(sys.argv[1])
    events_path = run_dir / 'scenarios.jsonl'
    out_csv = run_dir / 'mismatches.csv'
    db_path = os.environ['MAXMIND_DB_PATH']
    if not db_path:
        raise SystemExit('MAXMIND_DB_PATH not set')
    reader = maxminddb.open_database(db_path)
    rows = []
    for line in events_path.read_text(encoding='utf-8').splitlines():
        if not line.strip(): continue
        e = json.loads(line)
        ip = (e.get('geo_resolved') or {}).get('ip')
        if not ip:
            continue
        rec = reader.get(ip)
        if not rec:
            continue
        city = (rec.get('city') or {}).get('names', {}).get('en', '')
        country = (rec.get('country') or {}).get('iso_code', '')
        subs = (rec.get('subdivisions') or [{}])[0].get('iso_code', '') if rec.get('subdivisions') else ''
        req = e['geo_requested']
        if (req['country'], req.get('state',''), req.get('city','')) != (country, subs, city):
            rows.append([e['scenario_id'], ip, req['country'], req.get('state',''), req.get('city',''), country, subs, city])
    with out_csv.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['scenario_id','ip','requested_country','requested_state','requested_city','resolved_country','resolved_state','resolved_city'])
        w.writerows(rows)
    print(f'wrote {len(rows)} mismatches')

if __name__ == '__main__':
    main()