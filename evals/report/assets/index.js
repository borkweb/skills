// The index page: every run under a runs root, a trend chart for each eval, and a paired comparison of two runs.

const D = readData();
const pickState = {};

function graderText(g) { return [g.harness, g.model, g.effort].filter(Boolean).join(' · ') || 'none'; }

function trendChart(ev) {
  const primary = ev.metrics.find(m => m.key === ev.primary);
  if (!ev.shared_cases) return empty('no-shared-cases', 'The runs of this eval share no case, so no trend point is comparable.');
  const keys = [];
  ev.runs.forEach(r => Object.keys(r.points).forEach(k => { if (r.points[k] !== null && !keys.includes(k)) keys.push(k); }));
  if (!keys.length) return empty('no-graded', 'No run of this eval has a graded ' + primary.label + '.');
  const shown = keys.slice(0, 8);
  const latestCompat = ev.runs[ev.runs.length - 1].compat;
  const chart = responsive(el('div', { class: 'chart' }), w => {
    const h = w < 480 ? 260 : 300, ml = 52, mr = 18, mt = 16, mb = 52;
    const n = ev.runs.length;
    const xs = i => n === 1 ? (ml + w - mr) / 2 : ml + 12 + i * ((w - ml - mr - 24) / (n - 1));
    const values = ev.runs.flatMap(r => shown.map(k => r.points[k])).filter(v => v !== null && v !== undefined);
    const [y0, y1] = domainFor(primary.kind, values);
    const ys = scale(y0, y1, h - mb, mt);
    const svg = sv('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': 'Trend of ' + primary.label });
    niceTicks(y0, y1, 4).filter(t => t >= y0 && t <= y1).forEach(t => {
      svg.appendChild(sv('line', { class: 'grid', x1: ml, x2: w - mr, y1: ys(t), y2: ys(t) }));
      svg.appendChild(sv('text', { x: ml - 6, y: ys(t), 'text-anchor': 'end', 'dominant-baseline': 'middle', text: fmt(t, primary.kind) }));
    });
    svg.appendChild(sv('line', { class: 'base', x1: ml, x2: w - mr, y1: h - mb, y2: h - mb }));
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((w - ml - mr) / 70))));
    ev.runs.forEach((r, i) => {
      if (i > 0 && r.compat !== ev.runs[i - 1].compat) {
        const x = (xs(i) + xs(i - 1)) / 2;
        svg.appendChild(sv('line', { x1: x, x2: x, y1: mt, y2: h - mb, style: 'stroke: var(--axis)', 'stroke-dasharray': '3 3' }));
      }
      if (i % every === 0 || i === n - 1) {
        svg.appendChild(sv('text', { x: xs(i), y: h - mb + 15, 'text-anchor': 'middle', text: String(r.x).slice(5, 10) }));
        svg.appendChild(sv('text', { x: xs(i), y: h - mb + 29, 'text-anchor': 'middle', class: 'axis-title', text: shortSha(r.sha).slice(0, 7) }));
      }
    });
    shown.forEach((key, ki) => {
      const color = seriesColor(ki);
      const compats = [];
      ev.runs.forEach(r => { if (!compats.includes(r.compat)) compats.push(r.compat); });
      compats.forEach(compat => {
        const pts = ev.runs.map((r, i) => ({ r, i })).filter(p => p.r.compat === compat && p.r.points[key] !== null && p.r.points[key] !== undefined);
        if (pts.length > 1) svg.appendChild(sv('polyline', { points: pts.map(p => xs(p.i) + ',' + ys(p.r.points[key])).join(' '), fill: 'none',
          style: 'stroke: ' + color, 'stroke-width': 2, 'stroke-dasharray': compat === latestCompat ? null : '5 4', 'stroke-linejoin': 'round' }));
      });
      ev.runs.forEach((r, i) => {
        const v = r.points[key];
        if (v === null || v === undefined) return;
        const g = sv('g', {});
        g.appendChild(withTip(sv('circle', { class: 'hit', cx: xs(i), cy: ys(v), r: 12, tabindex: 0, role: 'img' }),
          [ev.labels[key], primary.label + ': ' + fmt(v, primary.kind) + ' on ' + plural(ev.shared_cases, 'shared case'),
            'Run ' + r.id, fmtDate(r.x) + ' · ' + shortSha(r.sha), 'Grader ' + graderText(r.grader) + ' · eval version ' + r.eval_version]));
        g.appendChild(sv('circle', { class: 'mark', cx: xs(i), cy: ys(v), r: 4.5, style: 'fill: ' + color + '; stroke: var(--surface)', 'stroke-width': 2 }));
        svg.appendChild(g);
      });
    });
    svg.appendChild(sv('text', { class: 'axis-title', x: (ml + w - mr) / 2, y: h - 4, 'text-anchor': 'middle', text: 'Run date and skills SHA →' }));
    return svg;
  });
  return el('div', {}, chart,
    el('div', { class: 'legend' }, shown.map((k, i) => el('span', {}, el('span', { class: 'sw', style: 'background: ' + seriesColor(i) }), ev.labels[k])),
      el('span', {}, el('span', { class: 'sw dash' }), 'Older grader or eval version')),
    keys.length > shown.length ? el('p', { class: 'small muted', text: (keys.length - shown.length) + ' more configs are not drawn; the comparison table has them.' }) : null);
}

