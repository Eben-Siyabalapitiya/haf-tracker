# Hack The Rex vote tracker

**Live dashboard: https://eben-siyabalapitiya.github.io/hack-the-rex-votes/**

A live-ish dashboard for the [TKS High Agency Fund](https://schools.tks.world/high-agency-fund) ballot, built to follow **Hack The Rex** (North Albion CI) and everyone it's racing against.

- Leaderboard of every project with changes for today, 1h, 5h, 10h and 24h, plus rank movement
- The race chart: each project's vote history with a faded projection line to the close
- Rank chart showing who passed who, and a momentum view of the biggest recent gains
- Live feed of updates (gains, overtakes, crossing the top-5 funding line, decreases)
- Lead over #2 and cushion over #6 (the first unfunded spot)

Everything runs on GitHub for free: a scheduled Actions job collects the data and GitHub Pages hosts the site. No server, no API keys.

## How it works

```
schools.tks.world  ──(vote feed every 30 s, full page every 10 min)──▶  collector/collect.py  ──▶  data/*.json(l)  ──▶  GitHub Pages
                                                      (GitHub Actions)          (committed)          site/ + data/
```

1. **Collect.** `collect.yml` checks the vote totals every 30 seconds. Each run lasts about 5.5 hours and then starts the next run itself, so collection doesn't depend on GitHub's scheduler (a 30-minute schedule is only a backup). Most checks read the small JSON vote feed the ballot page itself polls (`/api/vote-stats`, ~8 KB); every 10 minutes it reads the full page again for names and new projects. Every change is committed to `data/`. Pushing collector changes restarts it with the new code. It stops an hour after voting closes.
2. **Deploy.** When a run collected something new, it rebuilds and deploys the site.
3. **Refresh.** The dashboard checks for new data every 20 seconds. About every 75 seconds it also asks the GitHub API for the newest commit and loads the data from exactly that commit, which skips GitHub's 5-minute file cache, so new votes usually show up within 1–2 minutes. GitHub allows 60 anonymous API calls an hour per network; if a shared network (say, a whole school) runs low, the page pauses API checks until the limit resets and uses the cached files (at most ~5 minutes old) in the meantime.

The source has no API that browsers on other sites are allowed to call (no CORS), which is why collection happens in Actions instead of in the visitor's browser.

### What gets collected

The page is a Next.js app. Its embedded data holds a `voteCounts` map (slug → total), the project list (`items`), and a `LiveVoteCount` entry per project. The collector reads `voteCounts`, cross-checks it against `LiveVoteCount`, and rejects the scrape if anything disagrees, is duplicated, malformed, or if too many projects disappear at once. If the structure changes it falls back to the `LiveVoteCount` rows, then to a plain pattern match. Failed scrapes never overwrite good data.

The page also exposes "Best day" (`initialDay`) and a 7-day figure (`weekVotes`). Neither is a daily history and their exact definitions aren't documented, so they're stored in `projects.json` for reference only. All change calculations use our own snapshots.

Only the public page is read, with ordinary GET requests. Nothing touches the voting form.

### Data files

| File | What it holds |
| --- | --- |
| `data/snapshots.jsonl` | One line per distinct set of totals: `t` = first seen, `u` = last confirmed unchanged, then `c` (all totals) or `d` (only what changed; `null` = no longer listed). A full `c` line is written every 48 lines. |
| `data/projects.json` | Names, schools, first/last seen, and the source's own best-day and 7-day figures. |
| `data/status.json` | Last successful collection, last error, parser used. |

Unchanged totals don't create a new line; they extend `u` at most every 5 minutes, so quiet periods don't spam commits but the observed time range stays accurate.

## How the numbers are calculated

- Totals are **weighted votes** as shown on the ballot. Newsletter-confirmed votes can count double, so these are not unique voters. Changes are differences between observed totals, not proof of how many people voted.
- **Rolling windows** compare the latest snapshot with the snapshot closest to the target time, within a tolerance: 1h ±20 min, 5h ±45 min, 10h ±60 min, 24h ±90 min. If totals were confirmed unchanged across the target time, that value is used exactly. Without a match the cell says *Collecting history*, never zero. Hover or tap a number to see exactly which two collections it compares.
- **Today** uses Toronto midnight (±45 min). If tracking started after midnight it's labelled *since tracking began*; if collection had a gap at midnight it's labelled *since* the first collection that day.
- **New projects** are marked *new*; their gain is counted from when they were first seen, never from zero.
- **Decreases** show in red, appear in the feed and raise a banner for 24 hours.
- **Projections** extend each project's pace over the last 24h (or all history, if shorter) in a straight line to the close (Oct 31, 11:59 PM ET). They need at least an hour of data and are a rough guide only.
- All timestamps are stored in UTC and shown in Toronto time.
- If no collection succeeds for 15 minutes the dashboard shows **Stale**; if the last attempt failed it shows the error.

## Setup

1. Push this repository to GitHub. It needs to be **public** for free Pages hosting and free Actions minutes (the collector runs almost continuously).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions** tab → enable workflows if asked.
4. Run **Actions → Collect votes → Run workflow** once (or push a change to `collector/`). From then on it keeps itself running. The site appears at `https://USERNAME.github.io/REPOSITORY/`.

After that, everything runs by itself and stops after voting closes. To stop it early, disable the *Collect votes* workflow (Actions → Collect votes → ⋯ → Disable workflow).

Settings live in `site/config.js` (tracked project, close time, refresh interval, stale threshold).

## Run it locally

Requires Python 3.9+.

```bash
python collector/collect.py                        # collect one snapshot into data/
python scripts/build_site.py                       # build _site/
python -m http.server 8000 -d _site                # open http://localhost:8000
```

Tests:

```bash
python -m unittest discover -s tests -v            # collector: parsing, duplicates, storage, failures
node --test tests/metrics.test.mjs                 # dashboard maths: windows, Toronto midnight/DST, new projects, decreases
```

No Node? Serve the repo root (`python -m http.server 8000`) and open `http://localhost:8000/tests/browser.html` to run the same checks in a browser.

To check the parser against a saved copy of the live page:

```bash
curl -sL https://schools.tks.world/high-agency-fund -o page.html
SAMPLE_PAGE=page.html python -m unittest tests.test_collector -v
python collector/collect.py --html-file page.html --data-dir /tmp/try
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Dashboard says **Stale** | Actions → Collect votes. GitHub sometimes delays or skips scheduled runs; start one manually. Scheduled workflows also pause after 60 days without repository activity. |
| Dashboard shows **Source error** | The last attempt failed. The message is in `data/status.json` and in the run's warnings. Usually the site was down; it recovers on its own. |
| Error mentions *ballot blocks*, *disagree* or *no vote totals* | The page structure changed. Save the page (see above), run the parser against it, and update `collector/tracker.py`. The old data is untouched in the meantime. |
| Push rejected in the collector log | Someone pushed while it ran. The script resets to the latest commit and collects again (3 attempts). |
| Site 404s | Pages source must be *GitHub Actions*, and at least one deploy must have run. |
| Cells say *Collecting history* | Expected until enough snapshots exist: 24h needs about a day of collection. |

Unofficial; not affiliated with TKS.
