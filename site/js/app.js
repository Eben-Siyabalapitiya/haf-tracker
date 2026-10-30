import * as M from './metrics.js';

const CFG = {
  highlightSlug: 'hack-the-rex-7615bd', sourceUrl: 'https://schools.tks.world/high-agency-fund',
  votingClosesAt: '2026-11-01T03:59:00Z', fundedSpots: 5, refreshSeconds: 60, staleAfterMinutes: 40, repo: null,
  ...(window.TRACKER_CONFIG || {}),
};
const HL = CFG.highlightSlug;
const CLOSE = Date.parse(CFG.votingClosesAt);
const FUNDED = CFG.fundedSpots;
const HOUR = 3600e3;
const PALETTE = ['#f07b3f', '#4fc3c8', '#a98bf5', '#f2709c', '#6fa8ff', '#b5d65a', '#e0b07a', '#ff5d5d'];
const REX = '#ffd23f';
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state

const store = {
  get(k, d) { try { const v = localStorage.getItem('htr:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('htr:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  records: [], projects: {}, status: {}, loadedKey: null, source: null,
  lastPoll: 0, pollError: null, loading: false, firstLoad: true,
  chart: store.get('chart', 'totals'), range: store.get('range', 0), mom: store.get('mom', '5h'),
  feed: store.get('feed', 'all'), limit: store.get('limit', 0), rankPeriod: store.get('rankPeriod', '24h'),
  selected: store.get('selected', null), sort: { key: 'rank', dir: 1 }, search: '', showProj: store.get('showProj', true),
};

// ------------------------------------------------------------------ formatting

const nf = new Intl.NumberFormat('en-US');
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: M.TZ, hour: 'numeric', minute: '2-digit' });
const dtFmt = new Intl.DateTimeFormat('en-US', { timeZone: M.TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmt = (n) => nf.format(n);
const signed = (n) => (n > 0 ? '+' + fmt(n) : n < 0 ? '−' + fmt(-n) : '0');
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'zero');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function when(ms) { return M.zonedDateKey(ms) === M.zonedDateKey(Date.now()) ? timeFmt.format(ms) : dtFmt.format(ms); }
function dur(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return h < 48 ? `${h}h ${String(r).padStart(2, '0')}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${dur(Date.now() - ms)} ago`;
}
const title = (slug) => state.projects[slug]?.title || slug;
const school = (slug) => state.projects[slug]?.school || '';

// ------------------------------------------------------------------ data loading

function repoInfo() {
  if (CFG.repo) return { branch: 'main', ...CFG.repo };
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return null;
  const owner = host.slice(0, -'.github.io'.length);
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner, name: seg && !seg.includes('.') ? seg : host, branch: 'main' };
}
const SOURCES = [{ name: 'site', label: 'this site', base: 'data/' }];
const repo = repoInfo();
if (repo) SOURCES.push({ name: 'repo', label: 'GitHub repository', base: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.branch}/data/` });

async function getText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

async function poll() {
  if (state.loading) return;
  state.loading = true;
  $('refreshBtn').classList.add('spinning');
  const prevLast = state.records.length ? state.records[state.records.length - 1].t : null;
  try {
    const found = (await Promise.allSettled(SOURCES.map(async (src) => {
      const status = JSON.parse(await getText(`${src.base}status.json?t=${Date.now()}`));
      return { src, status };
    }))).filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!found.length) throw new Error('Could not reach the tracker data');
    found.sort((a, b) => String(b.status.last_success || '').localeCompare(String(a.status.last_success || '')));
    state.status = found[0].status;
    for (const { src, status } of found) {
      const key = `${status.last_success}|${status.last_change}`;
      if (key === state.loadedKey) break;
      try {
        const v = encodeURIComponent(key);
        const [snapText, projText] = await Promise.all([
          getText(`${src.base}snapshots.jsonl?v=${v}`), getText(`${src.base}projects.json?v=${v}`)]);
        const recs = M.parseSnapshots(snapText);
        if (!recs.length) throw new Error('no snapshots');
        const newestU = recs[recs.length - 1].u;
        const haveU = state.records.length ? state.records[state.records.length - 1].u : -Infinity;
        if (newestU < haveU) continue;                       // an older cached copy; ignore
        state.records = recs;
        state.projects = JSON.parse(projText);
        state.source = src;
        // Only remember the key once the snapshot file has caught up with its status file.
        if (newestU >= Date.parse(status.last_success) - 1000) state.loadedKey = key;
        break;
      } catch { /* try the next source */ }
    }
    state.pollError = state.records.length ? null : 'No snapshots collected yet';
  } catch (err) {
    state.pollError = err.message || String(err);
  } finally {
    state.lastPoll = Date.now();
    state.loading = false;
    $('refreshBtn').classList.remove('spinning');
  }
  render();
  if (!state.firstLoad && prevLast !== null) notifyNew(prevLast);
  if (state.records.length) state.firstLoad = false;
}

// ------------------------------------------------------------------ derived values

function derive() {
  const records = state.records;
  const cur = M.current(records);
  if (!cur) return null;
  const order = M.sortedSlugs(cur.counts);
  const ranks = M.rankMap(cur.counts);
  const bases = {};
  for (const w of M.WINDOWS) bases[w.key] = M.windowBaseline(records, w);
  const today = M.todayBaseline(records, Date.now());
  bases.today = today.base || null;
  return { records, cur, order, ranks, bases, today, first: records[0].t };
}

function selection(d) {
  if (Array.isArray(state.selected)) {
    const sel = state.selected.filter((s) => s in d.cur.counts);
    if (sel.length) return sel;
  }
  return closestRivals(d);
}

function closestRivals(d, n = 6) {
  const i = d.order.indexOf(HL);
  if (i < 0) return d.order.slice(0, 5);
  const picks = [HL];
  for (let k = 1; picks.length < n + 1 && k < d.order.length; k++) {
    if (d.order[i - k]) picks.push(d.order[i - k]);
    if (picks.length < n + 1 && d.order[i + k]) picks.push(d.order[i + k]);
  }
  return picks;
}

function colorFor(slug, sel) {
  if (slug === HL) return REX;
  const others = sel.filter((s) => s !== HL);
  return PALETTE[Math.max(0, others.indexOf(slug)) % PALETTE.length];
}

// ------------------------------------------------------------------ rendering

function render() {
  const d = derive();
  renderStatus(d);
  if (!d) { renderEmpty(); return; }
  renderHero(d);
  renderChart(d);
  renderMomentum(d);
  renderBoard(d);
  renderFeed(d);
  renderProjection(d);
}

function renderEmpty() {
  const msg = state.pollError ? esc(state.pollError) : 'Loading…';
  $('stats').innerHTML = `<div class="stat" style="grid-column:1/-1"><p class="label">Status</p><div class="s">${msg}</div></div>`;
}

function lastSuccess(d) {
  const s = Date.parse(state.status.last_success || '') || 0;
  return Math.max(s, d ? d.cur.time : 0);
}

function renderStatus(d) {
  const pill = $('statusPill'), text = $('statusText'), banner = $('banner');
  const now = Date.now();
  const ok = lastSuccess(d);
  const err = state.status.last_error;
  const errNewer = err && Date.parse(err.at) > Date.parse(state.status.last_success || 0);
  let st, label, bannerText = '', bannerCls = '';
  if (!d) { st = state.pollError ? 'error' : 'loading'; label = state.pollError ? 'No data' : 'Loading'; }
  else if (state.pollError) { st = 'error'; label = 'Offline · retrying'; bannerText = `This page could not reach the tracker data (${esc(state.pollError)}). Showing the last data it loaded.`; }
  else if (errNewer) { st = 'error'; label = `Source error · ${ago(ok)}`; bannerText = `The last collection attempt failed (${esc(err.message)}, ${when(Date.parse(err.at))}). Showing the last valid data from ${when(ok)}.`; }
  else if (now - ok > CFG.staleAfterMinutes * 60e3) { st = 'stale'; label = `Stale · ${ago(ok)}`; bannerCls = 'warn'; bannerText = `No successful collection since ${when(ok)}. GitHub can delay scheduled runs; the numbers below may be behind the live ballot.`; }
  else if (now > CLOSE) { st = 'closed'; label = 'Voting closed'; }
  else { st = 'live'; label = `Live · ${ago(ok)}`; }
  pill.dataset.state = st;
  text.textContent = label;

  // Decreases are rare and worth surfacing even when everything else is healthy.
  if (d && !bannerText) {
    const recent = M.buildEvents(d.records).filter((e) => (e.kind === 'decrease' || e.kind === 'removed') && now - e.at < 24 * HOUR);
    if (recent.length) {
      bannerCls = 'warn';
      bannerText = 'Vote decrease observed in the last 24h: ' + recent.slice(0, 3).map((e) => e.kind === 'removed'
        ? `${esc(title(e.slug))} no longer listed (${when(e.at)})`
        : `${esc(title(e.slug))} ${signed(e.delta)} (${when(e.at)})`).join(' · ') + '. Corrections or removals on the source can cause this.';
    }
  }
  banner.hidden = !bannerText;
  banner.className = 'banner ' + bannerCls;
  banner.innerHTML = bannerText;

  // System card
  const rows = [];
  rows.push(['Status', `<span class="${st === 'error' ? 'down' : st === 'stale' ? '' : 'up'}">${esc(label)}</span>`]);
  if (d) rows.push(['Last collection', `${when(ok)}<br><span class="zero">${ago(ok)}</span>`]);
  if (state.status.source_checked_at) rows.push(['Source clock', when(Date.parse(state.status.source_checked_at))]);
  rows.push(['Page checked', state.lastPoll ? `${ago(state.lastPoll)} · next in <span id="nextPoll">${nextPollIn()}</span>s` : '—']);
  if (state.source) rows.push(['Read from', esc(state.source.label)]);
  if (d) rows.push(['Snapshots', `${fmt(d.records.length)} · since ${when(d.first)}`]);
  if (d) rows.push(['Projects', fmt(Object.keys(d.cur.counts).length)]);
  if (state.status.parser_strategy) rows.push(['Parser', esc(state.status.parser_strategy)]);
  if (err) rows.push(['Last error', `<span class="${errNewer ? 'err' : 'zero'}">${esc(err.message)}<br>${when(Date.parse(err.at))}</span>`]);
  rows.push(['Schedule', 'GitHub Actions · ~3 min']);
  $('system').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function nextPollIn() {
  return Math.max(0, Math.round((state.lastPoll + CFG.refreshSeconds * 1000 - Date.now()) / 1000));
}

function todayLabel(d) {
  switch (d.today.kind) {
    case 'midnight': return 'since midnight';
    case 'tracking-began': return `since tracking began ${timeFmt.format(d.today.base.time)}`;
    case 'since': return `since ${timeFmt.format(d.today.base.time)} (no midnight baseline)`;
    default: return 'no collection yet today';
  }
}

function renderHero(d) {
  const counts = d.cur.counts;
  const inBallot = HL in counts;
  $('heroTitle').textContent = title(HL) || 'Hack The Rex';
  if (school(HL)) $('heroLede').textContent = `${school(HL)} · ${fmt(Object.keys(counts).length)} projects on the ballot · top ${FUNDED} get funded`;
  if (!inBallot) { $('stats').innerHTML = '<div class="stat" style="grid-column:1/-1"><div class="s">Hack The Rex is not on the current ballot.</div></div>'; return; }
  const rank = d.ranks[HL];
  const stat = (label, v, s, extra = '') => `<div class="stat ${extra}"><p class="label">${label}</p><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const out = [];
  out.push(stat('Rank', `#${rank}<small>/${Object.keys(counts).length}</small>`, rank <= FUNDED ? 'inside the funded top 5' : `${rank - FUNDED} place${rank - FUNDED > 1 ? 's' : ''} outside the top 5`, 'rex'));
  out.push(stat('Weighted votes', fmt(counts[HL]), 'not unique voters', 'rex'));

  const g2 = M.gapToPosition(counts, HL, 2);
  if (g2) {
    const sub = g2.self ? `ahead of #3 ${title(g2.other)}` : g2.gap >= 0 ? `lead over #2 ${title(g2.other)}` : `behind #2 ${title(g2.other)}`;
    const lbl = rank === 1 ? 'Lead over #2' : 'vs #2';
    out.push(stat(lbl, `<span class="${cls(g2.gap)}">${signed(g2.gap)}</span>`, esc(sub)));
  }
  const g6 = rank === FUNDED + 1 ? M.gapToPosition(counts, HL, FUNDED) : M.gapToPosition(counts, HL, FUNDED + 1);
  if (g6) {
    const sub = rank === FUNDED + 1 ? `to pass #${FUNDED} ${title(g6.other)}`
      : g6.gap >= 0 ? `cushion over #6 ${title(g6.other)}` : `behind #6 ${title(g6.other)}`;
    out.push(stat(rank <= FUNDED ? 'Cushion over #6' : 'vs funding line', `<span class="${cls(g6.gap)}">${signed(g6.gap)}</span>`, esc(sub)));
  }
  const tc = M.changeFor(d.records, HL, d.bases.today, d.cur);
  out.push(stat('Today', tc.status === 'collecting' ? '<span class="zero">—</span>' : `<span class="${cls(tc.delta)}">${signed(tc.delta)}</span>`, esc(todayLabel(d))));
  const p = M.project(d.records, CLOSE);
  if (p && Date.now() < CLOSE) {
    const pr = M.rankMap(p.projected)[HL];
    out.push(stat('Projected final', `~${fmt(p.projected[HL])}`, `projected #${pr} at close`));
  } else if (Date.now() >= CLOSE) {
    out.push(stat('Final', fmt(counts[HL]), 'voting has closed'));
  } else {
    out.push(stat('Projected final', '<span class="zero">—</span>', 'collecting history'));
  }
  $('stats').innerHTML = out.join('');
}

// ---------------------------------------------------------------- chart

let chart = null;
// Draws "now" and "close" guides on the chart.
const markers = {
  id: 'markers', now: null, close: null,
  afterDatasetsDraw(c) {
    const { ctx, chartArea: a, scales: { x } } = c;
    const line = (v, text, color) => {
      if (v == null || v < x.min || v > x.max) return;
      const px = x.getPixelForValue(v);
      ctx.save();
      ctx.strokeStyle = color; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = color; ctx.font = '500 10px "IBM Plex Mono", monospace';
      const right = px > a.right - 50;
      ctx.textAlign = right ? 'right' : 'left';
      ctx.fillText(text, px + (right ? -5 : 5), a.top + 10);
      ctx.restore();
    };
    line(markers.now, 'NOW', 'rgba(239,235,228,0.5)');
    line(markers.close, 'CLOSE', 'rgba(240,123,63,0.85)');
  },
};
function renderChart(d) {
  for (const b of $('chartTabs').children) b.setAttribute('aria-selected', String(b.dataset.chart === state.chart));
  for (const b of $('rangeSeg').children) b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.range));
  const sel = selection(d);
  $('chips').innerHTML = sel.map((s) => `<span class="chip"><i style="background:${colorFor(s, sel)}"></i><span>${esc(title(s))}</span><button type="button" data-unselect="${esc(s)}" aria-label="Remove ${esc(title(s))}">×</button></span>`).join('');
  if (!window.Chart) { setTimeout(() => renderChart(derive()), 250); return; }

  const from = state.range ? d.cur.time - state.range * HOUR : -Infinity;
  const fn = state.chart === 'rank' ? M.rankSeriesFor : state.chart === 'gain' ? M.gainSeriesFor : M.seriesFor;
  const datasets = sel.map((slug) => {
    const data = fn(d.records, slug, from);
    const color = colorFor(slug, sel);
    return {
      label: title(slug), slug, data, borderColor: color, backgroundColor: color,
      borderWidth: slug === HL ? 3.2 : 2, pointRadius: data.length < 40 ? 2.5 : 0, pointHoverRadius: 5,
      tension: 0, order: slug === HL ? 0 : 1,
    };
  });
  // Faded dashed line from each project's latest total to its straight-line projection at the close.
  const proj = state.showProj && Date.now() < CLOSE ? M.project(d.records, CLOSE) : null;
  const projRanks = proj ? M.rankMap(proj.projected) : null;
  if (proj) {
    for (const ds of [...datasets]) {
      if (!ds.data.length || !(ds.slug in proj.projected)) continue;
      const last = ds.data[ds.data.length - 1];
      const end = state.chart === 'rank' ? projRanks[ds.slug]
        : state.chart === 'gain' ? last.y + proj.projected[ds.slug] - d.cur.counts[ds.slug]
        : proj.projected[ds.slug];
      datasets.push({
        label: `${ds.label} (projected)`, slug: ds.slug, projection: true,
        data: [{ x: last.x, y: last.y }, { x: CLOSE, y: end }],
        borderColor: ds.borderColor + '70', backgroundColor: ds.borderColor + '70',
        borderDash: [6, 6], borderWidth: Math.max(1.4, ds.borderWidth - 0.6), pointRadius: [0, 3.5], pointHoverRadius: 5,
        tension: 0, order: 2,
      });
    }
  }
  const points = Math.max(0, ...datasets.filter((x) => !x.projection).map((x) => x.data.length));
  const empty = $('chartEmpty');
  if (points < 2) {
    empty.hidden = false;
    empty.innerHTML = `<div><strong>Collecting history</strong>One snapshot so far (${when(d.cur.time)}). Lines appear after the next collection, about every 3 minutes.</div>`;
  } else empty.hidden = true;

  const isRank = state.chart === 'rank';
  const maxRank = Math.max(2, ...datasets.flatMap((x) => x.data.map((p) => p.y)));
  const x0 = Number.isFinite(from) ? Math.max(from, d.first) : d.first;
  const xMax = proj ? CLOSE : d.cur.time;
  const longRange = xMax - x0 > 20 * HOUR;
  const options = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#24211d', borderColor: 'rgba(239,235,228,0.14)', borderWidth: 1, padding: 10,
        titleFont: { family: 'IBM Plex Mono', size: 11 }, bodyFont: { family: 'IBM Plex Sans', size: 12.5 },
        itemSort: (a, b) => (isRank ? a.parsed.y - b.parsed.y : b.parsed.y - a.parsed.y),
        callbacks: {
          title: (items) => items.length ? dtFmt.format(items[0].parsed.x) : '',
          label: (it) => ` ${it.dataset.label}: ${isRank ? '#' + it.parsed.y : state.chart === 'gain' ? signed(Math.round(it.parsed.y)) : (it.dataset.projection ? '~' : '') + fmt(Math.round(it.parsed.y))}`,
        },
      },
    },
    scales: {
      x: {
        type: 'linear', min: x0, max: xMax,
        grid: { color: 'rgba(239,235,228,0.05)' }, border: { color: 'rgba(239,235,228,0.1)' },
        ticks: { color: '#75716b', font: { family: 'IBM Plex Mono', size: 10.5 }, maxTicksLimit: 7, maxRotation: 0,
          callback: (v) => (longRange ? dtFmt.format(v).replace(/:\d\d /, ' ') : timeFmt.format(v)) },
      },
      y: {
        reverse: isRank, grid: { color: 'rgba(239,235,228,0.05)' }, border: { display: false },
        ticks: { color: '#75716b', font: { family: 'IBM Plex Mono', size: 10.5 }, precision: 0,
          ...(isRank ? { stepSize: 1 } : {}),
          callback: (v) => (isRank ? '#' + v : state.chart === 'gain' ? signed(v) : fmt(v)) },
        ...(isRank ? {
          min: 0.6, max: maxRank + 0.4,
          afterBuildTicks: (axis) => { axis.ticks = Array.from({ length: maxRank }, (_, i) => ({ value: i + 1 })); },
        } : {}),
      },
    },
  };
  if (!chart) {
    Chart.defaults.font.family = 'IBM Plex Sans';
    Chart.defaults.color = '#a39e96';
    chart = new Chart($('chart'), { type: 'line', data: { datasets }, options, plugins: [markers] });
  } else {
    chart.data.datasets = datasets;
    chart.options = options;
    chart.update();
  }
  markers.now = d.cur.time;
  markers.close = proj ? CLOSE : null;
  $('projToggle').textContent = state.showProj ? 'Projection on' : 'Projection off';
  $('projToggle').setAttribute('aria-pressed', String(state.showProj));
  const notes = {
    totals: 'Solid lines are weighted vote totals at each collection. The source does not say exactly when individual votes arrived.',
    gain: 'Net change since the start of the selected range (or since a project was first seen, if later).',
    rank: 'Ballot position at each collection. Lines crossing means one project overtook another.',
  };
  const projNote = proj ? ` Faded dashed lines extend each project's pace over the last ${dur(proj.spanMs)} to the close. A rough guide, not a forecast.`
    : state.showProj && Date.now() < CLOSE ? ' Projection lines appear after 1 hour of collections.' : '';
  $('chartNote').textContent = notes[state.chart] + projNote;
}

