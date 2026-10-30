"""Fetch, parse, validate and store public vote totals from the TKS High Agency Fund page.

Only the public page is read with an ordinary GET request. Nothing here touches the
voting form, submits votes or reads anything that is not served to every visitor.

How the page is structured (inspected 2026-10-29):

* It is a Next.js App Router page. Server data is streamed as "flight" rows inside
  ``<script>self.__next_f.push([1,"<escaped text>"])</script>`` tags.
* Decoded, one row holds the ballot props: ``items`` (slug, title, school, ...),
  ``voteCounts`` ({slug: total}), ``facts`` ({slug: {interests, publishedOn,
  publishedRank, weekVotes}}) and ``today`` (the server's date).
* Each project also has a ``LiveVoteCount`` row:
  ``{"slug": ..., "initialCount": N, "initialDay": {"votes": V, "date": D}, "checkedAt": ms}``.
  ``initialCount`` equals ``voteCounts[slug]``. ``initialDay`` is what the page shows as
  "Best day: +V votes" (the best single day, timezone undocumented). ``weekVotes`` looks
  like a rolling 7-day total but is undocumented. Neither is a daily history, so they are
  stored for reference only and never used in our change calculations.

Parsing is layered so a structure change degrades loudly instead of silently:
  1. ballot props (``voteCounts`` + ``items``), cross-checked against LiveVoteCount rows;
  2. LiveVoteCount rows alone, with titles from ``items`` or the HTML tiles;
  3. a raw regex over the HTML for ``"slug":"...","initialCount":N`` (escaped or not).
Anything inconsistent raises ``ParseError`` and the stored data is left untouched.
"""

from __future__ import annotations

import html as htmllib
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

SOURCE_URL = "https://schools.tks.world/high-agency-fund"
USER_AGENT = "hack-the-rex-vote-tracker/1.0 (+https://github.com; reads the public ballot page)"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,200}$")

# Validation thresholds.
MIN_PROJECTS = 3            # fewer than this is never a real ballot
MIN_KEEP_RATIO = 0.5        # reject if more than half of the known projects vanish at once
MAX_UNTITLED_RATIO = 0.25   # reject if too many counts have no readable name

# Storage behaviour.
HEARTBEAT = timedelta(minutes=5)           # re-confirm unchanged totals this often
ERROR_HEARTBEAT = timedelta(minutes=60)    # re-record an ongoing failure this often


class ParseError(Exception):
    """The page could not be turned into a complete, consistent set of projects."""


class FetchError(Exception):
    """The source could not be fetched."""


@dataclass
class Project:
    slug: str
    title: str
    count: int
    school: str = ""
    interests: list = field(default_factory=list)
    best_day: dict | None = None
    week_votes: int | None = None


@dataclass
class ParseResult:
    projects: dict          # slug -> Project
    strategy: str
    source_checked_at: str | None = None
    source_today: str | None = None
    warnings: list = field(default_factory=list)

    @property
    def counts(self) -> dict:
        return {slug: p.count for slug, p in sorted(self.projects.items())}


# --------------------------------------------------------------------------- fetch

def fetch(url: str = SOURCE_URL, timeout: int = 30, attempts: int = 3) -> str:
    last = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html",
                "Cache-Control": "no-cache",
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    raise FetchError(f"HTTP {resp.status}")
                ctype = resp.headers.get("Content-Type", "")
                if "html" not in ctype:
                    raise FetchError(f"unexpected content type {ctype!r}")
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError, FetchError) as exc:
            last = exc
            if attempt < attempts - 1:
                time.sleep(5 * (attempt + 1))
    raise FetchError(f"could not fetch {url}: {last}")


# --------------------------------------------------------------------------- parse

class _PairsDict(dict):
    """dict that remembers keys which appeared more than once with different values."""
    conflicts: list


def _pairs_hook(pairs):
    d = _PairsDict()
    d.conflicts = []
    for k, v in pairs:
        if k in d and d[k] != v:
            d.conflicts.append(k)
        d[k] = v
    return d


_PUSH_RE = re.compile(r"self\.__next_f\.push\((\[.*?\])\)\s*</script>", re.S)
_ROW_RE = re.compile(r"^([0-9a-zA-Z]+):(.*)$")


