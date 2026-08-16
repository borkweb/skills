// test_ledger.mjs — the architect's slice ledger and the `board` roll-up.
//
// These tests exist because of one concrete failure: across a six-builder run,
// a slice whose builder finished and exited kept being reported as "running"
// for the better part of an hour, because nothing on disk recorded that it had
// no owner. Every case below is a state the architect must not be able to
// misreport from memory.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF = join(HERE, 'handoff.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'ldg-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const run = (args, { session = 'arch', env: extra = {} } = {}) => {
  const env = { ...process.env, AGENT_HANDOFFS_DIR: BOX, ...extra };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (session !== undefined) env.CLAUDE_CODE_SESSION_ID = session;
  // Real herdr must never be consulted by a test; only the cases that opt into
  // the fake CLI below set HERDR_ENV.
  if (!extra.HERDR_ENV) delete env.HERDR_ENV;
  return execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env }).trim();
};

const runFail = (args, opts) => {
  try {
    run(args, opts);
    throw new Error('expected command to fail but it exited 0');
  } catch (e) {
    if (!('status' in e) || e.status === 0) throw e;
    return String(e.stderr || '');
  }
};

const repo = (name) => join(BOX, `repo-${name}`);
// `--no-git` everywhere: these fixtures are not git repos and the probe is not
// what is under test.
const board = (cwd, opts) => run(['board', cwd, '--no-git'], opts);

test('ledger init is idempotent and records the goal', () => {
  const REPO = repo('init');
  const p1 = run(['ledger', 'init', REPO, 'ship the fidelity fixes']);
  assert.ok(p1.endsWith('.ledger.json'));
  const p2 = run(['ledger', 'init', REPO]);
  assert.equal(p2, p1);
  const l = JSON.parse(run(['ledger', 'show', REPO]));
  assert.equal(l.goal, 'ship the fidelity fixes');
  assert.deepEqual(l.slices, []);
});

test('ledger is keyed per session — two architects never share one', () => {
  const REPO = repo('per-session');
  const a = run(['ledger', 'init', REPO, 'goal A'], { session: 'arch-A' });
  const b = run(['ledger', 'init', REPO, 'goal B'], { session: 'arch-B' });
  assert.notEqual(a, b);
  assert.equal(JSON.parse(run(['ledger', 'show', REPO], { session: 'arch-A' })).goal, 'goal A');
});

test('ledger add rejects a duplicate id and set rejects an unknown one', () => {
  const REPO = repo('ids');
  run(['ledger', 'init', REPO, 'g']);
  run(['ledger', 'add', REPO, '--id', '1', '--title', 'first']);
  assert.match(runFail(['ledger', 'add', REPO, '--id', '1', '--title', 'again']), /already exists/);
  assert.match(runFail(['ledger', 'set', REPO, '9', '--state', 'accepted']), /no slice "9"/);
});

test('ledger rejects a state outside the lifecycle', () => {
  const REPO = repo('bad-state');
  run(['ledger', 'init', REPO, 'g']);
  const err = runFail(['ledger', 'add', REPO, '--id', '1', '--state', 'in-progress']);
  assert.match(err, /invalid slice state/);
  assert.match(err, /results-ready/);
});

test('ledger set updates only the fields given', () => {
  const REPO = repo('partial');
  run(['ledger', 'init', REPO, 'g']);
  run(['ledger', 'add', REPO, '--id', '2', '--title', 'nav links',
    '--branch', 'fix/nav', '--pane', 'wY:p21', '--state', 'dispatched']);
  run(['ledger', 'set', REPO, '2', '--state', 'accepted', '--verdict', 'SAFE TO LAND']);
  const s = JSON.parse(run(['ledger', 'show', REPO])).slices[0];
  assert.equal(s.state, 'accepted');
  assert.equal(s.verdict, 'SAFE TO LAND');
  assert.equal(s.branch, 'fix/nav', 'branch survives a state-only update');
  assert.equal(s.pane, 'wY:p21', 'pane survives a state-only update');
});

test('board without a ledger says how to start one', () => {
  assert.match(board(repo('no-ledger')), /no ledger for this session/);
});

// --- the reconciliation cases ---------------------------------------------

// Build a slice with its own handoff doc. `pid` controls the .builder marker:
// a number writes it, 'none' leaves it absent (builder exited / never launched).
function slice(REPO, id, { state, docStatus, pid } = {}) {
  const wt = join(REPO, `wt-${id}`);
  const doc = run(['init', wt, 'arch', `slice ${id}`]);
  if (docStatus) writeFileSync(doc, readFileSync(doc, 'utf8').replace(/^status:.*$/m, `status: ${docStatus}`));
  if (pid !== 'none') writeFileSync(`${doc}.builder`, `${pid}\n`);
  run(['ledger', 'add', REPO, '--id', id, '--title', `slice ${id}`,
    '--slice-cwd', wt, '--handoff', doc, '--state', state]);
  return doc;
}

