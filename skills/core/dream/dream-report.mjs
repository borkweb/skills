#!/usr/bin/env node
// dream-report.mjs — build the dream report page, keep the newest five, and collect the user's decisions.
//
//   node dream-report.mjs build --data <report.json> [--dir <reports dir>] [--open]
//       Writes <reports dir>/<id>/index.html (self-contained) and report.json, rewrites the list page
//       <reports dir>/index.html, deletes all but the newest five reports, and prints the page path.
//       The same id rebuilds the same report in place.
//   node dream-report.mjs serve --report <report dir> --out <decisions.json> [--timeout-min <n>]
//       Serves that report on a loopback port, opens it in the browser, waits for one valid submission,
//       writes it to --out and to <report dir>/decisions.json, prints the --out path and exits 0.
//       Exit 3 means nobody answered before the timeout (default 120 minutes).
//
// The reports dir is --dir, else $BORK_DREAM_REPORTS_DIR, else <git top level of cwd>/output/dream, else
// ~/.borkweb-skills/dream-reports outside a repo. A report cites private repos and sessions, so inside a
// git work tree the directory must be ignored: when it is not, `build` adds it to the repo's local
// .git/info/exclude (never to a tracked .gitignore) and fails closed if it still is not ignored.
// BORK_DREAM_REPORT_OPEN=0 never opens a browser. Report text is data: the page renders every value as
// text, loads nothing from the network and can only post back to the server that served it.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEEP = 5;
const ID = /^\d{4}-\d{2}-\d{2}-dream-[A-Za-z0-9]{1,12}$/;
const DECISIONS = ['keep', 'revert', 'change'];
const MAX_BODY = 512 * 1024;

const die = (msg, code = 1) => {
  process.stderr.write(`dream-report: ${msg}\n`);
  process.exit(code);
};
const usage = () => die('usage: dream-report.mjs build --data <json> [--dir <dir>] [--open] | serve --report <dir> --out <json> [--timeout-min <n>]', 2);

const GIT_ENV = { ...process.env };
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete GIT_ENV[v];
const git = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (cwd, args) => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};

function parse(argv, flags, bools) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) usage();
    if (bools.includes(name)) out[name] = true;
    else if (flags.includes(name) && argv[i + 1] !== undefined) out[name] = argv[++i];
    else usage();
  }
  return out;
}

const writePrivate = (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
};

function openBrowser(target) {
  if (process.env.BORK_DREAM_REPORT_OPEN === '0') return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [target], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // No browser: the path or URL is already printed.
  }
}

// ---- the report data -----------------------------------------------------------------------------------

const str = (v, where, max = 20000) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') die(`${where} must be text`);
  return String(v).slice(0, max);
};

function normalize(raw) {
  if (!raw || typeof raw !== 'object') die('the report data is not an object');
  if (!ID.test(raw.id || '')) die('id must be the dream run directory name, <YYYY-MM-DD>-dream-<chars>');
  const seen = new Set();
  const sections = (raw.sections || []).map((s, si) => ({
    title: str(s.title, `sections[${si}].title`, 200),
    intro: str(s.intro, `sections[${si}].intro`),
    items: (s.items || []).map((it, ii) => {
      const where = `sections[${si}].items[${ii}]`;
      const id = str(it.id, `${where}.id`, 80);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) die(`${where}.id must be letters, digits, dot, dash, colon or underscore`);
      if (seen.has(id)) die(`item id ${id} is used twice`);
      seen.add(id);
      const recommended = str(it.recommended, `${where}.recommended`, 10);
      if (recommended && !['keep', 'revert'].includes(recommended)) die(`${where}.recommended must be keep or revert`);
      return {
        id,
        kind: str(it.kind, `${where}.kind`, 40),
        title: str(it.title, `${where}.title`, 300),
        target: str(it.target, `${where}.target`, 500),
        detail: str(it.detail, `${where}.detail`),
        evidence: (it.evidence || []).map((e, ei) => str(e, `${where}.evidence[${ei}]`, 1000)),
        before: str(it.before, `${where}.before`),
        after: str(it.after, `${where}.after`),
        recommended,
        why: str(it.why, `${where}.why`, 1000),
        outcome: str(it.outcome, `${where}.outcome`, 40),
        outcome_note: str(it.outcome_note, `${where}.outcome_note`, 1000),
      };
    }),
  }));
  return {
    id: raw.id,
    title: str(raw.title, 'title', 200) || 'Dream report',
    date: str(raw.date, 'date', 40),
    state: raw.state === 'final' ? 'final' : 'proposed',
    summary: str(raw.summary, 'summary'),
    stats: (raw.stats || []).map((s, i) => ({ label: str(s.label, `stats[${i}].label`, 80), value: str(s.value, `stats[${i}].value`, 80), note: str(s.note, `stats[${i}].note`, 200) })),
    sections,
    findings: (raw.findings || []).map((f, i) => ({ title: str(f.title, `findings[${i}].title`, 200), body: str(f.body, `findings[${i}].body`) })),
  };
}

