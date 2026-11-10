// test_dispatch_slice.mjs — one call from "block written" to "builder running".
//
// Dispatching a slice used to be eight to eleven separate architect turns:
// resolve the key, init the handoff, create the worktree, set Next slice, add
// the ledger row, run dispatch.sh, flip status, record the pane, arm the bridge.
// Each one was a full model round trip, and any of them could be skipped.
// dispatch-slice.sh does all of it deterministically and prints the one bridge
// command that still has to run in the architect's background. Correctives
// reuse the warm builder when it is still at its prompt instead of booting a
// fresh one.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLICE = join(HERE, 'dispatch-slice.sh');
const HANDOFF = join(HERE, 'handoff.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'ofl-ds-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const BIN = join(BOX, 'bin');
const LOG = join(BOX, 'calls.log');
mkdirSync(BIN, { recursive: true });
const stub = (name) => {
  const p = join(BIN, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${LOG}"\n`);
  chmodSync(p, 0o755);
};
['tmux', 'claude', 'codex', 'osascript'].forEach(stub);
writeFileSync(join(BIN, 'quota-axi'), '#!/usr/bin/env bash\nexit 1\n');
chmodSync(join(BIN, 'quota-axi'), 0o755);
// herdr: tab creation for dispatch.sh, pane/tab lookups for the ledger's pane
// check, and `pane run` for both the launch and the corrective send.
writeFileSync(join(BIN, 'herdr'), `#!/usr/bin/env bash
echo "herdr $*" >> "${LOG}"
case "$1 $2" in
  "tab create")
    if [ "\${HERDR_STUB_MODE:-ok}" = "fail-create" ]; then echo 'herdr: workspace wZ not found' >&2; exit 1; fi
    echo '{"result":{"root_pane":{"pane_id":"w9:p7","tab_id":"w9:t7","workspace_id":"w9"},"tab":{"tab_id":"w9:t7"},"type":"tab_created"}}' ;;
  "pane run") exit 0 ;;
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"w9:t7"}},"type":"pane_info"}\\n' "$3" ;;
  "tab get") printf '{"result":{"tab":{"tab_id":"%s","label":"builder","pane_count":1}},"type":"tab_info"}\\n' "$3" ;;
  "pane current") echo '{"result":{"pane":{"pane_id":"w5:p1","tab_id":"w5:t1","workspace_id":"w5"},"type":"pane_current"}}' ;;
esac
`);
chmodSync(join(BIN, 'herdr'), 0o755);

const TEST_PATH = `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin`;
const CONFIG = join(BOX, 'config.json');
writeFileSync(CONFIG, JSON.stringify({ dispatch: { rules: [{ when: 'test', use: [{ harness: 'claude' }], why: 'test' }] } }));

const BLOCK = join(BOX, 'block.md');
writeFileSync(BLOCK, 'Execute the nav slice in the worktree.\nAcceptance: 3 criteria.\n');
const FIX = join(BOX, 'fix.md');
writeFileSync(FIX, 'Corrective: blocker B1 token leak; blocker B2 missing test.\n');

// Hermetic: run-dir and round-cap settings from the architect that runs these tests must not leak in.
const AMBIENT_DROPPED = ['BORK_RUN_DIR', 'OFFLOAD_UNATTENDED_TURN', 'OFFLOAD_ROUND_CAP'];
const ambientEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !AMBIENT_DROPPED.includes(k)));
const env = (extra = {}) => ({
  ...ambientEnv(),
  AGENT_HANDOFFS_DIR: BOX, CLAUDE_CODE_SESSION_ID: 'arch', BORKWEB_SKILLS_CONFIG: CONFIG,
  HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', TMUX: '', PATH: TEST_PATH, ...extra,
});
const hoff = (args) => execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env: env() }).trim();
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

// A fresh repo per test so worktrees and ledgers never collide.
let n = 0;
function repo() {
  const r = join(BOX, `repo-${++n}`);
  mkdirSync(r, { recursive: true });
  git(r, ['init', '-q', '-b', 'main']);
  writeFileSync(join(r, 'README.md'), 'hi\n');
  git(r, ['add', '.']);
  git(r, ['commit', '-q', '-m', 'init']);
  return r;
}

