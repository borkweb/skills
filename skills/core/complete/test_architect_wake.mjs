// test_architect_wake.mjs — the detached wake resumes the right session with the
// bridge's output, and fails loudly rather than silently when it cannot.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAKE = join(HERE, 'architect-wake.sh');
const UNATTENDED = join(HERE, 'unattended.sh');
const HANDOFF = join(HERE, '..', 'offload', 'handoff.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'ofl-wake-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));
const BIN = join(BOX, 'bin');
const LOG = join(BOX, 'claude.log');
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, 'claude'), `#!/usr/bin/env bash\necho "claude $*" >> "${LOG}"\n[ "\${CLAUDE_STUB_FAIL:-}" = 1 ] && { echo 'Session is already running' >&2; exit 1; }\necho "turn done"\n`);
chmodSync(join(BIN, 'claude'), 0o755);
const env = (extra = {}) => ({
  ...process.env, AGENT_HANDOFFS_DIR: BOX, CLAUDE_CODE_SESSION_ID: 'arch-7', HERDR_ENV: '',
  PATH: `${BIN}:${dirname(NODE)}:/usr/bin:/bin`, WFR_GRACE: '2', WFR_POLL: '1', ...extra,
});
const hoff = (args) => execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env: env() }).trim();
const REPO = join(BOX, 'repo'); mkdirSync(REPO);

test('the wake runs the bridge, then resumes the architect session with the WAITER output as its prompt', () => {
  rmSync(LOG, { force: true });
  const wt = join(BOX, 'wt-1');
  const doc = hoff(['init', wt, 'arch-7', 'slice one']);
  writeFileSync(`${doc}.builder`, `${process.pid}\n`);
  hoff(['ledger', 'init', REPO, 'goal']);
  hoff(['ledger', 'add', REPO, '--id', '1', '--title', 'slice one', '--handoff', doc, '--slice-cwd', wt, '--state', 'dispatched']);
  // The builder has already reported: the bridge's first check returns ready.
  // (spawnSync blocks the event loop, so a timer could not flip it mid-wait.)
  hoff(['status', doc, 'results-ready']);
  const r = spawnSync('bash', [WAKE, REPO, doc, 'arch-7'], { encoding: 'utf8', env: env() });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(LOG, 'utf8');
  assert.match(log, /^claude -p --resume arch-7 --permission-mode auto --strict-mcp-config --mcp-config \S+ --output-format text \[unattended wake\]/m);
  assert.match(log, /WAITER: ready/);
  assert.match(log, /BOARD\s+goal/, 'the board travels with the wake');
  assert.match(log, /Each wake/);
  const wakeLog = readFileSync(`${doc}.wake.log`, 'utf8');
  assert.match(wakeLog, /bridge exited 0/);
  assert.match(wakeLog, /architect turn finished/);
});

test('a refused resume is logged and exits non-zero instead of pretending the turn ran', () => {
  const wt = join(BOX, 'wt-2');
  const doc = hoff(['init', wt, 'arch-7', 'slice two']);
  hoff(['status', doc, 'results-ready']);
  const r = spawnSync('bash', [WAKE, REPO, doc, 'arch-7'], { encoding: 'utf8', env: env({ CLAUDE_STUB_FAIL: '1' }) });
  assert.notEqual(r.status, 0);
  assert.match(readFileSync(`${doc}.wake.log`, 'utf8'), /claude --resume arch-7 failed \(exit 1\)/);
});

test('a Codex architect is refused up front', () => {
  const r = spawnSync('bash', [WAKE, REPO, join(BOX, 'x.md'), 'codex:abc'], { encoding: 'utf8', env: env() });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Claude architect session/);
});

test('OFFLOAD_WAKE_PERMISSIONS=bypass is the explicit opt-in to skip permissions', () => {
  rmSync(LOG, { force: true });
  const wt = join(BOX, 'wt-bypass');
  const doc = hoff(['init', wt, 'arch-7', 'slice bypass']);
  hoff(['status', doc, 'results-ready']);
  spawnSync('bash', [WAKE, REPO, doc, 'arch-7'], { encoding: 'utf8', env: env({ OFFLOAD_WAKE_PERMISSIONS: 'bypass' }) });
  const log = readFileSync(LOG, 'utf8');
  assert.match(log, /--dangerously-skip-permissions/);
  assert.doesNotMatch(log, /--permission-mode auto/);
});

test('OFFLOAD_ARCHITECT_MCP=inherit drops the strict MCP flags', () => {
  rmSync(LOG, { force: true });
  const wt = join(BOX, 'wt-3');
  const doc = hoff(['init', wt, 'arch-7', 'slice three']);
  hoff(['status', doc, 'results-ready']);
  spawnSync('bash', [WAKE, REPO, doc, 'arch-7'], { encoding: 'utf8', env: env({ OFFLOAD_ARCHITECT_MCP: 'inherit' }) });
  assert.doesNotMatch(readFileSync(LOG, 'utf8'), /strict-mcp-config/);
});

test('unattended.sh arms one detached wake per live slice and skips terminal rows', async () => {
  rmSync(LOG, { force: true });
  const R2 = join(BOX, 'repo-2'); mkdirSync(R2);
  hoff(['ledger', 'init', R2, 'fleet']);
  const live = hoff(['init', join(BOX, 'wt-live'), 'arch-7', 'live']);
  hoff(['status', live, 'results-ready']); // bridge fires immediately
  hoff(['ledger', 'add', R2, '--id', 'L', '--title', 'live', '--handoff', live, '--state', 'dispatched']);
  const done = hoff(['init', join(BOX, 'wt-done'), 'arch-7', 'done']);
  hoff(['ledger', 'add', R2, '--id', 'D', '--title', 'done', '--handoff', done, '--state', 'accepted']);
  const out = execFileSync('bash', [UNATTENDED, R2], { encoding: 'utf8', env: env() });
  assert.match(out, /slice L \(dispatched\) → detached bridge\+wake pid \d+/);
  assert.doesNotMatch(out, /slice D/);
  assert.match(out, /1 slice\(s\) handed to detached wakes/);
  const deadline = Date.now() + 15000;
  let log = '';
  while (Date.now() < deadline) {
    try { log = readFileSync(LOG, 'utf8'); } catch {}
    if (/--resume arch-7/.test(log)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.match(log, /--resume arch-7/, 'the detached chain resumed the architect');
});
