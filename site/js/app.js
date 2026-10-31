import * as M from './metrics.js';

const CFG = {
  highlightSlug: 'hack-the-rex-7615bd', sourceUrl: 'https://schools.tks.world/high-agency-fund',
  votingClosesAt: '2026-11-01T03:59:00Z', fundedSpots: 5, refreshSeconds: 20, staleAfterMinutes: 15, repo: null,
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
  chart: store.get('chart', 'race'), range: store.get('range', 0), mom: store.get('mom', '5h'),
  feed: store.get('feed', 'all'), limit: store.get('limit', 0), rankPeriod: store.get('rankPeriod', '24h'),
  selected: store.get('selected', null), show: store.get('show', 'rivals'), notify: store.get('notify', false), sort: { key: 'rank', dir: 1 }, search: '', showProj: store.get('showProj', true),
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
// Rank label with a star for the funded top 5.
const place = (rank, hash = true) => (rank <= FUNDED ? `<span class="star" title="Top ${FUNDED}">★</span>` : '') + (hash ? '#' : '') + rank;
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
const repo = repoInfo();
const SITE_SOURCE = { name: 'site', label: 'this site', base: 'data/' };
const API_EVERY = 75e3;   // GitHub allows 60 anonymous API calls per hour per network
const head = { sha: null, checked: 0, pausedUntil: 0 };

// The newest commit on the data branch. Raw files addressed by commit are never stale,
// unlike the branch URL, which GitHub caches for up to 5 minutes. Every API call counts
// against the hourly limit (even 304s), so check sparingly and back off near the limit.
async function latestSha() {
  const now = Date.now();
  if (!repo || now < head.pausedUntil || now - head.checked < API_EVERY) return head.sha;
  head.checked = now;
  try {
    const headers = { Accept: 'application/vnd.github.sha' };
    if (head.sha) headers['If-None-Match'] = `"${head.sha}"`;
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${repo.branch}`,
      { headers, cache: 'no-store' });
    const left = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    if (res.ok) {
      const sha = (await res.text()).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) head.sha = sha;
    }
    if (res.status === 403 || res.status === 429 || (Number.isFinite(left) && left <= 3)) {
      head.pausedUntil = reset > now ? reset : now + 10 * 60e3;
    }
  } catch { /* offline or blocked; fall back to the other sources */ }
  return head.sha;
}

async function sources() {
  if (!repo) return [SITE_SOURCE];
  const raw = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}`;
  const sha = await latestSha();
  const list = [{ name: 'branch', label: 'GitHub (cached up to 5 min)', base: `${raw}/${repo.branch}/data/` }, SITE_SOURCE];
  if (sha) list.unshift({ name: 'commit', label: 'GitHub (latest commit)', base: `${raw}/${sha}/data/` });
  return list;
}

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
    const found = (await Promise.allSettled((await sources()).map(async (src) => {
      const status = JSON.parse(await getText(`${src.base}status.json?t=${Date.now()}`));
      return { src, status };
    }))).filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!found.length) throw new Error('Could not reach the tracker data');
    found.sort((a, b) => String(b.status.last_success || '').localeCompare(String(a.status.last_success || '')));
    state.status = found[0].status;
    for (const { src, status } of found) {
      const key = `${status.last_snapshot || status.last_success}|${status.last_change}`;
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
        if (newestU >= Date.parse(status.last_snapshot || status.last_success) - 1000) state.loadedKey = key;
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
  if (state.show === 'top10') return d.order.slice(0, 10);
  if (state.show === 'movers') return movers(d);
  return closestRivals(d);
}

/** Hack The Rex plus whoever gained the most recently (last 5h, or all history if shorter). */
function movers(d, n = 5) {
  const base = d.bases['5h'] || { time: d.first, counts: d.records[0].c };
  const gains = d.order.map((slug) => ({ slug, ch: M.changeFor(d.records, slug, base, d.cur) }))
    .filter((r) => r.slug !== HL && (r.ch.status === 'ok' || r.ch.status === 'new'))
    .sort((x, y) => y.ch.delta - x.ch.delta || d.ranks[x.slug] - d.ranks[y.slug]);
  return [HL, ...gains.slice(0, n).map((r) => r.slug)].filter((s) => s in d.cur.counts);
}

function closestRivals(d, n = 4) {
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
  renderBell();
  renderStatus(d);
  if (!d) { renderEmpty(); return; }
  const f = getForecast(d);
  renderTicker(d, f);
  renderHero(d);
  renderChart(d);
  renderMarket(d, f);
  renderSignals(d, f);
  renderMomentum(d);
  renderBoard(d);
  renderFeed(d);
  renderProjection(d);
  renderHistory(d);
  loadHistory();
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
  rows.push(['Schedule', 'GitHub Actions · every 30 s']);
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
  const p = getForecast(d);
  if (p && HL in p.projected) {
    const pr = M.rankMap(p.projected)[HL];
    out.push(stat('Predicted final', `~${fmt(p.projected[HL])}`, `${fmt(p.low[HL])}–${fmt(p.high[HL])} · #${pr} at close`));
  } else if (Date.now() >= CLOSE) {
    out.push(stat('Final', fmt(counts[HL]), 'voting has closed'));
  } else {
    out.push(stat('Projected final', '<span class="zero">—</span>', 'collecting history'));
  }
  $('stats').innerHTML = out.join('');
}

// ---------------------------------------------------------------- chart

let chart = null;
const isPhone = () => window.matchMedia('(max-width: 720px)').matches;

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
      ctx.textAlign = 'right';
      ctx.fillText(text, px - 5, a.top + 10);
      ctx.restore();
    };
    line(markers.now, 'NOW', 'rgba(239,235,228,0.5)');
    line(markers.close, 'CLOSE', 'rgba(240,123,63,0.85)');
  },
};