function runsTable(ev) {
  return scrollTable(el('table', {},
    el('thead', {}, el('tr', {}, ['Date', 'Run', 'Skills', 'Version', 'Grader', 'Cases', 'Trials', 'Notes'].map((t, i) =>
      el('th', { scope: 'col', class: i === 5 || i === 6 ? 'num' : (i === 1 ? 'sticky-col' : null), text: t })))),
    el('tbody', {}, ev.runs.slice().reverse().map(r => el('tr', {},
      el('td', { class: 'num small', text: fmtDate(r.started_at) }),
      el('th', { scope: 'row', class: 'sticky-col' },
        D.reports[r.dir] ? el('a', { href: './' + encodeURIComponent(r.dir) + '/report.html', text: r.id }) : el('span', { text: r.id }),
        D.reports[r.dir] ? null : el('div', { class: 'small muted', text: 'no report.html yet' })),
      el('td', { class: 'mono', text: shortSha(r.sha) }),
      el('td', { text: r.eval_version }),
      el('td', { class: 'small', text: graderText(r.grader) }),
      el('td', { class: 'num', text: String(r.cases) }),
      el('td', { class: 'num', text: String(r.trials) }),
      el('td', { class: 'small' }, r.regraded_from ? el('div', { text: 'Regrade of ' + r.regraded_from }) : null, r.notes ? el('div', { text: r.notes }) : null))))));
}

