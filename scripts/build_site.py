"""Assemble the static site: site/ plus data/ -> _site/ (what GitHub Pages serves).

    python scripts/build_site.py [--data-dir data] [--out _site]
    python -m http.server 8000 -d _site      # then open http://localhost:8000
"""

import argparse
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "data"))
    ap.add_argument("--out", default=os.path.join(ROOT, "_site"))
    args = ap.parse_args()
    if os.path.exists(args.out):
        shutil.rmtree(args.out)
    shutil.copytree(os.path.join(ROOT, "site"), args.out)
    out_data = os.path.join(args.out, "data")
    os.makedirs(out_data, exist_ok=True)
    for name in ("snapshots.jsonl", "projects.json", "status.json"):
        src = os.path.join(args.data_dir, name)
        if os.path.exists(src):
            shutil.copy2(src, out_data)
    open(os.path.join(args.out, ".nojekyll"), "w").close()
    print(f"built {args.out}")


if __name__ == "__main__":
    main()
