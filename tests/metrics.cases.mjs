// Checks for site/js/metrics.js. Runs under `node --test tests/` (via metrics.test.mjs)
// and in a browser via tests/browser.html, so it uses its own tiny assert helpers.
import * as M from '../site/js/metrics.js';

const MIN = 60e3, H = 60 * MIN;
const iso = (s) => Date.parse(s);
const eq = (a, b, msg = '') => {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg} expected ${jb}, got ${ja}`);
};
const ok = (v, msg = 'expected truthy') => { if (!v) throw new Error(msg); };

/** Build records from [isoT, isoU, counts] triples. */
const recs = (...rows) => rows.map(([t, u, c]) => ({ t: iso(t), u: iso(u), c }));

export const cases = [
  ['parses keyframes and deltas, including removals', () => {
    const text = [
      '{"t":"2026-10-29T14:00:00Z","u":"2026-10-29T14:00:00Z","c":{"a":1,"b":5,"c":3}}',
      '{"t":"2026-10-29T14:03:00Z","u":"2026-10-29T14:09:00Z","d":{"a":4,"c":null}}',
      '',
      '{"t":"2026-10-29T14:12:00Z","u":"2026-10-29T14:12:00Z","d":{"b":6}}',
    ].join('\n');
    const r = M.parseSnapshots(text);
    eq(r.length, 3);
    eq(r[1].c, { a: 4, b: 5 });
    eq(r[2].c, { a: 4, b: 6 });
    eq(r[1].u - r[1].t, 6 * MIN);
  }],

  ['a malformed line breaks the delta chain instead of corrupting totals', () => {
    const text = [
      '{"t":"2026-10-29T14:00:00Z","u":"2026-10-29T14:00:00Z","c":{"a":1}}',
      'not json',
      '{"t":"2026-10-29T14:06:00Z","u":"2026-10-29T14:06:00Z","d":{"a":9}}',
      '{"t":"2026-10-29T14:09:00Z","u":"2026-10-29T14:09:00Z","c":{"a":10}}',
    ].join('\n');
    const r = M.parseSnapshots(text);
    eq(r.map((x) => x.c.a), [1, 10]);
  }],

  ['competition ranking shares ranks on ties', () => {
    eq(M.rankMap({ a: 10, b: 7, c: 7, d: 3 }), { a: 1, b: 2, c: 2, d: 4 });
  }],

  ['rolling window uses an observation within tolerance and reports the real interval', () => {
    const r = recs(
      ['2026-10-29T12:50:00Z', '2026-10-29T12:50:00Z', { a: 100 }],
      ['2026-10-29T13:30:00Z', '2026-10-29T13:30:00Z', { a: 110 }],
      ['2026-10-29T14:05:00Z', '2026-10-29T14:05:00Z', { a: 125 }]);
    const base = M.windowBaseline(r, M.WINDOWS[0]);            // target 13:05, ±20m
    ok(base, 'baseline expected');
    eq(new Date(base.time).toISOString(), '2026-10-29T12:50:00.000Z');   // 15 min from target beats 25 min
    const ch = M.changeFor(r, 'a', base);
    eq([ch.status, ch.delta, ch.to - ch.from], ['ok', 25, 75 * MIN]);
  }],

  ['missing history shows collecting instead of zero', () => {
    const r = recs(['2026-10-29T13:40:00Z', '2026-10-29T14:00:00Z', { a: 1 }]);
    const base = M.windowBaseline(r, M.WINDOWS[3]);           // 24h
    eq(base, null);
    eq(M.changeFor(r, 'a', base).status, 'collecting');
    eq(M.rankChange(base, M.current(r), 'a').status, 'collecting');
  }],

  ['an unchanged record spanning the target gives an exact baseline', () => {
    const r = recs(
      ['2026-10-29T10:00:00Z', '2026-10-29T13:30:00Z', { a: 50 }],   // quiet for 3.5h
      ['2026-10-29T14:00:00Z', '2026-10-29T14:00:00Z', { a: 58 }]);
    const base = M.windowBaseline(r, M.WINDOWS[1]);             // target 09:00 → not covered
    eq(base, null);
    const b1 = M.windowBaseline(r, M.WINDOWS[0]);               // target 13:00, inside the span
    eq([b1.exact, b1.time], [true, iso('2026-10-29T13:00:00Z')]);
    eq(M.changeFor(r, 'a', b1).delta, 8);
  }],

  ['negative changes stay negative and are reported as decreases', () => {
    const r = recs(
      ['2026-10-29T13:00:00Z', '2026-10-29T13:00:00Z', { a: 40, b: 30 }],
      ['2026-10-29T14:00:00Z', '2026-10-29T14:00:00Z', { a: 37, b: 31 }]);
    const ch = M.changeFor(r, 'a', M.windowBaseline(r, M.WINDOWS[0]));
    eq(ch.delta, -3);
    const ev = M.buildEvents(r).filter((e) => e.kind === 'decrease');
    eq(ev.map((e) => [e.slug, e.delta]), [['a', -3]]);
  }],

  ['new projects never count their whole total as gained', () => {
    const r = recs(
      ['2026-10-29T13:00:00Z', '2026-10-29T13:00:00Z', { a: 40 }],
      ['2026-10-29T13:30:00Z', '2026-10-29T13:30:00Z', { a: 41, n: 300 }],
      ['2026-10-29T14:00:00Z', '2026-10-29T14:00:00Z', { a: 42, n: 305 }]);
    const ch = M.changeFor(r, 'n', M.windowBaseline(r, M.WINDOWS[0]));
    eq([ch.status, ch.delta, ch.from], ['new', 5, iso('2026-10-29T13:30:00Z')]);
    eq(M.rankChange(M.windowBaseline(r, M.WINDOWS[0]), M.current(r), 'n').status, 'new');
    ok(M.buildEvents(r).some((e) => e.kind === 'new' && e.slug === 'n'));
    ok(!M.buildEvents(r).some((e) => e.kind === 'gain' && e.slug === 'n' && e.delta === 300));
  }],

  ['Toronto midnight is DST-aware', () => {
    // EDT (UTC-4) on Oct 31; EST (UTC-5) from Nov 2; DST ends 2026-11-01 02:00 local.
    eq(new Date(M.zonedMidnight(iso('2026-10-31T15:00:00Z'))).toISOString(), '2026-10-31T04:00:00.000Z');
    eq(new Date(M.zonedMidnight(iso('2026-11-01T12:00:00Z'))).toISOString(), '2026-11-01T04:00:00.000Z');
    eq(new Date(M.zonedMidnight(iso('2026-11-02T12:00:00Z'))).toISOString(), '2026-11-02T05:00:00.000Z');
    eq(new Date(M.zonedMidnight(iso('2027-03-14T12:00:00Z'))).toISOString(), '2027-03-14T05:00:00.000Z');
    // 11:30 PM Toronto on Oct 29 is already Oct 30 in UTC, but still Oct 29 locally.
    eq(M.zonedDateKey(iso('2026-10-30T03:30:00Z')), '2026-10-29');
    eq(new Date(M.zonedMidnight(iso('2026-10-30T03:30:00Z'))).toISOString(), '2026-10-29T04:00:00.000Z');
  }],

  ['today uses a baseline near Toronto midnight', () => {
    const r = recs(
      ['2026-10-30T03:50:00Z', '2026-10-30T03:50:00Z', { a: 100 }],   // 11:50 PM Oct 29 local
      ['2026-10-30T14:00:00Z', '2026-10-30T14:00:00Z', { a: 160 }]);
    const tb = M.todayBaseline(r, iso('2026-10-30T14:05:00Z'));
    eq(tb.kind, 'midnight');
    eq(M.changeFor(r, 'a', tb.base).delta, 60);
  }],

  ['today says "since tracking began" when collection started after midnight', () => {
    const r = recs(
      ['2026-10-29T18:00:00Z', '2026-10-29T18:00:00Z', { a: 100 }],
      ['2026-10-29T20:00:00Z', '2026-10-29T20:00:00Z', { a: 130 }]);
    const tb = M.todayBaseline(r, iso('2026-10-29T20:01:00Z'));
    eq(tb.kind, 'tracking-began');
    eq(M.changeFor(r, 'a', tb.base).delta, 30);
  }],

  ['today reports a gap at midnight as "since" the first collection of the day', () => {
    const r = recs(
      ['2026-10-29T20:00:00Z', '2026-10-29T20:00:00Z', { a: 100 }],
      ['2026-10-30T09:00:00Z', '2026-10-30T09:00:00Z', { a: 120 }],   // collector was down overnight
      ['2026-10-30T15:00:00Z', '2026-10-30T15:00:00Z', { a: 150 }]);
    const tb = M.todayBaseline(r, iso('2026-10-30T15:01:00Z'));
    eq(tb.kind, 'since');
    eq(M.changeFor(r, 'a', tb.base).delta, 30);
  }],

  ['today is empty before the first collection of the day', () => {
    const r = recs(['2026-10-29T20:00:00Z', '2026-10-29T20:00:00Z', { a: 100 }]);
    eq(M.todayBaseline(r, iso('2026-10-30T05:00:00Z')).kind, 'none');   // 1 AM Oct 30 local
  }],

  ['rank change and overtakes', () => {
    const r = recs(
      ['2026-10-29T13:00:00Z', '2026-10-29T13:00:00Z', { a: 50, b: 40, c: 30 }],
      ['2026-10-29T14:00:00Z', '2026-10-29T14:00:00Z', { a: 50, b: 40, c: 45 }]);
    const base = M.windowBaseline(r, M.WINDOWS[0]);
    eq(M.rankChange(base, M.current(r), 'c'), { status: 'ok', before: 3, after: 2, delta: 1 });
    const up = M.buildEvents(r).find((e) => e.kind === 'rank' && e.slug === 'c');
    eq([up.before, up.after, up.passed], [3, 2, ['b']]);
  }],

  ['cutoff events fire when crossing the funded line', () => {
    const before = { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4 };
    const r = recs(['2026-10-29T13:00:00Z', '2026-10-29T13:00:00Z', before],
      ['2026-10-29T13:03:00Z', '2026-10-29T13:03:00Z', { ...before, f: 6.5 }]);
    const ev = M.buildEvents(r).filter((e) => e.kind === 'cutoff');
    eq(ev.map((e) => [e.slug, e.entered]).sort(), [['e', false], ['f', true]]);
  }],

  ['gap to a position, including when we hold it', () => {
    const c = { rex: 100, b: 80, c: 70, d: 60, e: 50, f: 40, g: 30 };
    eq(M.gapToPosition(c, 'rex', 2), { self: false, other: 'b', gap: 20, myRank: 1 });
    eq(M.gapToPosition(c, 'rex', 6), { self: false, other: 'f', gap: 60, myRank: 1 });
    eq(M.gapToPosition(c, 'b', 2), { self: true, other: 'c', gap: 10, myRank: 2 });
    eq(M.gapToPosition(c, 'g', 6), { self: false, other: 'f', gap: -10, myRank: 7 });
  }],

  ['projection needs an hour of history and uses observed pace only', () => {
    const short = recs(['2026-10-29T13:30:00Z', '2026-10-29T14:00:00Z', { a: 10 }]);
    eq(M.project(short, iso('2026-10-31T00:00:00Z')), null);
    const r = recs(
      ['2026-10-29T10:00:00Z', '2026-10-29T10:00:00Z', { a: 100, b: 100 }],
      ['2026-10-29T14:00:00Z', '2026-10-29T14:00:00Z', { a: 140, b: 90 }]);
    const p = M.project(r, iso('2026-10-30T00:00:00Z'));
    eq(p.pacePerHour.a, 10);
    eq(p.projected.a, 240);
    eq(p.projected.b, 90);            // decreases never project downward
  }],

  ['pace rises and falls with observed gains per hour', () => {
    const r = recs(
      ['2026-10-29T13:00:00Z', '2026-10-29T13:00:00Z', { a: 100 }],
      ['2026-10-29T13:30:00Z', '2026-10-29T13:30:00Z', { a: 110 }],   // +10 in 30m = 20/h
      ['2026-10-29T14:00:00Z', '2026-10-29T14:00:00Z', { a: 112 }],   // +2 in 30m = 4/h
      ['2026-10-29T14:20:00Z', '2026-10-29T14:20:00Z', { a: 112 }]);  // nothing 30m ±15m back of 14:20 except 14:00 (20m)
    eq(M.paceSeriesFor(r, 'a').map((p) => p.y), [20, 4, 0]);
  }],

  ['chart series follow observations only', () => {
    const r = recs(['2026-10-29T13:00:00Z', '2026-10-29T13:30:00Z', { a: 5 }],
      ['2026-10-29T14:00:00Z', '2026-10-29T14:00:00Z', { a: 9 }]);
    eq(M.seriesFor(r, 'a').map((p) => p.y), [5, 5, 9]);
    eq(M.gainSeriesFor(r, 'a').map((p) => p.y), [0, 0, 4]);
    eq(M.rankSeriesFor(r, 'a').map((p) => p.y), [1, 1, 1]);
  }],
];
