"""Assemble the static site: site/ plus data/ -> _site/ (what GitHub Pages serves).

    python scripts/build_site.py [--data-dir data] [--out _site]
    python -m http.server 8000 -d _site      # then open http://localhost:8000
"""

import argparse
import hashlib
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


ASSETS = {  # file -> references to version inside it
    "index.html": ["css/style.css", "config.js", "js/app.js"],
    os.path.join("js", "app.js"): ["./metrics.js"],
}


def bust_cache(out):
    """Append ?v=<hash of the site files> to asset URLs so browsers pick up new versions right away."""
    h = hashlib.sha1()
    for base, _, files in sorted(os.walk(out)):
        for name in sorted(files):
            with open(os.path.join(base, name), "rb") as fh:
                h.update(fh.read())
    version = h.hexdigest()[:10]
    for rel, refs in ASSETS.items():
        path = os.path.join(out, rel)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for ref in refs:
            text = text.replace(f'"{ref}"', f'"{ref}?v={version}"').replace(f"'{ref}'", f"'{ref}?v={version}'")
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "data"))
    ap.add_argument("--out", default=os.path.join(ROOT, "_site"))
    args = ap.parse_args()
    if os.path.exists(args.out):
        shutil.rmtree(args.out)
    shutil.copytree(os.path.join(ROOT, "site"), args.out)
    bust_cache(args.out)
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
