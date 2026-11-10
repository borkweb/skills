#!/usr/bin/env node
// runs.mjs — run records, durable questions, the run signal and the herdr launcher
// for bork `do` runs. The state on disk (run.json in a run dir) is the center; any
// session that runs this CLI can coordinate. Contract: spec v2 sections 1-4.
//
// Node builtins only, no package.json: a herdr-spawned architect runs this from a
// bare environment, and an untracked node_modules next to it must never matter.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  accessSync, chmodSync, closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, watch, writeFileSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATES = ['running', 'needs-me', 'blocked', 'done', 'failed'];
const SIGNAL = new Set(['needs-me', 'blocked', 'done', 'failed']);
const TERMINAL = new Set(['done', 'failed']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STALE_RUN_MS = 24 * 3600e3;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const WAIT_DEFAULT_S = 3600;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const CLI_PATH = fileURLToPath(import.meta.url);

class Fail extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
const usageFail = (m) => new Fail(m, 2);
const nowIso = () => new Date().toISOString();
const rand = (n = 4) => randomBytes(n).toString('hex');

// ---- homes -------------------------------------------------------------------

const handoffsDir = () => process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs');
const runsHome = () => process.env.BORK_RUNS_HOME || join(handoffsDir(), 'runs');
const orchHome = () => process.env.ORCHESTRATOR_HOME || join(homedir(), '.borkweb-skills', 'orchestrator');
const orchFile = () => join(orchHome(), 'orchestrator.json');
const recFile = (dir) => join(dir, 'run.json');

function realHome(create = false) {
  try { return realpathSync(runsHome()); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (!create) return null;
    mkdirSync(runsHome(), { recursive: true, mode: 0o700 });
    return realpathSync(runsHome());
  }
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) throw new Fail(`invalid run id ${JSON.stringify(id)}`);
}

// A run dir is a direct child of the runs home, compared by realpath.
function resolveRun(arg) {
  const home = realHome();
  if (!home) throw new Fail(`no such run: ${arg} (no runs home at ${runsHome()})`);
  if (!isAbsolute(arg)) checkId(arg);
  let real;
  try { real = realpathSync(isAbsolute(arg) ? arg : join(home, arg)); } catch { throw new Fail(`no such run: ${arg}`); }
  if (dirname(real) !== home || !statSync(real).isDirectory()) throw new Fail(`${arg} is not a direct child of ${home}`);
  checkId(basename(real));
  return { id: basename(real), dir: real };
}

// ---- record: read, validate, lock, atomic write --------------------------------

function invalidReason(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'not a JSON object';
  if (rec.schema !== 1) return `unsupported schema ${JSON.stringify(rec.schema)}`;
  if (!STATES.includes(rec.state)) return `unknown state ${JSON.stringify(rec.state)}`;
  if (!Array.isArray(rec.questions)) return 'questions is not a list';
  if (!Array.isArray(rec.history)) return 'history is not a list';
  for (const k of ['revision', 'signal_revision', 'orchestrator_ack']) if (!Number.isInteger(rec[k])) return `${k} is not an integer`;
  if (typeof rec.goal !== 'string') return 'goal is not a string';
  if (!rec.architect || typeof rec.architect !== 'object') return 'architect is missing';
  if (!['orchestrator', 'self'].includes(rec.launched_by)) return 'launched_by is missing';
  for (const q of rec.questions) {
    if (!q || typeof q.id !== 'string' || !['open', 'answered', 'withdrawn'].includes(q.status) || !Array.isArray(q.options)) return 'a question is malformed';
  }
  return null;
}

class Invalid extends Fail {
  constructor(path, reason) { super(`invalid run.json ${path}: ${reason}`); this.invalid = true; }
}

function readRun(dir) {
  const path = recFile(dir);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') throw new Fail(`no run.json at ${path}`);
    throw e;
  }
  let rec;
  try { rec = JSON.parse(text); } catch (e) { throw new Invalid(path, `malformed JSON (${e.message})`); }
  const why = invalidReason(rec);
  if (why) throw new Invalid(path, why);
  return rec;
}