// ---------------------------------------------------------------- momentum

function renderMomentum(d) {
  for (const b of $('momSeg').children) b.setAttribute('aria-pressed', String(b.dataset.mom === state.mom));
  const win = M.WINDOWS.find((w) => w.key === state.mom);
  const base = state.mom === 'today' ? d.bases.today : d.bases[state.mom];
  if (!base) {
    const need = win ? `a collection about ${win.label} ago (±${dur(win.tol)})` : 'a collection today';
    $('bars').innerHTML = `<div class="empty"><strong>Collecting history.</strong> This view needs ${need}. Tracking began ${when(d.first)}.</div>`;
    $('momNote').textContent = '';
    return;
  }
  const rows = d.order.map((slug) => ({ slug, ch: M.changeFor(d.records, slug, base, d.cur) }))
    .filter((r) => r.ch.status === 'ok' || r.ch.status === 'new')
    .sort((a, b) => b.ch.delta - a.ch.delta || d.ranks[a.slug] - d.ranks[b.slug]);
  let top = rows.slice(0, 10);
  const me = rows.find((r) => r.slug === HL);
  if (me && !top.includes(me)) top = [...top, me];
  const max = Math.max(1, ...top.map((r) => r.ch.delta));
  $('bars').innerHTML = top.map((r) => {
    const w = Math.max(0, r.ch.delta) / max * 100;
    const isNew = r.ch.status === 'new' ? ' <span class="badge">new</span>' : '';
    return `<div class="bar ${r.slug === HL ? 'rex' : ''}"><span class="r">#${d.ranks[r.slug]}</span>
      <div class="track"><div class="fill" style="width:${w.toFixed(1)}%"></div><div class="name"><span>${esc(title(r.slug))}</span>${isNew}</div></div>
      <span class="n ${cls(r.ch.delta)}" data-tip="${esc(tipFor(r.ch, state.mom === 'today' ? 'Today' : win.label, win))}">${signed(r.ch.delta)}</span></div>`;
  }).join('') || '<div class="empty">No changes in this window.</div>';
  const label = state.mom === 'today' ? `Today (${todayLabel(d)})` : `Last ${win.label}`;
  $('momNote').textContent = `${label}: ${when(base.time)} → ${when(d.cur.time)} (${dur(d.cur.time - base.time)}). Net change in weighted votes.`;
}

