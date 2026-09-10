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
