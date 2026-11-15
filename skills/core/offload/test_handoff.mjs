// test_handoff.mjs
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
// with no session in the env (to exercise the empty-id guard). { env } adds the
// variables a dispatched builder carries ($OFFLOAD_HANDOFF, $OFFLOAD_SESSION_ID).
// The env is built from PATH, HOME, TMPDIR and the test's own variables, so a suite
// run inside a builder stays hermetic: nothing ambient reaches the CLI.
const baseEnv = () => ({ PATH: process.env.PATH, HOME: BOX, TMPDIR: tmpdir(), AGENT_HANDOFFS_DIR: BOX });
const run = (args, { session, env: extra = {} } = {}) => {
  const env = baseEnv();
  if (session !== undefined) env.CLAUDE_CODE_SESSION_ID = session;
  Object.assign(env, extra);
  return execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env }).trim();
};

// runFail() expects a non-zero exit; returns the captured stderr.
const runFail = (args, { session, env } = {}) => {
  try {
    run(args, { session, env });
    throw new Error('expected command to fail but it exited 0');
  } catch (e) {
    if (!('status' in e) || e.status === 0) throw e;
    return String(e.stderr || '');
  }
};

// Each test gets its own cwd subdir so docs from one test never leak into
// another's listFiles() (which keys on the cwd hash).
const repo = (name) => join(BOX, `repo-${name}`);