const itemIds = (data) => data.sections.flatMap((s) => s.items.map((i) => i.id));

// ---- the pages ---------------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// U+2028 and U+2029 end a line in older script parsers, so they are escaped by code point.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const embed = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c').replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d1c1a;--muted:#6b6862;--line:#dedbd3;--accent:#2f5d50;--keep:#2f6f4f;--revert:#a4442f;--change:#8a6412;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#ecebe6;--muted:#9c998f;--line:#35342f;--accent:#8fc7b4;--keep:#7cc79d;--revert:#e8907b;--change:#dcb45c;--code:#282824}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 120px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 6px}
.muted{color:var(--muted)}.pre{white-space:pre-wrap;overflow-wrap:anywhere}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:20px 0}
.stat,.item,.finding{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.stat span{font-size:13px;color:var(--muted)}
.item{margin:10px 0}.item[data-decision=keep]{border-left:4px solid var(--keep)}.item[data-decision=revert]{border-left:4px solid var(--revert)}.item[data-decision=change]{border-left:4px solid var(--change)}
.head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.head h3{font-size:15px;margin:0;flex:1 1 300px}
.tag{font-size:11px;text-transform:uppercase;letter-spacing:.05em;border:1px solid var(--line);border-radius:99px;padding:1px 8px;color:var(--muted)}
.tag.out{color:var(--accent);border-color:var(--accent)}
.target,code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}.target{color:var(--muted);overflow-wrap:anywhere}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}@media (max-width:640px){.ba{grid-template-columns:1fr}}
.ba div{background:var(--code);border-radius:8px;padding:8px 10px;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.ba small{display:block;font:11px -apple-system,sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px}
ul.ev{margin:8px 0 0;padding-left:18px;font-size:13px;color:var(--muted)}
.choice{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:5px 12px;cursor:pointer}
button:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button[aria-pressed=true][data-d=keep]{background:var(--keep);border-color:var(--keep);color:var(--card)}
button[aria-pressed=true][data-d=revert]{background:var(--revert);border-color:var(--revert);color:var(--card)}
button[aria-pressed=true][data-d=change]{background:var(--change);border-color:var(--change);color:var(--card)}
.rec{font-size:12.5px;color:var(--muted)}textarea{width:100%;margin-top:8px;min-height:64px;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.sechead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 16px}
.bar div{max-width:980px;margin:0 auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.bar .grow{flex:1;color:var(--muted);font-size:13px}
.primary{background:var(--accent);border-color:var(--accent);color:var(--card);font-weight:600}.primary:disabled{opacity:.45;cursor:not-allowed}
a{color:var(--accent)}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
`;

const SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
const prior = JSON.parse(document.getElementById('decisions').textContent);
const token = new URLSearchParams(location.search).get('t');
const live = location.protocol.startsWith('http') && !!token && data.state !== 'final' && !prior;
const locked = data.state === 'final' || !!prior;
const KEY = 'dream-report:' + data.id;
const LABEL = { keep: 'Keep', revert: 'Revert', change: 'Change it' };
let state = {};
if (prior) state = prior.decisions; else { try { state = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {} }
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const items = data.sections.flatMap((s) => s.items);
const cards = {};
const root = document.getElementById('app');

root.append(el('h1', '', data.title));
root.append(el('div', 'muted', [data.date, data.id, data.state === 'final' ? 'final' : 'proposed'].filter(Boolean).join(' · ')));
if (data.summary) root.append(el('p', 'pre', data.summary));
if (data.stats.length) {
  const g = el('div', 'stats');
  for (const s of data.stats) { const c = el('div', 'stat'); c.append(el('b', '', s.value), el('span', '', s.label + (s.note ? ' — ' + s.note : ''))); g.append(c); }
  root.append(g);
}

function setDecision(id, d) {
  if (locked) return;
  state[id] = { decision: d, comment: (state[id] && state[id].comment) || '' };
  paint(id); save();
}
function paint(id) {
  const c = cards[id]; const cur = state[id];
  c.card.dataset.decision = cur ? cur.decision : '';
  for (const b of c.buttons) b.setAttribute('aria-pressed', String(!!cur && cur.decision === b.dataset.d));
  c.note.hidden = !(cur && cur.decision === 'change');
  if (c.note.value !== ((cur && cur.comment) || '')) c.note.value = (cur && cur.comment) || '';
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} refresh(); }

for (const s of data.sections) {
  const head = el('div', 'sechead'); head.append(el('h2', '', s.title + ' (' + s.items.length + ')'));
  if (!locked && s.items.length > 1) { const all = el('button', '', 'Keep all in this section'); all.onclick = () => s.items.forEach((i) => setDecision(i.id, 'keep')); head.append(all); }
  root.append(head);
  if (s.intro) root.append(el('p', 'muted pre', s.intro));
  if (!s.items.length) root.append(el('p', 'muted', 'Nothing proposed.'));
  for (const it of s.items) {
    const card = el('div', 'item'); const h = el('div', 'head');
    if (it.kind) h.append(el('span', 'tag', it.kind));
    h.append(el('h3', '', it.title));
    if (it.outcome) h.append(el('span', 'tag out', it.outcome));
    card.append(h);
    if (it.target) card.append(el('div', 'target', it.target));
    if (it.detail) card.append(el('p', 'pre', it.detail));
    if (it.before || it.after) { const ba = el('div', 'ba'); for (const k of ['before', 'after']) { const d = el('div', 'pre'); d.append(el('small', '', k), document.createTextNode(it[k] || '(none)')); ba.append(d); } card.append(ba); }
    if (it.evidence.length) { const ul = el('ul', 'ev'); it.evidence.forEach((e) => ul.append(el('li', '', e))); card.append(ul); }
    if (it.outcome_note) card.append(el('p', 'muted pre', it.outcome_note));
    const row = el('div', 'choice'); const buttons = [];
    for (const d of ['keep', 'revert', 'change']) { const b = el('button', '', LABEL[d]); b.dataset.d = d; b.disabled = locked; b.onclick = () => setDecision(it.id, d); buttons.push(b); row.append(b); }
    if (it.recommended) row.append(el('span', 'rec', 'Recommended: ' + LABEL[it.recommended] + (it.why ? ' — ' + it.why : '')));
    const note = el('textarea'); note.placeholder = 'What should change?'; note.hidden = true; note.readOnly = locked; note.setAttribute('aria-label', 'Change request for ' + it.title);
    note.oninput = () => { state[it.id].comment = note.value; save(); };
    card.append(row, note); root.append(card);
    cards[it.id] = { card, buttons, note }; paint(it.id);
  }
}
if (data.findings.length) { root.append(el('h2', '', 'Findings')); for (const f of data.findings) { const c = el('div', 'finding item'); c.append(el('h3', '', f.title), el('p', 'pre', f.body)); root.append(c); } }

const status = document.getElementById('status'); const submit = document.getElementById('submit'); const all = document.getElementById('all');
function payload() { const out = {}; for (const i of items) out[i.id] = { decision: state[i.id].decision, comment: state[i.id].decision === 'change' ? state[i.id].comment.trim() : '' }; return { id: data.id, decisions: out }; }
function refresh() {
  if (locked) return;
  const open = items.filter((i) => !state[i.id]).length;
  const blank = items.filter((i) => state[i.id] && state[i.id].decision === 'change' && !state[i.id].comment.trim()).length;
  submit.disabled = open > 0 || blank > 0;
  status.textContent = open ? open + ' of ' + items.length + ' still need a decision' : blank ? blank + ' change request' + (blank > 1 ? 's need' : ' needs') + ' a comment' : 'All ' + items.length + ' decided';
}
if (locked || !items.length) { all.hidden = submit.hidden = true; status.textContent = prior ? 'Decisions were sent' + (prior.at ? ' on ' + prior.at : '') + '.' : data.state === 'final' ? 'Final report.' : 'Nothing to decide.'; }
else {
  submit.textContent = live ? 'Send decisions' : 'Copy decisions';
  all.onclick = () => items.forEach((i) => setDecision(i.id, 'keep'));
  submit.onclick = async () => {
    const body = JSON.stringify(payload());
    if (!live) { try { await navigator.clipboard.writeText(body); status.textContent = 'Copied. Paste it into the dream session.'; } catch (e) { status.textContent = 'Copy failed. Answer in the dream session.'; } return; }
    submit.disabled = true;
    try {
      const r = await fetch('/decisions?t=' + encodeURIComponent(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!r.ok) throw new Error(await r.text());
      try { localStorage.removeItem(KEY); } catch (e) {}
      all.hidden = submit.hidden = true; status.textContent = 'Sent. Return to the dream session.';
      Object.values(cards).forEach((c) => { c.buttons.forEach((b) => (b.disabled = true)); c.note.readOnly = true; });
    } catch (e) { submit.disabled = false; status.textContent = 'Not sent: ' + e.message; }
  };
  refresh();
}
`;

function page(data, decisions) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(data.title)} ${esc(data.id)}</title><style>${CSS}</style></head>
<body><main id="app"></main>
<div class="bar"><div><span class="grow" id="status" role="status"></span><button id="all">Approve all</button><button id="submit" class="primary" disabled>Send decisions</button></div></div>
<script type="application/json" id="data">${embed(data)}</script>
<script type="application/json" id="decisions">${embed(decisions)}</script>
<script>${SCRIPT}</script></body></html>
`;
}

function listPage(rows) {
  const body = rows
    .map((r) => `<tr><td><a href="${esc(r.id)}/index.html">${esc(r.id)}</a></td><td>${esc(r.title)}</td><td>${esc(r.state)}</td><td>${esc(String(r.items))}</td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Dream reports</title><style>${CSS}</style></head>
<body><main><h1>Dream reports</h1><p class="muted">The newest ${KEEP} are kept. Older ones are deleted when a new report is built.</p>
<table><thead><tr><th>Report</th><th>Title</th><th>State</th><th>Items</th></tr></thead><tbody>
${body}
</tbody></table></main></body></html>
`;
}

// ---- build -------------------------------------------------------------------------------------------------

function reportsDir(flag) {
  if (flag) return resolve(flag);
  if (process.env.BORK_DREAM_REPORTS_DIR) return resolve(process.env.BORK_DREAM_REPORTS_DIR);
  const top = tryGit(process.cwd(), ['rev-parse', '--show-toplevel']);
  return top ? join(top, 'output', 'dream') : join(homedir(), '.borkweb-skills', 'dream-reports');
}

// Inside a work tree the reports must be ignored and hold nothing tracked. Outside one there is nothing to check.
function ensureIgnored(dir) {
  const top = tryGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return;
  const rel = relative(realpathSync(top), realpathSync(dir)).split(sep).join('/');
  if (!rel || rel.startsWith('..')) die('the reports directory must be below the repository root, not the root itself');
  if (tryGit(top, ['ls-files', '--', rel])) die(`${rel} holds tracked files; a report must never be committed`);
  const ignored = () => tryGit(top, ['check-ignore', '-q', '--', `${rel}/probe`]) !== null;
  if (ignored()) return;
  const exclude = resolve(top, git(top, ['rev-parse', '--git-path', 'info/exclude']));
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${existsSync(exclude) && !readFileSync(exclude, 'utf8').endsWith('\n') ? '\n' : ''}/${rel}/\n`);
  if (!ignored()) die(`${rel} is not ignored by git and could not be excluded`);
}

