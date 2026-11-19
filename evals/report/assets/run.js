// The run report. Reads the embedded data and draws every section. Knows nothing about any one eval: metrics,
// axes, bands and item statuses all come from the data.

const D = readData();
const R = D.results;
const S = D.stats;
const OUTCOMES = ['graded', 'ungraded', 'error', 'skipped', 'env-unavailable'];
const metricByKey = Object.fromEntries(R.metrics.map(m => [m.key, m]));
const primary = metricByKey[S.primary];
const configById = Object.fromEntries(R.configs.map(c => [c.id, c]));
const caseById = Object.fromEntries(R.cases.map(c => [c.id, c]));
const costMetric = R.metrics.find(m => m.role === 'cost') || null;

const statusDefs = {};
(R.item_statuses || []).forEach(s => { statusDefs[s.key] = { label: s.label || s.key, color: s.color }; });
const FALLBACK = ['info', 'partial', 'neutral', 'warn', 'good', 'bad'];
let fallbackNext = 0;
function statusDef(key) {
  if (!statusDefs[key]) statusDefs[key] = { label: key, color: FALLBACK[fallbackNext++ % FALLBACK.length] };
  return statusDefs[key];
}

const gradedCount = {};
R.trials.forEach(t => { if (t.outcome === 'graded') gradedCount[t.case_id + '\u0000' + t.config_id] = (gradedCount[t.case_id + '\u0000' + t.config_id] || 0) + 1; });

const state = {
  filters: Object.fromEntries(R.axes.map(a => [a.key, '__all'])),
  sort: { key: 'rank', dir: 1 },
  drill: null,
  pair: null,
};

function axisText(value) { return value === null || value === undefined ? 'none' : String(value); }

function visibleConfigs() {
  return R.configs.filter(c => R.axes.every(a => state.filters[a.key] === '__all' || axisText(c.axes[a.key]) === state.filters[a.key]));
}

function m(cid, key) { return S.configs[cid].metrics[key]; }
function graded(cid) { return S.configs[cid].outcomes.graded || 0; }

// ---- header --------------------------------------------------------------------------------------------

function header() {
  const run = R.run;
  const totals = S.totals;
  const grader = [run.grader.harness, run.grader.model, run.grader.effort].filter(Boolean).join(' · ') || 'none';
  const gradedTotal = totals.outcomes.graded || 0;
  const errors = totals.outcomes.error || 0;
  const items = [
    ['Run', run.id],
    ['Started', fmtDate(run.started_at)],
    ['Skills', run.subject ? shortSha(run.subject.skills_sha) + (run.subject.skills_ref ? ' (' + run.subject.skills_ref + ')' : '') : 'n/a'],
    ['Grader', grader],
    ['Cases', String(R.cases.length)],
    ['Trials', totals.trials + ' (' + gradedTotal + ' graded)'],
    ['Total cost', costMetric ? (totals.cost === null ? 'n/a' : fmt(totals.cost, 'cost', costMetric.estimated) + ' over ' + plural(totals.cost_trials, 'trial')) : 'not measured'],
    ['Errors', String(errors)],
  ];
  if (run.grader.cost_usd !== undefined || run.grader.calls !== undefined) items.push(['Grader cost', (typeof run.grader.cost_usd === 'number' && Number.isFinite(run.grader.cost_usd) ? fmt(run.grader.cost_usd, 'cost', true) : 'n/a') + (run.grader.cost_complete === false ? ' (partial)' : '') + ' · ' + (run.grader.calls == null ? 'n/a' : String(run.grader.calls)) + ' calls']);
  if (run.context) items.push(['Context', run.context]);
  if (run.eval_version) items.push(['Eval version', run.eval_version]);
  if (run.regraded_from) items.push(['Regrade of', run.regraded_from]);
  const head = el('header', {},
    el('div', { class: 'topbar' },
      el('div', {}, el('h1', { text: run.eval + ' eval' }), el('p', { class: 'muted', text: 'Eval report · results schema ' + R.schema })),
      themeToggle()),
    el('dl', { class: 'meta' }, items.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { class: 'num', text: v, title: k === 'Skills' && run.subject ? run.subject.skills_sha : null })))),
    run.notes ? el('p', { class: 'lede', style: 'margin-top:10px' }, el('strong', { text: 'Notes: ' }), run.notes) : null,
    gradedTotal === 0 ? el('div', { class: 'banner', 'data-empty': 'all-failed', role: 'note' },
      'No trial in this run was graded, so every chart is empty. "Errors and outcomes" lists the reasons.') : null,
    costMetric && costMetric.estimated ? el('p', { class: 'small muted', text: '≈ marks an estimate: ' + costMetric.label + ' is estimated.' }) : null,
    el('nav', { class: 'nav', 'aria-label': 'Sections' }, [
      ['leaderboard', 'Leaderboard'], ['cost', 'Quality vs cost'], ['latency', 'Quality vs time'], ['axes', 'Axis effects'],
      ['heatmap', 'Cases'], ['items', 'Items'], ['stability', 'Stability'], ['outcomes', 'Outcomes'], ['drill', 'Drill-down'], ['h2h', 'Head-to-head'],
    ].map(([id, text]) => el('a', { href: '#' + id, text }))));
  return head;
}

