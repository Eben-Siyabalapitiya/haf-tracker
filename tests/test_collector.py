"""Collector checks: parsing, duplicates, malformed pages, storage and failure handling.

    python -m unittest discover -s tests -v

Set SAMPLE_PAGE=/path/to/saved/high-agency-fund.html to also parse a real saved copy.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "collector"))
import collect  # noqa: E402
import tracker  # noqa: E402

T0 = datetime(2026, 10, 29, 14, 0, tzinfo=timezone.utc)

PROJECTS = [
    ("hack-the-rex-7615bd", "Hack The Rex", "North Albion Collegiate Institute | TDSB", 1056),
    ("create-conference-council-d3bca3", "CREATE Conference Council", "Unionville High School | YRDSB", 799),
    ("mac-design-cup-2026-8bb8ef", "Mac Design Cup 2026", "William Lyon Mackenzie CI | TDSB", 660),
    ("fuse-society-5b1e6b", "FUSE Society", "St. Robert Catholic High School | YCDSB", 361),
]


def flight_push(text: str) -> str:
    return f'<script>self.__next_f.push({json.dumps([1, text])})</script>'


def make_page(projects=PROJECTS, vote_counts_json=None, live_override=None, include_props=True,
              include_live=True, extra_items=()):
    """Build a page shaped like the real one: ballot props row + LiveVoteCount rows + tiles."""
    items = [{"slug": s, "title": t, "school": sc, "pitch": "", "imagePath": None,
              "coverStyle": "confetti", "isWinner": False} for s, t, sc, _ in projects]
    items += list(extra_items)
    facts = {s: {"interests": ["science-tech"], "publishedOn": "2026-10-04", "publishedRank": i,
                 "weekVotes": n // 2} for i, (s, _, _, n) in enumerate(projects)}
    counts = vote_counts_json or json.dumps({s: n for s, _, _, n in projects})
    rows = []
    if include_props:
        props = ('{"cycleId":"x","items":%s,"facts":%s,"voteCounts":%s,"spotSeed":1,"today":"2026-10-29"}'
                 % (json.dumps(items), json.dumps(facts), counts))
        rows.append('39:["$","section",null,{"id":"ballot","children":["$","$L40",null,%s]}]' % props)
    if include_live:
        for i, (s, _, _, n) in enumerate(projects):
            n = (live_override or {}).get(s, n)
            rows.append('%x:["$","$Le4",null,{"slug":"%s","initialCount":%d,"initialDay":{"votes":5,"date":"2026-10-28"},"checkedAt":1793328608236}]'
                        % (0x93 + i, s, n))
    flight = "\n".join(rows) + "\n"
    tiles = "".join(f'<h3 class="haf-row-title"><a href="/high-agency-fund/p/{s}">{t}</a></h3>'
                    for s, t, _, _ in projects)
    # Split the stream across pushes the way Next.js does.
    mid = len(flight) // 2
    return f"<html><body>{tiles}{flight_push(flight[:mid])}{flight_push(flight[mid:])}</body></html>"


class ParseTests(unittest.TestCase):
    def test_parses_ballot_props(self):
        r = tracker.parse_page(make_page())
        self.assertEqual(r.strategy, "ballot-props")
        self.assertEqual(r.counts["hack-the-rex-7615bd"], 1056)
        self.assertEqual(r.projects["hack-the-rex-7615bd"].title, "Hack The Rex")
        self.assertEqual(r.projects["fuse-society-5b1e6b"].week_votes, 180)
        self.assertEqual(r.projects["fuse-society-5b1e6b"].best_day, {"votes": 5, "date": "2026-10-28"})
        self.assertEqual(r.source_checked_at, "2026-10-30T02:50:08Z")
        self.assertEqual(len(r.projects), 4)

    def test_duplicate_items_with_same_title_are_merged(self):
        dup = {"slug": "fuse-society-5b1e6b", "title": "FUSE Society", "school": ""}
        r = tracker.parse_page(make_page(extra_items=[dup]))
        self.assertEqual(len(r.projects), 4)

    def test_duplicate_items_with_different_titles_rejected(self):
        dup = {"slug": "fuse-society-5b1e6b", "title": "Something else", "school": ""}
        with self.assertRaises(tracker.ParseError):
            tracker.parse_page(make_page(extra_items=[dup]))

    def test_duplicate_vote_count_keys_rejected(self):
        raw = ('{"hack-the-rex-7615bd":1056,"create-conference-council-d3bca3":799,'
               '"mac-design-cup-2026-8bb8ef":660,"fuse-society-5b1e6b":361,"hack-the-rex-7615bd":10}')
        with self.assertRaises(tracker.ParseError):
            tracker.parse_page(make_page(vote_counts_json=raw, include_live=False))

    def test_props_disagreeing_with_live_counts_rejected(self):
        with self.assertRaises(tracker.ParseError):
            tracker.parse_page(make_page(live_override={"fuse-society-5b1e6b": 999}))

    def test_falls_back_to_live_rows_with_html_titles(self):
        r = tracker.parse_page(make_page(include_props=False))
        self.assertEqual(r.strategy, "live-vote-count")
        self.assertEqual(r.projects["mac-design-cup-2026-8bb8ef"].title, "Mac Design Cup 2026")

    def test_falls_back_to_raw_escaped_pattern(self):
        page = ('<h3><a href="/high-agency-fund/p/a-1">Alpha</a></h3>'
                '<h3><a href="/high-agency-fund/p/b-2">Beta</a></h3><h3><a href="/high-agency-fund/p/c-3">Gamma</a></h3>'
                '<script>junk \\"slug\\":\\"a-1\\",\\"initialCount\\":7 '
                '\\"slug\\":\\"b-2\\",\\"initialCount\\":3 \\"slug\\":\\"c-3\\",\\"initialCount\\":0</script>')
        r = tracker.parse_page(page)
        self.assertEqual(r.strategy, "raw-regex")
        self.assertEqual(r.counts, {"a-1": 7, "b-2": 3, "c-3": 0})
        self.assertEqual(r.projects["a-1"].title, "Alpha")

    def test_mostly_untitled_results_rejected(self):
        page = '\\"slug\\":\\"a-1\\",\\"initialCount\\":7 \\"slug\\":\\"b-2\\",\\"initialCount\\":3 \\"slug\\":\\"c-3\\",\\"initialCount\\":1'
        with self.assertRaises(tracker.ParseError):
            tracker.parse_page(page)

    def test_empty_or_unrelated_page_rejected(self):
        for page in ["", "<html>maintenance</html>", flight_push("0:[\"$\",\"div\",null,{}]\n")]:
            with self.assertRaises(tracker.ParseError):
                tracker.parse_page(page)

    def test_negative_or_non_integer_totals_rejected(self):
        for bad in ["-4", "12.5", "\"12\"", "true"]:
            raw = json.dumps({s: n for s, _, _, n in PROJECTS})[:-1] + f',"bad-1":{bad}}}'
            with self.assertRaises(tracker.ParseError, msg=bad):
                tracker.parse_page(make_page(vote_counts_json=raw, include_live=False))

    def test_validate_rejects_tiny_or_collapsed_ballots(self):
        r = tracker.parse_page(make_page(PROJECTS[:2]))
        with self.assertRaises(tracker.ParseError):
            tracker.validate(r)
        r = tracker.parse_page(make_page(PROJECTS))
        known = {f"old-{i}" for i in range(10)} | {s for s, *_ in PROJECTS}
        with self.assertRaises(tracker.ParseError):
            tracker.validate(r, known)
        tracker.validate(r, {s for s, *_ in PROJECTS} | {"removed-one"})   # one removal is fine

    @unittest.skipUnless(os.environ.get("SAMPLE_PAGE"), "set SAMPLE_PAGE to a saved copy of the live page")
    def test_real_saved_page(self):
        with open(os.environ["SAMPLE_PAGE"], encoding="utf-8") as fh:
            r = tracker.parse_page(fh.read())
        tracker.validate(r)
        self.assertEqual(r.strategy, "ballot-props")
        self.assertIn("hack-the-rex-7615bd", r.counts)
        self.assertGreater(len(r.counts), 20)


class VoteFeedTests(unittest.TestCase):
    KNOWN = {s: {"title": t, "school": sc, "interests": [], "source_week_votes": 5} for s, t, sc, _ in PROJECTS}

    def feed(self, counts, **extra):
        return json.dumps({"counts": counts, "days": {}, "checkedAt": 1793328608236, **extra})

    def test_parses_counts_with_known_names(self):
        r = tracker.parse_vote_stats(self.feed({s: n + 1 for s, _, _, n in PROJECTS}), self.KNOWN)
        self.assertEqual(r.strategy, "vote-feed")
        self.assertEqual(r.counts["hack-the-rex-7615bd"], 1057)
        self.assertEqual(r.projects["hack-the-rex-7615bd"].title, "Hack The Rex")

    def test_unknown_project_needs_full_page(self):
        counts = {s: n for s, _, _, n in PROJECTS} | {"brand-new-abc123": 4}
        with self.assertRaises(tracker.NeedFullParse):
            tracker.parse_vote_stats(self.feed(counts), self.KNOWN)

    def test_malformed_feed_rejected(self):
        for text in ["", "<html>", json.dumps({"counts": {}}), json.dumps({"counts": {"a-1": -2}}),
                     '{"counts":{"hack-the-rex-7615bd":1,"hack-the-rex-7615bd":2}}']:
            with self.assertRaises(tracker.ParseError, msg=text):
                tracker.parse_vote_stats(text, self.KNOWN)

    def test_quick_mode_end_to_end_and_fallback(self):
        d = tempfile.mkdtemp()
        try:
            data = os.path.join(d, "data")
            page = os.path.join(d, "page.html")
            feed = os.path.join(d, "feed.json")
            with open(page, "w", encoding="utf-8") as fh:
                fh.write(make_page())
            # No names known yet: --quick falls back to the full page.
            self.assertEqual(collect.main(["--data-dir", data, "--html-file", page, "--quick", "--stats-file", feed]), 0)
            # Pretend that collection happened a minute ago, as it would in the real loop.
            snap = os.path.join(data, "snapshots.jsonl")
            recs = tracker.load_records(snap)
            earlier = tracker.iso(tracker.parse_iso(recs[0]["t"]) - timedelta(minutes=1))
            recs[0].update(t=earlier, u=earlier)
            tracker.dump_records(snap, recs)
            with open(feed, "w", encoding="utf-8") as fh:
                fh.write(self.feed({s: n + (5 if s.startswith("hack") else 0) for s, _, _, n in PROJECTS}))
            self.assertEqual(collect.main(["--data-dir", data, "--html-file", page, "--quick", "--stats-file", feed]), 0)
            recs = tracker.load_records(os.path.join(data, "snapshots.jsonl"))
            self.assertEqual(recs[-1]["c"]["hack-the-rex-7615bd"], 1061)
            with open(os.path.join(data, "status.json"), encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["parser_strategy"], "vote-feed")
        finally:
            shutil.rmtree(d)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = tracker.Store(self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def result(self, **changes):
        projects = [(s, t, sc, changes.get(s, n)) for s, t, sc, n in PROJECTS]
        return tracker.parse_page(make_page(projects))

    def lines(self):
        with open(self.store.snapshots, encoding="utf-8") as fh:
            return [json.loads(x) for x in fh if x.strip()]

    def test_unchanged_totals_do_not_write_until_heartbeat(self):
        self.assertEqual(self.store.record_success(self.result(), T0), "appended")
        mtime = os.path.getmtime(self.store.snapshots)
        self.assertEqual(self.store.record_success(self.result(), T0 + timedelta(minutes=2)), "unchanged")
        self.assertEqual(os.path.getmtime(self.store.snapshots), mtime)
        self.assertEqual(self.store.record_success(self.result(), T0 + timedelta(minutes=20)), "extended")
        lines = self.lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual((lines[0]["t"], lines[0]["u"]), ("2026-10-29T14:00:00Z", "2026-10-29T14:20:00Z"))

    def test_changes_append_as_deltas_and_reload_fully(self):
        self.store.record_success(self.result(), T0)
        self.store.record_success(self.result(**{"hack-the-rex-7615bd": 1060}), T0 + timedelta(minutes=3))
        lines = self.lines()
        self.assertIn("c", lines[0])
        self.assertEqual(lines[1]["d"], {"hack-the-rex-7615bd": 1060})
        recs = tracker.load_records(self.store.snapshots)
        self.assertEqual(recs[1]["c"]["create-conference-council-d3bca3"], 799)
        self.assertEqual(recs[1]["c"]["hack-the-rex-7615bd"], 1060)

    def test_decreases_and_removals_are_stored(self):
        self.store.record_success(self.result(), T0)
        smaller = [p for p in PROJECTS if p[0] != "fuse-society-5b1e6b"]
        smaller = [(s, t, sc, 650 if s.startswith("mac") else n) for s, t, sc, n in smaller]
        r = tracker.parse_page(make_page(smaller))
        self.store.record_success(r, T0 + timedelta(minutes=3))
        self.assertEqual(self.lines()[1]["d"], {"fuse-society-5b1e6b": None, "mac-design-cup-2026-8bb8ef": 650})
        recs = tracker.load_records(self.store.snapshots)
        self.assertNotIn("fuse-society-5b1e6b", recs[1]["c"])
        self.assertEqual(recs[1]["c"]["mac-design-cup-2026-8bb8ef"], 650)

    def test_keyframes_repeat(self):
        recs = []
        for i in range(tracker.KEYFRAME_EVERY + 2):
            tracker.merge_snapshot(recs, T0 + timedelta(minutes=3 * i), {"a-1": i, "b-2": 1})
        lines = [json.loads(x) for x in tracker.encode_records(recs).splitlines()]
        self.assertIn("c", lines[0])
        self.assertIn("c", lines[tracker.KEYFRAME_EVERY])
        self.assertIn("d", lines[tracker.KEYFRAME_EVERY + 1])

    def test_clock_going_backwards_is_ignored(self):
        self.store.record_success(self.result(), T0)
        self.assertEqual(self.store.record_success(self.result(**{"fuse-society-5b1e6b": 1}), T0 - timedelta(minutes=1)), "unchanged")

    def test_empty_snapshot_refused(self):
        with self.assertRaises(ValueError):
            tracker.merge_snapshot([], T0, {})

    def test_project_metadata_keeps_first_seen(self):
        self.store.record_success(self.result(), T0)
        self.store.record_success(self.result(**{"hack-the-rex-7615bd": 2000}), T0 + timedelta(hours=1))
        with open(self.store.projects, encoding="utf-8") as fh:
            meta = json.load(fh)
        self.assertEqual(meta["hack-the-rex-7615bd"]["first_seen"], "2026-10-29T14:00:00Z")
        self.assertEqual(meta["hack-the-rex-7615bd"]["last_seen"], "2026-10-29T15:00:00Z")

    def test_failures_never_touch_snapshots_and_are_rate_limited(self):
        self.store.record_success(self.result(), T0)
        before = open(self.store.snapshots, encoding="utf-8").read()
        self.assertTrue(self.store.record_failure("HTTP 503", T0 + timedelta(minutes=3)))
        self.assertFalse(self.store.record_failure("HTTP 503", T0 + timedelta(minutes=6)))
        self.assertTrue(self.store.record_failure("HTTP 503", T0 + timedelta(minutes=70)))
        self.assertEqual(open(self.store.snapshots, encoding="utf-8").read(), before)
        with open(self.store.status, encoding="utf-8") as fh:
            status = json.load(fh)
        self.assertEqual(status["consecutive_failures"], 2)
        self.assertEqual(status["last_success"], "2026-10-29T14:00:00Z")
        self.store.record_success(self.result(**{"fuse-society-5b1e6b": 400}), T0 + timedelta(minutes=80))
        with open(self.store.status, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["consecutive_failures"], 0)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def test_bad_page_keeps_previous_data(self):
        data = os.path.join(self.dir, "data")
        good = self.write("good.html", make_page())
        bad = self.write("bad.html", "<html>Service unavailable</html>")
        self.assertEqual(collect.main(["--data-dir", data, "--html-file", good]), 0)
        snap = open(os.path.join(data, "snapshots.jsonl"), encoding="utf-8").read()
        self.assertEqual(collect.main(["--data-dir", data, "--html-file", bad]), 0)
        self.assertEqual(collect.main(["--data-dir", data, "--html-file", bad, "--fail-on-error"]), 1)
        self.assertEqual(open(os.path.join(data, "snapshots.jsonl"), encoding="utf-8").read(), snap)

    def test_first_run_with_bad_page_writes_no_snapshot(self):
        data = os.path.join(self.dir, "data")
        bad = self.write("bad.html", "")
        collect.main(["--data-dir", data, "--html-file", bad])
        self.assertFalse(os.path.exists(os.path.join(data, "snapshots.jsonl")))


if __name__ == "__main__":
    unittest.main()
