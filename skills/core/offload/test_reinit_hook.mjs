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

test('no handoff -> advertises CLI only', () => {
  const out = JSON.parse(fireHook(join(BOX, 'empty-repo')));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[offload\] Handoff CLI/);
  assert.doesNotMatch(ctx, /reattach with/);
});

test('one handoff -> injects state + reattach instruction, does NOT delete', () => {
  const p = hoff(['init', REPO, 'sess-1', 'Proj']);
  const out = JSON.parse(fireHook(REPO));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /reattach with/);
  assert.match(ctx, /Proj/);
  assert.ok(existsSync(p), 'handoff must NOT be consumed by the hook');
});

test('multiple handoffs -> menu', () => {
  hoff(['init', REPO, 'sess-2', 'Proj2']);
  const out = JSON.parse(fireHook(REPO));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /handoffs exist for this project/);
  assert.match(ctx, /\[1\]/);
});