def extract_flight(page_html: str) -> str:
    """Concatenate the Next.js flight stream embedded in the page."""
    parts = []
    for raw in _PUSH_RE.findall(page_html):
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(item, list) and len(item) >= 2 and item[0] == 1 and isinstance(item[1], str):
            parts.append(item[1])
    return "".join(parts)


def iter_flight_rows(flight: str):
    for line in flight.split("\n"):
        m = _ROW_RE.match(line)
        if not m or m.group(2)[:1] not in "[{":
            continue
        try:
            yield m.group(1), json.loads(m.group(2), object_pairs_hook=_pairs_hook)
        except json.JSONDecodeError:
            continue


def _walk(obj):
    stack = [obj]
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            yield o
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)


def _find_ballot_props(rows) -> dict | None:
    found = [d for _, row in rows for d in _walk(row)
             if isinstance(d.get("voteCounts"), dict) and isinstance(d.get("items"), list)]
    if len(found) > 1:
        raise ParseError(f"found {len(found)} ballot blocks; expected one")
    return found[0] if found else None


def _valid_count(slug, value):
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        raise ParseError(f"malformed slug {slug!r}")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ParseError(f"malformed vote total for {slug}: {value!r}")
    return value


def _live_rows(rows) -> dict:
    """slug -> LiveVoteCount props. Conflicting duplicates are an error."""
    out = {}
    for _, row in rows:
        for d in _walk(row):
            if "slug" in d and "initialCount" in d:
                slug = d["slug"]
                _valid_count(slug, d["initialCount"])
                if slug in out and out[slug]["initialCount"] != d["initialCount"]:
                    raise ParseError(f"conflicting LiveVoteCount totals for {slug}")
                out[slug] = d
    return out


def _items_by_slug(items: list) -> dict:
    out = {}
    for it in items:
        if not isinstance(it, dict) or "slug" not in it:
            raise ParseError("ballot item without slug")
        slug = it["slug"]
        title = (it.get("title") or "").strip()
        if slug in out:
            if (out[slug].get("title") or "").strip() != title:
                raise ParseError(f"duplicate ballot item {slug} with different titles")
            continue
        out[slug] = it
    return out


_TILE_RE = re.compile(
    r'href="[^"]*/(?:p|projects)/([a-z0-9-]+)"[^>]*>\s*([^<]{1,200}?)\s*</a>\s*</h3>', re.S)


def _titles_from_html(page_html: str) -> dict:
    titles = {}
    for slug, title in _TILE_RE.findall(page_html):
        titles.setdefault(slug, htmllib.unescape(title.strip()))
    return titles


_RAW_RE = re.compile(r'\\?"slug\\?":\\?"([a-z0-9-]+)\\?",\\?"initialCount\\?":(\d+)')


def _ms_to_iso(ms) -> str | None:
    if isinstance(ms, (int, float)) and not isinstance(ms, bool) and ms > 0:
        return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None


def _humanize(slug: str) -> str:
    base = re.sub(r"-[0-9a-f]{6}$", "", slug)
    return base.replace("-", " ").title()