test('board flags a dispatched slice whose builder exited as NO OWNER', () => {
  const REPO = repo('no-owner');
  run(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'dispatched', pid: 'none' });
  const out = board(REPO);
  assert.match(out, /NO OWNER/);
  assert.match(out, /nothing is working this slice/);
  assert.match(out, /1 needing attention/);
});

test('board does NOT flag a dispatched slice whose builder is alive', () => {
  const REPO = repo('alive');
  run(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'dispatched', pid: process.pid });
  const out = board(REPO);
  assert.doesNotMatch(out, /NO OWNER/);
  assert.match(out, /0 needing attention/);
});

test('board flags a doc that has moved ahead of the ledger', () => {
  const REPO = repo('mismatch');
  run(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'results-ready', pid: process.pid });
  const out = board(REPO);
  assert.match(out, /MISMATCH — ledger says dispatched, doc says results-ready/);
});

test('board flags a blocked slice as needing the architect', () => {
  const REPO = repo('blocked');
  run(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'blocked', docStatus: 'blocked', pid: process.pid });
  assert.match(board(REPO), /NEEDS ARCHITECT — arbitrate now/);
});

test('board flags the `status: undefined` corruption on a live slice', () => {
  const REPO = repo('corrupt');
  run(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'undefined', pid: process.pid });
  const out = board(REPO);
  assert.match(out, /CORRUPT DOC STATUS \("undefined"\)/);
  assert.match(out, /the bridge can never match it/);
});

// A terminal slice is settled; re-flagging its dead doc on every wake is the
// same every-turn noise that trained the architect to stop reading the board.
test('board goes quiet once a slice reaches a terminal state', () => {
  const REPO = repo('terminal');
  run(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'accepted', docStatus: 'undefined', pid: 'none' });
  const out = board(REPO);
  assert.doesNotMatch(out, /NO OWNER/);
  assert.doesNotMatch(out, /CORRUPT/);
  assert.doesNotMatch(out, /MISMATCH/);
  assert.match(out, /0 needing attention/);
});

test('board flags a specced slice as not dispatched, without calling it exited', () => {
  const REPO = repo('specced');
  run(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'specced', docStatus: 'specced', pid: 'none' });
  const out = board(REPO);
  assert.match(out, /NOT DISPATCHED/);
  assert.doesNotMatch(out, /NO OWNER/);
});

test('board flags a handoff that has vanished', () => {
  const REPO = repo('doc-gone');
  run(['ledger', 'init', REPO, 'g']);
  const doc = slice(REPO, '1', { state: 'dispatched', docStatus: 'dispatched', pid: process.pid });
  rmSync(doc);
  assert.match(board(REPO), /DOC MISSING/);
});

test('board summarises every slice in one pass, counting what needs attention', () => {
  const REPO = repo('roll-up');
  run(['ledger', 'init', REPO, 'HTML-first fidelity']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'dispatched', pid: 'none' });      // NO OWNER
  slice(REPO, '2', { state: 'accepted', docStatus: 'results-ready', pid: 'none' });     // settled
  slice(REPO, '3', { state: 'dispatched', docStatus: 'dispatched', pid: process.pid }); // healthy
  slice(REPO, '4', { state: 'results-ready', docStatus: 'results-ready', pid: process.pid });
  const out = board(REPO);
  assert.match(out, /HTML-first fidelity/);
  assert.match(out, /4 slices/);
  assert.match(out, /2 needing attention/, 'slice 1 (no owner) + slice 4 (awaiting judgment)');
  assert.match(out, /NEEDS ARCHITECT — judge the gates/);
});

test('board --json exposes the same reconciliation to a machine', () => {
  const REPO = repo('json');
  run(['ledger', 'init', REPO, 'g']);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'dispatched', pid: 'none' });
  const out = JSON.parse(run(['board', REPO, '--json', '--no-git']));
  assert.equal(out.slices.length, 1);
  assert.equal(out.slices[0].terminal, false);
  assert.ok(out.slices[0].flags.some((f) => f.startsWith('NO OWNER')));
});

test('a corrupt ledger is surfaced, never silently overwritten', () => {
  const REPO = repo('corrupt-ledger');
  const p = run(['ledger', 'init', REPO, 'g']);
  writeFileSync(p, '{ this is not json');
  assert.match(runFail(['ledger', 'show', REPO]), /not valid JSON/);
  assert.ok(existsSync(p), 'left on disk for inspection');
});