// ---------------------------------------------------------------- leaderboard

function tipFor(ch, label, win) {
  if (ch.status === 'ok') {
    let s = `${label}: ${signed(ch.delta)}\n${dtFmt.format(ch.from)} → ${dtFmt.format(ch.to)} (${dur(ch.to - ch.from)})\n${fmt(ch.fromValue)} → ${fmt(ch.toValue)} weighted votes`;
    if (ch.exact) s += '\nTotals were unchanged across the target time, so the starting value is exact.';
    return s;
  }
  if (ch.status === 'new') return `Not listed at the start of this window.\nFirst seen ${dtFmt.format(ch.from)}; ${signed(ch.delta)} since then.`;
  return win ? `Not enough history: needs a collection within ±${dur(win.tol)} of ${win.label} ago.` : 'Not enough history yet.';
}

function changeCell(ch, label, win) {
  if (ch.status === 'collecting') return `<span class="collecting" data-tip="${esc(tipFor(ch, label, win))}">Collecting history</span>`;
  if (ch.status === 'new') return `<span data-tip="${esc(tipFor(ch, label, win))}"><span class="badge">new</span> <span class="${cls(ch.delta)}">${signed(ch.delta)}</span></span>`;
  return `<span class="${cls(ch.delta)}" data-tip="${esc(tipFor(ch, label, win))}">${signed(ch.delta)}</span>`;
}

