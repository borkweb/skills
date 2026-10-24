// test_reinit_hook.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'reinit-hook.mjs');
const HANDOFF = join(HERE, 'handoff.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'ofl-h-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));
const REPO = join(BOX, 'repo');
const env = { ...process.env, AGENT_HANDOFFS_DIR: BOX };

const hoff = (args) => execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env }).trim();
const fireHook = (cwd) =>
  execFileSync(NODE, [HOOK], { encoding: 'utf8', env, input: JSON.stringify({ cwd }) });

test('no handoff -> no startup context', () => {
  assert.strictEqual(fireHook(join(BOX, 'empty-repo')), '');
});

test('saved handoff -> concise owner notice without consumption or takeover command', () => {
  const p = hoff(['init', REPO, 'sess-1', 'Proj']);
  const ctx = JSON.parse(fireHook(REPO)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /owner "sess-1"/);
  assert.match(ctx, /Proj/);
  assert.doesNotMatch(ctx, /handoff\.mjs|Handoff CLI|plugins\/cache/);
  assert.doesNotMatch(ctx, /--steal|resolve "\$PWD"|Current state:/);
  assert.ok(existsSync(p));
});

test('multiple handoffs -> menu, no full documents injected', () => {
  hoff(['init', REPO, 'sess-2', 'Proj2']);
  const ctx = JSON.parse(fireHook(REPO)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /2 saved offload handoff/);
  assert.match(ctx, /\[1\]/);
  assert.match(ctx, /\[2\]/);
  assert.doesNotMatch(ctx, /## Gate results|--steal|Resolve YOUR/);
});

test('Codex handoff notice shows the actual architect owner without impersonation', () => {
  const cwd = join(BOX, 'codex-repo');
  const id = 'codex:01a16a67-f178-70e2-9b40-c0babe791262';
  hoff(['init', cwd, id, 'Codex project']);
  const ctx = JSON.parse(fireHook(cwd)).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(`owner "${id}"`));
  assert.doesNotMatch(ctx, /owner "unknown"/);
});

// The wake after a compaction is the one most likely to narrate slice state from
// memory. When this session owns a ledger, SessionStart hands it the board and
// its own handoff path instead of leaving it to re-derive both.
test('a session that owns a ledger gets its board and handoff path at start', () => {
  const cwd = join(BOX, 'ledger-repo');
  const own = { ...env, CLAUDE_CODE_SESSION_ID: 'arch-9' };
  const h = (args) => execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env: own }).trim();
  const doc = h(['resolve', cwd, 'Ledger project']);
  h(['ledger', 'init', cwd, 'ship it']);
  h(['ledger', 'add', cwd, '--id', '1', '--title', 'first slice', '--state', 'specced']);
  const ctx = JSON.parse(execFileSync(NODE, [HOOK], {
    encoding: 'utf8', env: own, input: JSON.stringify({ cwd, session_id: 'arch-9' }),
  })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /BOARD\s+ship it/);
  assert.match(ctx, /first slice/);
  assert.ok(ctx.includes(doc), 'names the handoff this session owns');
});

test('another session’s ledger is listed as a notice only — no board, no path', () => {
  const cwd = join(BOX, 'ledger-repo');
  const ctx = JSON.parse(execFileSync(NODE, [HOOK], {
    encoding: 'utf8', env, input: JSON.stringify({ cwd, session_id: 'stranger' }),
  })).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /BOARD/);
  assert.match(ctx, /owner "arch-9"/);
});