function filterBar() {
  const controls = R.axes.map(axis => {
    const values = [];
    R.configs.forEach(c => { const v = axisText(c.axes[axis.key]); if (!values.includes(v)) values.push(v); });
    if (values.length < 2) return null;
    return selectBox(axis.label, [{ value: '__all', label: 'All' }].concat(values.map(v => ({ value: v, label: v }))),
      state.filters[axis.key], v => { state.filters[axis.key] = v; renderAll(); });
  }).filter(Boolean);
  const shown = visibleConfigs().length;
  return el('div', { class: 'filters', role: 'group', 'aria-label': 'Filter configs' }, controls,
    el('span', { class: 'small muted', text: 'Showing ' + shown + ' of ' + plural(R.configs.length, 'config') }));
}

// ---- leaderboard -----------------------------------------------------------------------------------------

function leaderboard(configs) {
  if (!configs.length) return card('leaderboard', 'Leaderboard', null, empty('no-configs', 'No config matches the filters.'));
  const ranked = {};
  R.metrics.forEach(mt => { ranked[mt.key] = Object.values(S.ranks[mt.key]).filter(r => r !== null).length; });
  const sortValue = c => {
    if (state.sort.key === 'rank') return S.ranks[primary.key][c.id];
    if (state.sort.key === 'label') return c.label;
    const v = m(c.id, state.sort.key).mean;
    return v === null ? null : v;
  };
  const rows = configs.slice().sort((a, b) => {
    const va = sortValue(a), vb = sortValue(b);
    if (va === null || va === undefined) return (vb === null || vb === undefined) ? 0 : 1;
    if (vb === null || vb === undefined) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.sort.dir;
  });
  const sortHead = (key, text, cls) => {
    const active = state.sort.key === key;
    const button = el('button', { class: 'sort', type: 'button', text });
    button.addEventListener('click', () => {
      if (state.sort.key === key) state.sort.dir *= -1;
      else { state.sort.key = key; const mt = metricByKey[key]; state.sort.dir = mt && mt.better === 'higher' ? -1 : 1; }
      replaceSection('leaderboard', leaderboard(visibleConfigs()));
    });
    return el('th', { scope: 'col', class: cls, 'aria-sort': active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : null }, button);
  };
  const table = el('table', { class: 'num' },
    el('thead', {}, el('tr', {}, sortHead('rank', 'Rank'), sortHead('label', 'Config', 'sticky-col'),
      R.metrics.map(mt => sortHead(mt.key, mt.label + (mt.primary ? ' (primary)' : ''))),
      el('th', { scope: 'col', text: 'Graded' }))),
    el('tbody', {}, rows.map(c => el('tr', {},
      el('td', { class: 'num', text: S.ranks[primary.key][c.id] === null ? '–' : String(S.ranks[primary.key][c.id]) }),
      el('th', { scope: 'row', class: 'sticky-col' }, c.label,
        graded(c.id) === 0 ? el('div', { class: 'small muted', 'data-empty': 'no-graded', text: 'No graded trials' }) : null),
      R.metrics.map(mt => {
        const s = m(c.id, mt.key);
        const cls = s.mean === null ? 'qnone' : stepClass(goodnessFromRank(S.ranks[mt.key][c.id], ranked[mt.key]));
        return el('td', {}, el('span', { class: 'cell ' + cls, title: s.n_trials + ' trials over ' + plural(s.n_cases, 'case') },
          fmt(s.mean, mt.kind, mt.estimated), el('span', { class: 'ci', text: s.mean === null ? '' : fmtInterval(s.lo, s.hi, mt.kind, mt.estimated) })));
      }),
      el('td', { class: 'num', text: graded(c.id) + '/' + S.configs[c.id].trials })))));
  return card('leaderboard', 'Leaderboard',
    'Mean over graded trials, with a 95% interval from a bootstrap over cases (1000 resamples, fixed seed). Color shows rank within each column; the number is always printed. Rank uses ' + primary.label + '. Click a column to sort.',
    el('div', { class: 'legend' }, rampLegend('worse rank', 'better rank'), el('span', { text: 'Gray: no graded value.' })),
    scrollTable(table));
}

// ---- scatter -------------------------------------------------------------------------------------------

