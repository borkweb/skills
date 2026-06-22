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

// run() lets each call set the ambient session id, since the ownership guard
// reads $CLAUDE_CODE_SESSION_ID. Pass { session } to control it; omit to run
// with no session in the env (to exercise the empty-id guard).
const run = (args, { session } = {}) => {
  const env = { ...process.env, AGENT_HANDOFFS_DIR: BOX };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (session !== undefined) env.CLAUDE_CODE_SESSION_ID = session;
  return execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env }).trim();
};

// runFail() expects a non-zero exit; returns the captured stderr.
const runFail = (args, { session } = {}) => {
  try {
    run(args, { session });
    throw new Error('expected command to fail but it exited 0');
  } catch (e) {
    if (!('status' in e) || e.status === 0) throw e;
    return String(e.stderr || '');
  }
};

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

test('init refuses an empty session id', () => {
  const err = runFail(['init', repo('empty-init'), '']);
  assert.match(err, /empty session id/);
});

test('resolve creates the canonical doc for $CLAUDE_CODE_SESSION_ID', () => {
  const REPO = repo('resolve');
  const p = run(['resolve', REPO], { session: 'sess-R' });
  assert.ok(existsSync(p));
  assert.match(readFileSync(p, 'utf8'), /claude_session: sess-R/);
  // resolve is idempotent and matches the path init would compute for that session.
  const again = run(['resolve', REPO], { session: 'sess-R' });
  assert.equal(again, p, 're-resolve returns the same canonical path');
  const viaPath = run(['path', REPO, 'sess-R']);
  assert.equal(viaPath, p, 'resolve and path agree on the canonical file');
});

test('resolve refuses when $CLAUDE_CODE_SESSION_ID is unset', () => {
  const err = runFail(['resolve', repo('resolve-empty')]);
  assert.match(err, /empty session id/);
});

test('two sessions in the same repo get distinct docs', () => {
  const REPO = repo('distinct');
  const a = run(['init', REPO, 'sess-A']);
  const b = run(['init', REPO, 'sess-B']);
  assert.notEqual(a, b);
  const rows = run(['list', REPO]).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, 'list returns exactly the two docs for this cwd');
});

test('ready flips status to results-ready for the owning session', () => {
  const p = run(['init', repo('ready'), 'sess-C']);
  run(['ready', p], { session: 'sess-C' });
  assert.match(readFileSync(p, 'utf8'), /status: results-ready/);
});

test('status sets an arbitrary status value for the owning session', () => {
  const p = run(['init', repo('status'), 'sess-S']);
  run(['status', p, 'blocked'], { session: 'sess-S' });
  assert.match(readFileSync(p, 'utf8'), /status: blocked/);
});

test('status/ready REFUSE a write from a different session (the tripwire)', () => {
  const p = run(['init', repo('guard'), 'sess-OWNER']);
  const err = runFail(['ready', p], { session: 'sess-INTRUDER' });
  assert.match(err, /refusing/);
  assert.match(err, /sess-OWNER/);
  assert.match(err, /sess-INTRUDER/);
  // The doc must be untouched — still dispatched, not results-ready.
  assert.match(readFileSync(p, 'utf8'), /status: dispatched/);
});

test('--steal lets a different session override the ownership guard', () => {
  const p = run(['init', repo('steal'), 'sess-OWNER']);
  run(['ready', p, '--steal'], { session: 'sess-INTRUDER' });
  assert.match(readFileSync(p, 'utf8'), /status: results-ready/);
});

test('status refuses when the caller session is unknown', () => {
  const p = run(['init', repo('guard-empty'), 'sess-OWNER']);
  const err = runFail(['ready', p]); // no session in env
  assert.match(err, /empty session id/);
});

test('reattach refreshes claude_session for the same session and returns the path', () => {
  const p = run(['init', repo('reattach-same'), 'sess-D']);
  const r = run(['reattach', p, 'sess-D']);
  assert.equal(r, p, 'same-session reattach keeps the same path');
  assert.match(readFileSync(p, 'utf8'), /claude_session: sess-D/);
});

test('reattach to a doc owned by another session requires --steal', () => {
  const p = run(['init', repo('reattach-steal'), 'sess-OLD']);
  const err = runFail(['reattach', p, 'sess-NEW']);
  assert.match(err, /refusing to reattach/);
  assert.match(readFileSync(p, 'utf8'), /claude_session: sess-OLD/, 'unchanged on refusal');
  assert.ok(existsSync(p), 'file not moved on refusal');
});

test('steal-reattach renames to the new session canonical path and resolve agrees', () => {
  const REPO = repo('reattach-rename');
  const p = run(['init', REPO, 'sess-OLD']);
  const dest = run(['reattach', p, 'sess-NEW', '--steal']);
  assert.notEqual(dest, p, 'file moved to the new session token');
  assert.ok(!existsSync(p), 'old-token file gone');
  assert.ok(existsSync(dest));
  assert.match(readFileSync(dest, 'utf8'), /claude_session: sess-NEW/);
  // The whole point: resolve for the new session returns the reattached doc,
  // not a fresh empty one.
  const resolved = run(['resolve', REPO], { session: 'sess-NEW' });
  assert.equal(resolved, dest, 'resolve after steal-reattach returns the same file');
});

test('reattach refuses to clobber an existing doc for the target session', () => {
  const REPO = repo('reattach-clobber');
  const pOld = run(['init', REPO, 'sess-OLD']);
  run(['init', REPO, 'sess-NEW']); // a real doc already exists for sess-NEW
  const err = runFail(['reattach', pOld, 'sess-NEW', '--steal']);
  assert.match(err, /already exists/);
  assert.ok(existsSync(pOld), 'source untouched when clobber would occur');
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
