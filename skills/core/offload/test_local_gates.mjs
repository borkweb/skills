// test_local_gates.mjs — `ready` runs the frozen local gates (AT-02).
//
// A local gate is a Frozen-gates line `L<n>: local: <command>`. After coverage and the
// stale check pass, `ready` and `status results-ready` run every one in the doc's cwd at
// HEAD, one at a time, under an allowlisted env, and refuse with exit 7 and `red:` when
// one fails, times out or cannot start. These cases drive the real CLI against real git
// repos; the Stop hook runs the same runner (test_gate_hook.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert';
import test from 'node:test';
import {
  BOX, HANDOFF, HERE, NODE, N, baseEnv, cli, docStatus, git, gitRepo, hostile, L, mkGateDoc, read, readyFx, scratch, FORBIDDEN_IN_GATE, uniq,
} from './gate-fixture.mjs';

const ready = (fx, o = {}) => cli(['ready', fx.doc], { session: 's', ...o });
const refused = (r, what = '') => { assert.equal(r.code, N, `${what} exit ${r.code}: ${r.err}`); assert.ok(r.err.startsWith('red:'), `${what}: ${r.err}`); };
const isoBefore = (fx) => read(fx.doc);
// Read a file the gate or runner must have written: a missing file is a failed assertion, not an ENOENT.
const must = (p) => { assert.ok(p && existsSync(p), `expected file is missing: ${p}`); return read(p); };

// --- syntax: what is and is not a local gate ---------------------------------------

test('C1c: a local line never counts as a criterion: coverage prints nothing and matches the same doc without it', () => {
  const repo = gitRepo();
  const withL = mkGateDoc({ frozen: [L('L1', 'true')], head: repo.head, cwd: repo.dir });
  const without = mkGateDoc({ frozen: [], head: repo.head, cwd: repo.dir });
  const a = cli(['coverage', withL]);
  const b = cli(['coverage', without]);
  assert.deepEqual([a.code, a.out, a.err], [0, '', '']);
  assert.deepEqual([b.code, b.out, b.err], [0, '', '']);
});

test('C1d: a criterion line is never run as a gate, even when it says local:', () => {
  const fx = readyFx((out) => [`touch ${out}/real`], {});
  const out = fx.out;
  const doc = mkGateDoc({ frozen: [`C7: local: touch ${out}/m7`, `- C8 local: touch ${out}/m8`], results: `Head: ${fx.head}\nC1: ok\nC7: ok\nC8: ok\n`, head: fx.head, cwd: fx.dir });
  const r = cli(['ready', doc], { session: 's' });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(out, 'm7')) && !existsSync(join(out, 'm8')), 'a criterion line ran as a gate');
});

test('C1e: a review-lead ID with no local marker, or a bare block line, is not a gate', () => {
  const repo = gitRepo();
  const out = scratch();
  const doc = mkGateDoc({ frozen: ['L5: run-env.sh passes -- before the run dir', `L6: touch ${out}/m6`], head: repo.head, cwd: repo.dir });
  const r = cli(['ready', doc], { session: 's' });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(out, 'm6')));
});

test('C1f: a local line inside a comment (one line, or an unclosed opener) is not run', () => {
  const repo = gitRepo();
  const out = scratch();
  const doc = mkGateDoc({
    frozen: [`<!-- ${L('L1', `touch ${out}/one`)} -->`, '<!-- unclosed', L('L2', `touch ${out}/two`), '', L('L3', `touch ${out}/three`)],
    head: repo.head, cwd: repo.dir,
  });
  const r = cli(['ready', doc], { session: 's' });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(out, 'one')) && !existsSync(join(out, 'two')), 'a commented local line ran');
  assert.ok(existsSync(join(out, 'three')), 'the line after the blank line is a gate again');
});