function rankCell(rc, period) {
  if (rc.status === 'collecting') return `<span class="collecting" data-tip="No baseline for ${esc(period)} yet.">Collecting history</span>`;
  if (rc.status === 'new') return '<span class="badge" data-tip="Not listed at the start of the period.">new</span>';
  const tip = `#${rc.before} → #${rc.after}`;
  if (rc.delta > 0) return `<span class="up" data-tip="${tip}">▲ ${rc.delta}</span>`;
  if (rc.delta < 0) return `<span class="down" data-tip="${tip}">▼ ${-rc.delta}</span>`;
  return `<span class="zero" data-tip="${tip}">–</span>`;
}

function renderBoard(d) {
  for (const b of $('limitSeg').children) b.setAttribute('aria-pressed', String(Number(b.dataset.limit) === state.limit));
  $('rankPeriod').value = state.rankPeriod;
  const sel = selection(d);
  const rankBase = d.bases[state.rankPeriod];
  const todayCol = d.today.kind === 'midnight' ? 'Today' : d.today.kind === 'none' ? 'Today' : 'Today*';
  $('thToday').textContent = todayCol;
  $('thRank').textContent = `Rank Δ ${state.rankPeriod}`;
  $('todayNote').innerHTML = d.today.kind === 'midnight' || d.today.kind === 'none' ? ''
    : `* Today = ${esc(todayLabel(d))}. A full-day change needs a collection near Toronto midnight.`;

  const rows = d.order.map((slug) => {
    const r = { slug, rank: d.ranks[slug], title: title(slug), school: school(slug), votes: d.cur.counts[slug], ch: {} };
    for (const k of ['today', ...M.WINDOWS.map((w) => w.key)]) r.ch[k] = M.changeFor(d.records, slug, d.bases[k], d.cur);
    if (d.today.kind === 'none') r.ch.today = { status: 'none' };
    r.rc = M.rankChange(rankBase, d.cur, slug);
    return r;
  });
  const q = state.search.trim().toLowerCase();
  let list = rows.filter((r) => (!state.limit || r.rank <= state.limit) && (!q || (r.title + ' ' + r.school).toLowerCase().includes(q)));
  const { key, dir } = state.sort;
  const val = (r) => {
    if (key === 'rank' || key === 'votes') return r[key];
    if (key === 'title') return r.title.toLowerCase();
    if (key === 'rankChg') return r.rc.status === 'ok' ? r.rc.delta : -Infinity;
    const c = r.ch[key];
    return c && (c.status === 'ok' || c.status === 'new') ? c.delta : -Infinity;
  };
  list.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va === vb) return a.rank - b.rank;
    if (va === -Infinity) return 1;
    if (vb === -Infinity) return -1;
    return (va < vb ? -1 : 1) * dir;
  });
  for (const th of document.querySelectorAll('.board th[data-sort]')) {
    if (th.dataset.sort === key) th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
  const showCut = key === 'rank' && dir > 0 && !q;
  const html = [];
  list.forEach((r, i) => {
    const next = list[i + 1];
    const isCut = showCut && r.rank <= FUNDED && (!next || next.rank > FUNDED);
    const on = sel.includes(r.slug);
    const winOf = (k) => M.WINDOWS.find((w) => w.key === k);
    const today = r.ch.today.status === 'none' ? '<span class="zero" data-tip="No collection yet today (Toronto time).">—</span>'
      : changeCell(r.ch.today, `Today (${todayLabel(d)})`, null);
    html.push(`<tr class="${r.slug === HL ? 'rex' : ''} ${isCut ? 'cut' : ''}">
      <td class="num rank sticky-a">${r.rank}</td>
      <td class="sticky-b namecell"><span class="pname">${esc(r.title)}${r.slug === HL ? '<span class="mark">★</span>' : ''}</span><span class="pschool">${esc(r.school)}</span></td>
      <td class="num votes">${fmt(r.votes)}</td>
      <td class="num" data-label="${todayCol}">${today}</td>
      ${M.WINDOWS.map((w) => `<td class="num" data-label="${w.label}">${changeCell(r.ch[w.key], w.label, winOf(w.key))}</td>`).join('')}
      <td class="num" data-label="Rank ${state.rankPeriod}">${rankCell(r.rc, state.rankPeriod)}</td>
      <td class="num togcell"><button class="toggle" type="button" data-toggle="${esc(r.slug)}" aria-pressed="${on}" aria-label="${on ? 'Remove from' : 'Add to'} chart: ${esc(r.title)}"><i style="${on ? 'background:' + colorFor(r.slug, sel) : ''}"></i></button></td>
    </tr>`);
    if (isCut && next) html.push(`<tr class="cutlabel"><td colspan="10">Funding line · top ${FUNDED} are funded</td></tr>`);
  });
  $('rows').innerHTML = html.join('') || '<tr><td colspan="10" class="zero">No projects match.</td></tr>';
}

