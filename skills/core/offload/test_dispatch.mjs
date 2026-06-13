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
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...extraEnv },
  });
  return readFileSync(LOG, 'utf8');
};

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