test('C1i: a malformed local line in a hand-edited doc refuses ready, byte-identical, never skipped', () => {
  for (const [what, lines] of [
    ['empty command', ['L1: local:', 'L2: local:    ']],
    ['duplicate id', ['L1: local: true', 'L1: local: true']],
    ['no colon after local', ['L1: local touch x']],
  ]) {
    const repo = gitRepo();
    const doc = mkGateDoc({ frozen: lines, head: repo.head, cwd: repo.dir });
    const before = read(doc);
    const r = cli(['ready', doc], { session: 's' });
    assert.notEqual(r.code, 0, `${what}: ready must refuse`);
    assert.equal(read(doc), before, `${what}: doc byte-identical`);
    assert.equal(docStatus(doc), 'dispatched');
  }
});

test('C1j: local lines are found in a CRLF doc', () => {
  const repo = gitRepo();
  const doc = mkGateDoc({ frozen: [L('L1', 'exit 3')], head: repo.head, cwd: repo.dir, eol: '\r\n' });
  refused(cli(['ready', doc], { session: 's' }), 'crlf');
});

// --- ready runs them ---------------------------------------------------------------

test('C3a-d: a red gate refuses ready: exit 7, red: naming the gate and an absolute saved path, doc untouched', () => {
  const fx = readyFx(['exit 3']);
  const before = isoBefore(fx);
  const r = ready(fx);
  refused(r);
  assert.match(r.err, /\bL1\b/);
  const path = /(\/[^\s]+)/.exec(r.err.replace(/^red:/, ''))?.[1];
  assert.ok(path && path.startsWith('/'), `absolute path in: ${r.err}`);
  assert.ok(existsSync(path), `saved output exists: ${path}`);
  assert.equal(read(fx.doc), before, 'doc byte-identical: status and updated unchanged');
});

test('C3e: status results-ready refuses a red gate the same way', () => {
  const fx = readyFx(['exit 3']);
  const before = isoBefore(fx);
  const r = cli(['status', fx.doc, 'results-ready'], { session: 's' });
  refused(r);
  assert.match(r.err, /\bL1\b/);
  assert.equal(read(fx.doc), before);
});

test('C3f: ready --steal refuses a red gate the same way', () => {
  const fx = readyFx(['exit 3']);
  const before = isoBefore(fx);
  const r = cli(['ready', fx.doc, '--steal'], { session: 'someone-else' });
  refused(r);
  assert.equal(read(fx.doc), before);
});

test('C3g: all gates green: ready exits 0 and flips the status', () => {
  const fx = readyFx(['true', 'exit 0']);
  const r = ready(fx);
  assert.equal(r.code, 0, r.err);
  assert.equal(docStatus(fx.doc), 'results-ready');
});

test('C3h/C3i: the saved output holds stdout and stderr, and lies outside the worktree', () => {
  const fx = readyFx(['echo out-marker; echo err-marker >&2; exit 1']);
  const r = ready(fx);
  refused(r);
  const path = /(\/[^\s]+)/.exec(r.err.replace(/^red:/, ''))?.[1];
  const saved = must(path);
  assert.match(saved, /out-marker/);
  assert.match(saved, /err-marker/);
  assert.equal(git(fx.dir, 'status', '--porcelain'), '');
  assert.ok(!path.startsWith(fx.dir), 'saved output is inside the worktree');
});

test('C3j: overlapping runs keep their own saved output', async () => {
  const fx = readyFx((out) => [`if [ -e ${out}/flip ]; then echo green-$$; sleep 2; else echo red-$$; sleep 2; exit 3; fi`]);
  const run = () => new Promise((res) => {
    const c = spawn(NODE, [HANDOFF, 'ready', fx.doc], { env: { ...baseEnv(), CLAUDE_CODE_SESSION_ID: 's' } });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => res({ code, err }));
  });
  const a = run();
  await new Promise((r) => setTimeout(r, 700));
  writeFileSync(join(fx.out, 'flip'), '');
  const b = run();
  const [ra, rb] = await Promise.all([a, b]);
  refused(ra, 'first');
  assert.equal(rb.code, 0, `second run is green: ${rb.err}`);
  const path = /(\/[^\s]+)/.exec(ra.err.replace(/^red:/, ''))?.[1];
  assert.match(must(path), /red-\d+/);
  assert.doesNotMatch(must(path), /green-/, 'the red output was overwritten by the green run');
});