// --- pane provenance -------------------------------------------------------
//
// These exist because of a run where five "dispatched" slices were never
// dispatched: the architect hand-rolled each builder with `herdr tab create
// --label <slug>` + `herdr agent start --tab <t> --split`, wrote the resulting
// pane ids into the ledger, and armed wait bridges that could never fire — no
// builder marker, no activity sidecar, no turn-end hook. Every row read
// "dispatched" while nothing on the other end could report back. dispatch.sh
// leaves a signature (tab labeled "builder", exactly one pane in it); the ledger
// now refuses a pane that does not carry it.

const FAKEBIN = join(BOX, 'fakebin');
mkdirSync(FAKEBIN, { recursive: true });
writeFileSync(join(FAKEBIN, 'herdr'), `#!/usr/bin/env bash
# FAKE_PANE_TAB="pane=tab;pane=tab"   FAKE_TAB_INFO="tab=label:pane_count;..."
lookup() { local kv k; for kv in \${1//;/ }; do k="\${kv%%=*}"; [ "$k" = "$2" ] && { printf '%s' "\${kv#*=}"; return 0; }; done; return 1; }
case "$1 $2" in
  "pane get")
    t=$(lookup "$FAKE_PANE_TAB" "$3") || { echo "no such pane" >&2; exit 1; }
    printf '{"result":{"pane":{"pane_id":"%s","tab_id":"%s"}},"type":"pane_info"}\\n' "$3" "$t" ;;
  "tab get")
    v=$(lookup "$FAKE_TAB_INFO" "$3") || { echo "no such tab" >&2; exit 1; }
    printf '{"result":{"tab":{"tab_id":"%s","label":"%s","pane_count":%s}},"type":"tab_info"}\\n' "$3" "\${v%%:*}" "\${v##*:}" ;;
  *) exit 2 ;;
esac
`);
chmodSync(join(FAKEBIN, 'herdr'), 0o755);

// A herdr session whose pane/tab topology is whatever the test declares.
const inHerdr = (panes, tabs, extra = {}) => ({
  env: {
    HERDR_ENV: '1',
    PATH: `${FAKEBIN}:${process.env.PATH}`,
    FAKE_PANE_TAB: Object.entries(panes).map(([k, v]) => `${k}=${v}`).join(';'),
    FAKE_TAB_INFO: Object.entries(tabs).map(([k, v]) => `${k}=${v}`).join(';'),
    ...extra,
  },
});

// dispatch.sh's own signature: one tab labeled "builder", holding one pane.
const DISPATCHED = inHerdr({ 'w1:p9': 'w1:t9' }, { 'w1:t9': 'builder:1' });
// The hand-rolled shape: the tab carries the slice's label and holds the empty
// root pane plus the split the agent was started in.
const HAND_ROLLED = inHerdr({ 'w1:p38': 'w1:t24' }, { 'w1:t24': 'multicol:2' });

test('ledger accepts a pane that carries dispatch.sh’s signature', () => {
  const REPO = repo('pane-ok');
  run(['ledger', 'init', REPO, 'g'], DISPATCHED);
  run(['ledger', 'add', REPO, '--id', '1', '--title', 't'], DISPATCHED);
  const s = JSON.parse(run(['ledger', 'set', REPO, '1', '--state', 'dispatched', '--pane', 'w1:p9'], DISPATCHED));
  assert.equal(s.pane, 'w1:p9');
});

test('ledger refuses a pane whose tab is not labeled "builder"', () => {
  const REPO = repo('pane-label');
  run(['ledger', 'init', REPO, 'g'], HAND_ROLLED);
  run(['ledger', 'add', REPO, '--id', '1', '--title', 't'], HAND_ROLLED);
  const err = runFail(['ledger', 'set', REPO, '1', '--pane', 'w1:p38'], HAND_ROLLED);
  assert.match(err, /refusing to record pane "w1:p38"/);
  assert.match(err, /labeled "multicol", not "builder"/);
  assert.equal(JSON.parse(run(['ledger', 'show', REPO], HAND_ROLLED)).slices[0].pane, '', 'nothing was written');
});

test('ledger refuses a pane in a builder tab that has been split', () => {
  const REPO = repo('pane-split');
  const SPLIT = inHerdr({ 'w1:p2': 'w1:t2' }, { 'w1:t2': 'builder:2' });
  run(['ledger', 'init', REPO, 'g'], SPLIT);
  run(['ledger', 'add', REPO, '--id', '1', '--title', 't'], SPLIT);
  assert.match(runFail(['ledger', 'set', REPO, '1', '--pane', 'w1:p2'], SPLIT), /holds 2 panes/);
});