def parse_page(page_html: str) -> ParseResult:
    flight = extract_flight(page_html)
    rows = list(iter_flight_rows(flight)) if flight else []
    live = _live_rows(rows) if rows else {}
    props = _find_ballot_props(rows) if rows else None
    warnings: list = []
    checked = next((_ms_to_iso(d.get("checkedAt")) for d in live.values() if d.get("checkedAt")), None)

    if props is not None:
        counts = props["voteCounts"]
        if getattr(counts, "conflicts", None):
            raise ParseError(f"duplicate voteCounts keys with different totals: {counts.conflicts[:5]}")
        items = _items_by_slug(props["items"])
        facts = props.get("facts") if isinstance(props.get("facts"), dict) else {}
        for slug, n in counts.items():
            _valid_count(slug, n)
        if set(items) != set(counts):
            missing = sorted(set(items) ^ set(counts))[:5]
            raise ParseError(f"items and voteCounts list different projects (e.g. {missing})")
        if live:
            if set(live) != set(counts):
                raise ParseError("LiveVoteCount rows and voteCounts list different projects")
            bad = [s for s in counts if live[s]["initialCount"] != counts[s]]
            if bad:
                raise ParseError(f"voteCounts disagree with LiveVoteCount for {bad[:5]}")
        else:
            warnings.append("no LiveVoteCount rows to cross-check against")
        projects = {}
        for slug, n in counts.items():
            it, fx, lv = items[slug], facts.get(slug) or {}, live.get(slug) or {}
            title = (it.get("title") or "").strip()
            projects[slug] = Project(
                slug=slug, title=title, count=n, school=(it.get("school") or "").strip(),
                interests=list(fx.get("interests") or []),
                best_day=lv.get("initialDay") if isinstance(lv.get("initialDay"), dict) else None,
                week_votes=fx.get("weekVotes") if isinstance(fx.get("weekVotes"), int) else None,
            )
        result = ParseResult(projects, "ballot-props", checked, props.get("today"), warnings)
    elif live:
        titles = _titles_from_html(page_html)
        projects = {s: Project(slug=s, title=titles.get(s, ""), count=d["initialCount"],
                               best_day=d.get("initialDay")) for s, d in live.items()}
        warnings.append("ballot props not found; used LiveVoteCount rows")
        result = ParseResult(projects, "live-vote-count", checked, None, warnings)
    else:
        raw = {}
        for slug, n in _RAW_RE.findall(page_html):
            n = int(n)
            if slug in raw and raw[slug] != n:
                raise ParseError(f"conflicting raw totals for {slug}")
            raw[slug] = n
        if not raw:
            raise ParseError("no vote totals found in page")
        titles = _titles_from_html(page_html)
        projects = {s: Project(slug=s, title=titles.get(s, ""), count=n) for s, n in raw.items()}
        warnings.append("flight data not parseable; used raw HTML pattern")
        result = ParseResult(projects, "raw-regex", None, None, warnings)

    untitled = [s for s, p in result.projects.items() if not p.title]
    if len(untitled) > MAX_UNTITLED_RATIO * max(1, len(result.projects)):
        raise ParseError(f"{len(untitled)} of {len(result.projects)} projects have no readable name")
    for s in untitled:
        result.projects[s].title = _humanize(s)
        warnings.append(f"no title for {s}; using slug")
    return result


def validate(result: ParseResult, previous_active: set | None = None) -> None:
    n = len(result.projects)
    if n < MIN_PROJECTS:
        raise ParseError(f"only {n} projects found (minimum {MIN_PROJECTS})")
    if previous_active:
        kept = len(previous_active & set(result.projects))
        if kept < MIN_KEEP_RATIO * len(previous_active):
            raise ParseError(
                f"only {kept} of {len(previous_active)} previously listed projects are present; "
                "refusing to treat this as a valid ballot")


# --------------------------------------------------------------------------- storage

def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _atomic_write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


KEYFRAME_EVERY = 48   # a full copy of all totals every N lines; the rest store only changes


