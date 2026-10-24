// test_stop_hook.mjs — the architect may not end a turn with work it owes.
//
// The prose said "write terminal states in the same turn you decide them" and
// "resolve every NO OWNER row before your turn ends". A Stop hook turns those
// into a refusal the harness enforces: when this session's ledger holds a slice
// the architect must act on now, the stop is blocked once with the board as the
// reason. Sessions without a ledger (builders, unrelated work) are untouched.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  hoff(['ledger', 'add', REPO, '--id', id, '--title', `slice ${id}`, '--slice-cwd', wt, '--handoff', doc, '--state', state]);
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