// ---------------------------------------------------------------- feed

function feedEvents(d) {
  const top = (slug) => (d.ranks[slug] || 999) <= 10;
  const involvesRex = (e) => e.slug === HL || (e.passed || []).includes(HL);
  const alertKinds = new Set(['cutoff', 'decrease', 'new', 'removed']);
  return M.buildEvents(d.records).filter((e) => {
    if (state.feed === 'rex') return involvesRex(e);
    if (state.feed === 'top') return top(e.slug);
    if (state.feed === 'alerts') return alertKinds.has(e.kind) || (e.kind === 'rank' && involvesRex(e));
    return true;
  });
}

function feedItem(e, fresh) {
  const rex = e.slug === HL ? 'rex' : '';
  const name = esc(title(e.slug));
  const f = fresh ? ' fresh' : '';
  switch (e.kind) {
    case 'gain': return `<li class="fitem ${rex}${f}"><span class="d up">${signed(e.delta)}</span><span class="t">${name} <span class="sub">· ${fmt(e.total)} · #${e.rank}</span></span></li>`;
    case 'decrease': return `<li class="fitem alert bad ${rex}${f}"><span class="d down">${signed(e.delta)}</span><span class="t">${name} <span class="sub">total went down to ${fmt(e.total)}</span></span></li>`;
    case 'rank': {
      const up = e.after < e.before;
      const passed = e.passed && e.passed.length ? `, ${up ? 'passing' : 'passed by'} ${e.passed.slice(0, 2).map((s) => esc(title(s))).join(', ')}` : '';
      return `<li class="fitem ${e.slug === HL || (e.passed || []).includes(HL) ? 'alert' : ''} ${rex}${f}"><span class="d ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} #${e.after}</span><span class="t">${name} <span class="sub">${up ? 'moved up' : 'moved down'} from #${e.before}${passed}</span></span></li>`;
    }
    case 'cutoff': return `<li class="fitem alert ${rex}${f}"><span class="d ${e.entered ? 'up' : 'down'}">${e.entered ? 'IN' : 'OUT'}</span><span class="t">${name} ${e.entered ? 'entered' : 'dropped out of'} the funded top ${FUNDED} (#${e.after})</span></li>`;
    case 'new': return `<li class="fitem alert ${f}"><span class="d"><span class="badge">new</span></span><span class="t">${name} joined the ballot with ${fmt(e.total)}</span></li>`;
    case 'removed': return `<li class="fitem alert bad ${f}"><span class="d down">—</span><span class="t">${name} is no longer listed (had ${fmt(e.total)})</span></li>`;
    default: return '';
  }
}