function atomicWrite(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${rand()}`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function lockIsStale(path) {
  let st;
  try { st = statSync(path); } catch { return false; }
  if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
  let pid;
  try { pid = JSON.parse(readFileSync(path, 'utf8')).pid; } catch { /* unreadable holder counts as dead */ }
  return !(Number.isInteger(pid) && pidAlive(pid));
}

// Break by rename; only the process whose rename succeeded removes the stale file.
// If what we moved turns out to be fresh (a racing breaker already replaced it), put it back.
function breakStale(lock) {
  const moved = `${lock}.stale-${process.pid}-${rand()}`;
  try { renameSync(lock, moved); } catch { return; }
  if (!lockIsStale(moved)) { try { linkSync(moved, lock); } catch { /* another writer holds it now */ } }
  rmSync(moved, { force: true });
}

function withLock(dir, fn) {
  const lock = join(dir, 'run.json.lock');
  const end = Date.now() + LOCK_WAIT_MS;
  for (let backoff = 2; ;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale(lock)) { breakStale(lock); continue; }
      if (Date.now() > end) throw new Fail(`could not take the run lock ${lock} within 5 s; another writer holds it`);
      sleepMs(backoff + Math.random() * backoff);
      backoff = Math.min(backoff * 2, 50);
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}

const NOOP = Symbol('noop');

// One locked read-modify-write. fn sees the already-incremented revision and may throw to refuse.
function mutate(dir, fn, { touch = true } = {}) {
  return withLock(dir, () => {
    const rec = readRun(dir);
    const at = nowIso();
    rec.revision += 1;
    if (fn(rec, at) === NOOP) return { rec: readRun(dir), wrote: false };
    if (touch) rec.updated_at = at;
    atomicWrite(recFile(dir), `${JSON.stringify(rec, null, 2)}\n`);
    return { rec, wrote: true };
  });
}

const openQuestions = (rec) => rec.questions.filter((q) => q.status === 'open');
const refuseTerminal = (rec) => { if (TERMINAL.has(rec.state)) throw new Fail(`run is ${rec.state}; a finished run only accepts ack`); };

function transition(rec, to, note, at) {
  rec.state = to;
  rec.history.push({ at, state: to, note: note ?? null });
  if (SIGNAL.has(to)) rec.signal_revision = rec.revision;
}

// answer and withdraw resume a needs-me run only when no question stays open.
function resumeIfClear(rec, note, at) {
  if (rec.state !== 'needs-me' || openQuestions(rec).length) return false;
  transition(rec, 'running', note, at);
  return true;
}

// ---- herdr nudges ----------------------------------------------------------------

function which(bin) {
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d) continue;
    try { accessSync(join(d, bin), constants.X_OK); return true; } catch { /* next dir */ }
  }
  return false;
}

const herdr = (args) => spawnSync('herdr', args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
const clean = (s) => String(s).replace(CONTROL, '');

// A nudge is one fixed-grammar line (words, run id, state token, Q<n>); never record text.
function nudge(pane, line) {
  if (typeof pane !== 'string' || !pane || pane.startsWith('-') || !which('herdr')) return;
  const r = herdr(['agent', 'prompt', pane, clean(line).slice(0, 300)]);
  let why = null;
  if (r.error) why = r.error.code || 'spawn failed';
  else if (r.status !== 0) why = `exit ${r.status}`;
  else if (/agent_blocked/.test(r.stdout || '')) why = 'agent_blocked';
  else { try { if (JSON.parse(r.stdout || 'null')?.error) why = 'herdr returned an error'; } catch { /* plain output is fine */ } }
  if (why) process.stderr.write(`warning: could not nudge pane ${clean(pane)} (${why}); the run record is already written\n`);
}

function readOrch() {
  try { const j = JSON.parse(readFileSync(orchFile(), 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

function nudgeOrchestrator(rec) {
  if (rec.launched_by !== 'orchestrator') return;
  const pane = readOrch()?.pane;
  if (!pane) return;
  const q = openQuestions(rec).at(-1)?.id;
  nudge(pane, `bork run ${rec.id}: ${rec.state}${rec.state === 'needs-me' && q ? ` ${q}` : ''}`);
}

const signalled = (res) => res.wrote && res.rec.signal_revision === res.rec.revision;

// ---- run creation ------------------------------------------------------------------

// The default slug names the repo, never the goal: the run id and the tab label reach herdr,
// and nothing the user wrote may travel there.
const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'run';
const defaultSlug = (repo) => (repo ? slugify(basename(repo)) : 'run');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function gitTop(path) {
  const r = spawnSync('git', ['-C', resolve(path), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) throw new Fail(`not a git checkout: ${path}`);
  return realpathSync(r.stdout.trim());
}

function directChild(home, abs) {
  if (!isAbsolute(abs)) throw new Fail(`--run-dir must be absolute: ${abs}`);
  checkId(basename(abs));
  let real;
  try { lstatSync(abs); real = realpathSync(abs); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { real = join(realpathSync(dirname(abs)), basename(abs)); } catch { throw new Fail(`${abs} is not a direct child of ${home}`); }
  }
  if (dirname(real) !== home) throw new Fail(`${abs} is not a direct child of ${home}`);
  return real;
}

function createRun({ goal, repo = null, slug, runDir, launchedBy = 'self', harness = null, sessionId = null, task = null }) {
  const home = realHome(true);
  let dir;
  if (runDir) {
    dir = directChild(home, runDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    for (; ;) {
      dir = join(home, `${today()}-${slug}-${[...randomBytes(4)].map((x) => (x % 36).toString(36)).join('')}`);
      try { mkdirSync(dir, { mode: 0o700 }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }
  chmodSync(dir, 0o700);
  return withLock(dir, () => {
    if (statSyncOrNull(recFile(dir))) return { dir, rec: readRun(dir), existed: true };
    const at = nowIso();
    const rec = {
      schema: 1, id: basename(dir), run_dir: dir, repo, goal, task, state: 'running', summary: '', delivery: null,
      questions: [], architect: { harness, session_id: sessionId, frontend: null, tab: null, pane: null },
      launched_by: launchedBy, revision: 1, signal_revision: 0, orchestrator_ack: 0, created_at: at, updated_at: at,
      history: [{ at, state: 'running', note: 'created' }],
    };
    atomicWrite(recFile(dir), `${JSON.stringify(rec, null, 2)}\n`);
    return { dir, rec, existed: false };
  });
}
const statSyncOrNull = (p) => { try { return statSync(p); } catch { return null; } };

function readGoal(o) {
  if (o.goal !== undefined && o['goal-file'] !== undefined) throw usageFail('give --goal or --goal-file, not both');
  const goal = o['goal-file'] !== undefined ? readFileSync(o['goal-file'], 'utf8') : o.goal;
  if (goal === undefined || goal === '') throw usageFail('a goal is required: --goal <text> or --goal-file <file>');
  return goal;
}

// ---- commands: record ------------------------------------------------------------------

const out = (s) => process.stdout.write(`${s}\n`);

function cmdInit(o) {
  const goal = readGoal(o);
  const repo = o.repo !== undefined ? gitTop(o.repo) : null;
  const slug = o.slug ?? defaultSlug(repo);
  checkId(slug);
  const { dir, rec, existed } = createRun({ goal, repo, slug, runDir: o['run-dir'] });
  out(o.json && !existed ? JSON.stringify(rec) : dir);
}

function cmdSet(o, [arg]) {
  const { dir } = resolveRun(arg);
  if (o.state === undefined && o.summary === undefined && o.delivery === undefined && o.note === undefined) throw usageFail('set needs --state, --summary, --delivery or --note');
  if (o.state !== undefined) {
    if (!STATES.includes(o.state)) throw new Fail(`unknown state ${JSON.stringify(o.state)}; use ${STATES.join(', ')}`);
    if (o.state === 'needs-me') throw new Fail('needs-me comes only from ask');
  }
  const res = mutate(dir, (rec, at) => {
    refuseTerminal(rec);
    if ((o.state === 'done' || o.state === 'running') && openQuestions(rec).length) throw new Fail(`${o.state} is refused while a question is open`);
    if (o.state !== undefined && o.state !== rec.state) transition(rec, o.state, o.note ?? o.summary, at);
    else if (o.note !== undefined) rec.history.push({ at, state: rec.state, note: o.note });
    if (o.summary !== undefined) rec.summary = o.summary;
    if (o.delivery !== undefined) rec.delivery = o.delivery;
  });
  if (signalled(res)) nudgeOrchestrator(res.rec);
  out(o.json ? JSON.stringify(res.rec) : `${res.rec.id} ${res.rec.state}`);
}

function parseOptions(text) {
  let list;
  try { list = JSON.parse(text); } catch { throw new Fail('--options is not valid JSON'); }
  if (!Array.isArray(list) || list.length < 2) throw new Fail('--options needs a JSON array of at least 2 options');
  const labels = new Set();
  const options = list.map((x) => {
    if (!x || typeof x.label !== 'string' || !x.label.trim()) throw new Fail('every option needs a non-empty label');
    if (labels.has(x.label)) throw new Fail(`duplicate option label ${JSON.stringify(x.label)}`);
    labels.add(x.label);
    return { label: x.label, description: typeof x.description === 'string' ? x.description : '' };
  });
  return options;
}

function cmdAsk(o, [arg]) {
  const { dir } = resolveRun(arg);
  if (!o.question) throw usageFail('ask needs --question');
  if (o.options === undefined || o.recommendation === undefined) throw usageFail('ask needs --options and --recommendation');
  const options = parseOptions(o.options);
  if (!options.some((x) => x.label === o.recommendation)) throw new Fail('--recommendation must equal exactly one option label');
  let qid;
  const res = mutate(dir, (rec, at) => {
    refuseTerminal(rec);
    qid = `Q${rec.questions.length + 1}`;
    rec.questions.push({
      id: qid, question: o.question, options, recommendation: o.recommendation, context: o.context ?? '', status: 'open',
      asked_at: at, answer: null, choice: null, answered_at: null, answered_by: null,
    });
    if (rec.state === 'needs-me') rec.signal_revision = rec.revision;
    else transition(rec, 'needs-me', `asked ${qid}`, at);
  });
  nudgeOrchestrator(res.rec);
  out(qid);
}

function findOpen(rec, qid) {
  const q = rec.questions.find((x) => x.id === qid);
  if (!q) throw new Fail(`no question ${qid} on ${rec.id}`);
  if (q.status !== 'open') throw new Fail(`${qid} is already ${q.status}`);
  return q;
}

function cmdAnswer(o, [arg, qid]) {
  const { dir } = resolveRun(arg);
  if (o.answer === undefined) throw usageFail('answer needs --answer');
  const res = mutate(dir, (rec, at) => {
    refuseTerminal(rec);
    const q = findOpen(rec, qid);
    Object.assign(q, {
      status: 'answered', answer: o.answer, choice: q.options.some((x) => x.label === o.answer) ? o.answer : null,
      answered_at: at, answered_by: o.by ?? 'orchestrator',
    });
    resumeIfClear(rec, `answered ${qid}`, at);
  });
  if (!o['no-nudge'] && res.rec.architect.pane) nudge(res.rec.architect.pane, `bork run ${res.rec.id}: answered ${qid}`);
  out(`${qid} answered`);
}

function cmdWithdraw(o, [arg, qid]) {
  const { dir } = resolveRun(arg);
  mutate(dir, (rec, at) => {
    refuseTerminal(rec);
    findOpen(rec, qid).status = 'withdrawn';
    if (!resumeIfClear(rec, o.note ?? `withdrew ${qid}`, at) && o.note !== undefined) rec.history.push({ at, state: rec.state, note: o.note });
  });
  out(`${qid} withdrawn`);
}

function ackOne(dir, revision) {
  return mutate(dir, (rec) => {
    const n = revision ?? rec.signal_revision;
    if (n > rec.signal_revision) throw usageFail(`--revision ${n} is above signal_revision ${rec.signal_revision}`);
    if (n <= rec.orchestrator_ack) return NOOP;
    rec.orchestrator_ack = n;
  }, { touch: false });
}

function cmdAck(o, pos) {
  let revision;
  if (o.revision !== undefined) {
    revision = Number(o.revision);
    if (!Number.isInteger(revision) || revision < 0) throw usageFail(`--revision must be a non-negative integer`);
  }
  if (!o.all) { ackOne(resolveRun(pos[0]).dir, revision); return; }
  if (revision !== undefined) throw usageFail('--revision cannot be combined with --all');
  const before = o.before === undefined ? null : Date.parse(o.before);
  if (before !== null && Number.isNaN(before)) throw usageFail('--before needs an ISO time');
  for (const { dir, rec } of scanRuns()) {
    if (before !== null && !(Date.parse(rec.updated_at) < before)) continue;
    try { ackOne(dir); } catch (e) { if (!e.invalid) throw e; warnInvalid(e); }
  }
}

// ---- show and list -------------------------------------------------------------------------

function architectGone(rec) {
  const pane = rec.architect?.pane;
  if (!pane || TERMINAL.has(rec.state) || !which('herdr')) return false;
  const r = herdr(['agent', 'get', pane]);
  if (r.error) return false;
  if (r.status !== 0) return true;
  try { return Boolean(JSON.parse(r.stdout)?.error); } catch { return false; }
}

function flagsOf(rec) {
  const f = [];
  if (rec.state === 'running' && Date.now() - Date.parse(rec.updated_at) > STALE_RUN_MS) f.push('stale');
  if (architectGone(rec)) f.push('architect gone');
  return f;
}

const firstLine = (s, n = 100) => String(s).split('\n')[0].slice(0, n);
const warnInvalid = (e) => process.stderr.write(`warning: skipping ${e.message}\n`);

// Every readable run under the home; invalid ones are reported through onInvalid and skipped.
function scanRuns(onInvalid = warnInvalid) {
  const home = realHome();
  if (!home) return [];
  const found = [];
  for (const name of readdirSync(home)) {
    if (!ID_RE.test(name) || name.includes('..')) continue;
    const dir = join(home, name);
    let st;
    try { st = lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    try { found.push({ name, dir, rec: readRun(dir) }); } catch (e) {
      if (e.invalid) onInvalid(e);
      else if (!/no run\.json/.test(e.message)) throw e;
    }
  }
  return found;
}

function cmdShow(o, [arg]) {
  const { id, dir } = resolveRun(arg);
  const rec = readRun(dir);
  const flags = flagsOf(rec);
  const moot = (q) => rec.state === 'failed' && q.status === 'open';
  if (o.json) {
    out(JSON.stringify({ ...rec, flags, questions: rec.questions.map((q) => (moot(q) ? { ...q, moot: true } : q)) }, null, 2));
    return;
  }
  const a = rec.architect;
  const lines = [
    `run: ${id}`, `state: ${rec.state}${flags.length ? ` (${flags.join(', ')})` : ''}`, `goal: ${firstLine(rec.goal, 200)}`,
    `summary: ${rec.summary || '-'}`, `delivery: ${rec.delivery ?? '-'}`, `run dir: ${dir}`,
    `architect: ${a.harness ?? '-'} tab ${a.tab ?? '-'} pane ${a.pane ?? '-'}`,
  ];
  for (const q of rec.questions.filter((x) => x.status === 'open')) {
    lines.push('', `${q.id}${moot(q) ? ' (moot: the run failed)' : ''}: ${q.question}`);
    if (q.context) lines.push(`  context: ${q.context}`);
    lines.push('  options:', ...q.options.map((x) => `    - ${x.label}: ${x.description}`), `  recommendation: ${q.recommendation}`);
  }
  out(lines.join('\n'));
}

function cmdList(o) {
  let want = null;
  if (o.state !== undefined) {
    want = new Set(o.state.split(','));
    for (const s of want) if (!STATES.includes(s)) throw usageFail(`unknown state ${JSON.stringify(s)}`);
  }
  const runs = scanRuns()
    .filter(({ rec }) => !want || want.has(rec.state))
    .sort((x, y) => Date.parse(y.rec.created_at) - Date.parse(x.rec.created_at) || (x.name < y.name ? 1 : -1));
  const rows = runs.map(({ name, rec }) => ({ name, rec, flags: flagsOf(rec) }));
  if (o.json) { out(JSON.stringify(rows.map(({ rec, flags }) => ({ ...rec, flags })), null, 2)); return; }
  for (const { name, rec, flags } of rows) out(`${name}  ${rec.state}${flags.length ? ` [${flags.join(', ')}]` : ''}  ${rec.summary || firstLine(rec.goal)}`);
}

// ---- claim, release, wait -------------------------------------------------------------------

function cmdClaim(o) {
  const pane = o.pane || process.env.HERDR_PANE_ID || null;
  const harness = o.harness ?? (process.env.CLAUDECODE ? 'claude' : null);
  const previous = readOrch();
  mkdirSync(orchHome(), { recursive: true });
  atomicWrite(orchFile(), `${JSON.stringify({ pane, claimed_at: nowIso(), harness }, null, 2)}\n`);
  out(`claimed pane ${pane ?? 'none'}`);
  out(`previous claimant: ${previous?.pane ?? 'none'}`);
}

function cmdRelease() {
  rmSync(orchFile(), { force: true });
  out('released');
}

function cmdWait(o) {
  const timeout = o.timeout === undefined ? WAIT_DEFAULT_S : Number(o.timeout);
  if (!Number.isFinite(timeout) || timeout < 0) throw usageFail('--timeout needs a number of seconds');
  const only = o.run?.length ? new Set(o.run.map((r) => resolveRun(r).id)) : null;
  const warned = new Set();
  const settled = new Set();
  const lastOpen = (rec) => openQuestions(rec).at(-1)?.id;

  const scan = () => {
    const fired = [];
    for (const { name, rec } of scanRuns((e) => { if (!warned.has(e.message)) { warned.add(e.message); warnInvalid(e); } })) {
      if (only && !only.has(name)) continue;
      if (settled.has(name)) continue;
      if (rec.signal_revision > rec.orchestrator_ack) fired.push(`RUN ${name} ${rec.state} r${rec.signal_revision}${rec.state === 'needs-me' && lastOpen(rec) ? ` ${lastOpen(rec)}` : ''}`);
      else if (TERMINAL.has(rec.state)) settled.add(name);
    }
    return fired;
  };

  return new Promise((done) => {
    const watchers = new Map();
    let finished = false;
    let pending = null;
    const finish = (code, lines) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(limit);
      clearTimeout(pending);
      for (const w of watchers.values()) w.close();
      if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
      done(code);
    };
    // Watch the home (new runs) and each live run dir. Never the run.json inode: every write renames a new one in.
    const syncWatchers = () => {
      const home = realHome();
      const wanted = new Set(home ? [home, ...readdirSafe(home).filter((n) => ID_RE.test(n) && !settled.has(n) && (!only || only.has(n))).map((n) => join(home, n))] : []);
      for (const [dir, w] of watchers) if (!wanted.has(dir)) { w.close(); watchers.delete(dir); }
      for (const dir of wanted) {
        if (watchers.has(dir)) continue;
        try {
          const w = watch(dir, schedule);
          w.on('error', () => { w.close(); watchers.delete(dir); });
          watchers.set(dir, w);
        } catch { /* the dir vanished; the stat pass covers it */ }
      }
    };
    const tick = () => {
      if (finished) return;
      const fired = scan();
      if (fired.length) finish(0, fired); else syncWatchers();
    };
    function schedule() { if (!pending) pending = setTimeout(() => { pending = null; tick(); }, 25); }
    const poll = setInterval(tick, 1000); // the stat pass: at least once a second
    const limit = setTimeout(() => finish(124, []), Math.min(timeout * 1000, 2 ** 31 - 1));
    tick();
  });
}
const readdirSafe = (d) => { try { return readdirSync(d); } catch { return []; } };

// ---- start: the herdr launcher ----------------------------------------------------------------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function projectPath(name) {
  let text;
  try { text = readFileSync(join(orchHome(), 'projects.md'), 'utf8'); } catch { throw new Fail(`unknown project ${JSON.stringify(name)} (no projects.md in ${orchHome()})`); }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s+(\S+)\s/);
    if (!m || m[1] !== name) continue;
    const p = line.match(/\(path:\s*([^)]+)\)/)?.[1].trim();
    if (p) return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  }
  throw new Fail(`unknown project ${JSON.stringify(name)} in projects.md`);
}

function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

function launchPrompt({ id, dir, goal }) {
  const f = fence(goal);
  const cli = `node ${JSON.stringify(CLI_PATH)}`;
  return `# Orchestrated bork run ${id}

A coordinating session started you through \`runs.mjs start\`. Your goal, verbatim:

${f}
${goal}
${f}

Please use the bork \`do\` skill for this goal.

- Run dir: ${dir} (also in BORK_RUN_DIR). Its run.json is the shared record.
- Run record CLI: ${cli}
  If that path is gone, re-resolve runs.mjs beside the loaded orchestrate skill's SKILL.md.

Record state and questions with that CLI:

- ${cli} set ${id} --state blocked|failed|done --summary "<one line>" --delivery "<delivery line>"
- A question for the user: ${cli} ask ${id} --question "<q>" --options '[{"label":"A","description":"..."},{"label":"B","description":"..."}]' --recommendation A
  Then end your turn. The answer arrives as a pane line \`bork run ${id}: answered Q<n>\`; read it with ${cli} show ${id}.
`;
}

