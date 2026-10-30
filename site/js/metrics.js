// Pure calculations over collected snapshots. No DOM access, so it runs in the
// browser and under `node --test` alike.
//
// A snapshot record is {t, u, c}: totals `c` ({slug: weighted votes}) were first seen at
// collection time `t` and confirmed unchanged up to collection time `u`. Every number
// below is a difference between two observed totals; nothing is interpolated.

export const TZ = 'America/Toronto';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Rolling windows and how far the baseline observation may sit from the exact target.
export const WINDOWS = [
  { key: '1h', label: '1h', ms: 1 * HOUR, tol: 20 * MIN },
  { key: '5h', label: '5h', ms: 5 * HOUR, tol: 45 * MIN },
  { key: '10h', label: '10h', ms: 10 * HOUR, tol: 60 * MIN },
  { key: '24h', label: '24h', ms: 24 * HOUR, tol: 90 * MIN },
];
export const MIDNIGHT_TOL = 45 * MIN;

// ------------------------------------------------------------------ parsing

/**
 * Lines hold either "c" (all totals) or "d" (changes since the previous line, null =
 * no longer listed). A malformed line breaks the delta chain, so later deltas are
 * dropped until the next full keyframe rather than being applied to the wrong base.
 */
export function parseSnapshots(text) {
  const out = [];
  let prev = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { prev = null; continue; }
    const t = Date.parse(r.t), u = Date.parse(r.u);
    if (Number.isNaN(t) || Number.isNaN(u)) { prev = null; continue; }
    let c;
    if (r.c && typeof r.c === 'object') c = { ...r.c };
    else if (r.d && typeof r.d === 'object' && prev) {
      c = { ...prev };
      for (const [slug, n] of Object.entries(r.d)) {
        if (n === null) delete c[slug]; else c[slug] = n;
      }
    } else { prev = null; continue; }
    out.push({ t, u: Math.max(t, u), c });
    prev = c;
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Every instant at which totals were actually observed. */
export function observations(records) {
  const obs = [];
  for (const r of records) {
    obs.push({ time: r.t, counts: r.c });
    if (r.u > r.t) obs.push({ time: r.u, counts: r.c });
  }
  return obs;
}

// ------------------------------------------------------------------ ranking

export function sortedSlugs(counts) {
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
}

/** Competition ranking: equal totals share a rank (1, 2, 2, 4). */
export function rankMap(counts) {
  const ranks = {};
  let prev = null, rank = 0;
  sortedSlugs(counts).forEach((slug, i) => {
    if (counts[slug] !== prev) { rank = i + 1; prev = counts[slug]; }
    ranks[slug] = rank;
  });
  return ranks;
}

// ------------------------------------------------------------------ time zones

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function zonedParts(ms) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, min: p.minute, s: p.second };
}

