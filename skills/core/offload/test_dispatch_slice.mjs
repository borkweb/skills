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
import { execFileSync } from 'node:child_process';
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

const env = (extra = {}) => ({
  ...process.env,
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
  hoff(['ledger', 'set', R, '2', '--state', 'rejected', '--verdict', 'review = do not land: token leak']);

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
  run([R, WT, 'feat/verdict', FIX, '--id', '4', '--corrective', '--verdict', 'gates green; review = DO NOT LAND: drag bug']);
  let s = JSON.parse(hoff(['ledger', 'show', R])).slices[0];
  assert.deepEqual(s.history.map((h) => h.state), ['specced', 'dispatched', 'results-ready', 'rejected', 'dispatched']);
  assert.equal(s.history[3].verdict, 'gates green; review = DO NOT LAND: drag bug');

  hoff(['ledger', 'set', R, '4', '--state', 'accepted', '--verdict', 'SAFE TO LAND']);
  run([R, WT, 'feat/verdict', FIX, '--id', '4', '--corrective']);
  s = JSON.parse(hoff(['ledger', 'show', R])).slices[0];
  assert.deepEqual(s.history.slice(-2).map((h) => h.state), ['accepted', 'dispatched'], 'a follow-up is not a rejection');
});

test('corrective when the builder is gone: re-dispatch cold and say so', () => {
  const R = repo();
  const WT = join(BOX, 'wt-cold');
  run([R, WT, 'feat/cold', BLOCK, '--title', 'cold']);
  const doc = hoff(['path', WT, 'arch']);
  rmSync(`${doc}.builder`, { force: true }); // builder exited
  hoff(['status', doc, 'results-ready']);
  const { stdout, log } = run([R, WT, 'feat/cold', FIX, '--corrective']);
  assert.match(stdout, /dispatch-slice: builder gone .*re-dispatching cold/);
  assert.match(log, /tab create/, 'a fresh builder was launched');
  assert.equal(status(doc), 'dispatched');
  assert.match(readFileSync(doc, 'utf8'), /blocker B1 token leak/);
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