function comparison(ev, holder) {
  if (ev.runs.length < 2) return empty('one-run', 'A comparison needs two runs of this eval.');
  const st = pickState[ev.eval] || (pickState[ev.eval] = { a: ev.runs.length - 2, b: ev.runs.length - 1 });
  const opts = ev.runs.map((r, i) => ({ value: String(i), label: r.x.slice(0, 10) + ' · ' + r.id }));
  const rerender = () => holder.replaceChildren(comparison(ev, holder));
  const picks = el('div', { class: 'pick' },
    selectBox('Before', opts, String(st.a), v => { st.a = +v; rerender(); }),
    selectBox('After', opts, String(st.b), v => { st.b = +v; rerender(); }));
  if (st.a === st.b) return el('div', {}, picks, empty('same-run', 'Pick two different runs.'));
  const lo = Math.min(st.a, st.b), hi = Math.max(st.a, st.b), sign = st.b > st.a ? 1 : -1;
  const rows = ev.comparisons[lo + '|' + hi];
  const ra = ev.runs[st.a], rb = ev.runs[st.b];
  const warn = ra.compat !== rb.compat ? el('div', { class: 'banner', role: 'note', 'data-empty': 'mixed-grader',
    text: 'These runs use a different grader or eval version. A delta here mixes a grading change with a real change.' }) : null;
  if (!rows.length) return el('div', {}, picks, warn, empty('no-shared-configs', 'No config has graded trials in both runs.'));
  const metrics = ev.metrics;
  const flip = r => sign === 1 ? r : { diff: r.diff === null ? null : -r.diff, lo: r.hi === null ? null : -r.hi, hi: r.lo === null ? null : -r.lo, n: r.n, changed: r.changed };
  const table = el('table', {},
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'sticky-col', text: 'Config' }),
      metrics.map(mt => el('th', { scope: 'col', class: 'num', text: mt.label + (mt.key === ev.primary ? ' (primary)' : '') })))),
    el('tbody', {}, rows.map(row => el('tr', {}, el('th', { scope: 'row', class: 'sticky-col', text: ev.labels[row.key] }),
      metrics.map(mt => {
        const raw = row.deltas[mt.key];
        if (!raw || raw.n === 0) return el('td', { class: 'num muted', text: 'n/a' });
        const r = flip(raw);
        let mark;
        if (r.changed) {
          const better = (r.diff > 0) === (mt.better === 'higher');
          mark = el('div', { class: better ? 'delta-good' : 'delta-bad', text: better ? '▲ better' : '▼ worse' });
        } else mark = el('div', { class: 'small muted', text: r.lo === null ? 'too few cases' : 'no clear change' });
        return el('td', { class: 'num', title: plural(r.n, 'shared case') },
          el('div', { text: fmtDelta(r.diff, mt.kind, mt.estimated) }),
          el('div', { class: 'small muted', text: r.lo === null ? 'n = ' + r.n : fmtDelta(r.lo, mt.kind, mt.estimated) + ' to ' + fmtDelta(r.hi, mt.kind, mt.estimated) }),
          mark);
      })))));
  return el('div', {}, picks, warn, scrollTable(table));
}

function evalCard(ev) {
  const primary = ev.metrics.find(m => m.key === ev.primary);
  const holder = el('div', {});
  holder.appendChild(comparison(ev, holder));
  return card('eval-' + ev.eval, ev.eval + ' eval',
    plural(ev.runs.length, 'run') + '. Each trend point is a config\'s ' + primary.label + ' over the ' + plural(ev.shared_cases, 'case') +
    ' that every run of this eval shares. A dashed vertical line marks a grader or eval-version change; scores on either side are not comparable, so lines break there. A regrade sits at the date of the run it regraded.',
    el('h3', { text: primary.label + ' over time' }), trendChart(ev),
    el('h3', { text: 'Runs' }), runsTable(ev),
    el('h3', { text: 'Compare two runs' }),
    el('p', { class: 'small muted', text: 'After minus before, paired by case and config on the cases both runs share. A delta counts as a change only when its 95% paired-bootstrap interval leaves out zero.' }),
    holder);
}

function renderIndex() {
  resetRedrawers();
  const runCount = D.evals.reduce((n, ev) => n + ev.runs.length, 0);
  document.getElementById('app').replaceChildren(el('div', { class: 'wrap' },
    el('header', {}, el('div', { class: 'topbar' },
      el('div', {}, el('h1', { text: 'Eval runs' }), el('p', { class: 'muted', text: plural(runCount, 'run') + ' in ' + plural(D.evals.length, 'eval') + ' under ' + D.root_name })),
      themeToggle()),
      D.evals.length > 1 ? el('nav', { class: 'nav', 'aria-label': 'Evals' }, D.evals.map(ev => el('a', { href: '#eval-' + encodeURIComponent(ev.eval), text: ev.eval }))) : null),
    D.evals.length ? D.evals.map(evalCard) : card('none', 'No runs', null, empty('no-runs', 'No run directory under this root has a valid results.json.')),
    D.skipped.length ? card('skipped', 'Skipped directories', 'These directories have a results.json that failed the schema check.',
      el('ul', {}, D.skipped.map(s => el('li', {}, el('strong', { text: s.dir }), ': ', el('span', { class: 'mono', text: s.error }))))) : null,
    el('p', { class: 'small muted', style: 'margin-top:20px', text: 'Built by evals/report/build_report.py --index. Self-contained: this page loads nothing from the network.' })));
}

renderIndex();