// Name + value at the end of each line, nudged apart so they never overlap.
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(c) {
    const { ctx, chartArea: a } = c;
    const items = [];
    c.data.datasets.forEach((ds, i) => {
      if (!ds.endLabel) return;
      const meta = c.getDatasetMeta(i);
      const pt = meta.data[meta.data.length - 1];
      if (!pt || meta.hidden) return;
      items.push({ x: pt.x, y: pt.y, text: ds.endLabel, color: ds.labelColor, bold: ds.slug === HL });
    });
    items.sort((p, q) => p.y - q.y);
    for (let i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + 14);
    const overflow = items.length ? items[items.length - 1].y - a.bottom : 0;
    if (overflow > 0) for (const it of items) it.y -= overflow;
    ctx.save();
    ctx.textBaseline = 'middle';
    for (const it of items) {
      ctx.font = `${it.bold ? 600 : 500} 11px "IBM Plex Sans", sans-serif`;
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, Math.min(it.x + 8, a.right + 8), it.y);
    }
    ctx.restore();
  },
};

function shortName(slug) {
  const t = title(slug);
  const max = isPhone() ? 10 : 18;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function glow(c, color) {
  const { ctx, chartArea } = c.chart;
  if (!chartArea) return color + '22';
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  g.addColorStop(0, color + '40');
  g.addColorStop(1, color + '00');
  return g;
}

function renderChart(d) {
  if (state.chart === 'gain') state.chart = 'totals';
  for (const b of $('chartTabs').children) b.setAttribute('aria-selected', String(b.dataset.chart === state.chart));
  for (const b of $('rangeSeg').children) b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.range));
  const sel = selection(d);
  $('chips').innerHTML = sel.map((s) => `<span class="chip"><i style="background:${colorFor(s, sel)}"></i><span>${esc(title(s))}</span><button type="button" data-unselect="${esc(s)}" aria-label="Remove ${esc(title(s))}">×</button></span>`).join('');
  const custom = Array.isArray(state.selected);
  for (const b of $('showSeg').children) b.setAttribute('aria-pressed', String(!custom && b.dataset.show === state.show));
  const canProject = !!getForecast(d);
  const sw = $('projToggle');
  sw.setAttribute('aria-checked', String(state.showProj && canProject));
  sw.classList.toggle('waiting', !canProject);
  sw.querySelector('span').textContent = 'Predictions';

  const from = state.range ? d.cur.time - state.range * HOUR : -Infinity;
  const proj = state.showProj ? getForecast(d) : null;
  const projNote = proj ? ' Faded dashed lines: recent momentum for the next few hours, then the daily + weekly pace up to the close; the shaded band is the range. A rough guide, not a forecast.'
    : state.showProj && Date.now() < CLOSE ? ' Prediction lines appear after 1 hour of collections.' : '';

  const race = state.chart === 'race';
  $('race').hidden = !race;
  document.querySelector('.chart-box').hidden = race;
  if (race) {
    renderRace(d, sel, from, proj);
    return;
  }
  if (!window.Chart) { setTimeout(() => renderChart(derive()), 250); return; }

  const kind = state.chart;
  const isRank = kind === 'rank';
  const fn = isRank ? M.rankSeriesFor : kind === 'pace' ? (r, slug, f) => M.paceSeriesFor(r, slug, f, HOUR) : M.seriesFor;
  const projRanks = proj ? M.rankMap(proj.projected) : null;
  const fmtVal = (v, p) => (isRank ? '#' + v : kind === 'pace' ? `${v.toFixed(1)}/h` : (p ? '~' : '') + fmt(Math.round(v)));
  const datasets = [];
  for (const slug of sel) {
    const data = fn(d.records, slug, from);
    if (!data.length) continue;
    const color = colorFor(slug, sel);
    const last = data[data.length - 1];
    const main = {
      label: title(slug), slug, data, borderColor: color, labelColor: color,
      borderWidth: slug === HL ? 3.2 : 2, tension: isRank ? 0.45 : 0.35, cubicInterpolationMode: isRank ? 'default' : 'monotone',
      pointRadius: (ctx) => (ctx.dataIndex === ctx.dataset.data.length - 1 ? 4 : 0),
      pointBackgroundColor: color, pointHoverRadius: 5, order: slug === HL ? 0 : 1,
      fill: slug === HL && !isRank ? 'start' : false,
      backgroundColor: slug === HL && !isRank ? (c) => glow(c, color) : color,
      endLabel: `${shortName(slug)}  ${fmtVal(last.y)}`,
    };
    datasets.push(main);
    if (proj && slug in proj.projected) {
      const end = isRank ? projRanks[slug] : kind === 'pace' ? proj.pacePerHour[slug] : proj.projected[slug];
      main.endLabel = null;
      datasets.push({
        label: `${title(slug)} (predicted)`, slug, projection: true, labelColor: color,
        data: [{ x: last.x, y: last.y }, { x: CLOSE, y: end }],
        borderColor: color + '66', borderDash: [5, 6], borderWidth: Math.max(1.4, main.borderWidth - 0.8),
        pointRadius: [0, 4], pointBackgroundColor: '#151311', pointBorderColor: color + 'aa', pointBorderWidth: 1.5,
        pointHoverRadius: 5, tension: 0, order: 2, fill: false,
        endLabel: `${shortName(slug)}  ${fmtVal(end, true)}`,
      });
      // Shaded range between the slowest and fastest measured pace, for Hack The Rex.
      if (slug === HL && kind === 'totals') {
        const band = (y, fillTo) => ({
          label: 'range', slug, projection: true, band: true, data: [{ x: last.x, y: last.y }, { x: CLOSE, y }],
          borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, tension: 0, order: 3,
          fill: fillTo, backgroundColor: color + '1f',
        });
        datasets.push(band(proj.low[slug], false));
        datasets.push(band(proj.high[slug], '-1'));
      }
    }
  }
  const points = Math.max(0, ...datasets.filter((x) => !x.projection).map((x) => x.data.length));
  const empty = $('chartEmpty');
  if (points < 2) {
    empty.hidden = false;
    empty.innerHTML = kind === 'pace'
      ? '<div><strong>Collecting history</strong>Pace needs about an hour of collections to compare against.</div>'
      : `<div><strong>Collecting history</strong>One snapshot so far (${when(d.cur.time)}). Lines appear as soon as the votes change.</div>`;
  } else empty.hidden = true;

  const maxRank = Math.max(2, ...datasets.flatMap((x) => x.data.map((p) => p.y)));
  const x0 = Number.isFinite(from) ? Math.max(from, d.first) : d.first;
  const xMax = proj ? CLOSE : d.cur.time;
  const longRange = xMax - x0 > 20 * HOUR;
  const tickFont = { family: 'IBM Plex Mono', size: 10.5 };
  const options = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    layout: { padding: { right: isPhone() ? 92 : 150, top: 8, left: 4 } },
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#24211d', borderColor: 'rgba(239,235,228,0.14)', borderWidth: 1, padding: 10,
        titleFont: { family: 'IBM Plex Mono', size: 11 }, bodyFont: { family: 'IBM Plex Sans', size: 12.5 },
        itemSort: (a, b) => (isRank ? a.parsed.y - b.parsed.y : b.parsed.y - a.parsed.y),
        callbacks: {
          title: (items) => (items.length ? dtFmt.format(items[0].parsed.x) : ''),
          label: (it) => (it.dataset.band ? null : ` ${it.dataset.label}: ${fmtVal(it.parsed.y, it.dataset.projection)}`),
        },
      },
    },
    scales: {
      x: {
        type: 'linear', min: x0, max: xMax,
        grid: { color: 'rgba(239,235,228,0.04)' }, border: { color: 'rgba(239,235,228,0.1)' },
        ticks: { color: '#75716b', font: tickFont, maxTicksLimit: isPhone() ? 4 : 7, maxRotation: 0,
          callback: (v) => (longRange ? dtFmt.format(v).replace(/:\d\d /, ' ') : timeFmt.format(v)) },
      },
      y: {
        reverse: isRank, grace: isRank ? 0 : '6%', grid: { color: 'rgba(239,235,228,0.05)' }, border: { display: false },
        ticks: { color: '#75716b', font: tickFont, precision: isRank ? 0 : undefined,
          callback: (v) => (isRank ? '#' + v : kind === 'pace' ? `${v}/h` : fmt(v)) },
        ...(isRank ? {
          min: 0.6, max: maxRank + 0.4,
          afterBuildTicks: (axis) => { axis.ticks = Array.from({ length: maxRank }, (_, i) => ({ value: i + 1 })); },
        } : kind === 'pace' ? { beginAtZero: true } : {}),
      },
    },
  };
  markers.now = d.cur.time;
  markers.close = proj ? CLOSE : null;
  if (!chart) {
    Chart.defaults.font.family = 'IBM Plex Sans';
    Chart.defaults.color = '#a39e96';
    chart = new Chart($('chart'), { type: 'line', data: { datasets }, options, plugins: [markers, endLabels] });
  } else {
    chart.data.datasets = datasets;
    chart.options = options;
    chart.update();
  }
  const notes = {
    totals: 'Weighted vote totals at each collection. The source does not say exactly when individual votes arrived.',
    pace: 'Votes per hour, measured over the previous hour at each collection. It rises and falls as voting speeds up or slows down.',
    rank: 'Ballot position at each collection. Lines crossing means one project overtook another.',
  };
  sw.dataset.tip = projNote.trim() || "Dashed lines continue each project's recent pace to the close.";
  $('chartTabs').dataset.tip = notes[kind];
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
}