let lastFeedTop = null;
function renderFeed(d) {
  for (const b of $('feedSeg').children) b.setAttribute('aria-pressed', String(b.dataset.feed === state.feed));
  const events = feedEvents(d);
  const groups = new Map();
  for (const e of events) { if (!groups.has(e.at)) groups.set(e.at, []); groups.get(e.at).push(e); }
  const order = { cutoff: 0, rank: 1, decrease: 2, removed: 3, new: 4, gain: 5 };
  const html = [];
  const newestAt = events.length ? events[0].at : null;
  let n = 0;
  for (const [at, list] of groups) {
    if (n++ >= 40) break;
    list.sort((a, b) => order[a.kind] - order[b.kind] || (b.delta || 0) - (a.delta || 0));
    const gains = list.filter((e) => e.kind === 'gain');
    const sum = gains.reduce((s, e) => s + e.delta, 0);
    const fresh = lastFeedTop !== null && at > lastFeedTop;
    const shownGains = state.feed === 'all' ? gains.slice(0, 6) : gains;
    const items = [...list.filter((e) => e.kind !== 'gain'), ...shownGains];
    const more = gains.length - shownGains.length;
    html.push(`<li class="fgroup"><div class="fhead"><span>${when(at)}</span><span>${gains.length ? `${signed(sum)} · ${gains.length} project${gains.length > 1 ? 's' : ''}` : ''}</span></div>
      <ol style="list-style:none;margin:0;padding:0">${items.map((e) => feedItem(e, fresh)).join('')}</ol>
      ${more > 0 ? `<div class="fmore">+ ${more} more project${more > 1 ? 's' : ''} gained votes</div>` : ''}</li>`);
  }
  if (newestAt !== null) lastFeedTop = Math.max(lastFeedTop ?? 0, newestAt);
  $('feed').innerHTML = html.join('') || `<li class="empty">${d.records.length < 2
    ? 'Waiting for the next collection. Updates appear here as projects gain votes, change places or cross the funding line.'
    : 'Nothing matches this filter yet.'}</li>`;
}

