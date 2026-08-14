// test_handoff.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  // A doc existing is not a builder running: creation lands on `specced`, and
  // the architect flips it to `dispatched` when it actually dispatches.
  assert.match(body, /status: specced/);
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

test('status sets a known status value for the owning session', () => {
  const p = run(['init', repo('status'), 'sess-S']);
  run(['status', p, 'blocked'], { session: 'sess-S' });
  assert.match(readFileSync(p, 'utf8'), /status: blocked/);
});

// `status` used to accept anything. `handoff.mjs status <path>` with the value
// omitted wrote `status: undefined` and exited 0 — which is invisible to the
// wait bridge, so it waits forever on a slice that already reported.
test('status REFUSES a missing value instead of writing `undefined`', () => {
  const p = run(['init', repo('status-missing'), 'sess-M']);
  const err = runFail(['status', p], { session: 'sess-M' });
  assert.match(err, /needs a value/);
  assert.doesNotMatch(readFileSync(p, 'utf8'), /status: undefined/);
  assert.match(readFileSync(p, 'utf8'), /status: specced/, 'doc untouched on refusal');
});

test('status REFUSES an unknown value', () => {
  const p = run(['init', repo('status-bogus'), 'sess-B']);
  const err = runFail(['status', p, 'in-progress'], { session: 'sess-B' });
  assert.match(err, /not a valid status/);
  assert.match(err, /results-ready/, 'error lists the valid vocabulary');
  assert.match(readFileSync(p, 'utf8'), /status: specced/, 'doc untouched on refusal');
});

test('status accepts every terminal state so a finished slice can land', () => {
  const p = run(['init', repo('status-terminal'), 'sess-T']);
  for (const s of ['accepted', 'rejected', 'merged', 'abandoned']) {
    run(['status', p, s], { session: 'sess-T' });
    assert.match(readFileSync(p, 'utf8'), new RegExp(`status: ${s}`));
  }
});

test('blocked flips status to blocked for the owning session', () => {
  const p = run(['init', repo('blocked'), 'sess-BLK']);
  run(['blocked', p], { session: 'sess-BLK' });
  assert.match(readFileSync(p, 'utf8'), /status: blocked/);
});

test('blocked REFUSES a write from a different session', () => {
  const p = run(['init', repo('blocked-guard'), 'sess-OWNER']);
  const err = runFail(['blocked', p], { session: 'sess-INTRUDER' });
  assert.match(err, /refusing/);
  assert.match(readFileSync(p, 'utf8'), /status: specced/);
});

test('status/ready REFUSE a write from a different session (the tripwire)', () => {
  const p = run(['init', repo('guard'), 'sess-OWNER']);
  const err = runFail(['ready', p], { session: 'sess-INTRUDER' });
  assert.match(err, /refusing/);
  assert.match(err, /sess-OWNER/);
  assert.match(err, /sess-INTRUDER/);
  // The doc must be untouched — still specced, not results-ready.
  assert.match(readFileSync(p, 'utf8'), /status: specced/);
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

// prune() only ever knew .md/.state, so every dispatch leaked its sidecars.
// A stale .builder holding a recycled pid makes a dead builder read as alive.
test('prune sweeps sidecars orphaned by a deleted doc, and spares live ones', () => {
  const live = run(['init', repo('prune-sidecar'), 'sess-LIVE']);
  const dead = run(['init', repo('prune-sidecar-dead'), 'sess-DEAD']);
  for (const base of [live, dead]) {
    for (const s of ['.builder', '.activity', '.turn-ended']) writeFileSync(`${base}${s}`, '123\n');
  }
  run(['end', dead]); // doc gone, sidecars left behind
  run(['prune']);
  for (const s of ['.builder', '.activity', '.turn-ended']) {
    assert.ok(!existsSync(`${dead}${s}`), `orphaned ${s} reaped`);
    assert.ok(existsSync(`${live}${s}`), `${s} of a live doc spared`);
  }
});

test('section get returns one section body', () => {
  const p = run(['init', repo('sec-get'), 'sess-SG']);
  const out = run(['section', 'get', p, 'Gate results']);
  assert.match(out, /ONLY section the architect grades/);
  assert.doesNotMatch(out, /Work summary/, 'stops at the next heading');
});

test('section append adds to a section without disturbing its neighbours', () => {
  const p = run(['init', repo('sec-append'), 'sess-SA']);
  run(['section', 'append', p, 'Decisions + why', '--text', '- RULING: accept the asset contract.'],
    { session: 'sess-SA' });
  run(['section', 'append', p, 'Decisions + why', '--text', '- RULING: reject the hash bump.'],
    { session: 'sess-SA' });
  const body = readFileSync(p, 'utf8');
  assert.match(body, /- RULING: accept the asset contract\./);
  assert.match(body, /- RULING: reject the hash bump\./);
  assert.match(body, /## Open disagreements/, 'following heading intact');
  assert.match(body, /## Frozen gates/, 'preceding heading intact');
  const seg = run(['section', 'get', p, 'Open disagreements']);
  assert.doesNotMatch(seg, /RULING/, 'content landed in the right section only');
});

test('section set replaces a body; section clear empties it', () => {
  const p = run(['init', repo('sec-set'), 'sess-SS']);
  run(['section', 'set', p, 'Gate results', '--text', 'G1 pass 2312/0/0 — composer test'],
    { session: 'sess-SS' });
  assert.match(run(['section', 'get', p, 'Gate results']), /^G1 pass 2312\/0\/0/m);
  assert.doesNotMatch(readFileSync(p, 'utf8'), /ONLY section the architect grades/);
  run(['section', 'clear', p, 'Gate results'], { session: 'sess-SS' });
  assert.equal(run(['section', 'get', p, 'Gate results']), '');
});

test('section writes are ownership-guarded like status writes', () => {
  const p = run(['init', repo('sec-guard'), 'sess-OWNER']);
  const err = runFail(['section', 'append', p, 'Decisions + why', '--text', 'x'],
    { session: 'sess-INTRUDER' });
  assert.match(err, /refusing/);
  assert.doesNotMatch(readFileSync(p, 'utf8'), /^x$/m);
});

test('section names the sections present when the heading is unknown', () => {
  const p = run(['init', repo('sec-missing'), 'sess-SM']);
  const err = runFail(['section', 'get', p, 'Nope'], { session: 'sess-SM' });
  assert.match(err, /no "## Nope" section/);
  assert.match(err, /Frozen gates/);
});