function renderRace(d, sel, from, proj) {
  const rows = sel.filter((s) => s in d.cur.counts).map((slug) => {
    const series = M.seriesFor(d.records, slug, from);
    return {
      slug, color: colorFor(slug, sel), rank: d.ranks[slug], now: d.cur.counts[slug],
      start: series.length ? series[0].y : d.cur.counts[slug], since: series.length ? series[0].x : d.cur.time,
      fin: proj && slug in proj.projected ? proj.projected[slug] : null,
      lo: proj && slug in proj.projected ? proj.low[slug] : null,
      hi: proj && slug in proj.projected ? proj.high[slug] : null,
    };
  }).sort((a, b) => b.now - a.now);
  if (!rows.length) { $('race').innerHTML = '<div class="empty">Pick a project from the leaderboard to add it here.</div>'; return; }
  const cutoff = d.cur.counts[d.order[FUNDED - 1]];
  const lo = Math.min(cutoff, ...rows.map((r) => r.start));
  const hi = Math.max(cutoff, ...rows.map((r) => r.hi ?? r.fin ?? r.now));
  const step = niceStep((hi - lo) / 5 || 10);
  const min = Math.max(0, Math.floor((lo - step * 0.4) / step) * step);
  const max = Math.ceil((hi + step * 0.3) / step) * step;
  const pct = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  const ticks = [];
  for (let v = min; v <= max + 1e-9; v += step) ticks.push(v);
  const lanes = rows.map((r, i) => {
    const next = rows[i + 1];
    const gap = next ? `${fmt(r.now - next.now)} ahead of next` : '';
    const moved = r.now - r.start;
    const s = pct(r.start), n = pct(r.now), f = r.fin != null ? pct(r.fin) : null;
    return `<div class="lane ${r.slug === HL ? 'rex' : ''}" style="--c:${r.color}">
      <div class="lane-name"><span class="r">${place(r.rank)}</span><span class="nm">${esc(title(r.slug))}</span>
        <span class="meta"><b class="${cls(moved)}">${signed(moved)}</b> since ${when(r.since)}${gap ? ' · ' + gap : ''}</span></div>
      <div class="track">
        ${ticks.map((t) => `<i class="grid" style="left:${pct(t)}%"></i>`).join('')}
        <i class="cut" style="left:${pct(cutoff)}%"></i>
        ${n >= s ? `<i class="trail" style="left:${s}%;width:${n - s}%"></i>` : `<i class="trail lost" style="left:${n}%;width:${s - n}%"></i>`}
        ${r.hi != null && r.hi > r.lo ? `<i class="range" style="left:${pct(r.lo)}%;width:${pct(r.hi) - pct(r.lo)}%" data-tip="Predicted range ${fmt(r.lo)}–${fmt(r.hi)}"></i>` : ''}
        ${f != null && f > n ? `<i class="ghost" style="left:${n}%;width:${f - n}%"></i><i class="ghost-end" style="left:${f}%"></i><span class="fin" style="left:${f}%">~${fmt(r.fin)}</span>` : ''}
        <i class="dot" style="left:${n}%"></i>
        <span class="val" style="left:${n}%">${fmt(r.now)}</span>
      </div>
    </div>`;
  }).join('');
  $('race').innerHTML = `${lanes}
    <div class="lane axis"><div></div><div class="track">${ticks.map((t) => `<span style="left:${pct(t)}%">${fmt(t)}</span>`).join('')}
      <span class="cut-label" style="left:${pct(cutoff)}%">top-${FUNDED} line · ${fmt(cutoff)}</span></div></div>`;
}

