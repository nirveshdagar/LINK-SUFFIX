import pathlib, sys, zipfile

def main():
    run_dir = pathlib.Path(sys.argv[1])
    base = run_dir / 'replay'
    if not base.exists():
        print('no replay dir')
        return
    for d in base.iterdir():
        if not d.is_dir(): continue
        out = base / f'{d.name}-bundle.zip'
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for p in d.rglob('*'):
                if p.is_file():
                    z.write(p, p.relative_to(d))
        print(f'wrote {out}')

if __name__ == '__main__':
    main()