test('C3k: prune reaps saved gate output after its doc is gone, even a directory', () => {
  const fx = readyFx(['exit 3']);
  refused(ready(fx));
  const gates = `${fx.doc}.gates`;
  assert.ok(existsSync(gates) && statSync(gates).isDirectory(), 'gate output lives beside the doc');
  assert.equal(cli(['prune']).code, 0);
  assert.ok(existsSync(gates), 'prune spares output while the doc exists');
  assert.equal(cli(['end', fx.doc]).code, 0);
  const r = cli(['prune']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(gates), 'orphaned gate output was not reaped');
});

test('C3l: the gate runs in the doc cwd at HEAD', () => {
  const fx = readyFx((out) => [`pwd -P > ${out}/pwd; git rev-parse HEAD > ${out}/head`]);
  assert.equal(ready(fx).code, 0);
  assert.equal(must(join(fx.out, 'pwd')).trim(), fx.dir);
  assert.equal(must(join(fx.out, 'head')).trim(), fx.head);
});

test('C3m: gates run one at a time in Frozen order', () => {
  const step = (id) => (out) => `mkdir ${out}/lock && echo ${id} >> ${out}/order && sleep 1 && rmdir ${out}/lock`;
  const fx = readyFx((out) => [step('L1')(out), step('L2')(out)]);
  assert.equal(ready(fx).code, 0);
  assert.deepEqual(must(join(fx.out, 'order')).trim().split('\n'), ['L1', 'L2']);
});

test('C3n: each gate runs once per call, even when the doc changes during the run', () => {
  const repo = gitRepo();
  const out = scratch();
  const doc = mkGateDoc({ head: repo.head, cwd: repo.dir });
  writeFileSync(doc, read(doc).replace('C1: x\n', `C1: x\n${L('L1', `echo x >> ${out}/count; printf ' ' >> ${doc}`)}\n`));
  const r = cli(['ready', doc], { session: 's' });
  const runs = must(join(out, 'count')).trim().split('\n').length;
  assert.equal(runs, 1, `the gate ran ${runs} times`);
  assert.ok(r.code === 0 || r.code === N || r.code === 5, `refuse or succeed, never loop: ${r.code} ${r.err}`);
});

test('C3o: HEAD moving during the gate run refuses and leaves the status alone', () => {
  const fx = readyFx(['git commit --allow-empty -qm x']);
  const r = ready(fx);
  assert.ok(r.code === 5 || r.code === N, `exit ${r.code}: ${r.err}`);
  assert.equal(docStatus(fx.doc), 'dispatched');
});

test('C3p/C11: a gate past its timeout is red and the message says so', () => {
  const fx = readyFx(['sleep 5']);
  const t0 = Date.now();
  const r = ready(fx, { env: { OFFLOAD_LOCAL_GATE_TIMEOUT_S: '1' } });
  refused(r);
  assert.match(r.err, /timed out/);
  assert.ok(Date.now() - t0 < 4500, 'returned at the timeout, not after the sleep');
});