// ---------------------------------------------------------------- momentum

function renderMomentum(d) {
  for (const b of $('momSeg').children) b.setAttribute('aria-pressed', String(b.dataset.mom === state.mom));
  const win = M.WINDOWS.find((w) => w.key === state.mom);
  const base = state.mom === 'today' ? d.bases.today : d.bases[state.mom];
  if (!base) {
    const need = win ? `a collection about ${win.label} ago (±${dur(win.tol)})` : 'a collection today';
    $('bars').innerHTML = `<div class="empty"><strong>Collecting history.</strong> This view needs ${need}. Tracking began ${when(d.first)}.</div>`;
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
    return `<div class="bar ${r.slug === HL ? 'rex' : ''}"><span class="r">${place(d.ranks[r.slug])}</span>
      <div class="track"><div class="fill" style="width:${w.toFixed(1)}%"></div><div class="name"><span>${esc(title(r.slug))}</span>${isNew}</div></div>
      <span class="n ${cls(r.ch.delta)}" data-tip="${esc(tipFor(r.ch, state.mom === 'today' ? 'Today' : win.label, win))}">${signed(r.ch.delta)}</span></div>`;
  }).join('') || '<div class="empty">No changes in this window.</div>';
  const label = state.mom === 'today' ? `Today (${todayLabel(d)})` : `Last ${win.label}`;
  $('momTitle').dataset.tip = `${label}: ${when(base.time)} → ${when(d.cur.time)} (${dur(d.cur.time - base.time)}). Net change in weighted votes.`;
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
  $('thToday').dataset.tip = d.today.kind === 'midnight' || d.today.kind === 'none' ? 'Change since Toronto midnight.'
    : `* Today = ${esc(todayLabel(d))}. A full-day change needs a collection near Toronto midnight.`;

  const removed = M.removedSince(d.records, d.cur.time - 24 * HOUR);
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
      <td class="num rank sticky-a">${place(r.rank, false)}</td>
      <td class="sticky-b namecell"><span class="pname">${esc(r.title)}${removed[r.slug] ? `<span class="lost-tag" data-tip="Votes removed in the last 24h: ${fmt(removed[r.slug].removed)} across ${removed[r.slug].times} drop${removed[r.slug].times > 1 ? 's' : ''}. Net changes already include this.">−${fmt(removed[r.slug].removed)} removed</span>` : ''}</span><span class="pschool">${esc(r.school)}</span></td>
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
    case 'gain': return `<li class="fitem ${rex}${f}"><span class="d up">${signed(e.delta)}</span><span class="t">${name} <span class="sub">· ${fmt(e.total)} · ${place(e.rank)}</span></span></li>`;
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

const TREND = { up: ['▲', 'speeding up', 'up'], down: ['▼', 'slowing down', 'down'], steady: ['●', 'steady', 'zero'] };
const getForecast = (d) => (Date.now() < CLOSE ? M.forecast(d.records, CLOSE, state.projects) : null);

function paceRows(parts) {
  return parts.map((p) => {
    const span = p.source ? `trailing ~${Math.round(p.hours / 24)} days (source)` : `${when(p.from)} → ${when(p.to)}`;
    return `<tr><td>${esc(p.label)}</td><td>${span}</td><td class="num ${p.rate < 0 ? 'down' : ''}">${p.rate.toFixed(1)}/h</td><td class="num">${esc(p.use)}</td></tr>`;
  }).join('');
}

function renderProjection(d) {
  const el = $('projection');
  if (Date.now() >= CLOSE) {
    el.innerHTML = '<p class="note">Voting has closed. The leaderboard shows the last collected totals.</p>';
    return;
  }
  const f = getForecast(d);
  if (!f) {
    el.innerHTML = '<div class="empty" style="margin-top:14px"><strong>Collecting history.</strong> Predictions start once a pace can be measured.</div>';
    return;
  }
  const pr = M.rankMap(f.projected);
  let shown = M.sortedSlugs(f.projected).slice(0, 7);
  if (HL in f.projected && !shown.includes(HL)) shown = [...shown, HL];
  let head = '';
  if (HL in f.projected) {
    const g = M.gapToPosition(f.projected, HL, pr[HL] === 1 ? 2 : FUNDED + 1);
    const t = TREND[f.trend[HL]];
    head = `<div class="proj-head"><span class="label">Hack The Rex at close</span><b>#${pr[HL]} · ~${fmt(f.projected[HL])}</b>
      <span class="zero">range ${fmt(f.low[HL])}–${fmt(f.high[HL])}</span> · <span class="${t[2]}">${t[0]} ${t[1]}</span>
      ${g ? `<br><span class="${cls(g.gap)}">${signed(g.gap)}</span> vs ${esc(title(g.other))}` : ''}
      <table class="paces"><tr><th>Pace</th><th>Measured over</th><th class="num">Votes/h</th><th class="num">Used for</th></tr>${paceRows(f.parts[HL])}</table></div>`;
  }
  el.innerHTML = head + `<div class="proj">${shown.map((s) => {
    const t = TREND[f.trend[s]];
    return `<div class="prow ${s === HL ? 'rex' : ''} ${pr[s] > FUNDED ? 'out' : ''}">
      <span class="r">${place(pr[s], false)}</span><span class="nm">${esc(title(s))}</span>
      <span class="pv" data-tip="${esc(f.parts[s].map((p) => `${p.label}: ${p.rate.toFixed(1)}/h`).join('\n'))}">~${fmt(f.projected[s])}<small>${fmt(f.low[s])}–${fmt(f.high[s])} · <span class="${t[2]}">${t[0]}</span></small></span></div>`;
  }).join('')}</div>
    <p class="note" data-tip="Momentum fades: the recent pace (last 1–3h) sets the next ${Math.round(f.nearHours)} hours, then a 45/55 blend of the last-day pace (6–24h) and the source's trailing 7-day pace covers the remaining ${dur(Math.max(0, f.remainingHours - f.nearHours) * HOUR)}. The range uses the slowest and fastest pace in each stretch, and is at least ±25% of the long-run pace (±50% while only one long-run pace exists), because daily voting swings a lot. Weighted votes. Newsletter confirmations can double earlier votes at once and removals take votes away, so real totals can jump either way.">Recent momentum, then daily + weekly pace · weighted votes</p>`;
}