function reports(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ID.test(e.name) && existsSync(join(dir, e.name, 'report.json')))
    .map((e) => ({ id: e.name, mtime: statSync(join(dir, e.name, 'report.json')).mtimeMs }))
    .sort((a, b) => (a.id.slice(0, 10) === b.id.slice(0, 10) ? b.mtime - a.mtime : a.id < b.id ? 1 : -1));
}

function build(opts) {
  if (!opts.data) usage();
  let raw;
  try {
    raw = JSON.parse(readFileSync(opts.data, 'utf8'));
  } catch (e) {
    die(`cannot read the report data: ${e.message}`);
  }
  const data = normalize(raw);
  const dir = reportsDir(opts.dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensureIgnored(dir);
  const out = join(dir, data.id);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  let decisions = null;
  try {
    decisions = JSON.parse(readFileSync(join(out, 'decisions.json'), 'utf8'));
  } catch {
    // No decisions yet.
  }
  writePrivate(join(out, 'report.json'), `${JSON.stringify(data, null, 2)}\n`);
  writePrivate(join(out, 'index.html'), page(data, data.state === 'final' ? decisions : null));

  const all = reports(dir);
  const kept = [...all.filter((r) => r.id === data.id), ...all.filter((r) => r.id !== data.id)].slice(0, KEEP);
  for (const r of all) if (!kept.includes(r)) rmSync(join(dir, r.id), { recursive: true, force: true });
  const rows = reports(dir).map((r) => {
    const d = JSON.parse(readFileSync(join(dir, r.id, 'report.json'), 'utf8'));
    return { id: r.id, title: d.title, state: d.state, items: itemIds(d).length };
  });
  writePrivate(join(dir, 'index.html'), listPage(rows));
  const file = join(out, 'index.html');
  process.stdout.write(`${file}\n`);
  if (opts.open) openBrowser(pathToFileURL(file).href);
}

// ---- serve -------------------------------------------------------------------------------------------------

function checkDecisions(body, data) {
  if (!body || typeof body !== 'object' || body.id !== data.id || !body.decisions || typeof body.decisions !== 'object') return 'not a decisions object for this report';
  const ids = itemIds(data);
  const got = Object.keys(body.decisions);
  if (got.length !== ids.length || !ids.every((id) => Object.hasOwn(body.decisions, id))) return 'every item needs exactly one decision';
  const clean = {};
  for (const id of ids) {
    const d = body.decisions[id];
    if (!d || !DECISIONS.includes(d.decision)) return `item ${id}: the decision must be keep, revert or change`;
    const comment = typeof d.comment === 'string' ? d.comment.trim().slice(0, 4000) : '';
    if (d.decision === 'change' && !comment) return `item ${id}: a change needs a comment`;
    clean[id] = { decision: d.decision, comment: d.decision === 'change' ? comment : '' };
  }
  return { id: data.id, at: new Date().toISOString(), decisions: clean };
}

function serve(opts) {
  if (!opts.report || !opts.out) usage();
  const dir = resolve(opts.report);
  let data;
  try {
    data = normalize(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')));
  } catch (e) {
    die(`cannot read the report: ${e.message}`);
  }
  if (data.state === 'final') die('a final report takes no decisions');
  const minutes = opts['timeout-min'] === undefined ? 120 : Number(opts['timeout-min']);
  if (!(minutes > 0)) usage();
  const token = randomBytes(24).toString('hex');
  const html = page(data, null);
  let origin = '';

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, text, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(text);
    };
    if (req.headers.host !== origin.slice('http://'.length)) return send(403, 'wrong host');
    if (url.searchParams.get('t') !== token) return send(403, 'missing or wrong token');
    if (req.method === 'GET' && url.pathname === '/') return send(200, html, 'text/html; charset=utf-8');
    if (req.method !== 'POST' || url.pathname !== '/decisions') return send(404, 'not found');
    if (req.headers.origin && req.headers.origin !== origin) return send(403, 'wrong origin');
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, 'send JSON');
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(413, 'too large');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, 'not JSON');
      }
      const result = checkDecisions(body, data);
      if (typeof result === 'string') return send(400, result);
      const text = `${JSON.stringify(result, null, 2)}\n`;
      const out = resolve(opts.out);
      mkdirSync(dirname(out), { recursive: true });
      writePrivate(out, text);
      writePrivate(join(dir, 'decisions.json'), text);
      send(200, 'ok');
      process.stdout.write(`${out}\n`);
      server.close();
      setTimeout(() => process.exit(0), 50);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    const link = `${origin}/?t=${token}`;
    process.stderr.write(`dream-report: waiting for decisions at ${link}\n`);
    openBrowser(link);
  });
  setTimeout(() => {
    process.stderr.write('dream-report: no decisions before the timeout\n');
    process.exit(3);
  }, minutes * 60000).unref();
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'build') build(parse(rest, ['data', 'dir'], ['open']));
else if (cmd === 'serve') serve(parse(rest, ['report', 'out', 'timeout-min'], []));
else usage();