function scatter(role, configs) {
  const id = role === 'cost' ? 'cost' : 'latency';
  const title = role === 'cost' ? 'Quality against cost' : 'Quality against time';
  const p = S.pareto[role];
  if (!p) return card(id, title, null, empty('no-' + role, 'This eval declares no ' + (role === 'cost' ? 'cost' : 'latency') + ' metric.'));
  const xm = metricByKey[p.metric];
  const points = configs.map(c => ({ c, x: m(c.id, xm.key).mean, y: m(c.id, primary.key) })).filter(pt => pt.x !== null && pt.y.mean !== null);
  if (configs.length < 2) return card(id, title, null, empty('one-config', 'Only one config is shown, so there is nothing to compare.'));
  if (points.length < 2) {
    const kind = configs.some(c => m(c.id, xm.key).mean !== null) ? 'no-graded' : (role === 'cost' ? 'no-cost-data' : 'no-latency-data');
    return card(id, title, null, empty(kind, 'Fewer than two configs have both a graded ' + primary.label + ' and a ' + xm.label + '.'));
  }
  const front = p.front.filter(cid => points.some(pt => pt.c.id === cid));
  const chart = responsive(el('div', { class: 'chart' }), w => {
    const h = w < 480 ? 260 : 320, ml = 52, mr = 18, mt = 14, mb = 44;
    const [x0, x1] = domainFor(xm.kind, points.map(pt => pt.x));
    const xs = scale(x0, x1 * 1.08, ml, w - mr);
    const [y0, y1] = domainFor(primary.kind, points.flatMap(pt => [pt.y.lo, pt.y.hi, pt.y.mean]));
    const ys = scale(y0, y1, h - mb, mt);
    const svg = sv('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': title });
    niceTicks(y0, y1, 5).filter(t => t >= y0 && t <= y1).forEach(t => {
      svg.appendChild(sv('line', { class: 'grid', x1: ml, x2: w - mr, y1: ys(t), y2: ys(t) }));
      svg.appendChild(sv('text', { x: ml - 6, y: ys(t), 'text-anchor': 'end', 'dominant-baseline': 'middle', text: fmt(t, primary.kind) }));
    });
    niceTicks(x0, x1 * 1.08, w < 480 ? 3 : 5).filter(t => t >= x0 && t <= x1 * 1.08).forEach(t => {
      svg.appendChild(sv('text', { x: xs(t), y: h - mb + 16, 'text-anchor': 'middle', text: fmt(t, xm.kind) }));
    });
    svg.appendChild(sv('line', { class: 'base', x1: ml, x2: w - mr, y1: h - mb, y2: h - mb }));
    svg.appendChild(sv('text', { class: 'axis-title', x: (ml + w - mr) / 2, y: h - 6, 'text-anchor': 'middle', text: xm.label + (xm.estimated ? ' (estimated)' : '') + ' →' }));
    svg.appendChild(sv('text', { class: 'axis-title', x: 12, y: mt + (h - mb - mt) / 2, 'text-anchor': 'middle', transform: 'rotate(-90 12 ' + (mt + (h - mb - mt) / 2) + ')', text: primary.label + ' →' }));
    const fp = front.map(cid => points.find(pt => pt.c.id === cid)).sort((a, b) => a.x - b.x);
    if (fp.length > 1) svg.appendChild(sv('polyline', { points: fp.map(pt => xs(pt.x) + ',' + ys(pt.y.mean)).join(' '), fill: 'none', style: 'stroke: var(--s1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    points.forEach(pt => {
      if (pt.y.lo !== null) svg.appendChild(sv('line', { x1: xs(pt.x), x2: xs(pt.x), y1: ys(pt.y.lo), y2: ys(pt.y.hi), style: 'stroke: var(--muted)', 'stroke-width': 1 }));
    });
    // Direct labels on front points only, placed above or below; a label that would overlap one already placed is
    // left off (the tooltip still names the point).
    const placed = points.map(pt => ({ x0: xs(pt.x) - 7, x1: xs(pt.x) + 7, y0: ys(pt.y.mean) - 7, y1: ys(pt.y.mean) + 7 }));
    const placeLabel = (cx, cy, text) => {
      const width = text.length * 6.2, right = cx > w - 160;
      const x0 = right ? cx - 9 - width : cx + 9;
      for (const dy of [-8, 16]) {
        const box = { x0, x1: x0 + width, y0: cy + dy - 11, y1: cy + dy + 3 };
        if (box.y0 < mt - 4 || box.y1 > h - mb) continue;
        if (placed.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
        placed.push(box);
        return sv('text', { x: right ? cx - 9 : cx + 9, y: cy + dy, 'text-anchor': right ? 'end' : 'start', text });
      }
      return null;
    };
    points.forEach(pt => {
      const onFront = front.includes(pt.c.id);
      const cx = xs(pt.x), cy = ys(pt.y.mean);
      const g = sv('g', {});
      g.appendChild(withTip(sv('circle', { class: 'hit', cx, cy, r: 14, tabindex: 0, role: 'img' }), [
        pt.c.label,
        primary.label + ': ' + fmt(pt.y.mean, primary.kind) + ' (' + fmtInterval(pt.y.lo, pt.y.hi, primary.kind) + ')',
        xm.label + ': ' + fmt(pt.x, xm.kind, xm.estimated),
        onFront ? 'On the Pareto front' : 'Dominated: another config is at least as good on both',
      ]));
      g.appendChild(sv('circle', { class: 'mark', cx, cy, r: 5, 'stroke-width': 2,
        style: onFront ? 'fill: var(--s1); stroke: var(--surface)' : 'fill: var(--surface); stroke: var(--muted)' }));
      svg.appendChild(g);
      if (onFront && w >= 480) {
        const label = placeLabel(cx, cy, truncate(pt.c.label, 30));
        if (label) svg.appendChild(label);
      }
    });
    return svg;
  });
  return card(id, title,
    primary.label + ' (y) against mean ' + xm.label.toLowerCase() + ' (x) for each config. The line joins the Pareto front: configs that no other config beats on both. The front is computed over all configs. Whiskers show the 95% interval.',
    chart,
    el('div', { class: 'legend' },
      el('span', {}, el('span', { class: 'sw fill' }), 'On the front'),
      el('span', {}, el('span', { class: 'sw ring' }), 'Dominated'),
      el('span', { text: 'Hover or focus a point for values.' })));
}

function truncate(text, n) { text = String(text); return text.length > n ? text.slice(0, n - 1) + '…' : text; }

// ---- axis effects -----------------------------------------------------------------------------------------

function axisEffects(configs) {
  const visible = new Set(configs.map(c => c.id));
  const effects = S.axis_effects;
  if (!effects.length) return card('axes', 'Axis effects', null, empty('no-axis', 'No axis has two or more values in this run.'));
  const blocks = effects.map(effect => {
    const groups = effect.groups.map(g => ({ ...g, bars: g.bars.filter(b => visible.has(b.config_id)) }))
      .filter(g => new Set(g.bars.map(b => axisText(b.value))).size >= 2);
    const heading = el('h3', { text: effect.label });
    if (!groups.length) return el('div', {}, heading, empty('no-axis-group', 'No two shown configs differ only by ' + effect.label.toLowerCase() + '.'));
    const valueIndex = v => effect.values.findIndex(x => axisText(x) === axisText(v));
    const chart = responsive(el('div', { class: 'chart' }), w => {
      const h = 240, ml = 48, mr = 12, mt = 16, mb = 46;
      const all = groups.flatMap(g => g.bars.flatMap(b => [b.mean, b.hi]));
      const [y0, y1] = domainFor(primary.kind, all);
      const ys = scale(y0, y1, h - mb, mt);
      const band = (w - ml - mr) / groups.length;
      const svg = sv('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': primary.label + ' by ' + effect.label });
      niceTicks(y0, y1, 4).filter(t => t >= y0 && t <= y1).forEach(t => {
        svg.appendChild(sv('line', { class: 'grid', x1: ml, x2: w - mr, y1: ys(t), y2: ys(t) }));
        svg.appendChild(sv('text', { x: ml - 6, y: ys(t), 'text-anchor': 'end', 'dominant-baseline': 'middle', text: fmt(t, primary.kind) }));
      });
      groups.forEach((g, gi) => {
        const bw = Math.min(30, (band * 0.8 - 2 * (g.bars.length - 1)) / g.bars.length);
        const total = bw * g.bars.length + 2 * (g.bars.length - 1);
        const start = ml + gi * band + (band - total) / 2;
        g.bars.forEach((b, bi) => {
          const x = start + bi * (bw + 2);
          const color = seriesColor(valueIndex(b.value));
          const label = configById[b.config_id].label;
          const lines = [label, effect.label + ': ' + axisText(b.value), primary.label + ': ' + fmt(b.mean, primary.kind) + (b.lo !== null ? ' (' + fmtInterval(b.lo, b.hi, primary.kind) + ')' : '')];
          if (b.mean === null) {
            svg.appendChild(sv('text', { x: x + bw / 2, y: h - mb - 4, 'text-anchor': 'middle', text: 'n/a' }));
          } else {
            const top = ys(b.mean), base = ys(Math.max(y0, 0));
            const r = Math.min(4, bw / 2, Math.abs(base - top));
            const d = 'M' + x + ',' + base + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) + 'V' + base + 'Z';
            svg.appendChild(withTip(sv('rect', { class: 'hit', x: x - 2, y: mt, width: bw + 4, height: h - mb - mt, tabindex: 0, role: 'img' }), lines));
            svg.appendChild(sv('path', { class: 'mark', d, style: 'fill: ' + color }));
            if (b.lo !== null) svg.appendChild(sv('line', { x1: x + bw / 2, x2: x + bw / 2, y1: ys(b.lo), y2: ys(b.hi), style: 'stroke: var(--ink-2)', 'stroke-width': 1 }));
          }
        });
        const maxChars = Math.max(6, Math.floor(band / 6.5));
        svg.appendChild(sv('text', { x: ml + gi * band + band / 2, y: h - mb + 16, 'text-anchor': 'middle', text: truncate(g.label, maxChars) }));
      });
      svg.appendChild(sv('line', { class: 'base', x1: ml, x2: w - mr, y1: ys(Math.max(y0, 0)), y2: ys(Math.max(y0, 0)) }));
      svg.appendChild(sv('text', { class: 'axis-title', x: (ml + w - mr) / 2, y: h - 8, 'text-anchor': 'middle', text: 'Configs that share every other axis value' }));
      return svg;
    });
    const used = [];
    groups.forEach(g => g.bars.forEach(b => { if (!used.some(u => axisText(u) === axisText(b.value))) used.push(b.value); }));
    used.sort((a, b) => valueIndex(a) - valueIndex(b));
    return el('div', {}, heading, chart, el('div', { class: 'legend' },
      used.map(v => el('span', {}, el('span', { class: 'sw', style: 'background: ' + seriesColor(valueIndex(v)) }), axisText(v)))));
  });
  return card('axes', 'Axis effects',
    'For each axis, ' + primary.label + ' of configs that are the same on every other axis. Only groups with two or more values of the axis show. Whiskers show the 95% interval.',
    el('div', { class: 'charts-grid' }, blocks));
}