// ---------------------------------------------------------------- earlier history

const history = { manual: null, refs: null, best: null, loaded: false };

async function loadHistory() {
  if (history.loaded) return;
  history.loaded = true;
  const get = async (name) => { try { return JSON.parse(await getText(`data/${name}?v=${Date.now()}`)); } catch { return null; } };
  [history.manual, history.refs, history.best] = await Promise.all(
    ['manual_observations.json', 'reference_daily_gains.json', 'source_best_days.json'].map(get));
  const d = derive();
  if (d) renderHistory(d);
}

function renderHistory(d) {
  const el = $('history');
  if (!el) return;
  const parts = [];
  const m = history.manual;
  if (m && m.observations?.length) {
    const slugs = Object.keys(m.projects);
    parts.push(`<div class="hist-head"><h3>Manual checks · Oct 28–29</h3><span class="zero">order known · times not recorded · — = not recorded</span></div>
      <div class="hist-wrap"><table class="hist"><thead><tr><th class="num">#</th>${slugs.map((s) => `<th class="num ${s === HL ? 'rexcol' : ''}" title="${esc(m.projects[s])}">${esc(shortLabel(m.projects[s]))}</th>`).join('')}</tr></thead>
      <tbody>${m.observations.map((o, i) => {
        const prev = m.observations[i - 1];
        return `<tr><td class="num zero">${o.observation_order}</td>${slugs.map((s) => {
          const v = o.totals[s];
          if (v == null) return '<td class="num zero">—</td>';
          const pv = prev?.totals[s];
          const jump = pv != null && v !== pv ? ` <small class="${cls(v - pv)}">${signed(v - pv)}</small>` : '';
          return `<td class="num ${s === HL ? 'rexcol' : ''}">${fmt(v)}${jump}</td>`;
        }).join('')}</tr>`;
      }).join('')}</tbody></table></div>`);
  }
  const refs = history.refs?.entries || [];
  if (refs.length) {
    parts.push(`<div class="hist-head"><h3>Best days</h3><span class="zero">a project's single best day, not an average</span></div>
      <div class="days">${refs.map((r) => {
        const now = state.projects[r.slug]?.source_best_day;
        const badge = r.status === 'verified' ? '<span class="badge ok">verified</span>' : r.status === 'superseded' ? '<span class="badge">beaten</span>' : '<span class="badge">unverified</span>';
        const latest = now && (now.date !== r.date || now.votes !== r.net_daily_gain) ? ` → now +${fmt(now.votes)} on ${now.date}` : '';
        return `<div class="day ${r.slug === HL ? 'rex' : ''}"><span class="nm">${esc(r.project)}</span><span>+${fmt(r.net_daily_gain)} on ${r.date}${latest}</span>${badge}</div>`;
      }).join('')}</div>`);
  }
  el.innerHTML = parts.join('') || '<div class="empty">No earlier history loaded.</div>';
}

function shortLabel(t) {
  const map = { 'Hack The Rex': 'Rex', 'CREATE Conference Council': 'CREATE', 'St. Robert Catholic High School HOSA': 'HOSA',
    'BlankIsYours': 'Blank', 'Open Minds Foundation': 'Open Minds', 'Mac Design Cup 2026': 'Mac', 'Lane Tech Science Olympiad Build Clinic': 'Lane Tech' };
  if (map[t]) return map[t];
  if (/faraday/i.test(t)) return 'Faraday';
  if (/^ramp/i.test(t)) return 'Ramp';
  return t.split(' ')[0];
}

// ---------------------------------------------------------------- market read-outs

const LEVEL = {
  surging: { tag: 'Surging', arrow: '▲▲' },
  heating: { tag: 'Heating up', arrow: '▲' },
  steady: { tag: 'Steady', arrow: '▸' },
  cooling: { tag: 'Cooling', arrow: '▼' },
  stalled: { tag: 'Stalled', arrow: '■' },
};
const OUTLOOK = { safe: 'Safe', likely: 'Likely', 'in reach': 'In reach', 'long shot': 'Long shot' };
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: M.TZ, weekday: 'short' });
const SESSION_SHORT = { Overnight: '12–6a', Morning: '6a–12p', Afternoon: '12–6p', Evening: '6p–12a' };

