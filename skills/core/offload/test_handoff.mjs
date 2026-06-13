// test_handoff.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF = join(HERE, 'handoff.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'ofl-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const run = (args) =>
  execFileSync(NODE, [HANDOFF, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_HANDOFFS_DIR: BOX },
  }).trim();

// Each test gets its own cwd subdir so docs from one test never leak into
// another's listFiles() (which keys on the cwd hash).
const repo = (name) => join(BOX, `repo-${name}`);

test('init creates a doc under <box>/offload, idempotent for same session', () => {
  const REPO = repo('init');
  const p1 = run(['init', REPO, 'sess-A', 'My Project']);
  assert.ok(p1.startsWith(join(BOX, 'offload')), `path under offload dir: ${p1}`);
  assert.ok(existsSync(p1));
  const body = readFileSync(p1, 'utf8');
  assert.match(body, /title: My Project/);
  assert.match(body, /claude_session: sess-A/);
  assert.match(body, /status: dispatched/);
  const p2 = run(['init', REPO, 'sess-A']);
  assert.equal(p2, p1, 'same session re-init returns same path, does not overwrite');
  assert.match(readFileSync(p2, 'utf8'), /title: My Project/, 'title preserved on re-init');
});

test('init preserves values containing regex replacement tokens ($1, $&)', () => {
  const REPO = repo('dollar');
  const title = 'Fix $1 and $& bug';
  const p = run(['init', REPO, 'sess-$', title]);
  assert.match(readFileSync(p, 'utf8'), /^title: Fix \$1 and \$& bug$/m, 'title stored verbatim');
});

test('two sessions in the same repo get distinct docs', () => {
  const REPO = repo('distinct');
  const a = run(['init', REPO, 'sess-A']);
  const b = run(['init', REPO, 'sess-B']);
  assert.notEqual(a, b);
  const rows = run(['list', REPO]).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, 'list returns exactly the two docs for this cwd');
});

test('ready flips status to results-ready', () => {
  const p = run(['init', repo('ready'), 'sess-C']);
  run(['ready', p]);
  assert.match(readFileSync(p, 'utf8'), /status: results-ready/);
});

test('status sets an arbitrary status value', () => {
  const p = run(['init', repo('status'), 'sess-S']);
  run(['status', p, 'blocked']);
  assert.match(readFileSync(p, 'utf8'), /status: blocked/);
});

test('reattach refreshes claude_session and returns the same path', () => {
  const p = run(['init', repo('reattach'), 'sess-D']);
  const r = run(['reattach', p, 'sess-D-NEW']);
  assert.equal(r, p);
  assert.match(readFileSync(p, 'utf8'), /claude_session: sess-D-NEW/);
});

test('list emits JSONL with status/title for this cwd', () => {
  const REPO = repo('list');
  run(['init', REPO, 'sess-L']);
  const rows = run(['list', REPO]).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, 'exactly one doc for this isolated cwd');
  assert.ok(rows.every((r) => r.path && 'status' in r));
});

test('end deletes the doc', () => {
  const p = run(['init', repo('end'), 'sess-E']);
  run(['end', p]);
  assert.ok(!existsSync(p));
});

test('prune reaps docs older than the TTL', () => {
  const p = run(['init', repo('prune'), 'sess-OLD']);
  const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000; // 8 days
  utimesSync(p, old, old);
  run(['prune']);
  assert.ok(!existsSync(p));
});