// ---- heatmap ----------------------------------------------------------------------------------------------

function goodness(value, metric, lo, hi) {
  if (value === null) return null;
  let g = metric.kind === 'rate' ? value : (hi === lo ? 1 : (value - lo) / (hi - lo));
  return metric.better === 'higher' ? g : 1 - g;
}

function caseLabel(c) {
  return [el('span', { class: 'case-title', text: c.title }), el('span', { class: 'small muted mono', text: c.id }),
    (c.tags || []).length ? el('span', { class: 'tags' }, c.tags.map(t => el('span', { class: 'tag', text: t }))) : null];
}

function heatmap(configs) {
  if (!R.cases.length) return card('heatmap', 'Cases × configs', null, empty('no-cases', 'This run has no cases.'));
  if (!configs.length) return card('heatmap', 'Cases × configs', null, empty('no-configs', 'No config matches the filters.'));
  const body = [];
  S.heatmap.forEach(band => {
    const metric = metricByKey[band.metric];
    const values = [];
    band.case_ids.forEach(cid => configs.forEach(c => { const v = band.cells[cid][c.id].mean; if (v !== null) values.push(v); }));
    const lo = Math.min(...values), hi = Math.max(...values);
    body.push(el('tr', { class: 'band-row' }, el('th', { colspan: configs.length + 1, scope: 'rowgroup', class: 'sticky-col' },
      band.label + ' · ' + metric.label + ' (' + (metric.better === 'higher' ? 'higher' : 'lower') + ' is better)')));
    band.case_ids.forEach(caseId => {
      const c = caseById[caseId];
      body.push(el('tr', {}, el('th', { scope: 'row', class: 'sticky-col' }, caseLabel(c)),
        configs.map(cfg => {
          const cell = band.cells[caseId][cfg.id];
          const btn = el('button', { type: 'button', class: 'cellbtn ' + stepClass(goodness(cell.mean, metric, lo, hi)),
            title: c.title + ' · ' + cfg.label + ': ' + plural(cell.n, 'graded value') + '. Open the drill-down.',
            text: fmt(cell.mean, metric.kind, metric.estimated) });
          btn.addEventListener('click', () => openDrill(caseId, cfg.id));
          return el('td', { class: 'hc' }, btn);
        })));
    });
  });
  const table = el('table', { class: 'heat' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'sticky-col', text: 'Case' }),
      configs.map(c => el('th', { scope: 'col', class: 'colhead', text: c.label })))),
    el('tbody', {}, body));
  return card('heatmap', 'Cases × configs',
    'Each cell is the mean over that config\'s graded trials on the case, for the metric its band names. Click a cell for the trials.',
    el('div', { class: 'legend' }, rampLegend('worse', 'better'), el('span', { text: 'Gray "n/a": no graded trial with a value.' })),
    scrollTable(table));
}

