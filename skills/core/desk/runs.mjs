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
  try { return realpathSync.native(runsHome()); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (!create) return null;
    mkdirSync(runsHome(), { recursive: true, mode: 0o700 });
    return realpathSync.native(runsHome());
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
  try { real = realpathSync.native(isAbsolute(arg) ? arg : join(home, arg)); } catch { throw new Fail(`no such run: ${arg}`); }
  if (dirname(real) !== home || !statSync(real).isDirectory()) throw new Fail(`${arg} is not a direct child of ${home}`);
  checkId(basename(real));
  return { id: basename(real), dir: real };
}

// ---- record: read, validate, lock, atomic write --------------------------------

function invalidReason(rec, dir) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'not a JSON object';
  if (rec.schema !== 1) return `unsupported schema ${JSON.stringify(rec.schema)}`;
  if (!STATES.includes(rec.state)) return `unknown state ${JSON.stringify(rec.state)}`;
  if (!Array.isArray(rec.questions)) return 'questions is not a list';
  if (!Array.isArray(rec.history)) return 'history is not a list';
  for (const k of ['revision', 'signal_revision', 'orchestrator_ack']) if (!Number.isInteger(rec[k])) return `${k} is not an integer`;
  if (rec.id !== basename(dir)) return 'id does not match the run dir name';
  if (typeof rec.goal !== 'string') return 'goal is not a string';
  if (!rec.architect || typeof rec.architect !== 'object') return 'architect is missing';
  if (!['orchestrator', 'self'].includes(rec.launched_by)) return 'launched_by is missing';
  for (const q of rec.questions) {
    if (!q || typeof q.id !== 'string' || !/^Q\d+$/.test(q.id) || !['open', 'answered', 'withdrawn'].includes(q.status) || !Array.isArray(q.options)) return 'a question is malformed';
  }
  // messages may be absent (a run from before tell); present, every element needs id, text and at.
  if (rec.messages !== undefined && (!Array.isArray(rec.messages) || rec.messages.some((m) => !m || typeof m.id !== 'string' || !/^M\d+$/.test(m.id) || typeof m.text !== 'string' || typeof m.at !== 'string'))) return 'messages is malformed';
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
    throw new Invalid(path, `unreadable (${e.code ?? e.message})`);
  }
  let rec;
  try { rec = JSON.parse(text); } catch (e) { throw new Invalid(path, `malformed JSON (${e.message})`); }
  const why = invalidReason(rec, dir);
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
  try { renameSync(lock, moved); } catch (e) { return e.code === 'ENOENT'; } // false: cannot break it (for example a read-only run dir)
  if (!lockIsStale(moved)) { try { linkSync(moved, lock); } catch { /* another writer holds it now */ } }
  rmSync(moved, { force: true });
  return true;
}