// ---------------------------------------------------------------- projection

function renderProjection(d) {
  const el = $('projection');
  if (Date.now() >= CLOSE) {
    el.innerHTML = '<p class="note">Voting has closed. The leaderboard shows the last collected totals.</p>';
    return;
  }
  const p = M.project(d.records, CLOSE);
  if (!p) {
    const have = d.cur.time - d.first;
    el.innerHTML = `<div class="empty" style="margin-top:14px"><strong>Collecting history.</strong> Projections start after 1 hour of collections (${dur(have)} so far).</div>`;
    return;
  }
  const order = M.sortedSlugs(p.projected);
  const pr = M.rankMap(p.projected);
  let shown = order.slice(0, 7);
  if (HL in p.projected && !shown.includes(HL)) shown = [...shown, HL];
  const mine = p.projected[HL];
  const g2 = HL in p.projected ? M.gapToPosition(p.projected, HL, pr[HL] === 1 ? 2 : FUNDED + 1) : null;
  const head = HL in p.projected ? `<div class="proj-head"><span class="label">Hack The Rex at close</span><b>#${pr[HL]} · ~${fmt(mine)}</b>
     ${g2 ? `<span class="${cls(g2.gap)}">${signed(g2.gap)}</span> vs ${esc(title(g2.other))} · pace ${p.pacePerHour[HL].toFixed(1)}/h` : ''}</div>` : '';
  el.innerHTML = head + `<div class="proj">${shown.map((s) => `<div class="prow ${s === HL ? 'rex' : ''} ${pr[s] > FUNDED ? 'out' : ''}">
      <span class="r">${pr[s]}</span><span class="nm">${esc(title(s))}</span>
      <span class="pv">~${fmt(p.projected[s])}<small>now ${fmt(d.cur.counts[s])} · ${p.pacePerHour[s].toFixed(1)}/h</small></span></div>`).join('')}</div>
    <p class="note">Straight line from each project's pace over the last ${dur(p.spanMs)} (${when(p.from)} → ${when(p.to)}), extended ${dur(p.remainingHours * HOUR)} to the close. Voting comes in bursts, so this is a rough guide, not a prediction of how people will vote.</p>`;
}