const run = (args, extra = {}) => {
  rmSync(LOG, { force: true });
  const stdout = execFileSync('bash', [SLICE, ...args], { encoding: 'utf8', env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  try { log = readFileSync(LOG, 'utf8'); } catch {}
  return { stdout, log };
};
const runFail = (args, extra = {}) => {
  rmSync(LOG, { force: true });
  try {
    execFileSync('bash', [SLICE, ...args], { encoding: 'utf8', env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error('expected dispatch-slice to fail but it exited 0');
  } catch (e) {
    if (!('status' in e) || e.status === 0) throw e;
    let log = '';
    try { log = readFileSync(LOG, 'utf8'); } catch {}
    return { status: e.status, stderr: String(e.stderr || ''), stdout: String(e.stdout || ''), log };
  }
};
const status = (doc) => readFileSync(doc, 'utf8').match(/^status:\s*(.*)$/m)[1].trim();

test('usage: missing arguments exit 2 with a usage line', () => {
  const r = runFail([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: dispatch-slice\.sh/);
});

test('fresh slice: worktree, handoff, Next slice, dispatch, status, pane sidecar and the bridge line, in one call', () => {
  const R = repo();
  const WT = join(BOX, 'wt-fresh');
  const { stdout, log } = run([R, WT, 'feat/nav', BLOCK, '--title', 'nav links']);

  assert.ok(existsSync(join(WT, 'README.md')), 'worktree was created');
  assert.equal(git(WT, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/nav');

  const doc = hoff(['path', WT, 'arch']);
  assert.ok(existsSync(doc), 'handoff doc exists at the canonical path');
  assert.match(readFileSync(doc, 'utf8'), /## Next slice\n[\s\S]*Execute the nav slice/);
  assert.match(readFileSync(doc, 'utf8'), /^title: nav links$/m);
  assert.equal(status(doc), 'dispatched');

  assert.match(log, /^herdr tab create --workspace w3 .*--label builder/m);
  assert.match(log, /^herdr pane run w9:p7 bash \S+\.sh/m);
  const pane = readFileSync(`${doc}.pane`, 'utf8');
  assert.match(pane, /^frontend=herdr$/m);
  assert.match(pane, /^pane=w9:p7$/m);
  assert.match(pane, /^tab=w9:t7$/m);
  assert.match(pane, /^harness=claude$/m);

  assert.match(stdout, /new herdr tab w9:t7/);
  assert.match(stdout, /dispatch-slice: worktree .*wt-fresh on feat\/nav \(created\)/);
  assert.match(stdout, new RegExp(`^NEXT \\(background\\): WFR_BOARD_CWD="${R.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" bash "\\S+/complete/wait-for-ready\\.sh" "${doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" builder$`, 'm'));
});

test('with a ledger and --id, the row is added and marked dispatched with the verified pane', () => {
  const R = repo();
  const WT = join(BOX, 'wt-ledger');
  hoff(['ledger', 'init', R, 'ship nav']);
  run([R, WT, 'feat/nav', BLOCK, '--id', '3', '--title', 'nav links']);
  const l = JSON.parse(hoff(['ledger', 'show', R]));
  const s = l.slices.find((x) => x.id === '3');
  assert.ok(s, 'row 3 exists');
  assert.equal(s.state, 'dispatched');
  assert.equal(s.pane, 'w9:p7');
  assert.equal(s.branch, 'feat/nav');
  assert.equal(s.cwd, WT);
  assert.equal(s.handoff, hoff(['path', WT, 'arch']));
  assert.deepEqual(s.history.map((h) => h.state), ['specced', 'dispatched']);
});

test('a row specced earlier is updated, not duplicated', () => {
  const R = repo();
  const WT = join(BOX, 'wt-prespecced');
  hoff(['ledger', 'init', R, 'g']);
  hoff(['ledger', 'add', R, '--id', '1', '--title', 'pre', '--state', 'specced']);
  run([R, WT, 'feat/pre', BLOCK, '--id', '1']);
  const l = JSON.parse(hoff(['ledger', 'show', R]));
  assert.equal(l.slices.length, 1);
  assert.equal(l.slices[0].state, 'dispatched');
  assert.equal(l.slices[0].title, 'pre', 'title survives when --title is not given');
});

test('an existing worktree is reused (pre-warmed by the architect), not recreated', () => {
  const R = repo();
  const WT = join(BOX, 'wt-reuse');
  git(R, ['worktree', 'add', '-q', '-b', 'feat/warm', WT]);
  writeFileSync(join(WT, 'warm.marker'), 'installed\n');
  const { stdout } = run([R, WT, 'feat/warm', BLOCK]);
  assert.ok(existsSync(join(WT, 'warm.marker')), 'worktree contents untouched');
  assert.match(stdout, /\(reused\)/);
});

test('a failed launch leaves status specced, the ledger row specced, and prints no bridge line', () => {
  const R = repo();
  const WT = join(BOX, 'wt-fail');
  hoff(['ledger', 'init', R, 'g']);
  const r = runFail([R, WT, 'feat/fail', BLOCK, '--id', '7'], { HERDR_STUB_MODE: 'fail-create' });
  assert.notEqual(r.status, 0);
  const doc = hoff(['path', WT, 'arch']);
  assert.equal(status(doc), 'specced');
  assert.equal(JSON.parse(hoff(['ledger', 'show', R])).slices[0].state, 'specced');
  assert.doesNotMatch(r.stdout, /^NEXT/m);
  assert.match(r.stderr, /FAILED to open a herdr tab/);
});

test('corrective into a warm builder: no new tab, the brief goes into the pane, status flips back to dispatched', () => {
  const R = repo();
  const WT = join(BOX, 'wt-warm');
  hoff(['ledger', 'init', R, 'g']);
  run([R, WT, 'feat/warm2', BLOCK, '--id', '2', '--title', 'auth']);
  const doc = hoff(['path', WT, 'arch']);
  // The builder finished and reported; its process is still at the prompt.
  writeFileSync(`${doc}.builder`, `${process.pid}\n`);
  hoff(['status', doc, 'results-ready']);
  hoff(['ledger', 'set', R, '2', '--state', 'rejected', '--verdict', 'review = do not land: token leak (unnamed)']);

  const { stdout, log } = run([R, WT, 'feat/warm2', FIX, '--id', '2', '--corrective']);
  assert.doesNotMatch(log, /tab create/, 'no second builder was launched');
  assert.match(log, /^herdr pane run w9:p7 .*Next slice/m, 'the corrective was typed into the warm pane');
  assert.match(readFileSync(doc, 'utf8'), /## Next slice\n[\s\S]*blocker B1 token leak/);
  assert.equal(status(doc), 'dispatched');
  assert.match(stdout, /dispatch-slice: corrective sent into herdr pane w9:p7 \(warm builder pid \d+\)/);
  assert.match(stdout, /^NEXT \(background\)/m, 'the bridge still has to be re-armed');
  const s = JSON.parse(hoff(['ledger', 'show', R])).slices[0];
  assert.equal(s.state, 'dispatched');
  assert.equal(s.pane, 'w9:p7');
});

test('corrective after results records the rejection with its verdict; a follow-up after acceptance does not', () => {
  // Architects sent most correctives straight from results-ready, so the
  // ledger never held a rejection: a DO NOT LAND with two criticals read as
  // zero rejections in the run report.
  const R = repo();
  const WT = join(BOX, 'wt-verdict');
  hoff(['ledger', 'init', R, 'g']);
  run([R, WT, 'feat/verdict', BLOCK, '--id', '4', '--title', 'sort']);
  const doc = hoff(['path', WT, 'arch']);
  writeFileSync(`${doc}.builder`, `${process.pid}\n`);
  hoff(['status', doc, 'results-ready']);
  hoff(['ledger', 'set', R, '4', '--state', 'results-ready']);
  run([R, WT, 'feat/verdict', FIX, '--id', '4', '--corrective', '--verdict', 'gates green; review = DO NOT LAND: drag bug (named C3)']);
  let s = JSON.parse(hoff(['ledger', 'show', R])).slices[0];
  assert.deepEqual(s.history.map((h) => h.state), ['specced', 'dispatched', 'results-ready', 'rejected', 'dispatched']);
  assert.equal(s.history[3].verdict, 'gates green; review = DO NOT LAND: drag bug (named C3)');

  hoff(['ledger', 'set', R, '4', '--state', 'accepted', '--verdict', 'SAFE TO LAND']);
  run([R, WT, 'feat/verdict', FIX, '--id', '4', '--corrective']);
  s = JSON.parse(hoff(['ledger', 'show', R])).slices[0];
  assert.deepEqual(s.history.slice(-2).map((h) => h.state), ['accepted', 'dispatched'], 'a follow-up is not a rejection');
});

test('corrective from unjudged results without a verdict is refused and leaves the brief alone', () => {
  // A rejection with no verdict cannot be classified by the dreaming pass over
  // review-criteria.md; refuse it before the builder's brief changes.
  const R = repo();
  const WT = join(BOX, 'wt-noverdict');
  hoff(['ledger', 'init', R, 'g']);
  run([R, WT, 'feat/noverdict', BLOCK, '--id', '5', '--title', 'nv']);
  const doc = hoff(['path', WT, 'arch']);
  hoff(['status', doc, 'results-ready']);
  hoff(['ledger', 'set', R, '5', '--state', 'results-ready']);
  const before = hoff(['section', 'get', doc, 'Next slice']);
  let r = runFail([R, WT, 'feat/noverdict', FIX, '--id', '5', '--corrective']);
  assert.match(r.stderr, /without --verdict/);
  r = runFail([R, WT, 'feat/noverdict', FIX, '--id', '5', '--corrective', '--verdict', 'review = DO NOT LAND: race']);
  assert.match(r.stderr, /provenance tag/);
  assert.equal(hoff(['section', 'get', doc, 'Next slice']), before, 'a refused corrective leaves Next slice as it was');
  assert.equal(JSON.parse(hoff(['ledger', 'show', R])).slices[0].state, 'results-ready');
});

test('round cap: a 4th rejected round needs the user\'s --past-cap ruling, which the ledger keeps', () => {
  const R = repo();
  const WT = join(BOX, 'wt-cap');
  hoff(['ledger', 'init', R, 'g']);
  run([R, WT, 'feat/cap', BLOCK, '--id', '6', '--title', 'cap']);
  const doc = hoff(['path', WT, 'arch']);
  for (let i = 1; i <= 3; i++) {
    hoff(['ledger', 'set', R, '6', '--state', 'results-ready']);
    run([R, WT, 'feat/cap', FIX, '--id', '6', '--corrective', '--verdict', `g${i} failed`]);
  }
  hoff(['ledger', 'set', R, '6', '--state', 'results-ready']);
  const before = hoff(['section', 'get', doc, 'Next slice']);
  const r = runFail([R, WT, 'feat/cap', FIX, '--id', '6', '--corrective', '--verdict', 'g4 failed']);
  assert.match(r.stderr, /rejected 4 times \(cap 3\)/);
  assert.match(r.stderr, /--past-cap/);
  assert.equal(hoff(['section', 'get', doc, 'Next slice']), before, 'nothing was sent past the cap');
  const un = runFail([R, WT, 'feat/cap', FIX, '--id', '6', '--corrective', '--past-cap', 'self-granted'], { OFFLOAD_UNATTENDED_TURN: '1' });
  assert.match(un.stderr, /unattended wake: --past-cap needs the user's own ruling/);
  assert.equal(hoff(['section', 'get', doc, 'Next slice']), before, 'an unattended wake cannot grant itself another round');
  run([R, WT, 'feat/cap', FIX, '--id', '6', '--corrective', '--past-cap', 'user: one more round, then abandon']);
  const s = JSON.parse(hoff(['ledger', 'show', R])).slices[0];
  assert.match(s.note, /past round cap \(4 > 3\): user: one more round/);
  assert.equal(s.state, 'dispatched');
});

test('a returned send-back (missing Loosened tests line) costs no rejection and no round', () => {
  const R = repo();
  const WT = join(BOX, 'wt-returned');
  hoff(['ledger', 'init', R, 'g']);
  run([R, WT, 'feat/returned', BLOCK, '--id', '8', '--title', 'ret']);
  hoff(['ledger', 'set', R, '8', '--state', 'results-ready']);
  hoff(['ledger', 'set', R, '8', '--state', 'returned']);
  run([R, WT, 'feat/returned', FIX, '--id', '8', '--corrective']);
  const s = JSON.parse(hoff(['ledger', 'show', R])).slices[0];
  assert.equal(s.history.filter((h) => h.state === 'rejected').length, 0);
  assert.equal(s.state, 'dispatched');
});

test('halt refuses every dispatch until unhalt', () => {
  const R = repo();
  hoff(['halt', R, 'user said stop']);
  const r = runFail([R, join(BOX, 'wt-halted'), 'feat/halted', BLOCK, '--id', '1']);
  assert.match(r.stderr, /halted \(user said stop\); nothing was dispatched/);
  hoff(['unhalt', R]);
  run([R, join(BOX, 'wt-halted'), 'feat/halted', BLOCK, '--id', '1']);
});

test('corrective when the builder is gone: re-dispatch cold and say so', () => {
  const R = repo();
  const WT = join(BOX, 'wt-cold');
  run([R, WT, 'feat/cold', BLOCK, '--title', 'cold']);
  const doc = hoff(['path', WT, 'arch']);
  rmSync(`${doc}.builder`, { force: true }); // builder exited
  hoff(['status', doc, 'results-ready']);
  // Declared change (spec v2 section 5): a one-slice run has a ledger row now, so
  // the corrective carries --verdict and the rejection lands in the row's history.
  const { stdout, log } = run([R, WT, 'feat/cold', FIX, '--corrective', '--verdict', 'g2 failed 3/5']);
  assert.match(stdout, /dispatch-slice: builder gone .*re-dispatching cold/);
  assert.match(log, /tab create/, 'a fresh builder was launched');
  assert.equal(status(doc), 'dispatched');
  assert.match(readFileSync(doc, 'utf8'), /blocker B1 token leak/);
  const rejected = JSON.parse(hoff(['ledger', 'show', R])).slices[0].history.find((h) => h.state === 'rejected');
  assert.equal(rejected?.verdict, 'g2 failed 3/5');
});

// --- one-slice runs: the ledger is created and the id is picked by the script ---

const ledger = (R) => JSON.parse(hoff(['ledger', 'show', R]));
const row = (R, id) => ledger(R).slices.find((s) => s.id === id);
const ledgerExists = (R) => existsSync(hoff(['ledger', 'path', R]));

test('one-slice dispatch with no ledger creates the ledger, the row and the run-dir link', () => {
  const R = repo();
  const WT = join(BOX, 'wt-one');
  const runDir = join(BOX, 'run-one');
  mkdirSync(runDir);
  run([R, WT, 'feat/one', BLOCK, '--title', 'nav links'], { BORK_RUN_DIR: runDir });
  const l = ledger(R);
  assert.equal(l.goal, 'nav links', 'the goal is the --title');
  assert.equal(l.run_dir, runDir, 'BORK_RUN_DIR is linked when the dir exists');
  assert.equal(l.slices.length, 1);
  const s = l.slices[0];
  assert.equal(s.id, '1');
  assert.equal(s.state, 'dispatched');
  assert.equal(s.pane, 'w9:p7');
  assert.equal(s.handoff, hoff(['path', WT, 'arch']));
});

test('the ledger goal is the block heading when there is no --title', () => {
  const R = repo();
  const headed = join(BOX, 'headed.md');
  writeFileSync(headed, '\n# Builder brief, slice Z\n\nDo the thing.\n');
  run([R, join(BOX, 'wt-heading'), 'feat/heading', headed]);
  assert.equal(ledger(R).goal, 'Builder brief, slice Z');
});

test('--run-dir wins over BORK_RUN_DIR; a missing BORK_RUN_DIR is ignored', () => {
  const win = repo();
  const a = join(BOX, 'run-a'); const b = join(BOX, 'run-b');
  mkdirSync(a); mkdirSync(b);
  run([win, join(BOX, 'wt-rd1'), 'feat/rd1', BLOCK, '--title', 't', '--run-dir', a], { BORK_RUN_DIR: b });
  assert.equal(ledger(win).run_dir, a);

  const env = repo();
  run([env, join(BOX, 'wt-rd2'), 'feat/rd2', BLOCK, '--title', 't'], { BORK_RUN_DIR: b });
  assert.equal(ledger(env).run_dir, b, 'BORK_RUN_DIR alone is used when it exists');

  const gone = repo();
  const r = run([gone, join(BOX, 'wt-rd3'), 'feat/rd3', BLOCK, '--title', 't'], { BORK_RUN_DIR: join(BOX, 'no-such-run') });
  assert.match(r.stdout, /^NEXT/m, 'the dispatch still succeeds');
  assert.equal(ledger(gone).run_dir, '', 'a BORK_RUN_DIR that does not exist is not linked');
});

test('a relative --run-dir is refused with exit 2 before anything is created or sent', () => {
  const R = repo();
  const WT = join(BOX, 'wt-relrd');
  const r = runFail([R, WT, 'feat/relrd', BLOCK, '--title', 't', '--run-dir', 'runs/x']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs an absolute path/);
  assert.ok(!existsSync(WT), 'no worktree');
  assert.ok(!ledgerExists(R), 'no ledger');
  assert.doesNotMatch(r.log, /tab create/);
});

test('a reused worktree with a terminal row gets a new id', () => {
  const R = repo();
  const WT = join(BOX, 'wt-terminal');
  hoff(['ledger', 'init', R, 'g']);
  const doc = hoff(['path', WT, 'arch']); // the handoff path is fixed per worktree
  for (const [id, state] of [['1', 'accepted'], ['1b', 'accepted'], ['3', 'abandoned']]) {
    hoff(['ledger', 'add', R, '--id', id, '--title', id, '--handoff', doc, '--state', state]);
  }
  git(R, ['worktree', 'add', '-q', '-b', 'feat/terminal', WT]);
  const before = ledger(R).slices.map((s) => ({ id: s.id, state: s.state, history: s.history }));
  run([R, WT, 'feat/terminal', BLOCK, '--title', 'again']);
  const after = ledger(R).slices;
  assert.equal(after.length, 4);
  assert.equal(after[3].id, '4', 'max(integer ids) + 1, ignoring 1b');
  assert.equal(after[3].state, 'dispatched');
  assert.deepEqual(after.slice(0, 3).map((s) => ({ id: s.id, state: s.state, history: s.history })), before, 'terminal rows are untouched');
});

test('without --id a fresh dispatch reuses the newest non-terminal row for this handoff', () => {
  const R = repo();
  const WT = join(BOX, 'wt-reuserow');
  hoff(['ledger', 'init', R, 'g']);
  const doc = hoff(['path', WT, 'arch']);
  hoff(['ledger', 'add', R, '--id', '1', '--title', 'old', '--handoff', doc, '--state', 'specced']);
  hoff(['ledger', 'add', R, '--id', '2', '--title', 'new', '--handoff', doc, '--state', 'specced']);
  git(R, ['worktree', 'add', '-q', '-b', 'feat/reuserow', WT]);
  run([R, WT, 'feat/reuserow', BLOCK]);
  const l = ledger(R);
  assert.equal(l.slices.length, 2, 'no row was added');
  assert.equal(l.slices.find((s) => s.id === '2').state, 'dispatched');
  assert.equal(l.slices.find((s) => s.id === '1').state, 'specced');
});

// --- one-slice correctives: --verdict without --id ---

// Dispatch once (row 1, dispatched) and mark the builder's results in.
function reported(branch) {
  const R = repo();
  const WT = join(BOX, `wt-${branch.replace('/', '-')}`);
  run([R, WT, branch, BLOCK, '--title', 'one']);
  const doc = hoff(['path', WT, 'arch']);
  writeFileSync(`${doc}.builder`, `${process.pid}\n`);
  hoff(['status', doc, 'results-ready']);
  hoff(['ledger', 'set', R, '1', '--state', 'results-ready']);
  return { R, WT, doc };
}

test('a one-slice corrective records --verdict', () => {
  const { R, WT } = reported('feat/c1');
  run([R, WT, 'feat/c1', FIX, '--corrective', '--verdict', 'gates green; review = DO NOT LAND: drag bug (named C3)']);
  const s = row(R, '1');
  assert.deepEqual(s.history.map((h) => h.state), ['specced', 'dispatched', 'results-ready', 'rejected', 'dispatched']);
  assert.equal(s.history[3].verdict, 'gates green; review = DO NOT LAND: drag bug (named C3)');
});

test('a corrective without --id applies to the most recently updated row with this handoff', () => {
  const R = repo();
  const WT = join(BOX, 'wt-recent');
  git(R, ['worktree', 'add', '-q', '-b', 'feat/x', WT]);
  hoff(['ledger', 'init', R, 'g']);
  const doc = hoff(['init', WT, 'arch', 'x']);
  hoff(['status', doc, 'results-ready']);
  hoff(['ledger', 'add', R, '--id', '1', '--handoff', doc, '--state', 'results-ready']);
  hoff(['ledger', 'add', R, '--id', '2', '--handoff', doc, '--state', 'results-ready']);
  hoff(['ledger', 'set', R, '1', '--note', 'touched last']); // row 1 is the newest by updated
  run([R, WT, 'feat/x', FIX, '--corrective', '--verdict', 'g2 failed 1/5']);
  assert.equal(row(R, '1').history.at(-2).state, 'rejected');
  assert.equal(row(R, '2').state, 'results-ready', 'the other row is untouched');
});

test('a corrective for a pre-ledger slice adds a row from the doc status, then records the verdict', () => {
  const R = repo();
  const WT = join(BOX, 'wt-backfill');
  git(R, ['worktree', 'add', '-q', '-b', 'feat/backfill', WT]);
  const doc = hoff(['init', WT, 'arch', 'old slice']);
  hoff(['status', doc, 'results-ready']);
  assert.ok(!ledgerExists(R), 'no ledger yet');
  run([R, WT, 'feat/backfill', FIX, '--corrective', '--verdict', 'g3 failed 2/4']);
  const s = row(R, '1');
  assert.equal(s.handoff, doc);
  assert.deepEqual(s.history.map((h) => h.state), ['results-ready', 'rejected', 'dispatched']);
  assert.equal(s.history[1].verdict, 'g3 failed 2/4');
});

test('an unrecordable verdict exits non-zero and sends nothing', () => {
  const { R, WT, doc } = reported('feat/c2');
  const before = hoff(['section', 'get', doc, 'Next slice']);
  const r = runFail([R, WT, 'feat/c2', FIX, '--corrective', '--verdict', 'review = DO NOT LAND: race']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /provenance tag/);
  assert.doesNotMatch(r.log, /pane run|tab create/);
  assert.equal(hoff(['section', 'get', doc, 'Next slice']), before);
  assert.equal(row(R, '1').state, 'results-ready');
});

// Declared change (decisions.md 10): `rejected` left this table. A verdict on an
// already rejected row is recorded as a note, not refused (see below). The other
// states exit 2 with or without --id.
for (const state of ['accepted', 'returned', 'specced', 'blocked', 'merged', 'abandoned']) {
  for (const idArgs of [[], ['--id', '1']]) {
    test(`--verdict on ${state === 'accepted' ? 'an accepted' : `a ${state}`} row exits 2 and sends nothing${idArgs.length ? ' (with --id)' : ''}`, () => {
      const { R, WT, doc } = reported(`feat/v-${state}${idArgs.length ? '-id' : ''}`);
      hoff(['ledger', 'set', R, '1', '--state', state]);
      const before = hoff(['section', 'get', doc, 'Next slice']);
      const r = runFail([R, WT, `feat/v-${state}${idArgs.length ? '-id' : ''}`, FIX, '--corrective', ...idArgs, '--verdict', 'g2 failed 3/5']);
      assert.equal(r.status, 2);
      assert.match(r.stderr, new RegExp(`\\b${state}\\b`));
      assert.doesNotMatch(r.log, /pane run|tab create/);
      assert.equal(hoff(['section', 'get', doc, 'Next slice']), before);
      assert.equal(row(R, '1').state, state);
    });
  }
}

// --- an already rejected row (decisions.md 10) ---
//
// complete's documented sequence sets `rejected` first and then sends the
// corrective with --verdict; the --past-cap retry repeats the same command on a
// row the refused first call already rejected. Both must go through, with the
// verdict kept as a note and no second rejection.
const rejectedRow = (branch, idArgs) => {
  const R = repo();
  const WT = join(BOX, `wt-${branch.replace('/', '-')}`);
  hoff(['ledger', 'init', R, 'g']);
  run([R, WT, branch, BLOCK, '--title', 'rj', ...idArgs]);
  const doc = hoff(['path', WT, 'arch']);
  writeFileSync(`${doc}.builder`, `${process.pid}\n`);
  hoff(['status', doc, 'results-ready']);
  const id = idArgs[1] ?? '1';
  hoff(['ledger', 'set', R, id, '--state', 'rejected', '--verdict', 'g1 failed 2/5']);
  return { R, WT, id };
};
for (const idArgs of [['--id', '2'], []]) {
  test(`--verdict on a rejected row is kept as a note and sends, ${idArgs.length ? 'with' : 'without'} --id`, () => {
    const branch = `feat/rj${idArgs.length ? '-id' : ''}`;
    const { R, WT, id } = rejectedRow(branch, idArgs);
    const { log } = run([R, WT, branch, FIX, '--corrective', ...idArgs, '--verdict', 'g2 failed again 3/5']);
    assert.match(log, /^herdr pane run w9:p7 .*Next slice/m, 'the corrective was sent');
    const s = row(R, id);
    assert.equal(s.history.filter((h) => h.state === 'rejected').length, 1, 'no second rejection');
    assert.match(s.note, /g2 failed again 3\/5/, 'the verdict is kept as the note');
    assert.equal(s.state, 'dispatched');
  });
}

test('a round-cap refusal re-run with the same --verdict plus --past-cap succeeds', () => {
  const R = repo();
  const WT = join(BOX, 'wt-capretry');
  hoff(['ledger', 'init', R, 'g']);
  run([R, WT, 'feat/capretry', BLOCK, '--id', '6', '--title', 'cap']);
  for (let i = 1; i <= 3; i++) {
    hoff(['ledger', 'set', R, '6', '--state', 'results-ready']);
    run([R, WT, 'feat/capretry', FIX, '--id', '6', '--corrective', '--verdict', `g${i} failed`]);
  }
  hoff(['ledger', 'set', R, '6', '--state', 'results-ready']);
  const args = [R, WT, 'feat/capretry', FIX, '--id', '6', '--corrective', '--verdict', 'g4 failed'];
  const refused = runFail(args);
  assert.match(refused.stderr, /rejected 4 times \(cap 3\)/);
  assert.equal(row(R, '6').state, 'rejected', 'the refused call already recorded the rejection');
  run([...args, '--past-cap', 'user: one more round']);
  const s = row(R, '6');
  assert.equal(s.state, 'dispatched');
  assert.equal(s.history.filter((h) => h.state === 'rejected').length, 4, 'the retry adds no fifth rejection');
  assert.match(s.note, /past round cap \(4 > 3\): user: one more round/, 'the ruling is in the note');
  assert.match(s.note, /corrective verdict: g4 failed/, 'and the verdict is not replaced by it');
});

test('an ambient OFFLOAD_ROUND_CAP and OFFLOAD_UNATTENDED_TURN do not reach the dispatch tests', () => {
  const saved = { cap: process.env.OFFLOAD_ROUND_CAP, un: process.env.OFFLOAD_UNATTENDED_TURN };
  process.env.OFFLOAD_ROUND_CAP = '0';
  process.env.OFFLOAD_UNATTENDED_TURN = '1';
  try {
    const R = repo();
    const WT = join(BOX, 'wt-ambientcap');
    hoff(['ledger', 'init', R, 'g']);
    run([R, WT, 'feat/ambientcap', BLOCK, '--id', '9', '--title', 'cap']);
    for (let i = 1; i <= 3; i++) { // a leaked cap of 0 would refuse the first of these
      hoff(['ledger', 'set', R, '9', '--state', 'results-ready']);
      run([R, WT, 'feat/ambientcap', FIX, '--id', '9', '--corrective', '--verdict', `g${i} failed`]);
    }
    hoff(['ledger', 'set', R, '9', '--state', 'results-ready']);
    const args = [R, WT, 'feat/ambientcap', FIX, '--id', '9', '--corrective', '--verdict', 'g4 failed'];
    assert.match(runFail(args).stderr, /rejected 4 times \(cap 3\)/);
    run([...args, '--past-cap', 'user: one more']); // a leaked unattended marker would refuse this
    assert.equal(row(R, '9').state, 'dispatched');
  } finally {
    for (const [k, v] of [['OFFLOAD_ROUND_CAP', saved.cap], ['OFFLOAD_UNATTENDED_TURN', saved.un]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// --- argument parsing, ledger-less correctives and BORK_RUN_DIR hygiene ---

for (const flag of ['--id', '--title', '--base', '--harness', '--run-dir', '--verdict', '--past-cap']) {
  test(`${flag} as the last argument exits 2 with a usage line instead of looping`, () => {
    const r = spawnSync('bash', [SLICE, join(BOX, 'r'), join(BOX, 'w'), 'b', BLOCK, flag], { encoding: 'utf8', env: env(), timeout: 10000 });
    assert.equal(r.status, 2, `status ${r.status} signal ${r.signal}`);
    assert.match(r.stderr, new RegExp(`${flag} needs a value`));
    assert.match(r.stderr, /Usage: dispatch-slice\.sh/);
  });
}

test('a corrective with --id and no session ledger opens one and records the verdict', () => {
  const R = repo();
  const WT = join(BOX, 'wt-idnoledger');
  git(R, ['worktree', 'add', '-q', '-b', 'feat/idnoledger', WT]);
  const doc = hoff(['init', WT, 'arch', 'old slice']);
  hoff(['status', doc, 'results-ready']);
  assert.ok(!ledgerExists(R), 'no ledger yet');
  run([R, WT, 'feat/idnoledger', FIX, '--corrective', '--id', '5', '--verdict', 'g3 failed 2/4']);
  const s = row(R, '5');
  assert.deepEqual(s.history.map((h) => h.state), ['results-ready', 'rejected', 'dispatched']);
  assert.equal(s.history[1].verdict, 'g3 failed 2/4', 'the verdict was recorded, not dropped');
});

test('a BORK_RUN_DIR whose run.json is done or failed is not linked; a running one is', () => {
  const link = (state) => {
    const d = join(BOX, `run-${state}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'run.json'), JSON.stringify({ schema: 1, state }));
    const R = repo();
    run([R, join(BOX, `wt-rd-${state}`), `feat/rd-${state}`, BLOCK, '--title', 't'], { BORK_RUN_DIR: d });
    return [ledger(R).run_dir, d];
  };
  for (const state of ['done', 'failed']) assert.equal(link(state)[0], '', `${state} run is skipped`);
  const [linked, dir] = link('running');
  assert.equal(linked, dir);
});

test('the dispatch tests ignore an ambient BORK_RUN_DIR', () => {
  const d = join(BOX, 'run-ambient');
  mkdirSync(d, { recursive: true });
  process.env.BORK_RUN_DIR = d;
  try {
    const R = repo();
    run([R, join(BOX, 'wt-ambient'), 'feat/ambient', BLOCK, '--title', 't']);
    assert.equal(ledger(R).run_dir, '');
  } finally { delete process.env.BORK_RUN_DIR; }
});

test('the usage line and header document --run-dir and the one-call-without---id limit', () => {
  const r = runFail([]);
  assert.match(r.stderr, /--run-dir/);
  const src = readFileSync(SLICE, 'utf8');
  assert.match(src, /without --id/);
});

test('corrective without a prior handoff is refused', () => {
  const R = repo();
  const r = runFail([R, join(BOX, 'wt-never'), 'feat/never', FIX, '--corrective']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no handoff/);
});

// --- unattended -------------------------------------------------------------
//
// A detached bridge + architect-wake chain instead of the NEXT line, so the run
// continues after the interactive session is gone. The chain is real; the
// `claude` it resumes is the stub, which logs its argv.
test('--unattended arms a detached wake that resumes this architect session when the bridge fires', async () => {
  const R = repo();
  const WT = join(BOX, 'wt-unattended');
  const wakeEnv = { WFR_GRACE: '2', WFR_POLL: '1' };
  const { stdout } = run([R, WT, 'feat/un', BLOCK, '--title', 'un', '--unattended'], wakeEnv);
  assert.match(stdout, /^UNATTENDED: bridge and architect wake armed \(pid \d+\); log \S+\.wake\.log$/m);
  assert.doesNotMatch(stdout, /^NEXT/m);
  const doc = hoff(['path', WT, 'arch']);
  // No builder marker exists (the stubbed pane never ran the launch script), so
  // the bridge reports never-started after the grace period and the wake fires.
  const deadline = Date.now() + 20000;
  let log = '';
  while (Date.now() < deadline) {
    try { log = readFileSync(LOG, 'utf8'); } catch {}
    if (/^claude -p --resume arch /m.test(log)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.match(log, /^claude -p --resume arch --permission-mode auto/m, 'the architect session was resumed headlessly');
  assert.match(log, /--strict-mcp-config/);
  assert.match(log, /\[unattended wake\]/);
  assert.match(log, /WAITER: never-started/);
  assert.match(log, /--unattended/, 'the wake prompt keeps the run in unattended mode');
  const wakeLog = readFileSync(`${doc}.wake.log`, 'utf8');
  assert.match(wakeLog, /bridge exited 3/);
  assert.match(wakeLog, /architect turn finished/);
});

test('--unattended refuses a Codex architect, which cannot be resumed with claude', () => {
  const R = repo();
  const r = runFail([R, join(BOX, 'wt-codex'), 'feat/c', BLOCK, '--unattended'],
    { CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: '0199-codex' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Codex architect/);
});
