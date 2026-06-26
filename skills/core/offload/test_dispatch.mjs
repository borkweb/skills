// test_dispatch.mjs — stub tmux/codex/osascript on PATH and assert branch selection.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
['tmux', 'codex', 'osascript'].forEach(stub);
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

const run = (extraEnv) => {
  rmSync(LOG, { force: true });
  execFileSync('bash', [DISPATCH, BOX, BLOCK, '/tmp/handoff.md', 'sess-Z'], {
    encoding: 'utf8',
    // HERDR_ENV / HERDR_WORKSPACE_ID are cleared by default so a real herdr session in
    // the test runner's env doesn't steal the branch or workspace; herdr tests opt back
    // in explicitly.
    env: { ...process.env, HERDR_ENV: '', HERDR_WORKSPACE_ID: '', PATH: `${BIN}:${process.env.PATH}`, ...extraEnv },
  });
  return readFileSync(LOG, 'utf8');
};

test('inside herdr -> creates a herdr tab and runs the launch script in its pane', () => {
  // HERDR_ENV set + tmux also set: herdr wins, tmux must NOT be touched.
  const log = run({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', TMUX: '/tmp/tmux-1,1,0' });
  assert.match(log, /^herdr tab create .*codex-build/m);
  // Runs the generated launch script in the pane the create JSON reported.
  assert.match(log, /^herdr pane run w9:p7 bash \S+\.sh/m);
  assert.doesNotMatch(log, /^tmux/m);
});

test('herdr tab lands in THIS session workspace from HERDR_WORKSPACE_ID', () => {
  const log = run({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3' });
  // The session's own workspace is passed through; no socket lookup needed.
  assert.match(log, /^herdr tab create --workspace w3 .*codex-build/m);
  assert.doesNotMatch(log, /^herdr pane current/m);
});

test('herdr workspace falls back to `pane current` when env var is unset', () => {
  const log = run({ HERDR_ENV: '1' });
  // No injected workspace -> resolve it over the socket, then target that workspace.
  assert.match(log, /^herdr pane current/m);
  assert.match(log, /^herdr tab create --workspace w5 .*codex-build/m);
});

test('inside tmux -> opens a new tmux window running codex', () => {
  const log = run({ TMUX: '/tmp/tmux-1,1,0' });
  assert.match(log, /^tmux new-window/m);
  assert.match(log, /codex-build/);
  // The window runs a generated launch script, not an inline codex command.
  assert.match(log, /bash \S+\.sh/);
});

test('no tmux on Darwin -> osascript Terminal fallback', () => {
  unameReports('Darwin');
  const log = run({ TMUX: '' });
  assert.match(log, /^osascript/m);
});

test('no tmux, non-Darwin -> headless codex exec', () => {
  unameReports('Linux');
  const log = run({ TMUX: '' });
  assert.match(log, /^codex exec/m);
});