// ---------------------------------------------------------------- notifications

function notifyNew(prevLastT) {
  const events = M.buildEvents(state.records).filter((e) => e.at > prevLastT);
  if (!events.length) return;
  const d = derive();
  const toasts = [];
  const rexGain = events.filter((e) => e.slug === HL && e.kind === 'gain').reduce((s, e) => s + e.delta, 0);
  if (rexGain) toasts.push({ cls: 'rex', label: 'Hack The Rex', text: `${signed(rexGain)} votes · now ${fmt(d.cur.counts[HL])} (#${d.ranks[HL]})` });
  for (const e of events) {
    if (toasts.length >= 4) break;
    if (e.kind === 'cutoff') toasts.push({ cls: e.slug === HL ? 'rex' : '', label: 'Funding line', text: `${title(e.slug)} ${e.entered ? 'entered' : 'left'} the top ${FUNDED}` });
    else if (e.kind === 'rank' && (e.slug === HL || (e.passed || []).includes(HL))) toasts.push({ cls: 'rex', label: 'Position change', text: `${title(e.slug)} moved ${e.after < e.before ? 'up' : 'down'} to #${e.after}` });
    else if (e.kind === 'decrease' && d.ranks[e.slug] <= 10) toasts.push({ cls: 'bad', label: 'Vote decrease', text: `${title(e.slug)} ${signed(e.delta)}` });
    else if (e.kind === 'new') toasts.push({ cls: '', label: 'New project', text: title(e.slug) });
  }
  if (!toasts.length) {
    const sum = events.filter((e) => e.kind === 'gain').reduce((s, e) => s + e.delta, 0);
    toasts.push({ cls: '', label: 'New collection', text: `${signed(sum)} votes across the ballot` });
  }
  for (const t of toasts.slice(0, 4)) toast(t);
}

function toast({ cls: c, label, text }) {
  const el = document.createElement('div');
  el.className = `toast ${c}`;
  el.innerHTML = `<p class="label">${esc(label)}</p>${esc(text)}`;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 7000);
}

// ---------------------------------------------------------------- interactions

function setPref(k, v) { state[k] = v; store.set(k, v); render(); }

function bind() {
  $('refreshBtn').addEventListener('click', () => { state.loadedKey = null; poll(); });
  $('chartTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-chart]'); if (b) setPref('chart', b.dataset.chart); });
  $('rangeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-range]'); if (b) setPref('range', Number(b.dataset.range)); });
  $('momSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-mom]'); if (b) setPref('mom', b.dataset.mom); });
  $('feedSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-feed]'); if (b) setPref('feed', b.dataset.feed); });
  $('limitSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-limit]'); if (b) setPref('limit', Number(b.dataset.limit)); });
  $('rankPeriod').addEventListener('change', (e) => setPref('rankPeriod', e.target.value));
  $('search').addEventListener('input', (e) => { state.search = e.target.value; const d = derive(); if (d) renderBoard(d); });
  $('resetSel').addEventListener('click', () => setPref('selected', null));
  $('projToggle').addEventListener('click', () => setPref('showProj', !state.showProj));
  $('top5Sel').addEventListener('click', () => { const d = derive(); if (d) setPref('selected', d.order.slice(0, FUNDED + 1)); });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle],[data-unselect]');
    if (!t) return;
    const d = derive(); if (!d) return;
    const slug = t.dataset.toggle || t.dataset.unselect;
    let sel = [...selection(d)];
    sel = sel.includes(slug) ? sel.filter((s) => s !== slug) : [...sel, slug].slice(-8);
    setPref('selected', sel.length ? sel : null);
  });
  document.querySelector('.board thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]'); if (!th) return;
    const key = th.dataset.sort;
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'rank' || key === 'title' ? 1 : -1 };
    const d = derive(); if (d) renderBoard(d);
  });
  // Tooltips: hover on desktop, tap on touch screens.
  const tip = $('tip');
  const show = (el) => {
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el && e.pointerType === 'mouse') show(el); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest('[data-tip]') && e.pointerType === 'mouse') tip.hidden = true; });
  document.addEventListener('click', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); else tip.hidden = true; });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastPoll > 30e3) poll();
  });
  $('sourceLink').href = CFG.sourceUrl;
}

function tick() {
  const left = CLOSE - Date.now();
  if (left <= 0) $('countdown').textContent = 'Closed';
  else {
    const s = Math.floor(left / 1000);
    const dd = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
    $('countdown').textContent = `${dd}d ${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`;
  }
  const np = document.getElementById('nextPoll');
  if (np) np.textContent = nextPollIn();
  if (state.lastPoll && Date.now() - state.lastPoll >= CFG.refreshSeconds * 1000 && !state.loading && document.visibilityState === 'visible') poll();
}

bind();
poll();
setInterval(tick, 1000);
setInterval(() => renderStatus(derive()), 30e3);
tick();