function launchScript({ id, dir, repo, harness, model, sessionId, home }) {
  const prompt = `Read ${dir}/launch-prompt.md and follow it.`;
  const arch = harness === 'claude'
    ? ['claude', ...(model ? ['--model', model] : []), '--session-id', sessionId, prompt]
    : ['codex', ...(model ? ['-m', model] : []), '--add-dir', home, '--add-dir', join(handoffsDir(), 'offload'), prompt];
  const exp = [['BORK_RUN_ID', id], ['BORK_RUN_DIR', dir], ['BORK_RUNS_CLI', CLI_PATH], ['BORK_RUNS_HOME', home]];
  for (const k of ['AGENT_HANDOFFS_DIR', 'ORCHESTRATOR_HOME']) if (process.env[k]) exp.push([k, process.env[k]]);
  return `#!/usr/bin/env bash
# Generated by runs.mjs start for run ${id}. Runs inside the herdr tab.
${exp.map(([k, v]) => `export ${k}=${shq(v)}`).join('\n')}
cd ${shq(repo)} || exit 1
${arch.map(shq).join(' ')}
code=$?
NODE=${shq(process.execPath)}
[ -x "$NODE" ] || NODE=node
"$NODE" "$BORK_RUNS_CLI" set "$BORK_RUN_ID" --state blocked --summary "architect exited (code $code)" >/dev/null 2>&1 || true
exit "$code"
`;
}

