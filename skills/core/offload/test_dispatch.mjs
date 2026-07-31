// test_dispatch.mjs — stub frontends + harness binaries on PATH and assert
// candidate selection, template contents, and frontend branch selection.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  echo '{"result":{"root_pane":{"agent_status":"unknown","cwd":"/r","pane_id":"w9:p7","tab_id":"w9:t7","workspace_id":"w9"},"tab":{"tab_id":"w9:t7"},"type":"tab_created"}}'
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
writeFileSync(join(CODEX_HOME, 'config.toml'), 'notify = ["/opt/orig-notify", "turn-ended"]\n');

// Constrained PATH: stubs first, node's own dir (dispatch shells out to node),
// then system dirs only — the host's real harness binaries (pi, codex, ...)
// must never leak into candidate resolution.
const TEST_PATH = `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin`;

// Config fixture consumed by harness.mjs via $BORKWEB_SKILLS_CONFIG.
const CONFIG = join(BOX, 'config.json');
const writeConfig = (use) => writeFileSync(CONFIG, JSON.stringify({
  dispatch: { rules: [{ when: 'builder dispatch', use, why: 'test' }] },
}));
writeConfig([{ harness: 'codex' }]);

const run = (extraEnv, args = []) => {
  rmSync(LOG, { force: true });
  const stdout = execFileSync(
    'bash', [DISPATCH, BOX, BLOCK, HANDOFF, 'sess-Z', ...args],
    {
      encoding: 'utf8',
      // HERDR_ENV / HERDR_WORKSPACE_ID are cleared by default so a real herdr
      // session in the test runner's env doesn't steal the branch or workspace;
      // herdr tests opt back in explicitly.
      env: {
        ...process.env, HERDR_ENV: '', HERDR_WORKSPACE_ID: '',
        BORKWEB_SKILLS_CONFIG: CONFIG, CODEX_HOME,
        PATH: TEST_PATH, ...extraEnv,
      },
    },
  );
  let log = '';
  try { log = readFileSync(LOG, 'utf8'); } catch {}
  return { log, stdout };
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
  writeConfig([{ harness: 'codex' }]);
});

test('per-profile permissionMode overrides the claude default', () => {
  writeConfig([{ harness: 'claude', permissionMode: 'acceptEdits' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(launchScriptOf(log), /claude --permission-mode acceptEdits/);
  writeConfig([{ harness: 'codex' }]);
});

test('model and effort flow into the codex command', () => {
  writeConfig([{ harness: 'codex', model: 'gpt-5.5', effort: 'high' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  const script = launchScriptOf(log);
  assert.match(script, /codex -m gpt-5\.5 --config model_reasoning_effort=high/);
  writeConfig([{ harness: 'codex' }]);
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
  writeFileSync(join(CODEX_HOME, 'config.toml'), 'notify = ["/opt/orig-notify", "turn-ended"]\n');
});

test('claude launch installs Stop/Notification hooks touching the turn-end marker', () => {
  writeConfig([{ harness: 'claude' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  const script = launchScriptOf(log);
  assert.ok(script.includes('--settings'), 'settings flag missing');
  assert.ok(script.includes('Stop'), 'Stop hook missing');
  assert.ok(script.includes('Notification'), 'Notification hook missing');
  assert.ok(script.includes(`${HANDOFF}.turn-ended`), 'marker path missing from hook command');
  writeConfig([{ harness: 'codex' }]);
});

test('dispatch clears a stale turn-end marker and writes the codex activity sidecar', () => {
  writeFileSync(`${HANDOFF}.turn-ended`, '');
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(log, /^tmux new-window/m);
  assert.ok(!existsSync(`${HANDOFF}.turn-ended`), 'stale turn-end marker not cleared');
  assert.equal(
    readFileSync(`${HANDOFF}.activity`, 'utf8').trim(),
    join(CODEX_HOME, 'sessions'),
    'activity sidecar should point at the codex sessions dir',
  );
});

test('claude activity sidecar points at the claude projects dir', () => {
  const home = join(BOX, 'home');
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  writeConfig([{ harness: 'claude' }]);
  run({ TMUX: '/tmp/tmux-1,1,0', HOME: home });
  assert.equal(
    readFileSync(`${HANDOFF}.activity`, 'utf8').trim(),
    join(home, '.claude', 'projects'),
  );
  writeConfig([{ harness: 'codex' }]);
});

test('first candidate missing from PATH falls through to the next', () => {
  // pi is not stubbed -> harness.mjs skips it; claude launches.
  writeConfig([{ harness: 'pi' }, { harness: 'claude' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(launchScriptOf(log), /claude --permission-mode auto/);
  writeConfig([{ harness: 'codex' }]);
});

test('explicit profile-spec argument bypasses config resolution', () => {
  rmSync(CONFIG, { force: true }); // no config at all — override must not need it
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' }, ['claude:opus']);
  assert.match(launchScriptOf(log), /claude --permission-mode auto --model opus/);
  writeConfig([{ harness: 'codex' }]);
});

test('custom command profile is used verbatim with __PROMPT_FILE__ substituted', () => {
  stub('mytool');
  writeConfig([{ harness: 'mytool', command: 'mytool --yolo "$(cat __PROMPT_FILE__)"' }]);
  const { log } = run({ TMUX: '/tmp/tmux-1,1,0' });
  const script = launchScriptOf(log);
  assert.match(script, /mytool --yolo/);
  assert.ok(script.includes(BLOCK), 'prompt file path substituted');
  writeConfig([{ harness: 'codex' }]);
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
  writeConfig([{ harness: 'codex' }]);
});

test('headless path skips interactive-only harnesses for the next candidate', () => {
  unameReports('Linux');
  stub('grok'); // on PATH so select keeps it, but it has no headless form
  writeConfig([{ harness: 'grok' }, { harness: 'codex' }]);
  const { log } = run({ TMUX: '' });
  assert.doesNotMatch(log, /^grok/m);
  assert.match(log, /^codex exec/m);
  writeConfig([{ harness: 'codex' }]);
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
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  writeFileSync(MARKER, `${child.pid}\n`);
  try {
    const { log } = run({ TMUX: '', OFFLOAD_FORCE: '1' });
    assert.match(log, /^codex exec/m, 'should launch after force-replacing');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    cleanMarker();
  }
});