function zoneOffset(ms) {
  const p = zonedParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of the most recent Toronto midnight at or before `ms` (DST-safe). */
export function zonedMidnight(ms) {
  const p = zonedParts(ms);
  const guess = Date.UTC(p.y, p.m - 1, p.d);
  let m = guess - zoneOffset(guess);
  const off2 = zoneOffset(m);
  if (guess - off2 !== m) m = guess - off2;
  return m;
}

export function zonedDateKey(ms) {
  const p = zonedParts(ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ baselines

/**
 * Totals at (or near) `target`, never at or after `notAfter`.
 * 1. If one record spans the target (identical totals observed before and after it),
 *    the totals at the target are known exactly.
 * 2. Otherwise use the nearest observation within `tol`.
 * Returns {time, counts, exact, span?} or null when history does not reach that far.
 */
export function baselineAt(records, target, tol, notAfter) {
  for (const r of records) {
    if (r.t <= target && target <= r.u && target < notAfter) {
      return { time: target, counts: r.c, exact: true, span: [r.t, r.u] };
    }
  }
  let best = null;
  for (const o of observations(records)) {
    if (o.time >= notAfter) continue;
    const d = Math.abs(o.time - target);
    if (d <= tol && (!best || d < Math.abs(best.time - target))) best = o;
  }
  return best ? { time: best.time, counts: best.counts, exact: false } : null;
}

export function current(records) {
  const last = records[records.length - 1];
  return last ? { time: last.u, counts: last.c } : null;
}

function firstSeen(records, slug) {
  for (const r of records) if (slug in r.c) return { time: r.t, value: r.c[slug] };
  return null;
}

/**
 * Change for one project between a baseline and the current totals.
 *   {status:'ok', delta, from, to, fromValue, toValue, exact}
 *   {status:'new', delta, from, to}   project was not listed at the baseline; delta is
 *                                     measured from when we first saw it, never from zero
 *   {status:'collecting'}             not enough history
 */
export function changeFor(records, slug, base, cur = current(records)) {
  if (!cur || !(slug in cur.counts)) return { status: 'collecting' };
  if (!base) return { status: 'collecting' };
  if (!(slug in base.counts)) {
    const fs = firstSeen(records, slug);
    return { status: 'new', delta: cur.counts[slug] - fs.value, from: fs.time, to: cur.time };
  }
  return {
    status: 'ok', delta: cur.counts[slug] - base.counts[slug],
    from: base.time, to: cur.time, fromValue: base.counts[slug], toValue: cur.counts[slug],
    exact: base.exact,
  };
}

export function windowBaseline(records, win) {
  const cur = current(records);
  if (!cur) return null;
  return baselineAt(records, cur.time - win.ms, win.tol, cur.time);
}

/**
 * Baseline for "today" (Toronto). kind:
 *   'midnight'        a baseline near Toronto midnight exists
 *   'since'           collection had a gap at midnight; change is since the first observation today
 *   'tracking-began'  tracking itself started today, after midnight
 *   'none'            no observation yet today
 */
export function todayBaseline(records, nowMs) {
  const cur = current(records);
  const midnight = zonedMidnight(nowMs);
  if (!cur || cur.time < midnight) return { kind: 'none', midnight };
  const b = baselineAt(records, midnight, MIDNIGHT_TOL, cur.time);
  if (b) return { kind: 'midnight', midnight, base: b };
  const obs = observations(records);
  const first = obs.find((o) => o.time >= midnight);
  if (!first || first.time >= cur.time) return { kind: 'none', midnight };
  const kind = obs[0].time >= midnight ? 'tracking-began' : 'since';
  return { kind, midnight, base: { time: first.time, counts: first.counts, exact: false } };
}

export function rankChange(base, cur, slug) {
  if (!base || !cur || !(slug in cur.counts)) return { status: 'collecting' };
  if (!(slug in base.counts)) return { status: 'new' };
  const before = rankMap(base.counts)[slug], after = rankMap(cur.counts)[slug];
  return { status: 'ok', before, after, delta: before - after };
}

// ------------------------------------------------------------------ series for charts

/** [{x: time, y: total}] for one project at every observation inside [from, ∞). */
export function seriesFor(records, slug, from = -Infinity) {
  const pts = [];
  for (const o of observations(records)) {
    if (o.time < from || !(slug in o.counts)) continue;
    pts.push({ x: o.time, y: o.counts[slug] });
  }
  return pts;
}

export function rankSeriesFor(records, slug, from = -Infinity) {
  const pts = [];
  for (const o of observations(records)) {
    if (o.time < from || !(slug in o.counts)) continue;
    pts.push({ x: o.time, y: rankMap(o.counts)[slug] });
  }
  return pts;
}

/**
 * Votes per hour over time: at each observation, the change since the observation about
 * `windowMs` earlier (within ±half the window), divided by the real elapsed time.
 * Rises and falls with activity; never interpolated.
 */
export function paceSeriesFor(records, slug, from = -Infinity, windowMs = 30 * MIN) {
  const obs = observations(records).filter((o) => slug in o.counts);
  const pts = [];
  let j = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (o.time < from) continue;
    const target = o.time - windowMs;
    while (j + 1 < i && Math.abs(obs[j + 1].time - target) <= Math.abs(obs[j].time - target)) j++;
    const b = obs[j];
    if (!b || b.time >= o.time || Math.abs(b.time - target) > windowMs / 2) continue;
    pts.push({ x: o.time, y: (o.counts[slug] - b.counts[slug]) / ((o.time - b.time) / HOUR) });
  }
  return pts;
}

/** Net gain since the first observation of the range (or since first seen, if later). */
export function gainSeriesFor(records, slug, from = -Infinity) {
  const s = seriesFor(records, slug, from);
  if (!s.length) return s;
  const base = s[0].y;
  return s.map((p) => ({ x: p.x, y: p.y - base }));
}

// ------------------------------------------------------------------ events feed

/**
 * Differences between consecutive records, newest first.
 * kinds: gain, decrease, new, removed, rank (moved within top `rankDepth`), cutoff (entered/left top 5)
 */
export function buildEvents(records, { rankDepth = 10, cutoff = 5 } = {}) {
  const events = [];
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1], next = records[i];
    const at = next.t, since = prev.u;
    const r0 = rankMap(prev.c), r1 = rankMap(next.c);
    for (const slug of Object.keys(next.c)) {
      if (!(slug in prev.c)) { events.push({ kind: 'new', slug, at, since, total: next.c[slug] }); continue; }
      const delta = next.c[slug] - prev.c[slug];
      if (delta > 0) events.push({ kind: 'gain', slug, at, since, delta, total: next.c[slug], rank: r1[slug] });
      if (delta < 0) events.push({ kind: 'decrease', slug, at, since, delta, total: next.c[slug], rank: r1[slug] });
      const before = r0[slug], after = r1[slug];
      if (before !== after && Math.min(before, after) <= rankDepth) {
        const passed = Object.keys(prev.c).filter((o) => o !== slug && o in next.c
          && (after < before ? r0[o] < before && r0[o] >= after && r1[o] > after
                             : r0[o] > before && r0[o] <= after && r1[o] < after));
        events.push({ kind: 'rank', slug, at, since, before, after, passed });
      }
      if ((before <= cutoff) !== (after <= cutoff)) {
        events.push({ kind: 'cutoff', slug, at, since, entered: after <= cutoff, before, after });
      }
    }
    for (const slug of Object.keys(prev.c)) {
      if (!(slug in next.c)) events.push({ kind: 'removed', slug, at, since, total: prev.c[slug] });
    }
  }
  return events.sort((a, b) => b.at - a.at);
}