function cmdStart(o) {
  const goal = readGoal(o);
  const harness = o.harness ?? 'claude';
  if (!['claude', 'codex'].includes(harness)) throw new Fail(`unknown harness ${JSON.stringify(harness)}; use claude or codex`);
  if (!o.repo) throw usageFail('start needs --repo <abs path | project name>');
  const repo = gitTop(o.repo.startsWith('/') ? o.repo : projectPath(o.repo));
  if (!process.env.HERDR_ENV) throw new Fail('start needs herdr: HERDR_ENV is not set (there is no headless fallback)');
  if (!which('herdr')) throw new Fail('start needs herdr on PATH (there is no headless fallback)');

  const slug = defaultSlug(repo);
  const sessionId = harness === 'claude' ? randomUUID() : null;
  const { dir, rec } = createRun({ goal, repo, slug, launchedBy: 'orchestrator', harness, sessionId, task: o.task ?? null });
  const home = realHome();
  let tab = null;
  const fail = (why) => {
    if (tab) herdr(['tab', 'close', tab]);
    const note = String(why).trim().slice(0, 500) || 'start failed';
    try { mutate(dir, (r, at) => { if (!TERMINAL.has(r.state)) { transition(r, 'failed', note, at); r.summary = note; } }); } catch { /* keep the original failure */ }
    throw new Fail(`start failed: ${note} (run ${rec.id} marked failed)`);
  };
  const call = (args) => { const r = herdr(args); return r.status === 0 && !r.error ? r : fail(`herdr ${args.slice(0, 2).join(' ')}: ${r.stderr || r.error?.message || `exit ${r.status}`}`); };
  const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

  try {
    writeFileSync(join(dir, 'launch-prompt.md'), launchPrompt({ id: rec.id, dir, goal }), { mode: 0o600 });
    writeFileSync(join(dir, 'launch.sh'), launchScript({ id: rec.id, dir, repo, harness, model: o.model, sessionId, home }), { mode: 0o700 });
  } catch (e) { fail(e.message); }

  const ws = process.env.HERDR_WORKSPACE_ID || parse(call(['pane', 'current']))?.result?.pane?.workspace_id || fail('herdr pane current gave no workspace');
  const help = herdr(['tab', 'create', '--help']);
  const args = ['tab', 'create', '--workspace', ws, '--cwd', repo, '--label', `do: ${slug}`];
  if (`${help.stdout}${help.stderr}`.includes('--no-focus')) args.push('--no-focus');
  const created = parse(call(args))?.result;
  const pane = created?.root_pane?.pane_id;
  tab = created?.tab?.tab_id ?? created?.root_pane?.tab_id ?? null;
  if (!pane) fail('herdr tab create returned no pane');

  // Record the pane before the architect can run, so its first write cannot race this one.
  mutate(dir, (r) => { Object.assign(r.architect, { frontend: 'herdr', tab, pane }); });
  call(['pane', 'run', pane, `bash ${shq(join(dir, 'launch.sh'))}`]);

  const final = readRun(dir);
  if (o.json) out(JSON.stringify(final, null, 2));
  else out(`${final.id}\ntab ${tab} "do: ${slug}" opened in workspace ${ws} (pane ${pane})`);
}