function spark(points, color, w = 84, h = 22) {
  if (points.length < 2) return '';
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const px = (x) => ((x - x0) / (x1 - x0 || 1)) * (w - 2) + 1;
  const py = (y) => h - 2 - ((y - y0) / (y1 - y0 || 1)) * (h - 4);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)} ${py(p.y).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${path}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/><circle cx="${px(last.x).toFixed(1)}" cy="${py(last.y).toFixed(1)}" r="2.2" fill="${color}"/></svg>`;
}
const LEVEL_COLOR = { surging: '#ff5147', heating: '#ff9a3d', steady: '#a39e96', cooling: '#6fb6ff', stalled: '#75716b' };

function renderTicker(d, f) {
  const el = $('tickerTrack');
  if (!el) return;
  const base = d.bases['1h'] || { counts: d.records[0].c };
  let slugs = d.order.slice(0, 15);
  if (!slugs.includes(HL)) slugs = [HL, ...slugs];
  const items = slugs.map((s) => {
    const lvl = M.momentum(d.records, f, s).level;
    const ch = s in base.counts ? d.cur.counts[s] - base.counts[s] : null;
    const pct = ch != null && base.counts[s] ? (ch / base.counts[s]) * 100 : null;
    return `<span class="tk ${lvl} ${s === HL ? 'rex' : ''}"><b>${d.ranks[s]}</b>${esc(shortLabel(title(s)).toUpperCase())}<em>${fmt(d.cur.counts[s])}</em>${ch == null ? '' : `<i>${LEVEL[lvl].arrow} ${signed(ch)}${pct != null ? ` ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}</i>`}</span>`;
  }).join('');
  const label = d.bases['1h'] ? 'last hour' : 'since tracking began';
  el.innerHTML = `<div class="tk-group"><span class="tk-label">${label}</span>${items}</div><div class="tk-group" aria-hidden="true"><span class="tk-label">${label}</span>${items}</div>`;
}