/**
 * Votes removed per project since `since`: the sum of every drop between consecutive
 * collections (gains in between don't cancel them out). {slug: {removed, times}}
 */
export function removedSince(records, since = -Infinity) {
  const out = {};
  for (let i = 1; i < records.length; i++) {
    if (records[i].t < since) continue;
    const prev = records[i - 1].c, next = records[i].c;
    for (const slug of Object.keys(next)) {
      if (slug in prev && next[slug] < prev[slug]) {
        const o = out[slug] || (out[slug] = { removed: 0, times: 0 });
        o.removed += prev[slug] - next[slug];
        o.times += 1;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ forecast

/**
 * Three paces, each measured over a real window:
 *   recent  last 3h (or 1h)       our snapshots; surges and lulls happening now
 *   day     last 24h (or 12h/6h)  our snapshots; smooths the overnight dip
 *   week    trailing ~7 days      the source's weekVotes; the long-run baseline
 * Momentum fades: the recent pace drives only the next MOMENTUM_HOURS, then the steadier
 * day/week blend takes over. So a burst or a slowdown moves the forecast without one hot
 * hour being stretched across two days. The range takes the slowest and fastest paces in
 * each stretch, widened to at least ±25% of the long-run pace (±50% with only one). Negative paces (vote removals) stay visible in the breakdown but count as
 * 0 going forward.
 */
export const MOMENTUM_HOURS = 3;
export const PACES = [
  { key: 'recent', label: 'Recent', windows: [3 * HOUR, 1 * HOUR] },
  { key: 'day', label: 'Last day', windows: [24 * HOUR, 12 * HOUR, 6 * HOUR], weight: 0.45 },
  { key: 'week', label: '7-day', weight: 0.55 },
];

/** Pace over a window ending at the latest collection, or null without history that far back. */
export function measuredPace(records, slug, windowMs) {
  const cur = current(records);
  if (!cur || !(slug in cur.counts)) return null;
  const base = baselineAt(records, cur.time - windowMs, windowMs * 0.25, cur.time);
  if (!base || !(slug in base.counts)) return null;
  const hours = (cur.time - base.time) / HOUR;
  if (hours <= 0) return null;
  const delta = cur.counts[slug] - base.counts[slug];
  return { rate: delta / hours, delta, from: base.time, to: cur.time, hours };
}

/** Pace from the source's trailing-week total, over the part of the week the project existed. */
export function weekPace(meta) {
  const votes = meta?.source_week_votes, at = Date.parse(meta?.source_week_votes_at || '');
  if (!Number.isFinite(votes) || !Number.isFinite(at)) return null;
  let hours = 168;
  if (meta.published_on) {
    const start = zonedMidnight(Date.parse(meta.published_on + 'T12:00:00Z'));
    hours = Math.min(168, (at - start) / HOUR);
  }
  if (!(hours >= 6)) return null;
  return { rate: votes / hours, delta: votes, from: at - hours * HOUR, to: at, hours, source: true };
}

export function forecast(records, closeMs, projects = {}) {
  const cur = current(records);
  if (!cur) return null;
  const remainingHours = Math.max(0, closeMs - cur.time) / HOUR;
  const nearH = Math.min(MOMENTUM_HOURS, remainingHours), restH = remainingHours - nearH;
  const out = { at: cur.time, remainingHours, nearHours: nearH, projected: {}, low: {}, high: {}, pacePerHour: {}, parts: {}, trend: {} };
  let any = false;
  for (const slug of Object.keys(cur.counts)) {
    const parts = [];
    for (const c of PACES) {
      let m = null;
      if (c.key === 'week') m = weekPace(projects[slug]);
      else {
        for (const w of c.windows) {
          // The "day" pace must look further back than the "recent" one to add anything.
          if (c.key === 'day' && parts[0]?.key === 'recent' && w <= parts[0].hours * HOUR * 1.5) break;
          m = measuredPace(records, slug, w);
          if (m) break;
        }
      }
      if (m) parts.push({ ...m, key: c.key, label: c.label, weight: c.weight || 0 });
    }
    if (!parts.length) continue;
    any = true;
    const pos = (p) => Math.max(0, p.rate);
    const recent = parts.find((p) => p.key === 'recent');
    const longRun = parts.filter((p) => p.key !== 'recent');
    // Long-run pace: day/week blend; falls back to the recent pace when nothing longer exists.
    const total = longRun.reduce((s, p) => s + p.weight, 0);
    const base = longRun.length ? longRun.reduce((s, p) => s + pos(p) * p.weight / total, 0) : pos(recent);
    // Daily voting swings a lot (a best day can be 2–3× the weekly average), so the long-run
    // range is never narrower than ±25%, and ±50% when only one long-run pace exists.
    const spread = longRun.length >= 2 ? 0.25 : 0.5;
    const baseLo = Math.min(base * (1 - spread), ...longRun.map(pos));
    const baseHi = Math.max(base * (1 + spread), ...longRun.map(pos));
    const near = recent ? pos(recent) : base;
    const now = cur.counts[slug];
    out.parts[slug] = parts.map((p) => ({
      ...p,
      use: p.key === 'recent' ? `next ${Math.round(nearH)}h` : longRun.length > 1 ? `then ${Math.round(p.weight / total * 100)}%` : 'then 100%',
    }));
    out.projected[slug] = Math.round(now + near * nearH + base * restH);
    out.low[slug] = Math.round(now + Math.min(near, baseLo) * nearH + baseLo * restH);
    out.high[slug] = Math.round(now + Math.max(near, baseHi) * nearH + baseHi * restH);
    out.pacePerHour[slug] = remainingHours > 0 ? (out.projected[slug] - now) / remainingHours : 0;
    let trend = 'steady';
    if (recent && longRun.length) {
      const r = pos(recent), b = base;
      if (r > b * 1.35 && r - b >= 0.5) trend = 'up';
      else if (r < b * 0.65 && b - r >= 0.5) trend = 'down';
    }
    out.trend[slug] = trend;
  }
  return any ? out : null;
}

// ------------------------------------------------------------------ gaps

/** Lead (+) or deficit (−) of `slug` against whoever holds position `pos` (1-based). */
export function gapToPosition(counts, slug, pos) {
  const order = sortedSlugs(counts);
  const me = order.indexOf(slug);
  if (me < 0 || order.length < pos) return null;
  const myRank = rankMap(counts)[slug];
  if (order[pos - 1] === slug) {
    // We hold this position: compare with the next one down.
    const other = order[pos];
    return other ? { self: true, other, gap: counts[slug] - counts[other], myRank } : null;
  }
  const other = order[pos - 1];
  return { self: false, other, gap: counts[slug] - counts[other], myRank };
}