// ---- item grid --------------------------------------------------------------------------------------------

function statusChip(key, text) {
  const def = statusDef(key);
  return el('span', { class: 'status' }, el('span', { class: 'dot st-' + def.color, 'aria-hidden': 'true' }), text);
}

function itemGrid(configs) {
  if (!S.items.length) return card('items', 'Items', null, empty('no-items', 'Trials in this run have no items.'));
  if (!configs.length) return card('items', 'Items', null, empty('no-configs', 'No config matches the filters.'));
  const rows = [];
  let lastCase = null;
  const seen = new Set();
  S.items.forEach(item => {
    if (item.case_id !== lastCase) {
      lastCase = item.case_id;
      rows.push(el('tr', { class: 'band-row' }, el('th', { colspan: configs.length + 1, scope: 'rowgroup', class: 'sticky-col', text: caseById[item.case_id].title })));
    }
    rows.push(el('tr', {}, el('th', { scope: 'row', class: 'sticky-col' }, el('span', { class: 'mono small', text: item.item_id + ' ' }), el('span', { class: 'case-title', text: item.label })),
      configs.map(cfg => {
        const cell = item.cells[cfg.id];
        const total = gradedCount[item.case_id + '\u0000' + cfg.id] || 0;
        if (!cell) return el('td', { class: 'small muted', text: total ? '0/' + total : 'n/a' });
        const entries = Object.entries(cell.counts).sort((a, b) => b[1] - a[1]);
        entries.forEach(([k]) => seen.add(k));
        return el('td', {}, el('div', { class: 'status-list' }, entries.map(([k, n]) => statusChip(k, n + '/' + cell.total + ' ' + statusDef(k).label))));
      })));
  });
  const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'sticky-col', text: 'Item' }),
    configs.map(c => el('th', { scope: 'col', class: 'colhead', text: c.label })))), el('tbody', {}, rows));
  return card('items', 'Items',
    'One row for each item of a case. A cell counts how many of the config\'s graded trials on that case gave each status. "0/3" means the item never came up.',
    el('div', { class: 'legend' }, [...seen].map(k => statusChip(k, statusDef(k).label))),
    scrollTable(table));
}