function renderMarket(d, f) {
  const el = $('market');
  if (!el) return;
  const sessions = M.sessionsBetween(d.first, d.cur.time).slice(-5);
  let slugs = d.order.slice(0, 10);
  if (!slugs.includes(HL)) slugs.push(HL);
  const gains = M.sessionGains(d.records, slugs, sessions);
  const outlook = f ? M.fundingOutlook(f, FUNDED) : {};
  const rates = slugs.flatMap((s) => gains[s].filter(Boolean).map((g) => (g.hours > 0 ? g.gain / g.hours : 0)));
  const maxRate = Math.max(1, ...rates);
  const heat = (g) => {
    if (!g) return '';
    const r = g.hours > 0 ? g.gain / g.hours : 0;
    if (r < 0) return 'background: rgba(111,182,255,0.16)';
    const t = Math.sqrt(Math.min(1, r / maxRate));
    // ember → orange → red as the pace climbs
    const hue = 28 - 24 * t, alpha = 0.06 + 0.5 * t;
    return `background: hsla(${hue.toFixed(0)}, 95%, 55%, ${alpha.toFixed(2)})`;
  };
  const head = sessions.map((s) => `<th class="num"><span>${dayFmt.format(s.start + HOUR)}${s.live ? ' · now' : ''}</span>${SESSION_SHORT[s.name]}</th>`).join('');
  const rows = slugs.map((s) => {
    const m = M.momentum(d.records, f, s);
    const cells = gains[s].map((g, i) => {
      if (!g) return '<td class="num cell none" data-tip="Not tracked from the start of this block">—</td>';
      const sess = sessions[i];
      const tip = `${sess.name} ${dayFmt.format(sess.start + HOUR)} (${SESSION_SHORT[sess.name]})${sess.live ? ', so far' : ''}: ${signed(g.gain)} in ${dur(g.hours * HOUR)} · ${(g.gain / (g.hours || 1)).toFixed(1)}/h`;
      return `<td class="num cell ${g.gain < 0 ? 'neg' : ''}" style="${heat(g)}" data-tip="${esc(tip)}">${signed(g.gain)}</td>`;
    }).join('');
    const pace = f?.near?.[s];
    const o = outlook[s];
    return `<tr class="${s === HL ? 'rex' : ''}">
      <td class="num r">${place(d.ranks[s], false)}</td>
      <td class="nm"><span>${esc(title(s))}</span></td>
      ${cells}
      <td class="num pace">${pace == null ? '—' : `${pace.toFixed(1)}<small>/h</small>`}</td>
      <td><span class="lvl ${m.level}" data-tip="${esc(levelTip(m))}">${LEVEL[m.level].arrow} ${LEVEL[m.level].tag}</span></td>
      <td>${o ? `<span class="outlook ${o.replace(' ', '-')}">${OUTLOOK[o]}</span>` : ''}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<div class="mk-wrap"><table class="mk">
    <thead><tr><th class="num">#</th><th>Project</th>${head}<th class="num">Pace now</th><th>Momentum</th><th>Outlook</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="mk-legend"><span><i class="sw s1"></i><i class="sw s2"></i><i class="sw s3"></i> hotter = more votes per hour</span>
    <span>Outlook compares predicted ranges for the top ${FUNDED}: <b class="outlook safe">Safe</b> holds even in its worst case</span></div>`;
}

function levelTip(m) {
  if (m.level === 'stalled') return `No new votes in the last ${dur(m.quietHours * HOUR)}.`;
  if (m.base == null || m.recent == null) return 'Not enough history to compare yet.';
  return `Now ${m.recent.toFixed(1)}/h vs a usual ${m.base.toFixed(1)}/h (${m.ratio === Infinity ? '∞' : m.ratio.toFixed(1)}×).`;
}

/** Plain-language calls about what's happening and what it means, most important first. */
function buildSignals(d, f) {
  if (!f) return [];
  const out = [];
  const close = CLOSE;
  const sparkFrom = d.cur.time - 6 * HOUR;
  const add = (score, slug, kind, title2, body) => out.push({ score, slug, kind, title: title2, body });
  // Overtake watch: Hack The Rex vs the next two, and both sides of the funding line.
  const pairs = [];
  const iRex = d.order.indexOf(HL);
  if (iRex >= 0) {
    if (iRex > 0) pairs.push([d.order[iRex - 1], HL]);
    for (const k of [1, 2]) if (d.order[iRex + k]) pairs.push([HL, d.order[iRex + k]]);
  }
  if (d.order[FUNDED]) pairs.push([d.order[FUNDED - 1], d.order[FUNDED]]);
  const seen = new Set();
  for (const [lead, chase] of pairs) {
    const key = lead + chase;
    if (seen.has(key)) continue;
    seen.add(key);
    const o = M.overtake(f, d.cur.counts, lead, chase, close);
    if (!o) continue;
    const funding = d.ranks[lead] === FUNDED;
    const who = `${title(chase)} vs ${title(lead)}`;
    if (o.passAt) {
      const inH = (o.passAt - d.cur.time) / HOUR;
      add(funding ? 90 : chase === HL || lead === HL ? 95 : 60, chase, 'overtake', `Overtake watch · ${who}`,
        `${o.gap} behind${o.closingPerHour > 0 ? `, closing ${o.closingPerHour.toFixed(1)}/h right now` : ''}. On current forecasts it passes in ~${dur(inH * HOUR)} (${when(o.passAt)})${funding ? ', taking the last funded spot' : ''}.`);
    } else if (o.closingPerHour > 0.3 && o.gap < 150) {
      add(funding ? 70 : 50, chase, 'closing', `Closing in · ${who}`,
        `${o.gap} behind and gaining ${o.closingPerHour.toFixed(1)}/h right now, but the forecast has it running out of time before the close.`);
    } else if (lead === HL || chase === HL) {
      add(30, lead === HL ? chase : lead, 'gap', `Gap holding · ${who}`, `${lead === HL ? 'Lead' : 'Gap'} of ${o.gap}. Not on course to change before the close.`);
    }
  }
  if (d.order[FUNDED] && Math.abs(d.cur.counts[d.order[FUNDED - 1]] - d.cur.counts[d.order[FUNDED]]) <= 10) {
    add(100, d.order[FUNDED], 'line', 'Funding line is a coin flip',
      `#${FUNDED} ${title(d.order[FUNDED - 1])} and #${FUNDED + 1} ${title(d.order[FUNDED])} are ${Math.abs(d.cur.counts[d.order[FUNDED - 1]] - d.cur.counts[d.order[FUNDED]])} apart.`);
  }
  // Momentum calls for the top 15.
  for (const s of d.order.slice(0, 15)) {
    const m = M.momentum(d.records, f, s);
    const top = d.ranks[s] <= FUNDED + 3 || s === HL;
    if (m.level === 'surging') {
      add(80 + Math.min(15, m.ratio), s, 'surging', `${title(s)} is surging`,
        `${m.recent.toFixed(1)} votes/h, about ${m.ratio.toFixed(1)}× its usual ${m.base.toFixed(1)}/h. Bursts like this usually fade, so the forecast lets it cool after ${Math.round(f.nearHours)}h: ~${fmt(f.projected[s])} at close.`);
    } else if (m.level === 'heating' && top) {
      add(55, s, 'heating', `${title(s)} is heating up`, `${m.recent.toFixed(1)}/h vs a usual ${m.base.toFixed(1)}/h.`);
    } else if (m.level === 'cooling' && top) {
      add(s === HL ? 85 : 45, s, 'cooling', `${title(s)} is slowing down`,
        `${m.recent.toFixed(1)}/h now vs a usual ${m.base.toFixed(1)}/h. If it stays this slow it ends near ${fmt(Math.round(d.cur.counts[s] + m.recent * f.remainingHours))} instead of ~${fmt(f.projected[s])}.`);
    } else if (m.level === 'stalled' && top) {
      add(s === HL ? 85 : 40, s, 'stalled', `${title(s)} has stalled`, `No new votes in ${dur(m.quietHours * HOUR)}.`);
    }
  }
  // Biggest session so far today.
  const sessions = M.sessionsBetween(d.first, d.cur.time);
  const last = sessions.filter((s) => !s.live).slice(-1)[0];
  if (last) {
    const g = M.sessionGains(d.records, d.order.slice(0, 15), [last]);
    const best = Object.entries(g).filter(([, v]) => v[0]).sort((a, b) => b[1][0].gain - a[1][0].gain)[0];
    if (best && best[1][0].gain > 0) {
      add(35, best[0], 'session', `Won the ${last.name.toLowerCase()} (${SESSION_SHORT[last.name]})`,
        `${title(best[0])} gained ${signed(best[1][0].gain)} between ${SESSION_SHORT[last.name].replace('–', ' and ')}, the most of any project.`);
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 7).map((x) => ({
    ...x, spark: spark(M.seriesFor(d.records, x.slug, sparkFrom), x.slug === HL ? REX : (LEVEL_COLOR[x.kind] || '#e8762c')),
  }));
}

function renderSignals(d, f) {
  const el = $('signals');
  if (!el) return;
  const list = buildSignals(d, f);
  el.innerHTML = list.length ? list.map((x) => `<li class="sig ${x.kind} ${x.slug === HL ? 'rex' : ''}">
      <div class="sig-top"><span class="sig-title">${esc(x.title)}</span>${x.spark}</div>
      <p>${esc(x.body)}</p></li>`).join('')
    : '<li class="empty">Signals appear once there is enough history to compare paces.</li>';
}

// ---------------------------------------------------------------- notifications

/**
 * Alerts for new collections. Removed projects and vote drops are always alerted, for
 * every project; then Hack The Rex news and funding-line changes. Shown as pop-ups and,
 * when switched on with the bell, as browser notifications (which also appear while the
 * dashboard is in a background tab).
 */
function alertsFor(events, d) {
  const out = [];
  for (const e of events) {
    if (e.kind === 'removed') {
      out.push({ cls: 'bad', label: 'Project removed', text: `${title(e.slug)} is no longer on the ballot (had ${fmt(e.total)} votes)`, urgent: true });
    }
  }
  for (const e of events.filter((x) => x.kind === 'decrease').sort((a, b) => a.delta - b.delta)) {
    const rex = e.slug === HL;
    out.push({ cls: 'bad', label: rex ? 'Hack The Rex lost votes' : 'Votes removed', text: `${title(e.slug)} ${signed(e.delta)} · now ${fmt(e.total)} (#${d.ranks[e.slug] ?? '–'})`, urgent: true });
  }
  for (const e of events) {
    if (e.kind === 'cutoff') out.push({ cls: e.slug === HL ? 'rex' : '', label: 'Funding line', text: `${title(e.slug)} ${e.entered ? 'entered' : 'dropped out of'} the top ${FUNDED}`, urgent: true });
    else if (e.kind === 'rank' && (e.slug === HL || (e.passed || []).includes(HL))) out.push({ cls: 'rex', label: 'Position change', text: `${title(e.slug)} moved ${e.after < e.before ? 'up' : 'down'} to #${e.after}`, urgent: e.slug === HL });
    else if (e.kind === 'new') out.push({ cls: '', label: 'New project', text: `${title(e.slug)} joined the ballot` });
  }
  const rexGain = events.filter((e) => e.slug === HL && e.kind === 'gain').reduce((s, e) => s + e.delta, 0);
  if (rexGain) out.push({ cls: 'rex', label: 'Hack The Rex', text: `${signed(rexGain)} votes · now ${fmt(d.cur.counts[HL])} (#${d.ranks[HL]})` });
  return out;
}

function notifyNew(prevLastT) {
  const events = M.buildEvents(state.records).filter((e) => e.at > prevLastT);
  if (!events.length) return;
  const d = derive();
  const list = alertsFor(events, d);
  if (!list.length) {
    const sum = events.filter((e) => e.kind === 'gain').reduce((s, e) => s + e.delta, 0);
    list.push({ cls: '', label: 'New collection', text: `${signed(sum)} votes across the ballot` });
  }
  const shown = list.slice(0, 5);
  for (const t of shown) toast(t);
  if (list.length > shown.length) toast({ cls: '', label: 'More alerts', text: `${list.length - shown.length} more in the live feed` });
  systemNotify(list.filter((t) => t.urgent || t.cls === 'rex'));
}

function systemNotify(list) {
  if (!state.notify || !('Notification' in window) || Notification.permission !== 'granted' || !list.length) return;
  const send = (titleText, body, tag) => {
    try { new Notification(titleText, { body, tag, icon: document.querySelector('link[rel=icon]')?.href }); } catch { /* unsupported context */ }
  };
  if (list.length <= 3) list.forEach((t, i) => send(t.label, t.text, `htr-${Date.now()}-${i}`));
  else send(`${list.length} vote alerts`, list.slice(0, 4).map((t) => `${t.label}: ${t.text}`).join('\n'), `htr-${Date.now()}`);
}

async function toggleNotifications() {
  if (!('Notification' in window)) {
    toast({ cls: 'bad', label: 'Alerts', text: 'This browser does not support notifications. On iPhone, add the page to your home screen first.' });
    return;
  }
  if (state.notify) { setPref('notify', false); toast({ cls: '', label: 'Alerts off', text: 'Browser notifications are off. Pop-ups on the page still appear.' }); return; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast({ cls: 'bad', label: 'Alerts blocked', text: 'Notifications are blocked for this site. Allow them in your browser settings, then try again.' });
    setPref('notify', false);
    return;
  }
  setPref('notify', true);
  toast({ cls: 'rex', label: 'Alerts on', text: 'You will get a notification when a project is removed, loses votes, crosses the funding line, or Hack The Rex moves.' });
  systemNotify([{ label: 'Alerts are on', text: 'This is what a vote alert looks like.' }]);
}

function renderBell() {
  const b = $('bellBtn');
  if (!b) return;
  const on = state.notify && 'Notification' in window && Notification.permission === 'granted';
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('span').textContent = on ? 'Alerts on' : 'Alerts';
}

function toast({ cls: c, label, text }) {
  const el = document.createElement('div');
  el.className = `toast ${c}`;
  el.innerHTML = `<p class="label">${esc(label)}</p>${esc(text)}`;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, c === 'bad' ? 12000 : 7000);
}

// ---------------------------------------------------------------- interactions

function setPref(k, v) { state[k] = v; store.set(k, v); render(); }

function bind() {
  $('refreshBtn').addEventListener('click', () => { state.loadedKey = null; poll(); });
  $('bellBtn').addEventListener('click', () => toggleNotifications().then(renderBell));
  $('chartTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-chart]'); if (b) setPref('chart', b.dataset.chart); });
  $('rangeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-range]'); if (b) setPref('range', Number(b.dataset.range)); });
  $('momSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-mom]'); if (b) setPref('mom', b.dataset.mom); });
  $('feedSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-feed]'); if (b) setPref('feed', b.dataset.feed); });
  $('limitSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-limit]'); if (b) setPref('limit', Number(b.dataset.limit)); });
  $('rankPeriod').addEventListener('change', (e) => setPref('rankPeriod', e.target.value));
  $('search').addEventListener('input', (e) => { state.search = e.target.value; const d = derive(); if (d) renderBoard(d); });
  $('showSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]'); if (!b) return;
    state.selected = null; store.set('selected', null);
    setPref('show', b.dataset.show);
  });
  $('projToggle').addEventListener('click', () => {
    const d = derive();
    if (d && !getForecast(d)) { toast({ cls: '', label: 'Predictions', text: Date.now() >= CLOSE ? 'Voting has closed.' : 'Predictions start once a pace can be measured.' }); return; }
    setPref('showProj', !state.showProj);
  });
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
// Re-measure chart labels once the web fonts have loaded.
Promise.all(['500 11px "IBM Plex Sans"', '600 11px "IBM Plex Sans"', '400 10.5px "IBM Plex Mono"'].map((f) => document.fonts?.load(f)))
  .then(() => { if (chart) chart.update('none'); }).catch(() => {});
setInterval(tick, 1000);
setInterval(() => renderStatus(derive()), 30e3);
tick();