// A git repo with one commit. `ready` checks a doc's `Head:` line against the
// HEAD of the worktree its `cwd:` names, so a doc that must reach results-ready
// needs a real repo there. git() commits with a fixed identity and no signing.
const GIT_ENV = { PATH: process.env.PATH, HOME: BOX, TMPDIR: tmpdir(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();
const commit = (dir, msg) => { git(dir, 'commit', '-q', '--allow-empty', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
const gitRepo = (name) => {
  const dir = repo(name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  return { dir, head: commit(dir, 'base') };
};

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
  const { dir, head } = gitRepo('ready');
  const p = run(['init', dir, 'sess-C']);
  run(['section', 'set', p, 'Gate results', '--text', `Head: ${head}`], { session: 'sess-C' });
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

// Claude Code replaces an inherited $CLAUDE_CODE_SESSION_ID with the builder's
// own session id inside its tool calls, so a Claude builder can never present
// the architect's id there. dispatch.sh carries it in $OFFLOAD_SESSION_ID too,
// scoped to the one doc it handed the builder in $OFFLOAD_HANDOFF.
test('a builder writes its assigned handoff with the carried architect id', () => {
  const { dir, head } = gitRepo('carried');
  const p = run(['init', dir, 'sess-ARCH']);
  const builder = { session: 'sess-BUILDER', env: { OFFLOAD_HANDOFF: p, OFFLOAD_SESSION_ID: 'sess-ARCH' } };
  run(['section', 'set', p, 'Gate results', '--text', `Head: ${head}\nPASS 3/3`], builder);
  run(['ready', p], builder);
  const body = readFileSync(p, 'utf8');
  assert.match(body, /status: results-ready/);
  assert.match(body, /PASS 3\/3/);
  assert.match(body, /claude_session: sess-ARCH/, 'ownership is unchanged by the write');
});

test('the carried id matches the assigned handoff however its path is spelled', () => {
  const p = run(['init', repo('carried-spelling'), 'sess-ARCH']);
  const spelled = join(dirname(p), '.', basename(p));
  run(['blocked', p], { session: 'sess-BUILDER', env: { OFFLOAD_HANDOFF: spelled, OFFLOAD_SESSION_ID: 'sess-ARCH' } });
  assert.match(readFileSync(p, 'utf8'), /status: blocked/);
});

test('the carried id opens only the assigned handoff, never another doc', () => {
  const mine = run(['init', repo('carried-mine'), 'sess-ARCH']);
  const other = run(['init', repo('carried-other'), 'sess-ARCH']);
  const builder = { session: 'sess-BUILDER', env: { OFFLOAD_HANDOFF: mine, OFFLOAD_SESSION_ID: 'sess-ARCH' } };
  const err = runFail(['ready', other], builder);
  assert.match(err, /refusing/);
  assert.match(err, /sess-BUILDER/);
  const errSection = runFail(['section', 'set', other, 'Gate results', '--text', 'x'], builder);
  assert.match(errSection, /refusing/);
  assert.match(readFileSync(other, 'utf8'), /status: specced/);
});

test('the carried id is ignored without an assigned handoff', () => {
  const p = run(['init', repo('carried-unassigned'), 'sess-ARCH']);
  const err = runFail(['ready', p], { session: 'sess-BUILDER', env: { OFFLOAD_SESSION_ID: 'sess-ARCH' } });
  assert.match(err, /refusing/);
  assert.match(readFileSync(p, 'utf8'), /status: specced/);
});

test('a carried id that does not own the assigned handoff is still refused', () => {
  const p = run(['init', repo('carried-wrong'), 'sess-ARCH']);
  const err = runFail(['ready', p], { session: 'sess-BUILDER', env: { OFFLOAD_HANDOFF: p, OFFLOAD_SESSION_ID: 'sess-OTHER' } });
  assert.match(err, /refusing/);
  assert.match(err, /sess-OTHER/);
  assert.match(readFileSync(p, 'utf8'), /status: specced/);
});

test('--steal lets a different session override the ownership guard', () => {
  const { dir, head } = gitRepo('steal');
  const p = run(['init', dir, 'sess-OWNER']);
  run(['section', 'set', p, 'Gate results', '--text', `Head: ${head}`], { session: 'sess-OWNER' });
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

const codexId = '01a16a67-f178-70e2-9b40-c0babe791262';
const codexEnv = { CODEX_SESSION_ID: codexId };
test('Codex owns a stable namespaced handoff without pretending to be Claude', () => {
  const { dir: cwd, head } = gitRepo('codex-native');
  const p = run(['resolve', cwd], { env: codexEnv });
  assert.equal(run(['resolve', cwd], { env: codexEnv }), p);
  assert.equal(run(['key'], { env: codexEnv }), `codex:${codexId}`);
  const body = readFileSync(p, 'utf8');
  assert.match(body, new RegExp(`architect_session: codex:${codexId}`));
  assert.doesNotMatch(body, new RegExp(`claude_session: .*${codexId}`));
  run(['section', 'set', p, 'Gate results', '--text', `Head: ${head}`], { env: codexEnv });
  run(['ready', p], { env: codexEnv });
  assert.match(readFileSync(p, 'utf8'), /status: results-ready/);
  const other = run(['resolve', cwd], { session: codexId });
  assert.notEqual(p, other);
  assert.match(runFail(['ready', p], { session: codexId }), /wrong-document/);
});
test('Codex carries ownership only for its assigned builder handoff', () => {
  const { dir, head } = gitRepo('codex-builder');
  const mine = run(['resolve', dir], { env: codexEnv });
  const foreign = run(['init', repo('codex-foreign'), 'foreign']);
  const builder = { session: 'builder', env: { OFFLOAD_HANDOFF: mine, OFFLOAD_SESSION_ID: `codex:${codexId}` } };
  run(['section', 'set', mine, 'Gate results', '--text', `Head: ${head}`], builder);
  run(['ready', mine], builder);
  assert.match(runFail(['ready', foreign], builder), /wrong-document/);
});
test('Codex ledger and board use the same native key', () => {
  const cwd = repo('codex-ledger');
  run(['ledger', 'init', cwd, 'native goal'], { env: codexEnv });
  run(['ledger', 'add', cwd, '--id', 'one', '--title', 'first'], { env: codexEnv });
  const ledger = JSON.parse(run(['ledger', 'show', cwd], { env: codexEnv }));
  assert.equal(ledger.session, `codex:${codexId}`);
  assert.equal(ledger.slices[0].id, 'one');
  assert.match(run(['board', cwd, '--no-git', '--no-pane'], { env: codexEnv }), /first/);
});
test('missing native identity still fails closed and malformed Codex ids cannot escape the directory', () => {
  assert.match(runFail(['resolve', repo('no-native')]), /empty session id/);
  for (const id of ['../foreign', 'bad\nid', 'bad/id']) {
    assert.match(runFail(['resolve', repo('bad-native')], { env: { CODEX_SESSION_ID: id } }), /invalid Codex session id/);
  }
});
test('real Claude identity takes precedence over inherited Codex environment', () => {
  assert.equal(run(['key'], { session: 'actual-claude', env: codexEnv }), 'actual-claude');
});

test('updateDoc retries on a concurrent write instead of dropping it, and leaves no temp file', async () => {
  // The architect writes Next slice into a warm builder's doc while that
  // builder may be writing Gate results: neither edit may be lost.
  const { updateDoc } = await import('./handoff.mjs');
  const { readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'ofl-cas-'));
  const p = join(dir, 'doc.md');
  writeFileSync(p, 'status: dispatched\n## Gate results\n\n## Next slice\n\n');
  let calls = 0;
  updateDoc(p, (b) => {
    calls += 1;
    // First attempt: another writer lands between this read and the write.
    if (calls === 1) writeFileSync(p, b.replace('## Gate results\n', '## Gate results\nG1 pass\n'));
    return b.replace('## Next slice\n', '## Next slice\ncorrective\n');
  });
  const out = readFileSync(p, 'utf8');
  assert.equal(calls, 2, 'the change was re-applied to the fresh text');
  assert.match(out, /G1 pass/, 'the other writer\'s edit survived');
  assert.match(out, /corrective/);
  assert.deepEqual(readdirSync(dir), ['doc.md'], 'no temp file left behind');
  rmSync(dir, { recursive: true, force: true });
});

// --- coverage: every frozen criterion ID needs a line under Gate results ------
// Everything below drives the CLI; the parser has no export. Each row is a
// frozen-gates body and a gate-results body, with the IDs `coverage` must print
// (one per line, in frozen order) and the exit code that follows from them.

// spawnSync keeps the exit code, stdout and stderr together, which runFail() drops.
const cli = (args, { session, env: extra = {} } = {}) => {
  const env = baseEnv();
  if (session !== undefined) env.CLAUDE_CODE_SESSION_ID = session;
  Object.assign(env, extra);
  const r = spawnSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

let docN = 0;
// A doc with frontmatter, Frozen gates and Gate results; eol '\r\n' makes a CRLF doc.
function mkDoc(frozen, results, { eol = '\n', status = 'dispatched', owner = 's', cwd, fm = [] } = {}) {
  const p = join(BOX, `cov-${++docN}.md`);
  const head = ['---', ...(cwd ? [`cwd: ${cwd}`] : []), ...fm, `claude_session: ${owner}`, `status: ${status}`, 'updated: x', '---', ''];
  const body = [...head, '## Frozen gates', frozen, '## Gate results', results, ''];
  writeFileSync(p, body.join('\n').replace(/\n/g, eol));
  return p;
}

const ids = (out) => out.split('\n').filter(Boolean);
const TEMPLATE_COMMENT = '<!-- Success criteria, frozen BEFORE results exist. Never edit after freezing. -->';
const COVERAGE_ROWS = [
  // [name, frozen, results, expected missing IDs]
  ['C13a a missing ID is printed, a covered one is not', 'C1: a\nC2: b\n', 'C1: pass\n', ['C2']],
  ['C13b full coverage exits 0 and NOT MET counts as a line', 'C1: a\nC2: b\n', 'C1: pass\nC2: NOT MET because x\n', []],
  ['C13f comment-only Frozen gates freezes nothing', `${TEMPLATE_COMMENT}\n`, '', []],
  ['C14a every allowed first-token prefix covers', 'C1: a\nC2: b\nC3: c\nC4: d\nC5: e\nC6: f\n', '- C1: p\n* C2: p\n1. C3: p\n| C4 | p |\n**C5**: p\n`C6`: p\n', []],
  ['C14b a mid-line mention does not cover', 'C1: a\n', 'Same as C1: pass\n', ['C1']],
  ['C14c frozen-side IDs count only as first tokens', 'C1: a, same as C2\n', 'C1: p\n', []],
  ['C14d token boundary: C10 does not cover C1', 'C1: a\nC10: b\n', 'C10: p\n', ['C1']],
  ['C14e IDs are case-sensitive on the results side', 'C1: a\n', 'c1: p\nCP-01: p\n', ['C1']],
  ['C14e IDs are case-sensitive on the frozen side', 'CP-01: a\nc2: b\n', '', []],
  ['C14f a single-line comment does not cover', 'C1: a\n', '<!-- C1: pass -->\n', ['C1']],
  ['C14g a multi-line comment in Frozen gates freezes nothing', 'C1: a\n<!--\nC9: x\n-->\n', 'C1: p\n', []],
  ['C14h a multi-line comment in Gate results does not cover', 'C1: a\n', '<!--\nC1: p\n-->\n', ['C1']],
  ['C14i duplicates are removed', 'C1: a\nC1: again\nC2: b\n', '', ['C1', 'C2']],
  ['C14l a parent is covered by all its sub-IDs', '**C1 Diff scope.**\n- C1a: x\n- C1b: y\n', 'C1a: p\nC1b: p\n', []],
  ['C14m one missing sub-ID is reported, not the parent', '**C1 Diff scope.**\n- C1a: x\n- C1b: y\n', 'C1a: p\n', ['C1b']],
  ['C14n a parent line alone covers no sub-ID', '**C1 Diff scope.**\n- C1a: x\n- C1b: y\n', 'C1: p\n', ['C1a', 'C1b']],
  ['C14o a sub-ID line does not cover a parent with no frozen sub-IDs', 'C1: a\n', 'C1a: p\n', ['C1']],
  ['C14p a hyphen range covers nothing', 'C1a: x\nC1b: y\nC2: z\n', 'C1a-C2: pass\n', ['C1a', 'C1b', 'C2']],
  ['C14q an en-dash range covers nothing', 'C1: a\nC2: b\nC3: c\n', 'C1–C3: pass\n', ['C1', 'C2', 'C3']],
  ['G4 a comma list covers nothing', 'C3: a\nC5b: b\n', 'C3, C5b: pass\n', ['C3', 'C5b']],
  ['G4 a slash list covers nothing', 'C1: a\nC2: b\n', 'C1/C2: pass\n', ['C1', 'C2']],
  ['G4 an "and" list covers nothing', 'C1: a\nC2: b\n', 'C1 and C2: pass\n', ['C1', 'C2']],
  ['G4 a multi-ID line freezes nothing on the frozen side', 'C1 and C2: a\nC3: b\n', 'C3: p\n', []],
  ['G4 bold ID with a title still counts', '**C4 Diff scope.**\n', '', ['C4']],
  ['G2 leading whitespace is accepted', '  C1: a\n\t- C2: b\n', '   C1: p\n', ['C2']],
  // A <!-- opens a comment only at the start of a line. A criterion that quotes it mid-line must not hide the lines after it.
  ['B1 a <!-- inside a code span hides nothing', 'C1: uses `<!--` here\nC2: b\n', 'C1: p\n', ['C2']],
  ['B1 a mid-line opener closed on a later line is not a comment', 'C1: a <!-- note\nC2: b\nC3: c -->\n', 'C1: p\n', ['C2', 'C3']],
  ['B1 a mid-line closer joins nothing onto the next line', 'C1: a <!-- note\nx -->C2: b\n', '', ['C1']],
  ['B1 an unclosed line-start comment ends at the next blank line', 'C1: a\n<!-- unclosed\nC9: hidden\n\nC2: b\n', '', ['C1', 'C2']],
  ['B1 a closed multi-line comment hides its own blank lines', 'C1: a\n<!--\nnote\n\nC9: hidden\n-->\nC2: b\n', '', ['C1', 'C2']],
  ['B1 an indented line-start comment is a comment', 'C1: a\n   <!-- C9: x -->\nC2: b\n', '', ['C1', 'C2']],
  ['B1 results side: a <!-- in a code span does not hide later lines', 'C1: a\nC2: b\n', 'C1: p `<!--`\nC2: p\n', []],
  // A leading ID followed by another ID (space, comma, semicolon, slash, dash, and, or, to, through) counts for no ID.
  ['B2 "C1 C2:" covers none', 'C1: a\nC2: b\nC3: c\n', 'C1 C2: pass\n', ['C1', 'C2', 'C3']],
  ['B2 "C1; C2:" covers none', 'C1: a\nC2: b\nC3: c\n', 'C1; C2: pass\n', ['C1', 'C2', 'C3']],
  ['B2 "C1 to C3:" covers none', 'C1: a\nC2: b\nC3: c\n', 'C1 to C3: pass\n', ['C1', 'C2', 'C3']],
  ['B2 "C1 through C3:" covers none', 'C1: a\nC2: b\nC3: c\n', 'C1 through C3: pass\n', ['C1', 'C2', 'C3']],
  ['B2 a joined first token freezes nothing on the frozen side', 'C1 C2: a\nC3: b\n', 'C3: p\n', []],
];
for (const [name, frozen, results, missing] of COVERAGE_ROWS) {
  test(`coverage: ${name}`, () => {
    const p = mkDoc(frozen, results);
    const r = cli(['coverage', p]);
    assert.deepEqual(ids(r.out), missing, 'stdout lists exactly the missing IDs, one per line, in frozen order');
    assert.equal(r.code, missing.length ? 4 : 0);
    if (missing.length) assert.match(r.err, /^incomplete:/, 'the message goes to stderr');
  });
}

test('coverage: CRLF docs fail closed and pass when covered', () => {
  const miss = cli(['coverage', mkDoc('C1: a\nC2: b\n', 'C1: p\n', { eol: '\r\n' })]);
  assert.deepEqual(ids(miss.out), ['C2']);
  assert.equal(miss.code, 4);
  const ok = cli(['coverage', mkDoc('C1: a\nC2: b\n', 'C1: p\nC2: p\n', { eol: '\r\n' })]);
  assert.equal(ok.out, '');
  assert.equal(ok.code, 0);
});

test('coverage: no Frozen gates section, or IDs without a Gate results section', () => {
  const none = join(BOX, 'cov-nofrozen.md');
  writeFileSync(none, '## Gate results\nC1: pass\n');
  assert.equal(cli(['coverage', none]).code, 0, 'no Frozen gates section behaves as today');
  const nores = join(BOX, 'cov-nores.md');
  writeFileSync(nores, '## Frozen gates\nC1: a\nC2: b\n');
  const r = cli(['coverage', nores]);
  assert.deepEqual(ids(r.out), ['C1', 'C2']);
  assert.equal(r.code, 4);
});

test('coverage: read-only, needs no session, and a missing path is neither 0 nor 4', () => {
  const p = mkDoc('C1: a\n', '', { owner: 'someone-else' });
  const before = readFileSync(p, 'utf8');
  const r = cli(['coverage', p]);
  assert.equal(r.code, 4, 'runs with no session and from a foreign owner');
  assert.equal(readFileSync(p, 'utf8'), before, 'the doc is untouched');
  const gone = cli(['coverage', '/nonexistent/x.md']);
  assert.ok(![0, 4].includes(gone.code), `exit ${gone.code}`);
  assert.match(gone.err, /\/nonexistent\/x\.md/);
});

test('coverage is listed in the CLI usage', () => {
  assert.match(cli([]).err, /coverage/);
});

// --- ready / status results-ready take the same gate ---------------------------
const incompleteDoc = (opts) => mkDoc('C1: a\n', '', opts);
const tmpFiles = (p) => readdirSync(dirname(p)).filter((f) => f.startsWith(`${basename(p)}.tmp-`));

test('ready refuses an incomplete doc with exit 4, an incomplete: message and no write', () => {
  const p = incompleteDoc();
  const before = readFileSync(p, 'utf8');
  const r = cli(['ready', p], { session: 's' });
  assert.equal(r.code, 4);
  assert.ok(r.err.startsWith('incomplete:'), r.err);
  assert.doesNotMatch(r.err, /refusing/);
  assert.match(r.err, /C1/);
  assert.ok(r.err.includes('add one line per criterion: evidence, NOT MET or NOT RUN with the reason'));
  assert.match(r.err, /one line per ID/i);
  assert.equal(readFileSync(p, 'utf8'), before, 'status and updated are not bumped');
  assert.deepEqual(tmpFiles(p), [], 'no temp file left');
});

test('status results-ready takes the same gate as ready', () => {
  const p = incompleteDoc();
  const before = readFileSync(p, 'utf8');
  const r = cli(['status', p, 'results-ready'], { session: 's' });
  assert.equal(r.code, 4);
  assert.equal(readFileSync(p, 'utf8'), before);
});

test('--steal skips ownership only, never coverage', () => {
  const p = incompleteDoc();
  const r = cli(['ready', p, '--steal'], { session: 'other' });
  assert.equal(r.code, 4);
  assert.match(readFileSync(p, 'utf8'), /status: dispatched/);
});

test('ownership is checked before coverage', () => {
  const p = incompleteDoc();
  const r = cli(['ready', p], { session: 'other' });
  assert.equal(r.code, 1);
  assert.match(r.err, /^refusing/);
});

test('a dispatched builder with the carried id gets the coverage refusal', () => {
  const p = incompleteDoc();
  const r = cli(['ready', p], { session: 'builder', env: { OFFLOAD_HANDOFF: p, OFFLOAD_SESSION_ID: 's' } });
  assert.equal(r.code, 4);
});

test('a covered doc is still marked results-ready', () => {
  const p = mkDoc('C1: a\n', 'C1: pass\n');
  assert.equal(cli(['ready', p], { session: 's' }).code, 0);
  assert.match(readFileSync(p, 'utf8'), /status: results-ready/);
});

test('only results-ready is gated: blocked and every other status still write', () => {
  for (const status of ['blocked', 'dispatched', 'returned', 'accepted']) {
    const p = incompleteDoc();
    const r = cli(status === 'blocked' ? ['blocked', p] : ['status', p, status], { session: 's' });
    assert.equal(r.code, 0, `${status}: ${r.err}`);
    assert.match(readFileSync(p, 'utf8'), new RegExp(`status: ${status}`));
  }
});

test('a CRLF doc that is incomplete is refused by ready', () => {
  const p = incompleteDoc({ eol: '\r\n' });
  const before = readFileSync(p, 'utf8');
  const r = cli(['ready', p], { session: 's' });
  assert.equal(r.code, 4);
  assert.equal(readFileSync(p, 'utf8'), before);
});

// --- the gate head: ready refuses evidence from an earlier commit -------------
test('ready refuses a worktree doc with no Head line: exit 5, stale:, no write', () => {
  const { dir, head } = gitRepo('head-missing');
  const p = mkDoc('C1: a\n', 'C1: pass\n', { cwd: dir });
  const before = readFileSync(p, 'utf8');
  const r = cli(['ready', p], { session: 's' });
  assert.equal(r.code, 5);
  assert.ok(r.err.startsWith('stale:'), r.err);
  assert.match(r.err, /no `Head: <sha>` line/);
  assert.ok(r.err.includes(head.slice(0, 12)), 'names the worktree HEAD');
  assert.equal(readFileSync(p, 'utf8'), before);
});

test('ready refuses a Head line that names an earlier commit', () => {
  const { dir, head: old } = gitRepo('head-old');
  const now = commit(dir, 'late edit');
  const p = mkDoc('C1: a\n', `Head: ${old.slice(0, 10)}\nC1: pass\n`, { cwd: dir });
  const r = cli(['ready', p], { session: 's' });
  assert.equal(r.code, 5);
  assert.ok(r.err.includes(old.slice(0, 10)), r.err);
  assert.ok(r.err.includes(now.slice(0, 12)), r.err);
  assert.match(readFileSync(p, 'utf8'), /status: dispatched/);
});

test('one stale Head line among current ones still refuses', () => {
  const { dir, head: old } = gitRepo('head-mixed');
  const now = commit(dir, 'late edit');
  const p = mkDoc('C1: a\n', `Head: ${now}\n- Head: ${old}\nC1: pass\n`, { cwd: dir });
  assert.equal(cli(['ready', p], { session: 's' }).code, 5);
});

test('a short, bold, backticked or upper-case Head prefix of HEAD passes', () => {
  const { dir, head } = gitRepo('head-forms');
  for (const line of [`Head: ${head.slice(0, 7)}`, `**Head:** \`${head.slice(0, 12)}\``, `- Head: ${head.toUpperCase()}`]) {
    const p = mkDoc('C1: a\n', `${line}\nC1: pass\n`, { cwd: dir });
    const r = cli(['ready', p], { session: 's' });
    assert.equal(r.code, 0, `${line}: ${r.err}`);
    assert.match(readFileSync(p, 'utf8'), /status: results-ready/);
  }
});

test('a Head line inside a comment or mid-line does not count', () => {
  const { dir, head } = gitRepo('head-comment');
  for (const results of [`<!-- Head: ${head} -->\nC1: pass\n`, `C1: pass at Head: ${head}\n`, `Head: ${head} (after rebase)\nC1: pass\n`]) {
    const p = mkDoc('C1: a\n', results, { cwd: dir });
    assert.equal(cli(['ready', p], { session: 's' }).code, 5, results);
  }
});

test('a work tree with no commit refuses instead of passing', () => {
  const dir = repo('head-unborn');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  const p = mkDoc('C1: a\n', 'Head: abcdef1\nC1: pass\n', { cwd: dir });
  const r = cli(['ready', p], { session: 's' });
  assert.equal(r.code, 5);
  assert.match(r.err, /cannot read HEAD/);
});

test('a cwd that is not a git work tree has no head to check', () => {
  const dir = repo('head-not-git');
  mkdirSync(dir, { recursive: true });
  for (const cwd of [dir, repo('head-missing-dir')]) {
    const p = mkDoc('C1: a\n', 'C1: pass\n', { cwd });
    assert.equal(cli(['ready', p], { session: 's' }).code, 0, cwd);
  }
});

test('a cwd line in the body is not the frontmatter cwd', () => {
  const p = mkDoc('C1: a\n', `cwd: ${repo('nowhere')}\nC1: pass\n`);
  assert.equal(cli(['ready', p], { session: 's' }).code, 0);
});

test('coverage reports missing IDs first (exit 4), then a stale head (exit 5)', () => {
  const { dir, head } = gitRepo('head-coverage');
  assert.equal(cli(['coverage', mkDoc('C1: a\n', '', { cwd: dir })]).code, 4);
  const stale = cli(['coverage', mkDoc('C1: a\n', 'C1: pass\n', { cwd: dir })]);
  assert.equal(stale.code, 5);
  assert.ok(stale.err.startsWith('stale:'), stale.err);
  assert.equal(cli(['coverage', mkDoc('C1: a\n', `Head: ${head}\nC1: pass\n`, { cwd: dir })]).code, 0);
});

// --- X6 / C25: a Carried: line is not a Head: line -------------------------------

test('C25: a Carried: line beside the current Head: line never trips stale', () => {
  const { dir, head } = gitRepo('carried');
  const older = commit(dir, 'later work');
  const p = mkDoc('C1: a\n', `Head: ${older}\nCarried: ${head} — G5\nC1: pass\n`, { cwd: dir });
  assert.equal(cli(['coverage', p]).code, 0);
  assert.equal(cli(['ready', p], { session: 's' }).code, 0);
});

// --- X2 / PS-04: `rulings` checks that every bar-changing ruling is backed by a criterion ---

const BAR_BLOCK = [
  '# Slice B', '', 'Execute the slice.', 'Acceptance:', 'C1: first criterion', 'C2a: a sub criterion', 'C2b: another',
  '', 'Gates: G1 `make test`', 'C9: named after Gates, in prose', 'The slice owns C8: not an Acceptance line.', '',
].join('\n');
let rulingN = 0;
const rulingsDocs = (decisions, block = BAR_BLOCK, eol = '\n') => {
  const n = ++rulingN;
  const d = join(BOX, `decisions-${n}.md`);
  const b = join(BOX, `block-${n}.md`);
  writeFileSync(d, `# Decisions\n\n${decisions}\n`.replace(/\n/g, eol));
  writeFileSync(b, block.replace(/\n/g, eol));
  return [d, b];
};
const rulings = (decisions, { slice = 'B', block, eol } = {}) => {
  const [d, b] = rulingsDocs(decisions, block, eol);
  return cli(['rulings', d, b, ...(slice === null ? [] : ['--slice', slice])]);
};
const unbackedLines = (r) => r.err.split('\n').filter((l) => l.startsWith('unbacked: '));

test('C7a: rulings exits 0 with empty stderr when every slice-B marker names IDs that lead an Acceptance line', () => {
  const r = rulings('Changes the bar (slice B): C1\n- **Changes the bar (slice B):** C1, C2a\n* Changes the bar (slice B): C2');
  assert.deepEqual([r.code, r.err], [0, '']);
});

test('C7b: a marker naming an ID absent from Acceptance exits 6 with one unbacked line per offender', () => {
  const one = rulings('Changes the bar (slice B): C1, C7');
  assert.equal(one.code, 6);
  assert.deepEqual(unbackedLines(one), ['unbacked: Changes the bar (slice B): C1, C7']);
  const two = rulings('Changes the bar (slice B): C7\nChanges the bar (slice B): C1\nChanges the bar (slice B): C2b, C11');
  assert.equal(two.code, 6);
  assert.deepEqual(unbackedLines(two), ['unbacked: Changes the bar (slice B): C7', 'unbacked: Changes the bar (slice B): C2b, C11']);
});

test('C7c/C7d: a marker with no IDs, or with a token that is not an ID, is unbacked', () => {
  for (const line of ['Changes the bar (slice B):', 'Changes the bar (slice B): C1, see notes', 'Changes the bar (slice B): none', 'Changes the bar (slice B): C1;C2a']) {
    const r = rulings(line);
    assert.equal(r.code, 6, line);
    assert.deepEqual(unbackedLines(r), [`unbacked: ${line}`], line);
  }
});

test('C7e: an ID that leads a line only outside Acceptance, or in a multi-ID line, backs nothing', () => {
  const block = [
    '# Slice', 'Acceptance:', 'C1: ok', 'C3, C4: both on one line', '', '```', 'C5: inside a fence', '```', 'Gates: G1', 'C6: after gates', 'Notes:', 'C7: under notes', '',
  ].join('\n');
  for (const id of ['C3', 'C4', 'C5', 'C6', 'C7']) {
    const r = rulings(`Changes the bar (slice B): ${id}`, { block });
    assert.equal(r.code, 6, id);
  }
  assert.equal(rulings('Changes the bar (slice B): C1', { block }).code, 0);
});

test('C22a/b: Acceptance runs to the template’s next known label; a parent ID is backed by its sub-IDs', () => {
  const block = ['Acceptance:', 'C1a: x', 'Gates: nothing', 'C2: not Acceptance', ''].join('\n');
  assert.equal(rulings('Changes the bar (slice B): C1', { block }).code, 0, 'C1 backed by C1a');
  assert.equal(rulings('Changes the bar (slice B): C1a', { block }).code, 0);
  assert.equal(rulings('Changes the bar (slice B): C2', { block }).code, 6, 'C2 follows a non-ID label');
  assert.equal(rulings('Changes the bar (slice B): C1b', { block }).code, 6, 'a sibling sub-ID does not back C1b');
});

test('C22c: a line that contains Changes the bar but does not parse as a marker is unbacked', () => {
  for (const line of ['Changes the bar slice B: C1', 'Changes the bar (slice B) C1', 'The ruling Changes the bar (slice B): C1', 'Changes the bar (B): C1']) {
    const r = rulings(line);
    assert.equal(r.code, 6, line);
    assert.deepEqual(unbackedLines(r), [`unbacked: ${line}`], line);
  }
});

test('C7f: markers for other slices are ignored and slice ids match exactly', () => {
  assert.equal(rulings('Changes the bar (slice A): C9\nChanges the bar (slice B2): C9', { slice: 'B' }).code, 0);
  assert.equal(rulings('Changes the bar (slice B): C9', { slice: 'B2' }).code, 0);
  assert.equal(rulings('Changes the bar (slice B2): C9', { slice: 'B2' }).code, 6);
});

test('C7g: CRLF decisions and block files give the same results', () => {
  const ok = rulings('Changes the bar (slice B): C1\n- **Changes the bar (slice B):** C2a', { eol: '\r\n' });
  assert.deepEqual([ok.code, ok.err], [0, '']);
  const bad = rulings('Changes the bar (slice B): C7\nChanges the bar (slice B): C1', { eol: '\r\n' });
  assert.equal(bad.code, 6);
  assert.deepEqual(unbackedLines(bad), ['unbacked: Changes the bar (slice B): C7']);
});

test('C7h: usage and IO errors are one-line messages, never a stack trace', () => {
  const [d, b] = rulingsDocs('Changes the bar (slice B): C1');
  for (const args of [['rulings'], ['rulings', d], ['rulings', d, b], ['rulings', d, b, '--slice']]) {
    const r = cli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /usage: handoff\.mjs rulings <decisions\.md> <block\.md> --slice <id>/);
  }
  for (const args of [['rulings', join(BOX, 'no-such-decisions.md'), b, '--slice', 'B'], ['rulings', d, join(BOX, 'no-such-block.md'), '--slice', 'B']]) {
    const r = cli(args);
    assert.notEqual(r.code, 0);
    assert.notEqual(r.code, 6, 'an unreadable file is not an unbacked ruling');
    assert.match(r.err, /no-such-(decisions|block)\.md/);
    assert.equal(r.err.trim().split('\n').length, 1);
    assert.doesNotMatch(r.err, /at .*\.m?js:\d+/);
  }
});

// --- PS-03: gate evidence survives a pure rebase ----------------------------------
//
// A slice that is rebased onto an advanced base keeps its patch but gets new
// shas, so every `Head:` line goes stale. The doc records the slice's base
// (`base:` sha, `base_ref:` full ref); `ready` and `coverage` accept a recorded
// head that differs from HEAD only when the two patches have the same
// `git patch-id --verbatim`, the patch is not empty and the head still merges
// onto the base's current tip. Everything unknown refuses with `stale:`.
// These cases run real git (the shim cases wrap it).

const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8', env: baseEnv() }).trim();
const put = (dir, file, text) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };
const addCommit = (dir, msg, ...files) => { git(dir, 'add', ...files); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };

// main holds shared.txt at B0; `slice` carries the patch `files` (one or three
// commits). Returns the recorded head (the patch tip before the rebase) and a
// `rebase()` that advances main with an unrelated commit and rebases the slice.
function rebaseRepo(name, { commits = 1, patch, baseFiles = {} } = {}) {
  const dir = repo(name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'shared.txt', 'line1\nline2\n');
  for (const [file, text] of Object.entries(baseFiles)) put(dir, file, text);
  const base = addCommit(dir, 'base', 'shared.txt', ...Object.keys(baseFiles));
  git(dir, 'checkout', '-q', '-b', 'slice');
  let recorded;
  if (patch) recorded = patch(dir);
  else {
    for (let i = 1; i <= commits; i++) { put(dir, `p${i}.txt`, `patch ${i}\n`); recorded = addCommit(dir, `patch ${i}`, `p${i}.txt`); }
  }
  const advance = (file = 'unrelated.txt', text = 'main moves\n') => {
    git(dir, 'checkout', '-q', 'main');
    put(dir, file, text);
    addCommit(dir, `main ${file}`, file);
    git(dir, 'checkout', '-q', 'slice');
  };
  const rebase = (...opts) => { advance(); git(dir, 'rebase', '-q', ...opts, 'main'); };
  return { dir, base, recorded, advance, rebase };
}
const docFor = (fx, { heads, fmExtra, omit = [] } = {}) => {
  const fm = [`base: ${fx.base}`, 'base_ref: refs/heads/main'].filter((l) => !omit.some((o) => l.startsWith(`${o}:`)));
  return mkDoc('C1: a\n', `${(heads ?? [fx.recorded]).map((h) => `Head: ${h}`).join('\n')}\nC1: pass\n`, { cwd: fx.dir, fm: [...fm, ...(fmExtra ?? [])] });
};
const docStatus = (p) => /^status: (.*)$/m.exec(readFileSync(p, 'utf8'))[1];

// Each refusal case runs through coverage, ready and status: exit 5, `stale:`, the
// condition's phrase, and `status` left alone.
function assertRefused(p, phrase, env) {
  const runs = [
    ['coverage', cli(['coverage', p], { env })],
    ['ready', cli(['ready', p], { session: 's', env })],
    ['status results-ready', cli(['status', p, 'results-ready'], { session: 's', env })],
  ];
  for (const [what, r] of runs) {
    assert.equal(r.code, 5, `${what}: ${r.err}`);
    assert.ok(r.err.startsWith('stale:'), `${what}: ${r.err}`);
    assert.match(r.err, phrase, what);
  }
  assert.equal(docStatus(p), 'dispatched', 'status unchanged');
}

test('C4a-c: a pure rebase keeps the gate evidence: coverage, ready and status all accept', () => {
  const fx = rebaseRepo('rb-ok');
  fx.rebase();
  assert.notEqual(git(fx.dir, 'rev-parse', 'HEAD'), fx.recorded);
  assert.equal(cli(['coverage', docFor(fx)]).code, 0, 'coverage');
  const p = docFor(fx);
  assert.equal(cli(['ready', p], { session: 's' }).code, 0, 'ready');
  assert.equal(docStatus(p), 'results-ready');
  const q = docFor(fx);
  assert.equal(cli(['status', q, 'results-ready'], { session: 's' }).code, 0, 'status');
  assert.equal(docStatus(q), 'results-ready');
});

test('C4d: a three-commit patch rebased the same way is accepted (the range covers the whole patch)', () => {
  const fx = rebaseRepo('rb-three', { commits: 3 });
  fx.rebase();
  assert.equal(cli(['coverage', docFor(fx)]).code, 0);
  // the recorded tip's own patch is not the whole patch: a doc naming only the first commit refuses
  const first = git(fx.dir, 'rev-list', '--reverse', `${fx.base}..${fx.recorded}`).split('\n')[0];
  assert.equal(cli(['coverage', docFor(fx, { heads: [first] })]).code, 5, 'a partial range is a different patch');
});

test('C4e: Head equal to HEAD passes with or without base; a doc with no cwd is not checked', () => {
  const fx = rebaseRepo('rb-same');
  const head = git(fx.dir, 'rev-parse', 'HEAD');
  assert.equal(cli(['coverage', docFor(fx, { heads: [head] })]).code, 0);
  assert.equal(cli(['coverage', mkDoc('C1: a\n', `Head: ${head}\nC1: pass\n`, { cwd: fx.dir })]).code, 0, 'no base lines');
  assert.equal(cli(['coverage', mkDoc('C1: a\n', 'C1: pass\n')]).code, 0, 'no cwd');
});

test('C5a: no base: refuses and names the missing base', () => {
  const fx = rebaseRepo('rb-nobase');
  fx.rebase();
  assertRefused(docFor(fx, { omit: ['base'] }), /no `base:` line/);
  assertRefused(docFor(fx, { omit: ['base_ref'] }), /no `base_ref:` line/);
});

test('C5b: a recorded head that git does not know refuses as unknown or unreachable', () => {
  const fx = rebaseRepo('rb-unknown');
  fx.rebase();
  assertRefused(docFor(fx, { heads: ['deadbeefdead'] }), /recorded head deadbeefdead is unknown or unreachable/);
});

test('C5c: an empty patch refuses, never two empty ids comparing equal', () => {
  const fx = rebaseRepo('rb-empty', { patch: (d) => { git(d, 'commit', '-q', '--allow-empty', '-m', 'empty'); return git(d, 'rev-parse', 'HEAD'); } });
  fx.rebase('--empty=keep');
  assert.notEqual(git(fx.dir, 'rev-parse', 'HEAD'), fx.recorded);
  assertRefused(docFor(fx), /patch is empty/);
});

test('C5d: a late content commit with no rebase refuses as a patch-id mismatch', () => {
  const fx = rebaseRepo('rb-late');
  put(fx.dir, 'late.txt', 'late edit\n');
  addCommit(fx.dir, 'late', 'late.txt');
  assertRefused(docFor(fx), /patch-id mismatch/);
});

test('C5e: a whitespace-only change inside a line refuses (verbatim, not --stable)', () => {
  const cases = [
    ['inline', 's = "a b"\n', 's = "ab"\n', 'ws.txt'],
    ['indent', 'if x:\n    y = 1\n', 'if x:\ny = 1\n', 'ws.py'],
  ];
  for (const [name, before, after, file] of cases) {
    const fx = rebaseRepo(`rb-ws-${name}`, { patch: (d) => { put(d, file, before); return addCommit(d, 'ws', file); } });
    fx.rebase();
    assert.equal(cli(['coverage', docFor(fx)]).code, 0, `${name}: unchanged patch is accepted`);
    put(fx.dir, file, after);
    git(fx.dir, 'add', file);
    git(fx.dir, 'commit', '-q', '--amend', '--no-edit');
    // sanity: --stable cannot tell the two patches apart, which is why verbatim is required
    const stable = (r) => execFileSync('/bin/sh', ['-c', `git diff -U0 --binary --full-index ${r} | git patch-id --stable`], { cwd: fx.dir, encoding: 'utf8', env: GIT_ENV }).split(' ')[0];
    assert.equal(stable(`${fx.base} ${fx.recorded}`), stable(`main HEAD`), `${name}: --stable sees no difference`);
    assertRefused(docFor(fx), /patch-id mismatch/);
  }
});

test('C5f: a binary content change, and a mode-only change, refuse', () => {
  const bin = rebaseRepo('rb-bin', { patch: (d) => { writeFileSync(join(d, 'b.bin'), Buffer.from([1, 2, 0, 3])); return addCommit(d, 'bin', 'b.bin'); } });
  bin.rebase();
  writeFileSync(join(bin.dir, 'b.bin'), Buffer.from([1, 2, 0, 4]));
  git(bin.dir, 'add', 'b.bin');
  git(bin.dir, 'commit', '-q', '--amend', '--no-edit');
  assertRefused(docFor(bin), /patch-id mismatch/);

  const mode = rebaseRepo('rb-mode', { patch: (d) => { put(d, 's.sh', 'echo hi\n'); return addCommit(d, 'sh', 's.sh'); } });
  mode.rebase();
  chmodSync(join(mode.dir, 's.sh'), 0o755);
  git(mode.dir, 'add', 's.sh');
  git(mode.dir, 'commit', '-q', '--amend', '--no-edit');
  assertRefused(docFor(mode), /patch-id mismatch/);
});

test('C5g: a conflict with the base’s current tip refuses; merge-tree runs against the tip, not the recorded base', () => {
  const fx = rebaseRepo('rb-conflict', { patch: (d) => { put(d, 'shared.txt', 'line1\npatched\n'); return addCommit(d, 'edit shared', 'shared.txt'); } });
  fx.rebase();
  assert.equal(cli(['coverage', docFor(fx)]).code, 0, 'clean before the base moves again');
  fx.advance('shared.txt', 'line1\nmain wins\n');
  assertRefused(docFor(fx), /merge conflict/);
});

// A `git` that runs the real one but fails for a chosen subcommand or flag.
function shimGit(name, failWhen, code) {
  const dir = join(BOX, `shim-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git'), `#!/bin/bash\nfor a in "$@"; do case "$a" in ${failWhen}) exit ${code};; esac; done\nexec ${REAL_GIT} "$@"\n`);
  chmodSync(join(dir, 'git'), 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

test('C5h: every git error refuses naming a git error, not a patch mismatch or conflict', () => {
  const fx = rebaseRepo('rb-giterr');
  fx.rebase();
  assert.equal(cli(['coverage', docFor(fx)]).code, 0, 'the fixture is accepted by real git');
  for (const [label, env] of [
    ['patch-id exits 128', shimGit('patch-id', 'patch-id', 128)],
    ['merge-tree exits 128', shimGit('merge-tree', 'merge-tree', 128)],
    ['--verbatim unsupported (129)', shimGit('verbatim', '--verbatim|--write-tree', 129)],
  ]) {
    const p = docFor(fx);
    const r = cli(['coverage', p], { env });
    assert.equal(r.code, 5, label);
    assert.match(r.err, /git error/, label);
    assert.doesNotMatch(r.err, /patch-id mismatch|merge conflict/, label);
    assertRefused(docFor(fx), /git error/, env);
  }
  const gone = rebaseRepo('rb-gone');
  gone.rebase();
  git(gone.dir, 'branch', '-q', '-D', 'main');
  assertRefused(docFor(gone), /git error: `base_ref: refs\/heads\/main` no longer resolves/);
  const lost = rebaseRepo('rb-lost');
  lost.rebase();
  assertRefused(mkDoc('C1: a\n', `Head: ${lost.recorded}\nC1: pass\n`, { cwd: lost.dir, fm: [`base: ${'1'.repeat(40)}`, 'base_ref: refs/heads/main'] }), /git error: `base: 1{40}` no longer resolves/);
});

test('C5i: two Head lines, one rebase-equivalent and one whose patch differs, refuse', () => {
  const fx = rebaseRepo('rb-two');
  git(fx.dir, 'checkout', '-q', '-b', 'other', fx.base);
  put(fx.dir, 'other.txt', 'different patch\n');
  const other = addCommit(fx.dir, 'other', 'other.txt');
  git(fx.dir, 'checkout', '-q', 'slice');
  fx.rebase();
  assert.equal(cli(['coverage', docFor(fx)]).code, 0, 'the equivalent head alone is accepted');
  assertRefused(docFor(fx, { heads: [fx.recorded, other] }), /patch-id mismatch/);
});

test('C5j: a base that is not a full hex sha is refused and never reaches git as an option', () => {
  const fx = rebaseRepo('rb-inject');
  fx.rebase();
  const pwned = join(BOX, 'pwned');
  for (const bad of [`--output=${pwned}`, 'HEAD', 'main']) {
    const p = mkDoc('C1: a\n', `Head: ${fx.recorded}\nC1: pass\n`, { cwd: fx.dir, fm: [`base: ${bad}`, 'base_ref: refs/heads/main'] });
    assertRefused(p, /not a full commit sha/);
    assert.ok(!existsSync(pwned), `${bad}: nothing was written`);
  }
  for (const bad of ['--output=/x', 'main', 'refs/tags/v1']) {
    const p = mkDoc('C1: a\n', `Head: ${fx.recorded}\nC1: pass\n`, { cwd: fx.dir, fm: [`base: ${fx.base}`, `base_ref: ${bad}`] });
    assertRefused(p, /base_ref:.* is not a full refs/);
  }
});

test('C5k: ambient GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE do not redirect the git children', () => {
  const fx = rebaseRepo('rb-env');
  fx.rebase();
  const other = rebaseRepo('rb-env-other');
  const hostile = { GIT_DIR: join(other.dir, '.git'), GIT_WORK_TREE: other.dir, GIT_INDEX_FILE: join(other.dir, '.git', 'index') };
  assert.equal(cli(['coverage', docFor(fx)], { env: hostile }).code, 0, 'C4a unchanged');
  const late = rebaseRepo('rb-env-late');
  put(late.dir, 'late.txt', 'late\n');
  addCommit(late.dir, 'late', 'late.txt');
  assertRefused(docFor(late), /patch-id mismatch/, hostile);
});

test('C5l: the same added line moved to another place in the file is a different patch', () => {
  // With zero context a patch is only its changed lines, so moving a line would keep its patch-id.
  // The patch-id comparison therefore keeps git's default context.
  const before = 'function a() {\n  const x = 1;\n  return x;\n}\n\nfunction b() {\n  const y = 2;\n  return y;\n}\n';
  const fx = rebaseRepo('rb-moved', { baseFiles: { 'f.js': before }, patch: (d) => {
    put(d, 'f.js', before.replace('  const x = 1;\n', '  const x = 1;\n  guard();\n'));
    return addCommit(d, 'guard in a', 'f.js');
  } });
  fx.rebase();
  assert.equal(cli(['coverage', docFor(fx)]).code, 0, 'the unmoved patch is accepted');
  put(fx.dir, 'f.js', before.replace('  const y = 2;\n', '  const y = 2;\n  guard();\n'));
  git(fx.dir, 'add', 'f.js');
  git(fx.dir, 'commit', '-q', '--amend', '--no-edit');
  assertRefused(docFor(fx), /patch-id mismatch/);
});

// --- corrective round 1 --------------------------------------------------------------

test('K1: a marker for C1 is not backed by C12, nor C2 by C20; only a lowercase-letter sub-ID backs a parent', () => {
  const block = ['Acceptance:', 'C12: twelve', 'C20: twenty', 'C3a: sub', 'Gates: G1', ''].join('\n');
  for (const id of ['C1', 'C2']) {
    const r = rulings(`Changes the bar (slice B): ${id}`, { block });
    assert.equal(r.code, 6, id);
    assert.deepEqual(unbackedLines(r), [`unbacked: Changes the bar (slice B): ${id}`], id);
  }
  assert.equal(rulings('Changes the bar (slice B): C3', { block }).code, 0, 'C3a still backs C3');
  assert.equal(rulings('Changes the bar (slice B): C12, C20', { block }).code, 0, 'the IDs themselves are backed');
});

// The moved-line fixture (C5l) under a given repository or user git config: the pure rebase is
// accepted, and the moved line is refused as a patch-id mismatch, never as an empty patch.
const JS_BEFORE = 'function a() {\n  const x = 1;\n  return x;\n}\n\nfunction b() {\n  const y = 2;\n  return y;\n}\n';
function guardFixture(name) {
  const fx = rebaseRepo(name, { baseFiles: { 'f.js': JS_BEFORE }, patch: (d) => {
    put(d, 'f.js', JS_BEFORE.replace('  const x = 1;\n', '  const x = 1;\n  guard();\n'));
    return addCommit(d, 'guard in a', 'f.js');
  } });
  fx.rebase();
  return fx;
}
function moveGuard(fx) {
  put(fx.dir, 'f.js', JS_BEFORE.replace('  const y = 2;\n', '  const y = 2;\n  guard();\n'));
  git(fx.dir, 'add', 'f.js');
  git(fx.dir, 'commit', '-q', '--amend', '--no-edit');
}
function assertGuardCases(name, { repoConfig = [], env } = {}) {
  const fx = guardFixture(name);
  for (const [k, v] of repoConfig) git(fx.dir, 'config', k, v);
  assert.equal(cli(['coverage', docFor(fx)], { env }).code, 0, `${name}: the pure rebase is accepted`);
  moveGuard(fx);
  const p = docFor(fx);
  const r = cli(['coverage', p], { env });
  assert.equal(r.code, 5, `${name}: ${r.err}`);
  assert.match(r.err, /patch-id mismatch/, name);
  assert.doesNotMatch(r.err, /patch is empty/, name);
  assertRefused(p, /patch-id mismatch/, env);
}

test('K2a: repository config (diff.context 0, color.diff always, diff.noprefix, mnemonicPrefix) never changes the patch comparison', () => {
  assertGuardCases('k2a-context', { repoConfig: [['diff.context', '0']] });
  assertGuardCases('k2a-color', { repoConfig: [['color.diff', 'always'], ['color.ui', 'always']] });
  assertGuardCases('k2a-prefix', { repoConfig: [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true']] });
});

test('K2b: user git config in HOME (context, color, prefix, ignoreSubmodules) never changes the carry-over', () => {
  const home = join(BOX, 'k2b-home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[diff]\n\tcontext = 0\n\tnoprefix = true\n\tignoreSubmodules = all\n[color]\n\tui = always\n\tdiff = always\n');
  assertGuardCases('k2b-home', { env: { HOME: home } });
});

test('K3: a builder holding OFFLOAD_HANDOFF and OFFLOAD_SESSION_ID cannot rewrite base or base_ref', () => {
  const dir = repo('k3');
  const doc = run(['init', dir, 'arch-k3', 'k3']);
  const sha = 'a'.repeat(40);
  run(['base', doc, sha, 'refs/heads/main'], { session: 'arch-k3' });
  const before = readFileSync(doc, 'utf8');
  const builder = { session: 'builder-k3', env: { OFFLOAD_HANDOFF: doc, OFFLOAD_SESSION_ID: 'arch-k3' } };
  const err = runFail(['base', doc, 'b'.repeat(40), 'refs/heads/slice'], builder);
  assert.match(err, /owned by session arch-k3/);
  assert.equal(readFileSync(doc, 'utf8'), before, 'the frontmatter is byte-identical');
  run(['status', doc, 'dispatched'], builder); // the carried id still works for status, as the builder needs
  run(['base', doc, 'c'.repeat(40)], { session: 'arch-k3' });
  assert.match(readFileSync(doc, 'utf8'), /^base: c{40}$/m, 'the architect can still record a base');
});

// --- D11: the Acceptance span ends only at the template's own labels ---------------------------
// `Gates:` and `Result file:` at column 0, a ``` fence, or the end of the file. A prose label such as
// `Fixture:` inside a criterion block no longer hides the IDs after it.

const spanRulings = (lines, ids = 'C9') => rulings(`Changes the bar (slice D): ${ids}`, { slice: 'D', block: lines.join('\n') });

test('C8a: a column-0 prose label does not end the Acceptance span', () => {
  assert.equal(spanRulings(['Acceptance:', 'C1: a', 'Fixture: two gates', 'C9: b', 'Gates: G1', '']).code, 0);
});
test('C8b: a column-0 Gates: ends the span, so a later ID backs nothing', () => {
  assert.equal(spanRulings(['Acceptance:', 'C1: a', 'Gates: G1', 'C9: b', '']).code, 6);
});
test('C8c: a column-0 Result file: ends the span', () => {
  assert.equal(spanRulings(['Acceptance:', 'C1: a', 'Result file: /x/result.md', 'C9: b', '']).code, 6);
});
test('C8d: a ``` fence ends the span', () => {
  assert.equal(spanRulings(['Acceptance:', 'C1: a', '```', 'C9: b', '```', '']).code, 6);
});
test('C8e: the span runs to the end of the file: an ID on the last line, with no terminator, backs its marker', () => {
  assert.equal(spanRulings(['Acceptance:', 'C1: a', 'C9: b']).code, 0);
});
test('C8f: only the exact labels end it: an indented Gates: or a Gate notes: label does not', () => {
  assert.equal(spanRulings(['Acceptance:', 'C1: a', '  Gates: none', 'Gate notes: x', 'C9: b', '']).code, 0);
});
test('C8h: the acceptanceIds comment and the rulings header line name the new terminators', () => {
  const src = readFileSync(HANDOFF, 'utf8');
  const region = src.slice(src.indexOf('// --- bar-changing rulings'), src.indexOf('function acceptanceIds'));
  assert.ok(region.includes('Result file:') && region.includes('Gates:'), 'the comment above acceptanceIds');
  const header = src.slice(0, src.indexOf('node handoff.mjs base '));
  assert.ok(header.includes('Result file:'), 'the rulings header line');
});
