// test_stop_hook.mjs — the architect may not end a turn with work it owes.
//
// The prose said "write terminal states in the same turn you decide them" and
// "resolve every NO OWNER row before your turn ends". A Stop hook turns those
// into a refusal the harness enforces: when this session's ledger holds a slice
// the architect must act on now, the stop is blocked once with the board as the
// reason. Sessions without a ledger (builders, unrelated work) are untouched.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'stop-hook.mjs');
const HANDOFF = join(HERE, 'handoff.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'ofl-stop-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const envFor = (session) => {
  const env = { ...process.env, AGENT_HANDOFFS_DIR: BOX };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.HERDR_ENV;
  delete env.BORK_RUN_DIR;
  if (session) env.CLAUDE_CODE_SESSION_ID = session;
  return env;
};
const hoff = (args, session = 'arch') => execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env: envFor(session) }).trim();
const fire = (input, session) => execFileSync(NODE, [HOOK], { encoding: 'utf8', env: envFor(session), input: JSON.stringify(input) });

const repo = (name) => join(BOX, `repo-${name}`);
function slice(REPO, id, { state, docStatus, pid }) {
  const wt = join(REPO, `wt-${id}`);
  const doc = hoff(['init', wt, 'arch', `slice ${id}`]);
  if (docStatus) writeFileSync(doc, readFileSync(doc, 'utf8').replace(/^status:.*$/m, `status: ${docStatus}`));
  if (pid !== 'none') writeFileSync(`${doc}.builder`, `${pid}\n`);
  // A rejection must carry its verdict (the ledger refuses one without it).
  const verdict = state === 'rejected' ? ['--verdict', 'g2 failed 3/5'] : [];
  hoff(['ledger', 'add', REPO, '--id', id, '--title', `slice ${id}`, '--slice-cwd', wt, '--handoff', doc, '--state', state, ...verdict]);
  return doc;
}

test('no ledger for this session -> silent', () => {
  assert.equal(fire({ session_id: 'nobody', cwd: repo('none') }), '');
});

test('a session id from stdin is enough — no env needed', () => {
  const REPO = repo('stdin-sid');
  hoff(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'results-ready', pid: 'none' });
  const out = JSON.parse(fire({ session_id: 'arch', cwd: REPO }, undefined));
  assert.equal(out.decision, 'block');
});

test('results reported and nobody judging -> block with the board as the reason', () => {
  const REPO = repo('owed');
  hoff(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'results-ready', pid: 'none' });
  const out = JSON.parse(fire({ session_id: 'arch', cwd: REPO }));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /BOARD/);
  assert.match(out.reason, /results-ready/);
  assert.match(out.reason, /terminal/);
});

test('a blocked builder -> block; the architect owes a ruling', () => {
  const REPO = repo('blocked');
  hoff(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'blocked', docStatus: 'blocked', pid: process.pid });
  assert.equal(JSON.parse(fire({ session_id: 'arch', cwd: REPO })).decision, 'block');
});

test('a healthy dispatched slice with a live builder -> silent (the bridge will wake us)', () => {
  const REPO = repo('healthy');
  hoff(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'dispatched', pid: process.pid });
  assert.equal(fire({ session_id: 'arch', cwd: REPO }), '');
});

test('all terminal -> silent', () => {
  const REPO = repo('terminal');
  hoff(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'accepted', docStatus: 'results-ready', pid: 'none' });
  slice(REPO, '2', { state: 'rejected', docStatus: 'results-ready', pid: 'none' });
  assert.equal(fire({ session_id: 'arch', cwd: REPO }), '');
});

test('a specced slice awaiting the user is not owed work -> silent', () => {
  const REPO = repo('specced');
  hoff(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'specced', docStatus: 'specced', pid: 'none' });
  assert.equal(fire({ session_id: 'arch', cwd: REPO }), '');
});

test('stop_hook_active -> never block twice in a row', () => {
  const REPO = repo('once');
  hoff(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'results-ready', pid: 'none' });
  assert.equal(fire({ session_id: 'arch', cwd: REPO, stop_hook_active: true }), '');
});

test('garbage on stdin -> silent, never a crash that blocks the user', () => {
  const out = execFileSync(NODE, [HOOK], { encoding: 'utf8', env: envFor('arch'), input: 'not json' });
  assert.equal(out, '');
});

test('a halted run owes nothing: the stop is never refused', () => {
  const REPO = repo('halted');
  hoff(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'results-ready', pid: 'none' });
  hoff(['halt', REPO, 'user said stop']);
  assert.equal(fire({ session_id: 'arch', cwd: REPO }), '');
  hoff(['unhalt', REPO]);
  assert.equal(JSON.parse(fire({ session_id: 'arch', cwd: REPO })).decision, 'block', 'unhalt restores the hook');
});