test('C3q/C3r: the timeout kills the whole process tree and returns promptly', () => {
  const tag = uniq('9').replace(/\D/g, '');
  const fx = readyFx([`sh -c 'sleep 31337${tag} & sleep 31338${tag}'`]);
  const t0 = Date.now();
  const r = ready(fx, { env: { OFFLOAD_LOCAL_GATE_TIMEOUT_S: '1' } });
  refused(r);
  assert.ok(Date.now() - t0 < 6000, `returned in ${Date.now() - t0} ms`);
  const ps = spawnSync('pgrep', ['-f', `sleep 3133[78]${tag}`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(ps, '', `survivors: ${ps}`);
});

test('C3t: a spawn failure is red, not a crash: cwd missing or a regular file', () => {
  const repo = gitRepo();
  const file = join(scratch(), 'plain');
  writeFileSync(file, 'x');
  for (const cwd of [join(BOX, 'no-such-dir'), file]) {
    const doc = mkGateDoc({ frozen: [L('L1', 'true')], head: repo.head, cwd });
    const before = read(doc);
    const r = cli(['ready', doc], { session: 's' });
    refused(r, cwd);
    assert.match(r.err, /\bL1\b/);
    assert.doesNotMatch(r.err, /at .*\.m?js:\d+/, 'no stack trace');
    assert.equal(read(doc), before);
  }
});

test('C3u: local gates and no cwd: refuse, and nothing runs in the caller directory', () => {
  const out = scratch();
  const doc = mkGateDoc({ frozen: [L('L1', 'touch m')], head: 'abc1234' });
  const before = read(doc);
  const r = cli(['ready', doc], { session: 's', cwd: out });
  assert.notEqual(r.code, 0);
  assert.ok(!existsSync(join(out, 'm')), 'a gate ran in the caller directory');
  assert.equal(read(doc), before);
});

test('C3v: a cwd that is not inside a git work tree refuses (fail closed)', () => {
  const dir = scratch();
  const doc = mkGateDoc({ frozen: [L('L1', `touch ${dir}/m`)], head: 'abc1234', cwd: dir });
  const before = read(doc);
  const r = cli(['ready', doc], { session: 's' });
  assert.notEqual(r.code, 0);
  assert.ok(!existsSync(join(dir, 'm')));
  assert.equal(read(doc), before);
});

test('C3w: large output does not turn a green gate red', () => {
  const fx = readyFx(['yes x | head -c 5242880']);
  const r = ready(fx);
  assert.equal(r.code, 0, r.err);
});

test('C3x: a doc with no local gates behaves as before', () => {
  const repo = gitRepo();
  const doc = mkGateDoc({ head: repo.head, cwd: repo.dir });
  assert.equal(cli(['ready', doc], { session: 's' }).code, 0);
  assert.equal(docStatus(doc), 'results-ready');
  writeFileSync(join(repo.dir, 'file.txt'), 'dirty\n');
  const q = mkGateDoc({ head: repo.head, cwd: repo.dir });
  assert.equal(cli(['ready', q], { session: 's' }).code, 0, 'no local gates: a dirty tree is not our business');
});

// --- order and carry-over ----------------------------------------------------------

test('C4a/C4b/C4c: incomplete and stale refusals and coverage never run a gate', () => {
  const repo = gitRepo();
  const out = scratch();
  const gate = L('L1', `touch ${out}/ran`);
  const incomplete = mkGateDoc({ frozen: [gate, 'C2: y'], head: repo.head, cwd: repo.dir });
  assert.equal(cli(['ready', incomplete], { session: 's' }).code, 4);
  const stale = mkGateDoc({ frozen: [gate], head: 'abcdef1', cwd: repo.dir });
  assert.equal(cli(['ready', stale], { session: 's' }).code, 5);
  const ok = mkGateDoc({ frozen: [gate], head: repo.head, cwd: repo.dir });
  assert.equal(cli(['coverage', ok]).code, 0);
  assert.ok(!existsSync(join(out, 'ran')), 'a gate ran on incomplete, stale or coverage');
});

test('C4d: status dispatched, blocked and accepted never run a gate', () => {
  const repo = gitRepo();
  const out = scratch();
  const doc = mkGateDoc({ frozen: [L('L1', `touch ${out}/ran`)], head: repo.head, cwd: repo.dir });
  for (const s of ['dispatched', 'blocked', 'accepted']) assert.equal(cli(['status', doc, s], { session: 's' }).code, 0, s);
  assert.ok(!existsSync(join(out, 'ran')));
});

test('C4e: list, board, section get, rulings and wait-for-ready never run a gate', () => {
  const repo = gitRepo();
  const out = scratch();
  const doc = mkGateDoc({ frozen: [L('L1', `touch ${out}/ran`)], head: repo.head, cwd: repo.dir });
  const dec = join(out, 'decisions.md'); const blk = join(out, 'block.md');
  writeFileSync(dec, '# d\n'); writeFileSync(blk, 'Acceptance:\nC1: x\n');
  cli(['list', repo.dir], { session: 's' });
  cli(['board', repo.dir, '--json', '--no-git', '--no-pane'], { session: 's' });
  cli(['section', 'get', doc, 'Frozen gates']);
  cli(['rulings', dec, blk, '--slice', 'A']);
  // The architect's own Stop hook (stop-hook.mjs) and one poll of the wait bridge on a results-ready doc.
  spawnSync(NODE, [join(HERE, 'stop-hook.mjs')], { input: JSON.stringify({ session_id: 'arch', cwd: repo.dir }), env: { ...baseEnv(), CLAUDE_CODE_SESSION_ID: 'arch' }, encoding: 'utf8', timeout: 30000 });
  const waiting = mkGateDoc({ frozen: [L('L1', `touch ${out}/ran`)], head: repo.head, cwd: repo.dir, status: 'results-ready' });
  writeFileSync(`${waiting}.builder`, `${process.pid}\n`);
  const wait = spawnSync('bash', [join(HERE, '..', 'complete', 'wait-for-ready.sh'), waiting, 'builder', '20'], { env: { ...baseEnv(), WFR_NO_UPGRADE: '1', WFR_POLL: '1' }, encoding: 'utf8', timeout: 40000 });
  assert.equal(wait.status, 0, `wait bridge: ${wait.stdout}${wait.stderr}`);
  assert.ok(!existsSync(join(out, 'ran')));
});

test('C4e: no runner call outside the entry points', () => {
  const callers = ['handoff.mjs', 'stop-hook.mjs', 'ledger.mjs', 'dispatch.sh', 'dispatch-slice.sh', 'harness.mjs', 'dir.mjs'];
  const src = Object.fromEntries(callers.map((f) => [f, readFileSync(join(new URL('.', import.meta.url).pathname, f), 'utf8')]));
  const hits = (text) => (text.match(/runLocalGates\(/g) || []).length;
  assert.ok(hits(src['handoff.mjs']) >= 1, 'the runner exists in handoff.mjs');
  for (const f of callers.filter((f) => f !== 'handoff.mjs')) assert.equal(hits(src[f]), 0, `${f} calls the runner`);
  const calls = src['handoff.mjs'].split('\n').filter((l) => /runLocalGates\(/.test(l) && !/function runLocalGates\(/.test(l) && !/^\s*\/\//.test(l));
  assert.ok(calls.length <= 2, `runner called from ${calls.length} places: ${calls.join(' | ')}`);
});

test('C4f: a local gate reruns after a pure rebase (carry-over passes coverage)', () => {
  const dir = join(BOX, uniq('rebase'));
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'shared.txt'), 'line1\nline2\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'slice');
  writeFileSync(join(dir, 'p1.txt'), 'patch\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'patch');
  const recorded = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'unrelated.txt'), 'main moves\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'main moves');
  git(dir, 'checkout', '-q', 'slice');
  git(dir, 'rebase', '-q', 'main');
  const doc = mkGateDoc({ frozen: [L('L1', 'exit 3')], results: `Head: ${recorded}\nC1: ok\n`, cwd: dir, fm: [`base: ${base}`, 'base_ref: refs/heads/main'] });
  assert.equal(cli(['coverage', doc]).code, 0, 'coverage carries over the rebase');
  refused(cli(['ready', doc], { session: 's' }), 'rebase');
});

test('C4g: a Carried: line does not exempt a local gate', () => {
  const repo = gitRepo();
  const doc = mkGateDoc({ frozen: [L('L1', 'exit 3')], results: `Head: ${repo.head}\nCarried: ${repo.head} — L1\nC1: ok\n`, cwd: repo.dir });
  refused(cli(['ready', doc], { session: 's' }));
});

// --- the gate environment (K1) -------------------------------------------------------

const envNames = (file) => must(file).split('\n').filter(Boolean).map((l) => l.split('=')[0]);

test('C5a-e: under a hostile env the gate sees only the allowlist, and no startup script ran', () => {
  const fx = readyFx((out) => [`env > ${out}/dump`]);
  const env = { ...hostile(fx.out), OFFLOAD_HANDOFF: fx.doc, OFFLOAD_SESSION_ID: 's' };
  const r = cli(['ready', fx.doc], { session: 's', env });
  assert.equal(r.code, 0, r.err);
  const names = envNames(join(fx.out, 'dump'));
  assert.ok(names.length > 0, 'empty dump');
  const header = read(HANDOFF).match(/Gate env allowlist: ([A-Z_, ]+)\./)?.[1];
  assert.ok(header, 'the allowlist is documented in the header comment');
  const allowed = new Set([...header.split(/,\s*/), 'PWD', 'SHLVL', '_', 'OLDPWD']);
  for (const v of names) assert.ok(allowed.has(v), `${v} is outside the allowlist`);
  for (const v of FORBIDDEN_IN_GATE) assert.ok(!names.includes(v), `${v} reached the gate`);
  assert.ok(names.includes('PATH') && names.includes('HOME'));
  assert.ok(!existsSync(join(fx.out, 'env-sourced')), 'BASH_ENV or ENV ran');
});

test('C5g: the documented allowlist is the constant in the code', () => {
  const src = read(HANDOFF);
  const header = src.match(/Gate env allowlist: ([A-Z_, ]+)\./)?.[1];
  const code = src.match(/const GIT_ENV_PASS = \[([^\]]*)\]/)?.[1];
  assert.ok(header && code);
  assert.deepEqual(header.split(/,\s*/), [...code.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
});

// --- C11, C12, C18 -------------------------------------------------------------------

test('C12: a dirty tracked tree refuses before any gate runs, naming the path; untracked files are ignored', () => {
  const fx = readyFx((out) => [`touch ${out}/ran`]);
  writeFileSync(join(fx.dir, 'untracked.txt'), 'u');
  assert.equal(ready(fx).code, 0, 'untracked files are ignored');
  const gx = readyFx((out) => [`touch ${out}/ran`]);
  writeFileSync(join(gx.dir, 'file.txt'), 'changed\n');
  const before = read(gx.doc);
  const r = ready(gx);
  refused(r);
  assert.match(r.err, /file\.txt/);
  assert.ok(!existsSync(join(gx.out, 'ran')), 'a gate ran on a dirty tree');
  assert.equal(read(gx.doc), before);
  const s = cli(['status', gx.doc, 'results-ready'], { session: 's' });
  refused(s);
});

test('C18: ready runs every gate and names every red one, each with its saved path', () => {
  const fx = readyFx(['exit 3', 'true', 'exit 4']);
  const r = ready(fx);
  refused(r);
  assert.match(r.err, /\bL1\b/);
  assert.match(r.err, /\bL3\b/);
  assert.doesNotMatch(r.err, /\bL2\b/);
  const paths = r.err.match(/\/[^\s]+/g) || [];
  assert.ok(paths.length >= 2, r.err);
  for (const p of paths) assert.ok(existsSync(p), `saved output ${p}`);
});

test('C11: the timeout knob is read by the runner only: a line cannot set it and a bad value falls back', () => {
  const fx = readyFx(['sleep 2; exit 0']);
  const bad = ready(fx, { env: { OFFLOAD_LOCAL_GATE_TIMEOUT_S: 'nope' } });
  assert.equal(bad.code, 0, 'a non-numeric knob falls back to the default, not to a zero timeout');
});

// --- corrective r1 ----------------------------------------------------------------------
// K1: a near-miss of a local line is refused with the line named, never silently skipped.
test('K1: decorated, backticked, table-row, bold-list and wrong-case local lines are refused by ready, naming the line', () => {
  const forms = ['**L1**: local: make', '`L1: local: make`', '| L1: local: make |', '- **L1: local:** make', 'L1: Local: make', 'L1: LOCAL: make', '`L1`: local: make'];
  for (const line of forms) {
    const repo = gitRepo();
    const out = scratch();
    const doc = mkGateDoc({ frozen: [line, L('L2', `touch ${out}/ran`)], head: repo.head, cwd: repo.dir });
    const before = read(doc);
    const r = cli(['ready', doc], { session: 's' });
    refused(r, line);
    assert.ok(r.err.includes(line.trim()), `the refusal names the line ${line}: ${r.err}`);
    assert.equal(read(doc), before, line);
    assert.ok(!existsSync(join(out, 'ran')), `${line}: no gate ran`);
  }
});

test('K1: the lines that are not near-misses still pass: a lowercase id, a mid-line mention, a criterion line', () => {
  const repo = gitRepo();
  const doc = mkGateDoc({ frozen: ['l11: local: make', 'see L9: local: make', 'L12: runs locally'], head: repo.head, cwd: repo.dir });
  assert.equal(cli(['ready', doc], { session: 's' }).code, 0);
});

// K2: the old-output sweep never follows a symlinked <doc>.gates and deletes only run directories.
const daysAgo = (p, d) => { const t = new Date(Date.now() - d * 24 * 60 * 60 * 1000); utimesSync(p, t, t); };

test('K2: a symlinked <doc>.gates is not swept: an old file and an old non-matching directory in its target survive', () => {
  const fx = readyFx(['true']);
  const target = scratch('linktarget');
  writeFileSync(join(target, 'old-file.txt'), 'x');
  mkdirSync(join(target, 'old-dir'));
  writeFileSync(join(target, 'old-dir', 'inner.txt'), 'x');
  daysAgo(join(target, 'old-file.txt'), 3); daysAgo(join(target, 'old-dir'), 3);
  symlinkSync(target, `${fx.doc}.gates`);
  assert.equal(ready(fx).code, 0);
  assert.ok(existsSync(join(target, 'old-file.txt')), 'the old file in the symlink target was deleted');
  assert.ok(existsSync(join(target, 'old-dir', 'inner.txt')), 'the old directory in the symlink target was deleted');
});

test('K2: in a real <doc>.gates only old run directories are swept; other old entries stay', () => {
  const fx = readyFx(['true']);
  const gates = `${fx.doc}.gates`;
  mkdirSync(gates);
  const oldRun = join(gates, '1700000000000-123-abcdef');
  const oldOther = join(gates, 'notes');
  const oldFile = join(gates, '1700000000001-124-abcdef');
  mkdirSync(oldRun); mkdirSync(oldOther); writeFileSync(oldFile, 'a file with a run name');
  for (const q of [oldRun, oldOther, oldFile]) daysAgo(q, 3);
  assert.equal(ready(fx).code, 0);
  assert.ok(!existsSync(oldRun), 'an old run directory is swept');
  assert.ok(existsSync(oldOther), 'an old non-matching directory was deleted');
  assert.ok(existsSync(oldFile), 'an old file with a run-dir name is not a run directory');
});

// K4: no test in the new files spawns a child without an explicit env.
test('K4: every child a new test file spawns passes an explicit env', () => {
  const calls = /\b(spawnSync|spawn|execFileSync|execSync)\(/g;
  for (const f of ['gate-fixture.mjs', 'test_local_gates.mjs', 'test_gate_hook.mjs', 'test_local_gates_docs.mjs']) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const m of src.matchAll(calls)) {
      const line = src.slice(0, m.index).split('\n').length;
      if (/import /.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
      const rest = src.slice(m.index, m.index + 420);
      const call = rest.slice(0, rest.search(/\)\s*(;|\)|,|$)/m) + 1 || rest.length);
      assert.ok(/\benv\b/.test(rest.split(/\n\s*\n/)[0].slice(0, 420)), `${f}:${line} spawns without env: ${call.slice(0, 90)}`);
    }
  }
});