// ---- stability ----------------------------------------------------------------------------------------------

function stability(configs) {
  const any = configs.some(c => S.stability[c.id].cases.length);
  if (!configs.length) return card('stability', 'Stability', null, empty('no-configs', 'No config matches the filters.'));
  if (!any) return card('stability', 'Stability', null, empty('no-stability', 'No case has two or more graded trials of one config, so there is no spread to show.'));
  const maxSd = Math.max(...configs.flatMap(c => S.stability[c.id].cases.map(s => s.sd)), 1e-9);
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ['Config', 'Mean ' + primary.label, 'Cases with 2+ trials', 'Mean spread (SD)', 'Worst case', 'Spread per case'].map((t, i) =>
      el('th', { scope: 'col', class: i === 0 ? 'sticky-col' : (i === 1 || i === 2 || i === 3 ? 'num' : null), text: t })))),
    el('tbody', {}, configs.map(c => {
      const st = S.stability[c.id];
      const worst = st.cases[0];
      const strip = sv('svg', { width: 170, height: 26, viewBox: '0 0 170 26', role: 'img', 'aria-label': 'Spread per case' });
      strip.appendChild(sv('line', { class: 'base', x1: 5, x2: 165, y1: 13, y2: 13, style: 'stroke: var(--axis)' }));
      st.cases.forEach(s => {
        const x = 5 + (s.sd / maxSd) * 160;
        strip.appendChild(withTip(sv('circle', { cx: x, cy: 13, r: 5, tabindex: 0, style: 'fill: var(--s1); stroke: var(--surface)', 'stroke-width': 2 }),
          [caseById[s.case_id].title, 'SD ' + fmt(s.sd, primary.kind) + ' over ' + plural(s.n, 'trial'), 'Range ' + fmt(s.min, primary.kind) + ' – ' + fmt(s.max, primary.kind)]));
      });
      return el('tr', {},
        el('th', { scope: 'row', class: 'sticky-col', text: c.label }),
        el('td', { class: 'num', text: fmt(m(c.id, primary.key).mean, primary.kind) }),
        el('td', { class: 'num', text: String(st.cases.length) }),
        el('td', { class: 'num', text: st.mean_sd === null ? 'n/a' : fmt(st.mean_sd, primary.kind) }),
        el('td', {}, worst ? [el('span', { class: 'case-title', text: caseById[worst.case_id].title }),
          el('span', { class: 'small muted', text: fmt(worst.min, primary.kind) + ' – ' + fmt(worst.max, primary.kind) })] : el('span', { class: 'muted', 'data-empty': 'no-spread', text: 'n/a: needs 2+ graded trials on a case' })),
        el('td', {}, st.cases.length ? strip : null));
    })));
  return card('stability', 'Stability',
    'The spread of ' + primary.label + ' over the trials of one case: the sample standard deviation per case. A config with a high mean and a high spread is not reliable. Strip scale: 0 to ' + fmt(maxSd, primary.kind) + '.',
    scrollTable(table));
}

// ---- outcomes -----------------------------------------------------------------------------------------------