// ---- argument parsing and dispatch ----------------------------------------------------------------

const SPEC = {
  init: { vals: ['repo', 'goal', 'goal-file', 'run-dir', 'slug'], bools: ['json'], pos: 0, run: cmdInit },
  set: { vals: ['state', 'summary', 'delivery', 'note'], bools: ['json'], pos: 1, run: cmdSet },
  show: { bools: ['json'], pos: 1, run: cmdShow },
  list: { vals: ['state'], bools: ['json'], pos: 0, run: cmdList },
  start: { vals: ['repo', 'goal', 'goal-file', 'harness', 'model', 'task'], bools: ['json'], pos: 0, run: cmdStart },
  claim: { vals: ['pane', 'harness'], pos: 0, run: cmdClaim },
  release: { pos: 0, run: cmdRelease },
  wait: { vals: ['timeout'], multi: ['run'], pos: 0, run: cmdWait },
  ack: { vals: ['revision', 'before'], bools: ['all'], pos: (o) => (o.all ? 0 : 1), run: cmdAck },
  ask: { vals: ['question', 'options', 'recommendation', 'context'], pos: 1, run: cmdAsk },
  answer: { vals: ['answer', 'by'], bools: ['no-nudge'], pos: 2, run: cmdAnswer },
  withdraw: { vals: ['note'], pos: 2, run: cmdWithdraw },
};
const WRITERS = new Set(['init', 'set', 'ask', 'answer', 'withdraw', 'ack', 'claim', 'release', 'start']);
const USAGE = `usage: runs.mjs <${Object.keys(SPEC).join('|')}> [args]  (spec: skills/core/orchestrate/SKILL.md)`;