function withLock(dir, fn) {
  const lock = join(dir, 'run.json.lock');
  const end = Date.now() + LOCK_WAIT_MS;
  let stuck = false;
  for (let backoff = 2; ;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale(lock)) { if (breakStale(lock)) continue; stuck = true; }
      if (Date.now() > end) {
        throw new Fail(stuck
          ? `could not take the run lock ${lock} within 5 s; it is stale but the run dir is not writable, so it cannot be broken`
          : `could not take the run lock ${lock} within 5 s; another writer holds it`);
      }
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
const refuseTerminal = (rec) => {
  if (rec.state === 'done') throw new Fail(`run is done; to continue it run runs.mjs reopen ${rec.id} (or tell), or start a new run`);
  if (TERMINAL.has(rec.state)) throw new Fail(`run is ${rec.state}; a finished run only accepts ack`);
};

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

// The error code of a JSON error body, 'error' when it has none, null when the text holds no error.
function errorOf(text) {
  try { const e = JSON.parse(text || 'null')?.error; return e ? String(e.code ?? 'error') : null; } catch { return null; }
}

// A nudge is one fixed-grammar line (words, run id, state token, Q<n>); never record text.
// Returns why it could not be delivered, null when herdr took it. The warning is for callers that carry on regardless.
function nudge(pane, line, { warn = true } = {}) {
  if (typeof pane !== 'string' || !pane || pane.startsWith('-') || !which('herdr')) return 'herdr unavailable';
  const r = herdr(['agent', 'prompt', pane, clean(line).slice(0, 300)]);
  // herdr 0.9.3 fails with exit 1 and a JSON error body on stderr; older shapes use stdout or exit 0.
  const bodyError = errorOf(r.stdout) ?? errorOf(r.stderr);
  let why = null;
  if (r.error) why = r.error.code || 'spawn failed';
  else if (r.status !== 0) why = bodyError ?? `exit ${r.status}`;
  else if (/agent_blocked/.test(`${r.stdout}${r.stderr}`)) why = 'agent_blocked';
  else if (bodyError) why = bodyError;
  if (why && warn) process.stderr.write(`warning: could not nudge pane ${clean(pane)} (${clean(why).slice(0, 40)}); the run record is already written\n`);
  return why;
}

function readOrch() {
  try { const j = JSON.parse(readFileSync(orchFile(), 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

function nudgeOrchestrator(dir, rec) {
  if (rec.launched_by !== 'orchestrator') return;
  const pane = readOrch()?.pane;
  if (!pane) return;
  const q = openQuestions(rec).at(-1)?.id;
  nudge(pane, `bork run ${basename(dir)}: ${rec.state}${rec.state === 'needs-me' && q ? ` ${q}` : ''}`);
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
  try { lstatSync(abs); real = realpathSync.native(abs); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { real = join(realpathSync.native(dirname(abs)), basename(abs)); } catch { throw new Fail(`${abs} is not a direct child of ${home}`); }
  }
  if (dirname(real) !== home) throw new Fail(`${abs} is not a direct child of ${home}`);
  return real;
}

function createRun({ goal, repo = null, slug, runDir, launchedBy = 'self', harness = null, sessionId = null, task = null, herdrSelf = null }) {
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
    if (statSyncOrNull(recFile(dir))) return { dir, rec: readRun(dir) };
    const at = nowIso();
    const rec = {
      schema: 1, id: basename(dir), run_dir: dir, repo, goal, task, state: 'running', summary: '', delivery: null,
      questions: [], messages: [], architect: { harness, session_id: sessionId, frontend: herdrSelf?.frontend ?? null, tab: herdrSelf?.tab ?? null, pane: herdrSelf?.pane ?? null },
      launched_by: launchedBy, revision: 1, signal_revision: 0, orchestrator_ack: 0, created_at: at, updated_at: at,
      history: [{ at, state: 'running', note: 'created' }],
    };
    atomicWrite(recFile(dir), `${JSON.stringify(rec, null, 2)}\n`);
    return { dir, rec };
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

// A run started inside a herdr pane records that tab and pane, so the board can take the user back to it.
// Both ids must be well-formed (they later reach herdr's argv); otherwise the architect stays unrecorded.
const HERDR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
function herdrSelf() {
  const { HERDR_ENV, HERDR_TAB_ID: tab, HERDR_PANE_ID: pane } = process.env;
  return HERDR_ENV && HERDR_ID_RE.test(tab ?? '') && HERDR_ID_RE.test(pane ?? '') ? { frontend: 'herdr', tab, pane } : null;
}

function cmdInit(o) {
  const goal = readGoal(o);
  const repo = o.repo !== undefined ? gitTop(o.repo) : null;
  const slug = o.slug ?? defaultSlug(repo);
  checkId(slug);
  const { dir, rec } = createRun({ goal, repo, slug, runDir: o['run-dir'], herdrSelf: herdrSelf() });
  out(o.json ? JSON.stringify(rec) : dir);
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
  if (signalled(res)) nudgeOrchestrator(dir, res.rec);
  out(o.json ? JSON.stringify(res.rec) : `${res.rec.id} ${res.rec.state}`);
}

// ---- tell and reopen ---------------------------------------------------------------------------------------

const TELL_USAGE = 'usage: runs.mjs tell <run> (--message <text> | --message-file <file>) [--json]';
const MESSAGE_MAX_BYTES = 65536;

function readMessage(o) {
  if (o.message !== undefined && o['message-file'] !== undefined) throw usageFail(TELL_USAGE);
  let text = o.message;
  if (o['message-file'] !== undefined) {
    try { text = readFileSync(o['message-file'], 'utf8'); } catch (e) { throw usageFail(`cannot read --message-file (${e.code ?? e.message})\n${TELL_USAGE}`); }
  }
  if (text === undefined || !text.trim()) throw usageFail(TELL_USAGE);
  if (Buffer.byteLength(text) > MESSAGE_MAX_BYTES) throw usageFail(`the message is over 64 KiB (${MESSAGE_MAX_BYTES} bytes)\n${TELL_USAGE}`);
  return text;
}

const refusal = (verb, token, why) => new Fail(`${verb} refused (${token}): ${why}`);

// The record-only refusals, in token order. tell and reopen run them before the write and again on the record read under the lock.
function refuseClosed(rec, verb) {
  const id = rec.id;
  if (rec.state === 'failed') throw refusal(verb, 'run_failed', `run ${id} failed and stays final; start a new run and name this run dir (${rec.run_dir}) in its goal`);
  const open = openQuestions(rec).map((q) => q.id);
  if (rec.state === 'needs-me' || open.length) throw refusal(verb, 'question_open', `run ${id} has an open question (${open.join(', ') || 'none recorded'}); answer or withdraw ${open.join(', ') || 'it'} first`);
  if (verb === 'tell' && !Array.isArray(rec.messages)) throw refusal(verb, 'predates_tell', `run ${id} was created before tell existed and has no message list; continue in the run's tab (${rec.architect.tab ?? 'no tab recorded'})`);
}

// done or blocked becomes running; the old delivery line stays in the history note.
function reopenRec(rec, note, at) {
  const previous = rec.delivery;
  transition(rec, 'running', previous ? `${note}; previous delivery: ${previous}` : note, at);
  rec.summary = note;
  rec.delivery = null;
}

// The herdr half of the preflight: the pane must hold an agent that is not blocked. Reads only agent_status.
function refuseAgent(rec) {
  const [id, pane, tab] = [rec.id, rec.architect.pane, rec.architect.tab ?? 'no tab recorded'];
  if (typeof pane !== 'string' || !HERDR_ID_RE.test(pane)) throw refusal('tell', 'no_pane', `run ${id} has no usable architect pane; tell the session directly`);
  const unreachable = (why) => refusal('tell', 'herdr_unreachable', `herdr could not be asked about pane ${pane} of run ${id} (${why}); type the work into tab ${tab}`);
  if (!which('herdr')) throw unreachable('herdr is not on PATH');
  const r = herdr(['agent', 'get', pane]);
  if (r.error) throw unreachable(r.error.code || 'spawn failed');
  let status;
  if (r.status === 0) {
    try { status = JSON.parse(r.stdout)?.result?.agent?.agent_status; } catch { /* unusable answer */ }
    if (typeof status !== 'string') throw unreachable('unreadable answer');
  } else if ((errorOf(r.stderr) ?? errorOf(r.stdout)) === 'agent_not_found') {
    throw refusal('tell', 'agent_gone', `the agent in pane ${pane} of run ${id} is gone; start a new run with this work, or set the run failed`);
  } else throw unreachable(`exit ${r.status}`);
  if (status === 'blocked') throw refusal('tell', 'agent_blocked', `the agent in pane ${pane} of run ${id} is blocked on a dialog; answer the dialog in tab ${tab}, then run tell again`);
}

function cmdTell(o, [arg]) {
  const text = readMessage(o);
  const { dir } = resolveRun(arg);
  const before = readRun(dir);
  refuseClosed(before, 'tell');
  refuseAgent(before);
  let msg;
  // No herdr call inside the lock; the record read under it decides again.
  const res = mutate(dir, (rec, at) => {
    refuseClosed(rec, 'tell');
    msg = { id: `M${rec.messages.length + 1}`, text, by: 'user', at };
    rec.messages.push(msg);
    if (rec.state === 'running') rec.history.push({ at, state: 'running', note: `message ${msg.id}` });
    else reopenRec(rec, `reopened by ${msg.id}`, at);
  });
  const why = nudge(before.architect.pane, `bork run ${res.rec.id}: new instruction ${msg.id} from the user; read it with runs.mjs show ${res.rec.id}`, { warn: false });
  if (o.json) out(JSON.stringify({ message: msg, state: res.rec.state, delivered: !why }));
  else out(why ? `${msg.id} recorded, not delivered (${clean(why).slice(0, 40)})` : `${msg.id} sent`);
  return why ? 3 : 0;
}

function cmdReopen(o, [arg]) {
  const { dir, id } = resolveRun(arg);
  let isOpen = false;
  mutate(dir, (rec, at) => {
    refuseClosed(rec, 'reopen');
    if (rec.state === 'running') { isOpen = true; return NOOP; }
    rec.messages ??= [];
    reopenRec(rec, o.note || 'reopened', at);
  });
  out(`${id} running${isOpen ? ' (already open)' : ''}`);
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
  nudgeOrchestrator(dir, res.rec);
  out(qid);
}

function findOpen(rec, qid) {
  const q = rec.questions.find((x) => x.id === qid);
  if (!q) throw new Fail(`no question ${qid} on ${rec.id}`);
  if (q.status !== 'open') throw new Fail(`${qid} is already ${q.status}`);
  return q;
}

function cmdAnswer(o, [arg, qid]) {
  if (o.by === undefined) throw usageFail('usage: runs.mjs answer <run> Q<n> --answer <text> --by user|orchestrator (--by is required)');
  const { dir } = resolveRun(arg);
  if (o.answer === undefined) throw usageFail('answer needs --answer');
  const res = mutate(dir, (rec, at) => {
    refuseTerminal(rec);
    const q = findOpen(rec, qid);
    Object.assign(q, {
      status: 'answered', answer: o.answer, choice: q.options.some((x) => x.label === o.answer) ? o.answer : null,
      answered_at: at, answered_by: o.by,
    });
    resumeIfClear(rec, `answered ${qid}`, at);
  });
  if (!o['no-nudge'] && res.rec.architect.pane) nudge(res.rec.architect.pane, `bork run ${basename(dir)}: answered ${qid}`);
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

const AGENT_WORD = { working: 'agent working', blocked: 'agent blocked', idle: 'agent idle', done: 'agent turn ended', unknown: 'agent unknown' };

// One `herdr agent list` as a pane -> agent_status map (only those two fields are read; an unknown status is `unknown`).
// null when herdr is missing, fails, times out or prints anything unusable: no status, never an error and never gone.
function agentMap() {
  if (!which('herdr')) return null;
  const r = herdr(['agent', 'list']);
  if (r.error || r.status !== 0) return null;
  let agents;
  try { agents = JSON.parse(r.stdout)?.result?.agents; } catch { return null; }
  if (!Array.isArray(agents)) return null;
  const map = new Map();
  for (const a of agents) if (typeof a?.pane_id === 'string') map.set(a.pane_id, a.agent_status in AGENT_WORD ? a.agent_status : 'unknown');
  return map;
}

const liveRun = (rec) => typeof rec.architect?.pane === 'string' && rec.architect.pane !== '' && !TERMINAL.has(rec.state);
// The raw status, 'gone' (herdr answered and the pane holds no agent) or undefined (no answer, or nothing to ask).
const agentOf = (rec, map) => (map && liveRun(rec) ? map.get(rec.architect.pane) ?? 'gone' : undefined);

function flagsOf(rec, agent) {
  const f = [];
  if (agent === 'gone') f.push('architect gone');
  if (rec.state === 'running' && Date.now() - Date.parse(rec.updated_at) > STALE_RUN_MS) f.push('stale');
  return f;
}

const firstLine = (s, n = 100) => String(s).split('\n')[0].slice(0, n);
const warnInvalid = (e) => process.stderr.write(`warning: skipping ${e.message}\n`);

// Every readable run under the home; invalid ones are reported through onInvalid and skipped.
// With a cache (wait), a run.json is re-read only when its mtime, size or inode changed.
function scanRuns(onInvalid = warnInvalid, { cache } = {}) {
  const home = realHome();
  if (!home) return [];
  const found = [];
  for (const name of readdirSync(home)) {
    if (!ID_RE.test(name) || name.includes('..')) continue;
    const dir = join(home, name);
    let st;
    try { st = lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let sig = null;
    if (cache) {
      try { const f = statSync(recFile(dir)); sig = `${f.mtimeMs}:${f.size}:${f.ino}`; } catch { cache.delete(name); }
      const hit = sig && cache.get(name);
      if (hit?.sig === sig) { found.push({ name, dir, rec: hit.rec }); continue; }
    }
    try {
      const rec = readRun(dir);
      cache?.set(name, { sig, rec });
      found.push({ name, dir, rec });
    } catch (e) {
      if (e.invalid) { cache?.delete(name); onInvalid(e); } // never cache a failed read: a chmod repair changes no mtime, size or inode
      else if (!/no run\.json/.test(e.message)) throw e;
    }
  }
  return found;
}

function cmdShow(o, [arg]) {
  const { id, dir } = resolveRun(arg);
  const rec = readRun(dir);
  const agent = agentOf(rec, liveRun(rec) ? agentMap() : null);
  const flags = flagsOf(rec, agent);
  const moot = (q) => rec.state === 'failed' && q.status === 'open';
  if (o.json) {
    out(JSON.stringify({ ...rec, flags, ...(agent !== undefined && { agent_status: agent }), questions: rec.questions.map((q) => (moot(q) ? { ...q, moot: true } : q)) }, null, 2));
    return;
  }
  const a = rec.architect;
  const lines = [
    `run: ${id}`, `state: ${rec.state}${flags.length ? ` (${flags.join(', ')})` : ''}`, `goal: ${firstLine(rec.goal, 200)}`,
    `launched by: ${rec.launched_by}`,
    ...(agent && agent !== 'gone' ? [`agent: ${AGENT_WORD[agent].replace(/^agent /, '')}`] : []),
    `summary: ${rec.summary || '-'}`, `delivery: ${rec.delivery ?? '-'}`, `run dir: ${dir}`,
    `architect: ${a.harness ?? '-'} tab ${a.tab ?? '-'} pane ${a.pane ?? '-'}`,
  ];
  if (rec.messages?.length) {
    // Newlines stay (a message is an instruction with structure); every other control character goes.
    lines.push('', 'messages:', ...rec.messages.map((m) => `  ${m.id} (${m.at}): ${m.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').replace(/\n/g, '\n    ')}`));
  }
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
  // At most one herdr call, and only when a shown run could be asked about.
  const map = runs.some(({ rec }) => liveRun(rec)) ? agentMap() : null;
  const rows = runs.map(({ name, rec }) => { const agent = agentOf(rec, map); return { name, rec, agent, flags: flagsOf(rec, agent) }; });
  if (o.json) { out(JSON.stringify(rows.map(({ rec, flags, agent }) => ({ ...rec, flags, ...(agent !== undefined && { agent_status: agent }) })), null, 2)); return; }
  for (const { name, rec, agent, flags } of rows) {
    const tags = [...(agent && agent !== 'gone' ? [AGENT_WORD[agent]] : []), ...flags];
    out(`${name}  ${rec.state}${tags.length ? ` [${tags.join(', ')}]` : ''}  ${rec.summary || firstLine(rec.goal)}`);
  }
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
  const cache = new Map();
  const lastOpen = (rec) => openQuestions(rec).at(-1)?.id;

  const scan = () => {
    const fired = [];
    const warnOnce = (e) => { if (!warned.has(e.message)) { warned.add(e.message); warnInvalid(e); } };
    // A settled run is still scanned (the cache keeps it to one stat): a reopen must wake an armed wait. Settled only limits fs.watch.
    for (const { name, rec } of scanRuns(warnOnce, { cache })) {
      if (only && !only.has(name)) continue;
      if (rec.signal_revision > rec.orchestrator_ack) fired.push(`RUN ${name} ${rec.state} r${rec.signal_revision}${rec.state === 'needs-me' && lastOpen(rec) ? ` ${lastOpen(rec)}` : ''}`);
      else if (TERMINAL.has(rec.state)) settled.add(name);
      else settled.delete(name);
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
      try {
        const fired = scan();
        if (fired.length) finish(0, fired); else syncWatchers();
      } catch (e) {
        process.stderr.write(`runs: wait stopped: ${e.message}\n`);
        finish(1, []); // clears every timer and watcher; nothing outlives the failure
      }
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
  If that path is gone, re-resolve runs.mjs beside the loaded desk skill's SKILL.md.

Record state and questions with that CLI:

- ${cli} set ${id} --state blocked|failed|done --summary "<one line>" --delivery "<delivery line>"
- A question for the user: ${cli} ask ${id} --question "<q>" --options '[{"label":"A","description":"..."},{"label":"B","description":"..."}]' --recommendation A
  Then end your turn. The answer arrives as a pane line \`bork run ${id}: answered Q<n>\`; read it with ${cli} show ${id}.
- More work for this run arrives as a pane line \`bork run ${id}: new instruction M<n> from the user; read it with runs.mjs show ${id}\`: run \`show\` with ${cli}, treat M<n>'s text as the user's next instruction for this run, continue under the do skill, and set a final state again when finished.
`;
}

// Claude only. The Codex launch line was removed under decisions 16: herdr is blocked inside
// Codex's workspace-write sandbox, so cmdStart refuses a Codex architect before any side effect.
function launchScript({ id, dir, repo, model, sessionId, home }) {
  const prompt = `Read ${dir}/launch-prompt.md and follow it.`;
  const arch = ['claude', ...(model ? ['--model', model] : []), '--session-id', sessionId, prompt];
  const exp = [['BORK_RUN_ID', id], ['BORK_RUN_DIR', dir], ['BORK_RUNS_CLI', CLI_PATH], ['BORK_RUNS_HOME', home]];
  for (const k of ['AGENT_HANDOFFS_DIR', 'ORCHESTRATOR_HOME']) if (process.env[k]) exp.push([k, process.env[k]]);
  return `#!/usr/bin/env bash
# Generated by runs.mjs start for run ${id}. Runs inside the herdr tab.
${exp.map(([k, v]) => `export ${k}=${shq(v)}`).join('\n')}
NODE=${shq(process.execPath)}
[ -x "$NODE" ] || NODE=node
# A run already blocked keeps its summary (the architect's reason); the exit is added as a note.
# Any other non-terminal run is set blocked. A terminal run refuses the set and stays as it is.
blocked_hook() {
  if "$NODE" -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.env.BORK_RUN_DIR + "/run.json", "utf8")).state === "blocked" ? 0 : 1)' 2>/dev/null; then
    "$NODE" "$BORK_RUNS_CLI" set "$BORK_RUN_ID" --note "$1" >/dev/null 2>&1 || true
  else
    "$NODE" "$BORK_RUNS_CLI" set "$BORK_RUN_ID" --state blocked --summary "$1" >/dev/null 2>&1 || true
  fi
}
cd ${shq(repo)} || { blocked_hook "architect could not start (cd failed)"; exit 1; }
${arch.map(shq).join(' ')}
code=$?
blocked_hook "architect exited (code $code)"
exit "$code"
`;
}

function cmdStart(o) {
  const harness = o.harness ?? 'claude';
  if (harness === 'codex') throw usageFail("Codex architect launch is disabled: herdr is not reachable inside Codex's sandbox, so a Codex architect cannot send pane messages. Codex sessions can still coordinate (claim, wait, show, answer, ack). Use --harness claude.");
  if (harness !== 'claude') throw new Fail(`unknown harness ${JSON.stringify(harness)}; use claude`);
  const goal = readGoal(o);
  if (!o.repo) throw usageFail('start needs --repo <abs path | project name>');
  const repo = gitTop(o.repo.startsWith('/') ? o.repo : projectPath(o.repo));
  if (!process.env.HERDR_ENV) throw new Fail('start needs herdr: HERDR_ENV is not set (there is no headless fallback)');
  if (!which('herdr')) throw new Fail('start needs herdr on PATH (there is no headless fallback)');

  const slug = defaultSlug(repo);
  const sessionId = randomUUID();
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
    writeFileSync(join(dir, 'launch.sh'), launchScript({ id: rec.id, dir, repo, model: o.model, sessionId, home }), { mode: 0o700 });
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
  tell: { vals: ['message', 'message-file'], bools: ['json'], pos: 1, run: cmdTell },
  reopen: { vals: ['note'], pos: 1, run: cmdReopen },
};
const WRITERS = new Set(['init', 'set', 'ask', 'answer', 'withdraw', 'ack', 'claim', 'release', 'start', 'tell', 'reopen']);
const USAGE = `usage: runs.mjs <${Object.keys(SPEC).join('|')}> [args]  (spec: skills/core/desk/SKILL.md)`;

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
