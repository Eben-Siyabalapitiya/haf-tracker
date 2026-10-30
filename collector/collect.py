"""Collect one snapshot of the public ballot into data/.

    python collector/collect.py                      # fetch the live page
    python collector/collect.py --html-file page.html  # parse a saved copy instead

Exit codes: 0 = stored, unchanged or (without --fail-on-error) source problem recorded;
1 = source problem with --fail-on-error.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tracker  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    ap.add_argument("--url", default=tracker.SOURCE_URL)
    ap.add_argument("--html-file", help="parse this saved page instead of fetching")
    ap.add_argument("--heartbeat-minutes", type=float, default=tracker.HEARTBEAT.total_seconds() / 60)
    ap.add_argument("--fail-on-error", action="store_true", help="exit 1 if the source cannot be read")
    ap.add_argument("--quick", action="store_true",
                    help="read the small vote feed the page polls (falls back to the full page if needed)")
    ap.add_argument("--stats-file", help="with --quick, parse this saved vote feed instead of fetching")
    args = ap.parse_args(argv)

    store = tracker.Store(os.path.normpath(args.data_dir))
    now = datetime.now(timezone.utc).replace(microsecond=0)   # collection time, used everywhere
    try:
        result = quick(args, store) if args.quick else None
        if result is None:
            if args.html_file:
                with open(args.html_file, encoding="utf-8") as fh:
                    page = fh.read()
            else:
                page = tracker.fetch(args.url)
            result = tracker.parse_page(page)
        tracker.validate(result, store.active_slugs())
    except (tracker.FetchError, tracker.ParseError) as exc:
        wrote = store.record_failure(str(exc), now)
        print(f"::warning title=Vote collection failed::{exc}")
        print(f"Kept the last valid data. Status {'updated' if wrote else 'unchanged (already reported)'}.")
        return 1 if args.fail_on_error else 0

    outcome = store.record_success(result, now, timedelta(minutes=args.heartbeat_minutes))
    for w in result.warnings:
        print(f"::notice::{w}")
    top = sorted(result.projects.values(), key=lambda p: -p.count)[:5]
    print(f"{tracker.iso(now)}: {len(result.projects)} projects via {result.strategy}; snapshot {outcome}")
    for i, p in enumerate(top, 1):
        print(f"  {i}. {p.title}: {p.count}")
    return 0


def quick(args, store):
    """Totals from the vote feed, or None when the full page should be read instead."""
    known, cycle = store.known_projects(), store.cycle_id()
    if not known or not (cycle or args.stats_file):
        return None
    try:
        if args.stats_file:
            with open(args.stats_file, encoding="utf-8") as fh:
                text = fh.read()
        else:
            text = tracker.fetch_vote_stats(cycle)
        return tracker.parse_vote_stats(text, known)
    except (tracker.FetchError, tracker.ParseError) as exc:
        print(f"Quick feed unusable ({exc}); reading the full page instead")
        return None


if __name__ == "__main__":
    sys.exit(main())