// --- run.json: a needs-me run is waiting on the user, not on this turn ---------
//
// A `do` run that asked the user a question sits at needs-me with its ledger
// still holding a results-ready slice. Refusing the stop there would trap the
// architect in a turn that cannot finish. The hook reads run.json directly
// (it never imports runs.mjs) from BORK_RUN_DIR, else the ledger's run_dir.
// The fixture carries every spec v2 section 1 field, so the hook is tested
// against the frozen shape and not a minimal one.
const runJson = (state, over = {}) => ({
  schema: 1, id: 'run-1', run_dir: '/x', repo: null, goal: 'g', task: null, state, summary: '', delivery: null,
  questions: [], architect: { harness: 'claude', session_id: null, frontend: null, tab: null, pane: null },
  launched_by: 'self', revision: 1, signal_revision: 0, orchestrator_ack: 0,
  created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:00:00Z', history: [], ...over,
});
function runDirWith(name, body) {
  const d = join(BOX, `run-${name}`);
  mkdirSync(d, { recursive: true });
  if (body !== undefined) writeFileSync(join(d, 'run.json'), typeof body === 'string' ? body : JSON.stringify(body));
  return d;
}
const fireRun = (input, runDir) => {
  const env = envFor('arch');
  if (runDir) env.BORK_RUN_DIR = runDir;
  return execFileSync(NODE, [HOOK], { encoding: 'utf8', env, input: JSON.stringify(input) });
};
function owedRepo(name, ledgerRunDir) {
  const REPO = repo(name);
  hoff(['ledger', 'init', REPO, 'g', ...(ledgerRunDir ? ['--run-dir', ledgerRunDir] : [])]);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'results-ready', pid: 'none' });
  return REPO;
}

test('a needs-me run.json in BORK_RUN_DIR allows the stop while a slice is results-ready', () => {
  const REPO = owedRepo('needs-me-env');
  const out = fireRun({ session_id: 'arch', cwd: REPO }, runDirWith('needs-me-env', runJson('needs-me')));
  assert.equal(out, '');
});

test('with BORK_RUN_DIR unset the hook finds run.json through the ledger run_dir', () => {
  const dir = runDirWith('needs-me-ledger', runJson('needs-me'));
  const REPO = owedRepo('needs-me-ledger', dir);
  assert.equal(fireRun({ session_id: 'arch', cwd: REPO }), '');
});

// A finished run's BORK_RUN_DIR (done or failed) is never reused, as dispatch-slice.sh
// treats it, so the hook looks at the ledger's own run_dir instead.
for (const state of ['done', 'failed']) {
  test(`a ${state} BORK_RUN_DIR is ignored and the ledger run_dir (needs-me) allows the stop`, () => {
    const ledgerRun = runDirWith(`ledger-needs-me-${state}`, runJson('needs-me'));
    const REPO = owedRepo(`env-${state}-ledger-needs-me`, ledgerRun);
    assert.equal(fireRun({ session_id: 'arch', cwd: REPO }, runDirWith(`env-${state}`, runJson(state))), '');
  });
}

for (const state of ['running', 'blocked', 'done']) {
  test(`a ${state} run.json still blocks the stop once`, () => {
    const REPO = owedRepo(`run-${state}`);
    const out = JSON.parse(fireRun({ session_id: 'arch', cwd: REPO }, runDirWith(`state-${state}`, runJson(state))));
    assert.equal(out.decision, 'block');
  });
}

for (const [name, body, schemaNote] of [
  ['malformed', '{ not json', ''],
  ['wrong shape: questions not a list', runJson('needs-me', { questions: 'nope' }), ''],
  ['wrong shape: a field missing', (() => { const r = runJson('needs-me'); delete r.history; return r; })(), ''],
  ['wrong shape: unknown state', runJson('waiting'), ''],
  ...['repo', 'goal', 'summary', 'delivery', 'created_at', 'updated_at'].map((k) => [
    `wrong shape: ${k} missing`, (() => { const r = runJson('needs-me'); delete r[k]; return r; })(), '']),
  ['newer schema', runJson('needs-me', { schema: 2 }), ''],
  ['no run.json at all', undefined, ''],
]) {
  test(`${name}: the hook falls back to the ledger decision, with no stack trace`, () => {
    const REPO = owedRepo(`bad-${name.replace(/\W+/g, '-')}`);
    const dir = runDirWith(`bad-${name.replace(/\W+/g, '-')}`, body);
    const res = execFileSync(NODE, [HOOK], { encoding: 'utf8', env: { ...envFor('arch'), BORK_RUN_DIR: dir }, input: JSON.stringify({ session_id: 'arch', cwd: REPO }), stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(JSON.parse(res).decision, 'block');
  });
}