// An option takes the next token as its value whatever it looks like: goals may start with "-".
function parseArgv(spec, argv) {
  const o = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const m = tok.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
    if (!m) { pos.push(tok); continue; }
    const [, name, inline] = m;
    if (spec.bools?.includes(name)) { o[name] = true; continue; }
    const multi = spec.multi?.includes(name);
    if (!multi && !spec.vals?.includes(name)) throw usageFail(`unknown option --${name}\n${USAGE}`);
    const value = inline ?? argv[++i];
    if (value === undefined) throw usageFail(`--${name} needs a value`);
    if (multi) (o[name] ??= []).push(value); else o[name] = value;
  }
  const want = typeof spec.pos === 'function' ? spec.pos(o) : spec.pos;
  if (pos.length !== want) throw usageFail(`expected ${want} argument(s), got ${pos.length}\n${USAGE}`);
  return { o, pos };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const spec = SPEC[cmd];
  if (!spec) throw usageFail(USAGE);
  const { o, pos } = parseArgv(spec, rest);
  // A builder process (OFFLOAD_HANDOFF set) must never write run state.
  if (WRITERS.has(cmd) && process.env.OFFLOAD_HANDOFF) throw new Fail(`${cmd} refused: OFFLOAD_HANDOFF is set, so this process is a builder and must not write run state`);
  return (await spec.run(o, pos)) ?? 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`runs: ${e.message}\n`);
  if (process.env.BORK_RUNS_DEBUG) process.stderr.write(`${e.stack}\n`);
  process.exitCode = e instanceof Fail ? e.code : 1;
});