def load_records(path: str) -> list:
    """Read snapshots.jsonl into records {"t", "u", "c": full totals}.

    On disk each line is {"t": first seen, "u": last confirmed, ...} plus either
    "c" (all totals, a keyframe) or "d" (only totals that changed since the previous
    line; null marks a project that is no longer listed).
    """
    records = []
    prev = None
    try:
        with open(path, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                if not (rec.get("t") and rec.get("u")):
                    raise ValueError(f"{path}:{i}: snapshot without timestamps")
                if isinstance(rec.get("c"), dict):
                    counts = dict(rec["c"])
                elif isinstance(rec.get("d"), dict) and prev is not None:
                    counts = dict(prev)
                    for slug, n in rec["d"].items():
                        if n is None:
                            counts.pop(slug, None)
                        else:
                            counts[slug] = n
                else:
                    raise ValueError(f"{path}:{i}: malformed snapshot record")
                records.append({"t": rec["t"], "u": rec["u"], "c": counts})
                prev = counts
    except FileNotFoundError:
        pass
    return records


def encode_records(records: list) -> str:
    lines, prev = [], None
    for i, r in enumerate(records):
        out = {"t": r["t"], "u": r["u"]}
        if prev is None or i % KEYFRAME_EVERY == 0:
            out["c"] = dict(sorted(r["c"].items()))
        else:
            d = {s: n for s, n in r["c"].items() if prev.get(s) != n}
            d.update({s: None for s in prev if s not in r["c"]})
            out["d"] = dict(sorted(d.items()))
        lines.append(json.dumps(out, separators=(",", ":")) + "\n")
        prev = r["c"]
    return "".join(lines)


def dump_records(path: str, records: list) -> None:
    _atomic_write(path, encode_records(records))


def merge_snapshot(records: list, now: datetime, counts: dict, heartbeat: timedelta = HEARTBEAT):
    """Add an observation. Returns "appended", "extended" or "unchanged" (nothing to write).

    Identical totals extend the last record's "u" (last confirmed time) instead of adding a
    line, and only once ``heartbeat`` has passed, so quiet periods do not create commits
    while the time range over which the totals were observed stays accurate.
    """
    if not counts:
        raise ValueError("refusing to store an empty snapshot")
    stamp = iso(now)
    if records:
        last = records[-1]
        if now <= parse_iso(last["u"]):
            return "unchanged"      # clock went backwards or duplicate run
        if last["c"] == counts:
            if now - parse_iso(last["u"]) < heartbeat:
                return "unchanged"
            last["u"] = stamp
            return "extended"
    records.append({"t": stamp, "u": stamp, "c": dict(sorted(counts.items()))})
    return "appended"


def update_projects(meta: dict, result: ParseResult, now: datetime) -> dict:
    stamp = iso(now)
    for slug, p in result.projects.items():
        entry = meta.get(slug, {"first_seen": stamp})
        entry.update({
            "title": p.title, "school": p.school, "interests": p.interests, "last_seen": stamp,
            # Source-reported figures, stored for reference only (see module docstring).
            "source_best_day": p.best_day, "source_week_votes": p.week_votes,
        })
        meta[slug] = entry
    return dict(sorted(meta.items()))


class Store:
    def __init__(self, data_dir: str):
        self.dir = data_dir
        self.snapshots = os.path.join(data_dir, "snapshots.jsonl")
        self.projects = os.path.join(data_dir, "projects.json")
        self.status = os.path.join(data_dir, "status.json")

    def record_success(self, result: ParseResult, now: datetime, heartbeat=HEARTBEAT) -> str:
        records = load_records(self.snapshots)
        outcome = merge_snapshot(records, now, result.counts, heartbeat)
        if outcome == "unchanged":
            return outcome
        dump_records(self.snapshots, records)
        meta = update_projects(_read_json(self.projects, {}), result, now)
        _atomic_write(self.projects, json.dumps(meta, indent=1, ensure_ascii=False) + "\n")
        status = _read_json(self.status, {})
        status.update({
            "source_url": SOURCE_URL,
            "last_success": iso(now),
            "last_change": records[-1]["t"],
            "project_count": len(result.projects),
            "parser_strategy": result.strategy,
            "source_checked_at": result.source_checked_at,
            "source_today": result.source_today,
            "warnings": result.warnings[:10],
            "consecutive_failures": 0,
        })
        _atomic_write(self.status, json.dumps(status, indent=1) + "\n")
        return outcome

    def record_failure(self, message: str, now: datetime) -> bool:
        """Note a failed run without touching snapshots. Returns True if status was written."""
        status = _read_json(self.status, {})
        prev = status.get("last_error") or {}
        failing = status.get("consecutive_failures", 0) > 0
        if failing and prev.get("at") and now - parse_iso(prev["at"]) < ERROR_HEARTBEAT:
            return False
        status.update({
            "source_url": SOURCE_URL,
            "last_error": {"at": iso(now), "message": message[:500]},
            "consecutive_failures": status.get("consecutive_failures", 0) + 1,
        })
        _atomic_write(self.status, json.dumps(status, indent=1) + "\n")
        return True

    def active_slugs(self) -> set:
        records = load_records(self.snapshots)
        return set(records[-1]["c"]) if records else set()