test('ledger refuses a pane herdr has never heard of', () => {
  const REPO = repo('pane-ghost');
  run(['ledger', 'init', REPO, 'g'], DISPATCHED);
  run(['ledger', 'add', REPO, '--id', '1', '--title', 't'], DISPATCHED);
  assert.match(runFail(['ledger', 'set', REPO, '1', '--pane', 'w1:p404'], DISPATCHED), /does not know pane w1:p404/);
});

test('ledger add refuses an unverified pane too — not just set', () => {
  const REPO = repo('pane-add');
  run(['ledger', 'init', REPO, 'g'], HAND_ROLLED);
  assert.match(
    runFail(['ledger', 'add', REPO, '--id', '1', '--title', 't', '--pane', 'w1:p38'], HAND_ROLLED),
    /refusing to record pane/,
  );
});

test('OFFLOAD_ALLOW_UNVERIFIED_PANE is the deliberate override', () => {
  const REPO = repo('pane-override');
  const OVERRIDE = inHerdr({ 'w1:p38': 'w1:t24' }, { 'w1:t24': 'multicol:2' }, { OFFLOAD_ALLOW_UNVERIFIED_PANE: '1' });
  run(['ledger', 'init', REPO, 'g'], OVERRIDE);
  run(['ledger', 'add', REPO, '--id', '1', '--title', 't'], OVERRIDE);
  assert.equal(
    JSON.parse(run(['ledger', 'set', REPO, '1', '--pane', 'w1:p38'], OVERRIDE)).pane,
    'w1:p38',
  );
});

test('outside herdr a pane is unverifiable, not invalid', () => {
  const REPO = repo('pane-no-herdr');
  run(['ledger', 'init', REPO, 'g']);
  run(['ledger', 'add', REPO, '--id', '1', '--title', 't']);
  assert.equal(JSON.parse(run(['ledger', 'set', REPO, '1', '--pane', 'tmux:builder'])).pane, 'tmux:builder');
});

test('board flags a live slice whose pane never came from dispatch.sh', () => {
  const REPO = repo('pane-board');
  const OVERRIDE = inHerdr({ 'w1:p38': 'w1:t24' }, { 'w1:t24': 'multicol:2' }, { OFFLOAD_ALLOW_UNVERIFIED_PANE: '1' });
  run(['ledger', 'init', REPO, 'g'], OVERRIDE);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'dispatched', pid: process.pid });
  run(['ledger', 'set', REPO, '1', '--pane', 'w1:p38'], OVERRIDE);
  // Read the board WITHOUT the override: recording it is a choice, hiding it is not.
  const out = board(REPO, inHerdr({ 'w1:p38': 'w1:t24' }, { 'w1:t24': 'multicol:2' }));
  assert.match(out, /UNMANAGED PANE/);
  assert.match(out, /wait bridge can never fire/);
  assert.match(out, /1 needing attention/);
});

test('board leaves a terminal slice’s pane alone', () => {
  const REPO = repo('pane-board-terminal');
  const OVERRIDE = inHerdr({ 'w1:p38': 'w1:t24' }, { 'w1:t24': 'multicol:2' }, { OFFLOAD_ALLOW_UNVERIFIED_PANE: '1' });
  run(['ledger', 'init', REPO, 'g'], OVERRIDE);
  slice(REPO, '1', { state: 'accepted', docStatus: 'results-ready', pid: 'none' });
  run(['ledger', 'set', REPO, '1', '--pane', 'w1:p38'], OVERRIDE);
  assert.doesNotMatch(board(REPO, inHerdr({ 'w1:p38': 'w1:t24' }, { 'w1:t24': 'multicol:2' })), /UNMANAGED PANE/);
});

test('board --no-pane opts out of the provenance probe', () => {
  const REPO = repo('pane-board-off');
  const OVERRIDE = inHerdr({ 'w1:p38': 'w1:t24' }, { 'w1:t24': 'multicol:2' }, { OFFLOAD_ALLOW_UNVERIFIED_PANE: '1' });
  run(['ledger', 'init', REPO, 'g'], OVERRIDE);
  slice(REPO, '1', { state: 'dispatched', docStatus: 'dispatched', pid: process.pid });
  run(['ledger', 'set', REPO, '1', '--pane', 'w1:p38'], OVERRIDE);
  const out = run(['board', REPO, '--no-git', '--no-pane'], inHerdr({ 'w1:p38': 'w1:t24' }, { 'w1:t24': 'multicol:2' }));
  assert.doesNotMatch(out, /UNMANAGED PANE/);
});
