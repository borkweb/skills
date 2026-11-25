// test_dispatch.mjs — stub frontends + harness binaries on PATH and assert
// candidate selection, template contents, and frontend branch selection.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(HERE, 'dispatch.sh');
const BOX = mkdtempSync(join(tmpdir(), 'ofl-d-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const BIN = join(BOX, 'bin');
const LOG = join(BOX, 'calls.log');
mkdirSync(BIN, { recursive: true });
const stub = (name) => {
  const p = join(BIN, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${LOG}"\n`);
  chmodSync(p, 0o755);
};
['tmux', 'codex', 'claude', 'osascript'].forEach(stub);
// Real quota-axi may be reachable via the inherited PATH; shadow it so candidate
// ordering never depends on the host machine's live quota state.
writeFileSync(join(BIN, 'quota-axi'), '#!/usr/bin/env bash\nexit 1\n');
chmodSync(join(BIN, 'quota-axi'), 0o755);
// herdr is stubbed to log calls and emit the `tab create` JSON the script parses.
writeFileSync(
  join(BIN, 'herdr'),
  `#!/usr/bin/env bash
echo "herdr $*" >> "${LOG}"
if [ "$1" = "tab" ] && [ "$2" = "create" ]; then
  case "\${HERDR_STUB_MODE:-ok}" in
    fail-create)
      echo 'herdr: workspace wZ not found' >&2
      exit 1
      ;;
    no-tab)
      # A pane with no tab id: the builder did not get its own tab.
      echo '{"result":{"root_pane":{"pane_id":"w9:p7","workspace_id":"w9"},"type":"pane_created"}}'
      exit 0
      ;;
  esac
  echo '{"result":{"root_pane":{"agent_status":"unknown","cwd":"/r","pane_id":"w9:p7","tab_id":"w9:t7","workspace_id":"w9"},"tab":{"tab_id":"w9:t7"},"type":"tab_created"}}'
fi
if [ "$1" = "pane" ] && [ "$2" = "run" ]; then
  if [ "\${HERDR_STUB_MODE:-ok}" = "fail-run" ]; then
    echo 'herdr: pane w9:p7 is not accepting input' >&2
    exit 1
  fi
fi
if [ "$1" = "pane" ] && [ "$2" = "current" ]; then
  echo '{"result":{"pane":{"pane_id":"w5:p1","tab_id":"w5:t1","workspace_id":"w5"},"type":"pane_current"}}'
fi
`,
);
chmodSync(join(BIN, 'herdr'), 0o755);
// uname is stubbed per-test (Darwin vs Linux) so test order doesn't matter.
const unameReports = (os) => {
  const p = join(BIN, 'uname');
  writeFileSync(p, `#!/usr/bin/env bash\necho ${os}\n`);
  chmodSync(p, 0o755);
};

const BLOCK = join(BOX, 'block.md');
writeFileSync(BLOCK, 'BUILDER BLOCK CONTENTS\n');

// validate_args requires the handoff to be a real file, so the fixture lives in
// BOX rather than pointing at a path that may not exist on the host.
const HANDOFF = join(BOX, 'handoff.md');
writeFileSync(HANDOFF, '---\nstatus: dispatched\n---\n');

// Codex home fixture: a user-configured notify (must be chained, not replaced)
// and a sessions dir (the activity sidecar target). CODEX_HOME is always set in
// run() so the host's real ~/.codex never leaks into assertions.
const CODEX_HOME = join(BOX, 'codex-home');
mkdirSync(join(CODEX_HOME, 'sessions'), { recursive: true });

// Constrained PATH: stubs first, node's own dir (dispatch shells out to node),
// then system dirs only — the host's real harness binaries (pi, codex, ...)
// must never leak into candidate resolution.
const TEST_PATH = `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin`;

// Config fixture consumed by harness.mjs via $BORKWEB_SKILLS_CONFIG.
const CONFIG = join(BOX, 'config.json');
const writeConfig = (use) => writeFileSync(CONFIG, JSON.stringify({
  dispatch: { rules: [{ when: 'builder dispatch', use, why: 'test' }] },
}));
// Tests rewrite the config and the codex config.toml; each one starts from these defaults, so a
// failed test cannot leave its fixture behind for the next.
test.beforeEach(() => {
  writeConfig([{ harness: 'codex' }]);
  writeFileSync(join(CODEX_HOME, 'config.toml'), 'notify = ["/opt/orig-notify", "turn-ended"]\n');
});

const run = (extraEnv, args = [], cwd = undefined) => {
  rmSync(LOG, { force: true });
  const stdout = execFileSync(
    'bash', [DISPATCH, BOX, BLOCK, HANDOFF, 'sess-Z', ...args],
    {
      encoding: 'utf8',
      cwd,
      // HERDR_ENV / HERDR_WORKSPACE_ID are cleared by default so a real herdr
      // session in the test runner's env doesn't steal the branch or workspace;
      // herdr tests opt back in explicitly.
      env: {
        HOME: BOX, TMPDIR: tmpdir(), HERDR_ENV: '', HERDR_WORKSPACE_ID: '',
        BORKWEB_SKILLS_CONFIG: CONFIG, CODEX_HOME,
        PATH: TEST_PATH, ...extraEnv,
      },
    },
  );
  let log = '';
  try { log = readFileSync(LOG, 'utf8'); } catch {}
  return { log, stdout };
};

// Like run(), but for the paths that now exit non-zero. Returns the captured
// stderr plus whatever the herdr stub logged before the failure.
const runFail = (extraEnv, args = []) => {
  rmSync(LOG, { force: true });
  let stderr = '';
  let status = 0;
  try {
    execFileSync('bash', [DISPATCH, BOX, BLOCK, HANDOFF, 'sess-Z', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: BOX, TMPDIR: tmpdir(), HERDR_ENV: '', HERDR_WORKSPACE_ID: '',
        BORKWEB_SKILLS_CONFIG: CONFIG, CODEX_HOME,
        PATH: TEST_PATH, ...extraEnv,
      },
    });
    throw new Error('expected dispatch to fail but it exited 0');
  } catch (e) {
    if (!('status' in e) || e.status === 0) throw e;
    stderr = String(e.stderr || '');
    status = e.status;
  }
  let log = '';
  try { log = readFileSync(LOG, 'utf8'); } catch {}
  return { log, stderr, status };
};

// The launch-script path is logged by the frontend stub; read its contents to
// assert the actual harness command dispatched into the pane/window.
const launchScriptOf = (log) => {
  const m = log.match(/bash (\S+\.sh)/);
  assert.ok(m, `no launch script in log:\n${log}`);
  return readFileSync(m[1], 'utf8');
};

test('inside herdr -> creates a herdr tab labeled builder', () => {
  // HERDR_ENV set + tmux also set: herdr wins, tmux must NOT be touched.
  const { log } = run({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', TMUX: '/tmp/tmux-1,1,0' });
  assert.match(log, /^herdr tab create .*builder/m);
  assert.match(log, /^herdr pane run w9:p7 bash \S+\.sh/m);
  assert.doesNotMatch(log, /^tmux/m);
});

test('herdr tab lands in THIS session workspace from HERDR_WORKSPACE_ID', () => {
  const { log } = run({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3' });
  assert.match(log, /^herdr tab create --workspace w3 .*builder/m);
  assert.doesNotMatch(log, /^herdr pane current/m);
});

// The dispatch line used to name only the root pane, so every downstream report
// called the builder "pane wY:p22" and nobody could tell afterwards whether a
// tab had actually been created. Name the tab and the workspace.
test('the launch line names the tab and workspace, not just the pane', () => {
  const { stdout } = run({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3' });
  assert.match(stdout, /new herdr tab w9:t7/);
  assert.match(stdout, /workspace w3/);
  assert.match(stdout, /root pane w9:p7/);
});

// Inside herdr, falling through to `tmux new-window` puts the builder outside
// herdr's tab model — a stray pane in the active workspace view — while still
// printing a launch line. A failed tab create must stop the dispatch instead.
test('a failed herdr tab create stops the dispatch — no tmux/Terminal fallback', () => {
  const { log, stderr } = runFail({
    HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', HERDR_STUB_MODE: 'fail-create',
    TMUX: '/tmp/tmux-1,1,0',
  });
  assert.match(stderr, /FAILED to open a herdr tab in workspace w3/);
  assert.match(stderr, /herdr: workspace wZ not found/, 'surfaces the herdr error it used to swallow');
  assert.match(stderr, /refusing to fall back/);
  assert.doesNotMatch(log, /^herdr pane run/m, 'nothing was launched');
});

// A response carrying a pane but no tab id is not a new tab.
test('a pane with no tab id is treated as a failure, not a tab', () => {
  const { stderr } = runFail({
    HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', HERDR_STUB_MODE: 'no-tab',
  });
  assert.match(stderr, /tab='none'/);
  assert.match(stderr, /pane='w9:p7'/, 'reports the pane it did get, for diagnosis');
  assert.match(stderr, /refusing to fall back/);
});

// The tab opened but the harness never started in it: previously `pane run`'s
// exit status was discarded and dispatch claimed success on an empty tab.
// The tab must also be cleaned up — an empty tab labeled "builder" is exactly
// what the ledger's pane provenance check treats as a real dispatch.
test('a tab that opens but fails to run the harness is not reported as launched', () => {
  const { log, stderr } = runFail({
    HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', HERDR_STUB_MODE: 'fail-run',
  });
  assert.match(stderr, /tab w9:t7 was created but 'pane run' failed/);
  assert.match(stderr, /closed the empty tab/);
  assert.match(log, /^herdr tab close w9:t7$/m);
});

test('OFFLOAD_ALLOW_NON_HERDR restores the old fallback chain', () => {
  const { log, stdout } = run({
    HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', HERDR_STUB_MODE: 'fail-create',
    OFFLOAD_ALLOW_NON_HERDR: '1', TMUX: '/tmp/tmux-1,1,0',
  });
  assert.match(log, /^tmux new-window/m);
  assert.match(stdout, /new tmux window/);
});

test('herdr workspace falls back to `pane current` when env var is unset', () => {
  const { log } = run({ HERDR_ENV: '1' });
  assert.match(log, /^herdr pane current/m);
  assert.match(log, /^herdr tab create --workspace w5 .*builder/m);
});

test('inside tmux -> opens a builder window running the configured harness', () => {
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(log, /^tmux new-window/m);
  assert.match(log, /builder/);
  assert.match(launchScriptOf(log), /codex .*--dangerously-bypass-approvals-and-sandbox/);
});

test('claude profile launches with --permission-mode auto by default', () => {
  writeConfig([{ harness: 'claude' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(launchScriptOf(log), /claude --permission-mode auto/);
});

test('per-profile permissionMode overrides the claude default', () => {
  writeConfig([{ harness: 'claude', permissionMode: 'acceptEdits' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(launchScriptOf(log), /claude --permission-mode acceptEdits/);
});

test('model and effort flow into the codex command', () => {
  writeConfig([{ harness: 'codex', model: 'gpt-5.5', effort: 'high' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  const script = launchScriptOf(log);
  assert.match(script, /codex -m gpt-5\.5 --config model_reasoning_effort=high/);
});

// --- deterministic turn-end wiring ---
test('codex launch installs the turn-end notify hook chained to the user notify', () => {
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  const script = launchScriptOf(log);
  assert.ok(script.includes('notify'), 'notify config missing');
  assert.ok(script.includes('notify-turn-ended.sh'), 'wrapper missing from notify argv');
  assert.ok(script.includes(HANDOFF), 'handoff path missing from notify argv');
  assert.ok(script.includes('/opt/orig-notify'), 'user notify program not chained');
});

test('codex notify hook works without a user config.toml notify line', () => {
  rmSync(join(CODEX_HOME, 'config.toml'), { force: true });
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  const script = launchScriptOf(log);
  assert.ok(script.includes('notify-turn-ended.sh'), 'wrapper missing with no user notify');
  assert.ok(!script.includes('/opt/orig-notify'), 'phantom chain with no user notify');
});

// The sidecar must never name a shared log root: every other open session
// (the architect's included) writes there, so a stopped builder never idles.
const REAL_BOX = realpathSync(BOX);
const claudeDirOf = (home, cwd) => join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

test('dispatch clears a stale turn-end marker and writes a cwd-scoped codex rollout rule', () => {
  writeFileSync(`${HANDOFF}.turn-ended`, '');
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(log, /^tmux new-window/m);
  assert.ok(!existsSync(`${HANDOFF}.turn-ended`), 'stale turn-end marker not cleared');
  const lines = readFileSync(`${HANDOFF}.activity`, 'utf8').trim().split('\n');
  assert.ok(!lines.includes(join(CODEX_HOME, 'sessions')), 'sidecar must not name the whole sessions root');
  const [kind, root, since, cwd] = lines[0].split('\t');
  assert.equal(kind, 'codex-rollouts');
  assert.equal(root, join(CODEX_HOME, 'sessions'));
  assert.match(since, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  assert.equal(cwd, REAL_BOX);
});

test('claude builder gets a pinned session id and the sidecar names only its transcript', () => {
  const home = join(BOX, 'home');
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  writeConfig([{ harness: 'claude' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0', HOME: home });
  const m = launchScriptOf(log).match(/--session-id ([0-9a-f-]{36}) /);
  assert.ok(m, 'launch command should pin --session-id');
  const dir = claudeDirOf(home, REAL_BOX);
  assert.deepEqual(
    readFileSync(`${HANDOFF}.activity`, 'utf8').trim().split('\n'),
    [join(dir, `${m[1]}.jsonl`), join(dir, m[1])],
  );
});

test('claude without a session id: repo transcript dir, or no sidecar when the architect shares the cwd', () => {
  const home = join(BOX, 'home');
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  const uuidgen = join(BIN, 'uuidgen');
  writeFileSync(uuidgen, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(uuidgen, 0o755);
  writeConfig([{ harness: 'claude' }]);
  try {
    const { log } = run({ TMUX: '/tmp/tmux-1,1,0', HOME: home }, [], tmpdir());
    assert.ok(!launchScriptOf(log).includes('--session-id'), 'no id to pin');
    assert.equal(readFileSync(`${HANDOFF}.activity`, 'utf8').trim(), claudeDirOf(home, REAL_BOX));
    run({ TMUX: '/tmp/tmux-1,1,0', HOME: home }, [], BOX);
    assert.ok(!existsSync(`${HANDOFF}.activity`), 'shared cwd is not discriminating');
  } finally {
    rmSync(uuidgen, { force: true });
  }
});

test('first candidate missing from PATH falls through to the next', () => {
  // pi is not stubbed -> harness.mjs skips it; claude launches.
  writeConfig([{ harness: 'pi' }, { harness: 'claude' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(launchScriptOf(log), /claude --permission-mode auto/);
});

test('explicit profile-spec argument bypasses config resolution', () => {
  rmSync(CONFIG, { force: true }); // no config at all — override must not need it
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' }, ['claude:opus']);
  assert.match(launchScriptOf(log), /claude --permission-mode auto --model opus/);
});

test('custom command profile is used verbatim with __PROMPT_FILE__ substituted', () => {
  stub('mytool');
  writeConfig([{ harness: 'mytool', command: 'mytool --yolo "$(cat __PROMPT_FILE__)"' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  const script = launchScriptOf(log);
  assert.match(script, /mytool --yolo/);
  assert.ok(script.includes(BLOCK), 'prompt file path substituted');
});

test('no tmux on Darwin -> osascript Terminal fallback', () => {
  unameReports('Darwin');
  const { log } = run({ TMUX: '' });
  assert.match(log, /^osascript/m);
});

test('no tmux, non-Darwin -> headless codex exec', () => {
  unameReports('Linux');
  const { log } = run({ TMUX: '' });
  assert.match(log, /^codex exec/m);
});

test('headless claude uses -p with full bypass, not auto mode', () => {
  unameReports('Linux');
  writeConfig([{ harness: 'claude' }]);
  const { log } = run({ TMUX: '' });
  assert.match(log, /^claude -p --dangerously-skip-permissions/m);
});

// Claude Code replaces an inherited $CLAUDE_CODE_SESSION_ID with its own session
// id inside tool calls, so the architect's id must also travel in a variable no
// harness owns. handoff.mjs honors it for the builder's assigned handoff only.
test('every launch carries the architect id in OFFLOAD_SESSION_ID beside the handoff', () => {
  for (const harness of ['claude', 'codex']) {
    writeConfig([{ harness }]);
    const script = launchScriptOf(run({ TMUX: '/tmp/tmux-1,1,0' }).log);
    assert.match(script, /^export OFFLOAD_SESSION_ID=sess-Z$/m, `${harness} launch carries the id`);
    assert.match(script, /^export OFFLOAD_HANDOFF=\S+handoff\.md$/m);
  }
});

// review-criteria class 2: a builder runs with its gates off, so it never sees the user's tokens.
const SECRETS = {
  GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-leak', ELEVENLABS_API_KEY: 'el-leak', AWS_SECRET_ACCESS_KEY: 'aws-leak',
  NPM_TOKEN: 'npm-leak', DB_PASSWORD: 'db-leak', GATE_ONLY_TOKEN: 'gate-pass',
  ANTHROPIC_API_KEY: 'anthropic-keep', OPENAI_API_KEY: 'openai-keep', TOKENIZERS_PARALLELISM: 'false',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
};
const ENV_NAMES = Object.keys(SECRETS);
const envProbe = (name) => {
  const p = join(BIN, name);
  writeFileSync(p, `#!/usr/bin/env bash\n{ ${ENV_NAMES.map((n) => `echo "env ${n}=\${${n}-UNSET}"`).join('; ')}; } >> "${LOG}"\n`);
  chmodSync(p, 0o755);
};
const assertScrubbed = (log, { pass = [] } = {}) => {
  for (const n of ['GITHUB_PERSONAL_ACCESS_TOKEN', 'ELEVENLABS_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'DB_PASSWORD']) {
    assert.match(log, new RegExp(`^env ${n}=UNSET$`, 'm'), `${n} reached the builder`);
  }
  assert.match(log, new RegExp(`^env GATE_ONLY_TOKEN=${pass.includes('GATE_ONLY_TOKEN') ? 'gate-pass' : 'UNSET'}$`, 'm'));
  for (const [n, v] of [['ANTHROPIC_API_KEY', 'anthropic-keep'], ['OPENAI_API_KEY', 'openai-keep'],
    ['TOKENIZERS_PARALLELISM', 'false'], ['SSH_AUTH_SOCK', '/tmp/agent.sock']]) {
    assert.match(log, new RegExp(`^env ${n}=${v}$`, 'm'), `${n} should stay`);
  }
};

test('a headless builder gets no token or secret from the environment, but keeps its harness key and the ssh agent', () => {
  unameReports('Linux');
  writeConfig([{ harness: 'claude' }]);
  envProbe('claude');
  try {
    assertScrubbed(run({ TMUX: '', ...SECRETS }).log);
  } finally {
    stub('claude');
  }
});

test('OFFLOAD_BUILDER_PASS_ENV keeps a named secret, and OFFLOAD_BUILDER_ENV=inherit keeps them all', () => {
  unameReports('Linux');
  writeConfig([{ harness: 'claude' }]);
  envProbe('claude');
  try {
    assertScrubbed(run({ TMUX: '', ...SECRETS, OFFLOAD_BUILDER_PASS_ENV: 'NPM_X GATE_ONLY_TOKEN' }).log, { pass: ['GATE_ONLY_TOKEN'] });
    assert.match(run({ TMUX: '', ...SECRETS, OFFLOAD_BUILDER_ENV: 'inherit' }).log, /^env GITHUB_PERSONAL_ACCESS_TOKEN=ghp-leak$/m);
  } finally {
    stub('claude');
  }
});

test('an interactive launch script scrubs secrets from the tab environment it starts in', () => {
  // The launch script runs in a herdr or tmux tab, which starts from the server's environment,
  // not the architect's: run it under a hostile environment the dispatch never saw.
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0', OFFLOAD_BUILDER_PASS_ENV: 'GATE_ONLY_TOKEN' });
  const script = log.match(/bash (\S+\.sh)/)[1];
  envProbe('codex');
  try {
    rmSync(LOG, { force: true });
    execFileSync('bash', [script], { env: { HOME: BOX, PATH: TEST_PATH, ...SECRETS }, encoding: 'utf8' });
    assertScrubbed(readFileSync(LOG, 'utf8'), { pass: ['GATE_ONLY_TOKEN'] });
  } finally {
    stub('codex');
  }
});

test('a headless builder gets OFFLOAD_SESSION_ID in its environment', () => {
  unameReports('Linux');
  writeConfig([{ harness: 'claude' }]);
  const envStub = join(BIN, 'claude');
  writeFileSync(
    envStub,
    `#!/usr/bin/env bash\necho "claude-env OFFLOAD_SESSION_ID=$OFFLOAD_SESSION_ID OFFLOAD_HANDOFF=$OFFLOAD_HANDOFF" >> "${LOG}"\n`,
  );
  chmodSync(envStub, 0o755);
  try {
    const { log } = run({ TMUX: '' });
    assert.match(log, /^claude-env OFFLOAD_SESSION_ID=sess-Z OFFLOAD_HANDOFF=\S+handoff\.md$/m);
  } finally {
    stub('claude');
  }
});

test('headless path skips interactive-only harnesses for the next candidate', () => {
  unameReports('Linux');
  stub('grok'); // on PATH so select keeps it, but it has no headless form
  writeConfig([{ harness: 'grok' }, { harness: 'codex' }]);
  const { log } = run({ TMUX: '' });
  assert.doesNotMatch(log, /^grok/m);
  assert.match(log, /^codex exec/m);
});

// --- duplicate-builder guard (one handoff owns at most one builder) ---
const MARKER = `${HANDOFF}.builder`;
const cleanMarker = () => rmSync(MARKER, { force: true });

test('refuses to launch when a live builder marker already exists', () => {
  unameReports('Linux');
  writeFileSync(MARKER, `${process.pid}\n`); // node itself: a definitely-live pid
  let threw = false;
  try {
    run({ TMUX: '' });
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 2, 'expected exit code 2 on duplicate refusal');
    assert.match(String(err.stderr), /a builder is already running for this handoff/);
  } finally {
    cleanMarker();
  }
  assert.ok(threw, 'dispatch should have refused (nonzero exit) with a live marker');
});

test('clears a stale marker (dead pid) and proceeds to launch', () => {
  unameReports('Linux');
  writeFileSync(MARKER, '2147480000\n'); // an unused, dead pid
  const { log } = run({ TMUX: '' });
  assert.match(log, /^codex exec/m, 'should launch after clearing the stale marker');
  cleanMarker();
});

test('OFFLOAD_FORCE=1 replaces a running builder instead of refusing', () => {
  unameReports('Linux');
  // A real, live but harmless child we are willing to see killed.
  const child = spawn('sleep', ['30'], { stdio: 'ignore', env: { PATH: TEST_PATH } });
  writeFileSync(MARKER, `${child.pid}\n`);
  try {
    const { log } = run({ TMUX: '', OFFLOAD_FORCE: '1' });
    assert.match(log, /^codex exec/m, 'should launch after force-replacing');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    cleanMarker();
  }
});

test('builder launch never impersonates the architect native session', () => {
  writeConfig([{ harness: 'claude', model: 'sonnet' }]);
  const { log } = run({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', CODEX_SESSION_ID: 'native-architect' });
  const script = launchScriptOf(log);
  assert.match(script, /^export OFFLOAD_SESSION_ID=sess-Z$/m);
  assert.match(script, /^unset CLAUDE_CODE_SESSION_ID CODEX_SESSION_ID$/m);
  assert.doesNotMatch(script, /^export CLAUDE_CODE_SESSION_ID=/m);
});

// --- pane sidecar + lean builder boot ---------------------------------------

// dispatch-slice.sh and the corrective path need to know where the builder
// lives without parsing the human-facing launch line; dispatch.sh records it.
test('a herdr launch records the frontend, pane, tab and harness beside the handoff', () => {
  writeConfig([{ harness: 'claude' }]);
  rmSync(`${HANDOFF}.pane`, { force: true });
  run({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3' });
  const side = readFileSync(`${HANDOFF}.pane`, 'utf8');
  assert.match(side, /^frontend=herdr$/m);
  assert.match(side, /^pane=w9:p7$/m);
  assert.match(side, /^tab=w9:t7$/m);
  assert.match(side, /^harness=claude$/m);
});

test('a failed herdr launch leaves no pane sidecar behind', () => {
  rmSync(`${HANDOFF}.pane`, { force: true });
  runFail({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', HERDR_STUB_MODE: 'fail-create' });
  assert.ok(!existsSync(`${HANDOFF}.pane`));
});

// The builder session used to boot every MCP server on the machine and carry
// their tool schemas on every turn. Builders need node and the skills, not the
// MCP fleet, so claude launches with no MCP servers unless told otherwise.
test('claude builders launch with no MCP servers by default', () => {
  writeConfig([{ harness: 'claude' }]);
  unameReports('Linux');
  const script = launchScriptOf(run({ TMUX: '/tmp/tmux-1,1,0' }).log);
  assert.match(script, /--strict-mcp-config --mcp-config/);
  assert.match(script, /mcpServers/);
});

test('OFFLOAD_BUILDER_MCP=inherit keeps the user’s MCP configuration', () => {
  writeConfig([{ harness: 'claude' }]);
  unameReports('Linux');
  const script = launchScriptOf(run({ TMUX: '/tmp/tmux-1,1,0', OFFLOAD_BUILDER_MCP: 'inherit' }).log);
  assert.doesNotMatch(script, /strict-mcp-config/);
});

test('OFFLOAD_BUILDER_MCP=<path> loads exactly that MCP config', () => {
  writeConfig([{ harness: 'claude' }]);
  unameReports('Linux');
  const mcp = join(BOX, 'builder-mcp.json');
  writeFileSync(mcp, '{"mcpServers":{}}');
  const script = launchScriptOf(run({ TMUX: '/tmp/tmux-1,1,0', OFFLOAD_BUILDER_MCP: mcp }).log);
  assert.match(script, new RegExp(`--strict-mcp-config --mcp-config ${mcp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

// A headless claude builder (claude -p) gets the same Stop gate hook as an interactive one:
// --settings carries one Stop entry that runs the local-gate check and then the touch.
test('C16: a headless claude builder gets the Stop gate hook through --settings', () => {
  unameReports('Linux');
  writeConfig([{ harness: 'claude' }]);
  const argvOut = join(BOX, 'headless-argv');
  const rec = join(BIN, 'claude');
  writeFileSync(rec, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvOut}"\n`);
  chmodSync(rec, 0o755);
  try {
    run({ TMUX: '' });
    const argv = readFileSync(argvOut, 'utf8').split('\n');
    const i = argv.indexOf('--settings');
    assert.ok(i >= 0, `headless claude has no --settings: ${argv.join(' ')}`);
    const settings = JSON.parse(argv[i + 1]);
    assert.equal(settings.hooks.Stop.length, 1);
    const stop = settings.hooks.Stop[0].hooks[0];
    assert.match(stop.command, /stop-gates/);
    assert.ok(stop.command.includes(`${HANDOFF}.turn-ended`));
    assert.equal(stop.timeout, 900);
    assert.match(settings.hooks.Notification[0].hooks[0].command, /^touch .*\.turn-ended/);
    assert.ok(argv.indexOf('-p') >= 0 && argv.indexOf('--dangerously-skip-permissions') >= 0, 'still headless with full bypass');
  } finally {
    stub('claude');
  }
});