function outcomes(configs) {
  if (!configs.length) return card('outcomes', 'Errors and outcomes', null, empty('no-configs', 'No config matches the filters.'));
  const table = el('table', {},
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'sticky-col', text: 'Config' }),
      OUTCOMES.map(o => el('th', { scope: 'col', class: 'num', text: o })), el('th', { scope: 'col', text: 'Reasons' }))),
    el('tbody', {}, configs.map(c => {
      const st = S.configs[c.id];
      return el('tr', {}, el('th', { scope: 'row', class: 'sticky-col', text: c.label }),
        OUTCOMES.map(o => el('td', { class: 'num', text: String(st.outcomes[o] || 0) })),
        el('td', {}, st.reasons.length ? el('div', { class: 'status-list' }, st.reasons.map(r =>
          el('span', {}, el('strong', { text: r.count + '× ' + r.outcome }), r.reason ? ': ' + r.reason : ''))) : el('span', { class: 'muted', text: '–' })));
    })));
  return card('outcomes', 'Errors and outcomes', 'Only graded trials count toward means. Every other outcome is counted here, with its reasons.', scrollTable(table));
}

// ---- drill-down -----------------------------------------------------------------------------------------------

function openDrill(caseId, configId) {
  state.drill = { caseId, configId };
  replaceSection('drill', drill(visibleConfigs()));
  document.getElementById('drill').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fileSize(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }

function drill(configs) {
  if (!R.cases.length || !R.configs.length) return card('drill', 'Drill-down', null, empty('no-trials', 'This run has no trials.'));
  if (!state.drill || !caseById[state.drill.caseId] || !configById[state.drill.configId]) {
    const first = R.trials.find(t => t.outcome === 'graded') || R.trials[0];
    state.drill = first ? { caseId: first.case_id, configId: first.config_id } : { caseId: R.cases[0].id, configId: R.configs[0].id };
  }
  const { caseId, configId } = state.drill;
  const picks = el('div', { class: 'pick' },
    selectBox('Case', R.cases.map(c => ({ value: c.id, label: c.title })), caseId, v => { state.drill.caseId = v; replaceSection('drill', drill(visibleConfigs())); }),
    selectBox('Config', R.configs.map(c => ({ value: c.id, label: c.label })), configId, v => { state.drill.configId = v; replaceSection('drill', drill(visibleConfigs())); }));
  const trials = R.trials.filter(t => t.case_id === caseId && t.config_id === configId).sort((a, b) => a.trial - b.trial);
  const c = caseById[caseId];
  const body = trials.length ? trials.map(t => {
    const files = D.files[t.token] || [];
    return el('div', { class: 'trial' },
      el('h3', { style: 'margin-top:0' }, 'Trial ' + t.trial + ' · ', el('span', { text: t.outcome }), t.reason ? el('span', { class: 'muted', text: ' · ' + t.reason }) : null),
      el('div', { class: 'chips' }, R.metrics.map(mt => el('span', { class: 'chip num', text: mt.label + ': ' + fmt(t.metrics[mt.key] === undefined ? null : t.metrics[mt.key], mt.kind, mt.estimated) }))),
      t.usage ? el('div', { class: 'chips' }, Object.entries(t.usage).map(([k, v]) => el('span', { class: 'chip num small', text: k.replace(/_/g, ' ') + ': ' + (v === null ? 'n/a' : Number(v).toLocaleString('en-US')) }))) : null,
      (t.items || []).length ? el('div', { class: 'status-list', style: 'margin:6px 0' }, t.items.map(it => statusChip(it.status, it.id + ' · ' + statusDef(it.status).label + ' · ' + it.label))) : null,
      el('p', { class: 'small muted mono', text: 'trials/' + t.token + '/' }),
      files.length ? files.map((f, i) => el('details', { open: i === 0 },
        el('summary', {}, f.name + ' (' + fileSize(f.bytes) + (f.truncated ? ', truncated' : '') + ')'),
        el('pre', { class: 'raw', text: f.text }),
        f.truncated ? el('p', { class: 'small muted', text: 'Showing the first ' + fileSize(f.text_bytes) + '. The full file is in the run directory.' }) : null))
        : el('p', { class: 'muted', 'data-empty': 'no-files', text: 'No raw files for this trial.' }));
  }) : [empty('no-trials', 'No trials for this case and config.')];
  return card('drill', 'Drill-down', 'Each trial of one case and one config: outcome, metrics, items and the raw files from trials/<token>/. Raw text shows as plain text, never as markup.',
    picks, el('div', { class: 'small', style: 'margin-bottom:6px' }, caseLabel(c)), body);
}

// ---- head-to-head -------------------------------------------------------------------------------------------

function pairResult(a, b) {
  const direct = S.pairs[JSON.stringify([a, b])];
  if (direct) return direct;
  const rev = S.pairs[JSON.stringify([b, a])];
  if (!rev) return null;
  const metrics = {};
  Object.entries(rev.metrics).forEach(([k, r]) => {
    metrics[k] = { diff: r.diff === null ? null : -r.diff, lo: r.hi === null ? null : -r.hi, hi: r.lo === null ? null : -r.lo, n: r.n };
  });
  return { metrics, top_cases: rev.top_cases.map(t => ({ case_id: t.case_id, a: t.b, b: t.a, diff: -t.diff })) };
}

function headToHead(configs) {
  if (configs.length < 2) return card('h2h', 'Head-to-head', null, empty('one-config', 'Head-to-head needs two configs.'));
  const ids = configs.map(c => c.id);
  if (!state.pair || !ids.includes(state.pair[0]) || !ids.includes(state.pair[1])) {
    const byRank = ids.slice().sort((x, y) => (S.ranks[primary.key][x] ?? 1e9) - (S.ranks[primary.key][y] ?? 1e9));
    state.pair = [byRank[0], byRank[1]];
  }
  const [a, b] = state.pair;
  const opts = configs.map(c => ({ value: c.id, label: c.label }));
  const picks = el('div', { class: 'pick' },
    selectBox('Config A', opts, a, v => { state.pair[0] = v; replaceSection('h2h', headToHead(visibleConfigs())); }),
    selectBox('Config B', opts, b, v => { state.pair[1] = v; replaceSection('h2h', headToHead(visibleConfigs())); }));
  if (a === b) return card('h2h', 'Head-to-head', null, picks, empty('same-config', 'Pick two different configs.'));
  const pr = pairResult(a, b);
  const reading = (mt, r) => {
    if (r.n === 0) return el('span', { class: 'muted', text: 'no shared cases' });
    if (r.lo === null) return el('span', { class: 'muted', text: 'too few shared cases' });
    if (r.lo > 0 || r.hi < 0) {
      const aBetter = (r.diff > 0) === (mt.better === 'higher');
      return el('span', { class: 'delta-good', text: (aBetter ? 'A' : 'B') + ' is better' });
    }
    return el('span', { class: 'muted', text: 'no clear difference' });
  };
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ['Metric', 'A', 'B', 'A − B', '95% interval', 'Cases', 'Reading'].map((t, i) =>
      el('th', { scope: 'col', class: i === 0 ? 'sticky-col' : (i > 0 && i < 6 ? 'num' : null), text: t })))),
    el('tbody', {}, R.metrics.map(mt => {
      const r = pr.metrics[mt.key];
      return el('tr', {}, el('th', { scope: 'row', class: 'sticky-col', text: mt.label }),
        el('td', { class: 'num', text: fmt(m(a, mt.key).mean, mt.kind, mt.estimated) }),
        el('td', { class: 'num', text: fmt(m(b, mt.key).mean, mt.kind, mt.estimated) }),
        el('td', { class: 'num', text: fmtDelta(r.diff, mt.kind, mt.estimated) }),
        el('td', { class: 'num', text: r.lo === null ? 'n/a' : fmtDelta(r.lo, mt.kind, mt.estimated) + ' to ' + fmtDelta(r.hi, mt.kind, mt.estimated) }),
        el('td', { class: 'num', text: String(r.n) }),
        el('td', {}, reading(mt, r)));
    })));
  const sharedPrimary = pr.metrics[primary.key].n;
  const top = sharedPrimary === 0 ? empty('no-shared-cases', 'No case has a graded ' + primary.label + ' for both configs.') : pr.top_cases.length ? el('table', {},
    el('thead', {}, el('tr', {}, ['Case', 'A', 'B', 'A − B'].map((t, i) => el('th', { scope: 'col', class: i ? 'num' : null, text: t })))),
    el('tbody', {}, pr.top_cases.map(t => el('tr', {}, el('td', {}, caseLabel(caseById[t.case_id])),
      el('td', { class: 'num', text: fmt(t.a, primary.kind) }), el('td', { class: 'num', text: fmt(t.b, primary.kind) }),
      el('td', { class: 'num', text: fmtDelta(t.diff, primary.kind) })))))
    : empty('no-difference', 'The two configs give the same ' + primary.label + ' on every shared case.');
  return card('h2h', 'Head-to-head',
    'A paired comparison over the cases both configs have. The difference for a case is A\'s mean minus B\'s; the interval is a paired bootstrap over those cases. Overlapping leaderboard intervals do not show that two configs are equal; this does the comparison directly.',
    picks, scrollTable(table), el('h3', { text: 'Cases where they differ most on ' + primary.label }), scrollTable(top));
}

// ---- assembly ---------------------------------------------------------------------------------------------------

function replaceSection(id, node) {
  const old = document.getElementById(id);
  if (old) old.replaceWith(node);
}

function renderAll() {
  resetRedrawers();
  hideTip();
  const configs = visibleConfigs();
  const app = document.getElementById('app');
  app.replaceChildren(el('div', { class: 'wrap' },
    header(), filterBar(), leaderboard(configs), el('div', { class: 'charts-grid' }, scatter('cost', configs), scatter('latency', configs)),
    axisEffects(configs), heatmap(configs), itemGrid(configs), stability(configs), outcomes(configs), drill(configs), headToHead(configs),
    el('p', { class: 'small muted', style: 'margin-top:20px', text: 'Built by evals/report/build_report.py from results.json. Self-contained: this page loads nothing from the network.' })));
}

renderAll();
