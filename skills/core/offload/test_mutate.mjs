// Tests for mutate.mjs. Every case drives the CLI the way the architect does, against a fixture repo in TMPDIR.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync, symlinkSync, realpathSync, statSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'mutate.mjs');
const ROOT = resolve(HERE, '..', '..', '..');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'mutate-test-')));
after(() => rmSync(BOX, { recursive: true, force: true }));

const GIT_ENV = { PATH: process.env.PATH, HOME: BOX, TMPDIR: tmpdir(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();

let seq = 0;
const next = () => ++seq;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  assert.fail(`timed out waiting for ${what}`);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const killQuiet = (pid, sig = 'SIGKILL') => { try { process.kill(pid, sig); } catch { /* gone */ } };
const readPid = (f) => { try { return Number(readFileSync(f, 'utf8').trim()); } catch { return 0; } };

const BASE_FILES = {
  'src/a.txt': 'alpha\nbeta\ngamma\n',
  'src/b.txt': 'alpha\n',
  't/c_alpha.sh': 'grep -q alpha src/a.txt\n',
  't/c_beta.sh': 'grep -q beta src/a.txt\n',
  't/c_all.sh': 'grep -q alpha src/a.txt && grep -q beta src/a.txt\n',
  't/slow.sh': 'grep -q alpha src/a.txt && exit 0\nsleep 1\nexit 1\n',
  't/test_a.mjs': "import test from 'node:test';\nimport { readFileSync } from 'node:fs';\nconst has = (w) => readFileSync('src/a.txt', 'utf8').includes(w);\ntest('alpha', () => { if (!has('alpha')) throw new Error('alpha gone'); });\ntest('beta', () => { if (!has('beta')) throw new Error('beta gone'); });\n",
  'empty/keep.txt': 'x\n',
  README: 'readme\n',
  'other.txt': 'o\n',
  '.gitignore': 'ign.txt\n.setup-done\n',
};

function put(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

// A fixture repo with one commit of BASE_FILES plus `extra`.
function repo(extra = {}) {
  const dir = join(BOX, `repo-${next()}`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, { ...BASE_FILES, ...extra });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
const head = (dir, rev = 'HEAD') => git(dir, 'rev-parse', rev);
const commitFiles = (dir, files, msg = 'change') => { put(dir, files); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return head(dir); };
const wtList = (dir) => git(dir, 'worktree', 'list', '--porcelain');
const scratch = (name = 'w') => { const d = join(BOX, `${name}-${next()}`); mkdirSync(d, { recursive: true }); return d; };
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

// One mutation entry: edit `word` to its uppercase form, killed by t/c_<word>.sh.
const mk = (id, word = 'alpha', over = {}) => ({ id, file: 'src/a.txt', find: word, replace: word.toUpperCase(), cmd: `sh t/c_${word}.sh`, ...over });

function exec(argv, { env, cwd = BOX } = {}) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', rej);
    c.on('close', (status, signal) => res({ status, signal, stdout, stderr }));
  });
}

const RESULT_LINE = [
  [/^killed   (\S+)  log: (\S+?)( timeout)?$/, (m) => ({ status: 'killed', id: m[1], log: m[2], timeout: Boolean(m[3]) })],
  [/^survived (\S+)  log: (\S+)$/, (m) => ({ status: 'survived', id: m[1], log: m[2] })],
  [/^error    (\S+)  (\S+)  exit (\d+|-)  log: (\S+)$/, (m) => ({ status: 'error', id: m[1], token: m[2], exit: m[3], log: m[4] })],
  [/^carried  (\S+)  @([0-9a-f]{40})$/, (m) => ({ status: 'carried', id: m[1], sha: m[2] })],
];
function parse(stdout) {
  const out = { header: {}, results: {}, order: [], summary: null, unparsed: [] };
  for (const l of stdout.split('\n').filter(Boolean)) {
    let m;
    if ((m = /^(Head|Logs|Pool|Since): (.+)$/.exec(l))) { out.header[m[1].toLowerCase()] = m[2]; continue; }
    if (/^killed=\d+ survived=\d+ error=\d+ carried=\d+ wall=[0-9.]+s$/.test(l)) { out.summary = l; continue; }
    const hit = RESULT_LINE.map(([re, f]) => { const x = re.exec(l); return x && f(x); }).find(Boolean);
    if (hit) { out.results[hit.id] = hit; out.order.push(hit.id); } else out.unparsed.push(l);
  }
  return out;
}

// Runs the runner. By default: --repo <fx> --head <HEAD> --log-dir <fresh>, run from outside the repo, with a
// minimal environment and a private TMPDIR so the test can see what the runner leaves behind.
async function go(dir, muts, args = [], o = {}) {
  const n = next();
  const input = o.input ?? join(BOX, `in-${n}.json`);
  if (o.raw !== undefined) writeFileSync(input, o.raw); else if (o.input === undefined) writeFileSync(input, JSON.stringify(muts));
  const tmp = o.tmp ?? join(BOX, `tmp-${n}`);
  mkdirSync(tmp, { recursive: true });
  const logDir = o.logDir ?? join(BOX, `log-${n}`);
  const argv = [RUNNER, input];
  if (!o.noRepo) argv.push('--repo', dir);
  if (!o.noHead) argv.push('--head', o.head ?? head(dir));
  if (!o.noLog) argv.push('--log-dir', logDir);
  argv.push(...args);
  const env = o.env ?? { PATH: process.env.PATH, HOME: BOX, TMPDIR: tmp, ...o.envExtra };
  const r = await exec(argv, { env, cwd: o.cwd });
  return { ...r, ...parse(r.stdout), tmp, logDir, argv, resultsFile: join(logDir, 'results.json') };
}
const resultsOf = (r) => JSON.parse(readFileSync(r.resultsFile, 'utf8'));
const noWorktree = async (dir, fn) => { const before = wtList(dir); const r = await fn(); assert.equal(wtList(dir), before, 'worktree list changed'); return r; };

// ---- input validation (exit 2, before any worktree) -------------------------------------------------------------

test('C1a: input that is not an array exits 2 before any worktree', async () => {
  const dir = repo();
  for (const raw of ['{"id":"x"}', 'not json', '"str"']) {
    const r = await noWorktree(dir, () => go(dir, null, [], { raw }));
    assert.equal(r.status, 2, raw);
    assert.match(r.stderr, /array|JSON/i, raw);
  }
});

test('C1b: an entry missing id, file or cmd, or with a wrong type, exits 2 and names the entry', async () => {
  const dir = repo();
  const rows = [
    [{ file: 'src/a.txt', find: 'alpha', replace: 'x', cmd: 'true' }, /entry 1\b/],
    [{ id: 'bad', find: 'alpha', replace: 'x', cmd: 'true' }, /bad/],
    [{ id: 'bad', file: 'src/a.txt', find: 'alpha', replace: 'x' }, /bad/],
    [{ id: 'bad', file: 'src/a.txt', find: 'alpha', replace: 'x', cmd: 1 }, /bad/],
  ];
  for (const [entry, who] of rows) {
    const r = await noWorktree(dir, () => go(dir, [mk('ok'), entry]));
    assert.equal(r.status, 2, JSON.stringify(entry));
    assert.match(r.stderr, who, JSON.stringify(entry));
  }
});

test('C1c: a duplicate id exits 2 and names the id', async () => {
  const dir = repo();
  const r = await noWorktree(dir, () => go(dir, [mk('same'), mk('same', 'beta')]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /same/);
});

test('C1d: an entry with both find and patch, or neither, exits 2 and names the entry', async () => {
  const dir = repo();
  const patch = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n-alpha\n+ALPHA\n beta\n gamma\n';
  const rows = [
    { id: 'both', file: 'src/a.txt', find: 'alpha', replace: 'x', patch, cmd: 'true' },
    { id: 'neither', file: 'src/a.txt', cmd: 'true' },
    { id: 'noreplace', file: 'src/a.txt', find: 'alpha', cmd: 'true' },
  ];
  for (const e of rows) {
    const r = await noWorktree(dir, () => go(dir, [e]));
    assert.equal(r.status, 2, e.id);
    assert.match(r.stderr, new RegExp(e.id), e.id);
  }
});

test('C1e: a file path that is absolute or leaves the repo exits 2 and names the entry', async () => {
  const dir = repo();
  const canary = join(BOX, 'x');
  writeFileSync(canary, 'untouched');
  for (const [id, file] of [['abs', '/abs/path'], ['up', '../x']]) {
    const r = await noWorktree(dir, () => go(dir, [{ id, file, find: 'a', replace: 'b', cmd: 'true' }]));
    assert.equal(r.status, 2, id);
    assert.match(r.stderr, new RegExp(id), id);
  }
  assert.equal(readFileSync(canary, 'utf8'), 'untouched');
});

// ---- edits ------------------------------------------------------------------------------------------------------

test('C2a: a find with no match is an error and no file changes', async () => {
  const dir = repo();
  const before = git(dir, 'status', '--porcelain');
  const r = await go(dir, [mk('nf', 'alpha', { find: 'nothere' })]);
  assert.equal(r.status, 1);
  assert.equal(r.results.nf.status, 'error');
  assert.equal(r.results.nf.token, 'edit-not-found');
  assert.equal(git(dir, 'status', '--porcelain'), before);
});

test('C2b: a find that matches twice is an error and no file changes', async () => {
  const dir = repo({ 'src/dup.txt': 'dup dup\n' });
  const before = git(dir, 'status', '--porcelain');
  const r = await go(dir, [{ id: 'amb', file: 'src/dup.txt', find: 'dup', replace: 'x', cmd: 'false' }]);
  assert.equal(r.results.amb.status, 'error');
  assert.equal(r.results.amb.token, 'edit-ambiguous');
  assert.equal(git(dir, 'status', '--porcelain'), before);
});

test('C2c: a patch that does not apply is an error', async () => {
  const dir = repo();
  const patch = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,1 +1,1 @@\n-nothere\n+x\n';
  const r = await go(dir, [{ id: 'bad', file: 'src/a.txt', patch, cmd: 'sh t/c_alpha.sh' }]);
  assert.equal(r.results.bad.status, 'error');
  assert.equal(r.results.bad.token, 'patch-failed');
});

test('C2d: a patch that applies and turns its cmd red is killed', async () => {
  const dir = repo();
  const patch = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n-alpha\n+ALPHA\n beta\n gamma\n';
  const r = await go(dir, [{ id: 'p', file: 'src/a.txt', patch, cmd: 'sh t/c_alpha.sh' }]);
  assert.equal(r.status, 0);
  assert.equal(r.results.p.status, 'killed');
});

// ---- baseline ---------------------------------------------------------------------------------------------------

test('C3a: a cmd red on the clean head is error baseline-red with a log path', async () => {
  const dir = repo();
  const counter = join(scratch(), 'count');
  const r = await go(dir, [mk('red', 'alpha', { cmd: `echo x >> ${counter}; exit 1` })]);
  assert.equal(r.status, 1);
  assert.equal(r.results.red.status, 'error');
  assert.equal(r.results.red.token, 'baseline-red');
  assert.ok(existsSync(r.results.red.log), 'log path exists');
  assert.equal(lines(counter).length, 1, 'only the baseline ran');
});

test('C3b: a green cmd whose output shows zero tests is error no-tests', async () => {
  const sigs = {
    unittest: 'Ran 0 tests in 0.000s\n\nOK\n',
    phpunit: 'No tests executed!\n',
    tap: '# tests 0\n# pass 0\n',
    spec: 'ℹ tests 0\nℹ pass 0\n',
  };
  const files = {};
  for (const [k, out] of Object.entries(sigs)) files[`t/z_${k}.sh`] = `printf '${out.replace(/\n/g, '\\n')}'\ngrep -q alpha src/a.txt\n`;
  files['t/z_inner.sh'] = "printf '# tests 0\\n# tests 2\\n# pass 2\\n'\ngrep -q alpha src/a.txt\n";
  const dir = repo(files);
  const r = await go(dir, [...Object.keys(sigs).map((k) => mk(`z_${k}`, 'alpha', { cmd: `sh t/z_${k}.sh` })), mk('z_inner', 'alpha', { cmd: 'sh t/z_inner.sh' })]);
  for (const k of Object.keys(sigs)) {
    assert.equal(r.results[`z_${k}`].status, 'error', k);
    assert.equal(r.results[`z_${k}`].token, 'no-tests', k);
  }
  assert.equal(r.results.z_inner.status, 'killed', 'a zero in a test\'s own output above a nonzero summary is not flagged');
});

test('C3c: real node and python runs that select no test are errors', async () => {
  const dir = repo();
  const r = await go(dir, [
    mk('node_test', 'alpha', { cmd: "node --test --test-name-pattern='^nomatch$' t/test_a.mjs" }),
    mk('node_plain', 'alpha', { cmd: "node --test-name-pattern='^nomatch$' t/test_a.mjs" }),
    mk('py', 'alpha', { cmd: 'python3 -m unittest discover -s empty' }),
    mk('node_hit', 'alpha', { cmd: "node --test --test-name-pattern='^alpha$' t/test_a.mjs" }),
  ]);
  assert.equal(r.results.node_test.status, 'error');
  assert.equal(r.results.node_test.token, 'no-tests');
  assert.equal(r.results.node_plain.status, 'error');
  assert.equal(r.results.node_plain.token, 'no-tests');
  assert.equal(r.results.py.status, 'error');
  assert.match(r.results.py.token, /^(baseline-red|no-tests)$/);
  assert.equal(r.results.node_hit.status, 'killed');
});

test('C3d: each distinct cmd runs once at baseline', async () => {
  const dir = repo();
  const counter = join(scratch(), 'count');
  const cmd = `echo x >> ${counter}; sh t/c_all.sh`;
  const r = await go(dir, [mk('one', 'alpha', { cmd }), mk('two', 'beta', { cmd })]);
  assert.equal(r.status, 0);
  assert.equal(lines(counter).length, 3, '1 baseline + 2 mutations');
});

// ---- exit codes and output --------------------------------------------------------------------------------------

test('C4a: all killed exits 0', async () => {
  const dir = repo();
  const r = await go(dir, [mk('a'), mk('b', 'beta')]);
  assert.equal(r.status, 0);
  assert.equal(r.results.a.status, 'killed');
  assert.equal(r.results.b.status, 'killed');
});

test('C4b: one survived among killed exits 1 and prints its survived line with a log path', async () => {
  const dir = repo();
  const r = await go(dir, [mk('a'), mk('s', 'gamma', { cmd: 'sh t/c_alpha.sh' })]);
  assert.equal(r.status, 1);
  assert.equal(r.results.s.status, 'survived');
  assert.ok(existsSync(r.results.s.log));
  assert.equal(r.results.a.status, 'killed');
});

test('C4c: one error among killed exits 1', async () => {
  const dir = repo();
  const r = await go(dir, [mk('a'), mk('e', 'alpha', { find: 'nothere' })]);
  assert.equal(r.status, 1);
  assert.equal(r.results.a.status, 'killed');
  assert.equal(r.results.e.status, 'error');
});

// ---- timeouts ---------------------------------------------------------------------------------------------------

test('C5: a timeout kills the whole command group; a baseline timeout is error timeout and a mutation timeout is killed timeout', { timeout: 30000 }, async () => {
  const dir = repo();
  const w = scratch();
  const pids = [];
  try {
    const hang = (pidf) => `sleep 600 >/dev/null 2>&1 & echo $! > ${pidf}; wait`;
    const p1 = join(w, 'pid1');
    const r1 = await go(dir, [mk('base', 'alpha', { cmd: hang(p1) })], ['--timeout', '1']);
    pids.push(readPid(p1));
    assert.equal(r1.results.base.status, 'error');
    assert.equal(r1.results.base.token, 'timeout');
    const p2 = join(w, 'pid2');
    const r2 = await go(dir, [mk('mut', 'alpha', { cmd: `if grep -q alpha src/a.txt; then exit 0; fi; ${hang(p2)}` })], ['--timeout', '1']);
    pids.push(readPid(p2));
    assert.equal(r2.results.mut.status, 'killed');
    assert.equal(r2.results.mut.timeout, true);
    for (const pid of pids) {
      assert.ok(pid > 1, 'pid recorded');
      await waitFor(() => !alive(pid), 3000, `pid ${pid} to die`);
    }
  } finally {
    for (const pid of pids) if (pid > 1) killQuiet(pid);
  }
});

// ---- setup and restore ------------------------------------------------------------------------------------------

test('C6a: setup runs once in each worktree before that worktree runs any command', async () => {
  const dir = repo();
  const out = join(scratch(), 'setups');
  const cmd = (w) => `test -f .setup-done && sh t/c_${w}.sh`;
  const r = await go(dir, [mk('a', 'alpha', { cmd: cmd('alpha') }), mk('b', 'beta', { cmd: cmd('beta') }), mk('c', 'gamma', { cmd: 'test -f .setup-done && sh t/c_alpha.sh' })],
    ['--jobs', '2', '--setup', `pwd >> ${out}; touch .setup-done`]);
  assert.equal(r.results.a.status, 'killed');
  assert.equal(r.results.b.status, 'killed');
  assert.equal(r.results.c.status, 'survived');
  const wts = lines(out);
  assert.equal(wts.length, Number(r.header.pool));
  assert.equal(new Set(wts).size, wts.length, 'one setup per pool worktree');
});

test('C6b: a failed setup stops dispatch and every unrun mutation is error setup-failed', async () => {
  const dir = repo();
  const r = await noWorktreeLeft(dir, () => go(dir, [mk('a'), mk('b', 'beta')], ['--jobs', '1', '--setup', 'exit 3']));
  assert.equal(r.status, 1);
  for (const id of ['a', 'b']) {
    assert.equal(r.results[id].status, 'error', id);
    assert.equal(r.results[id].token, 'setup-failed', id);
  }
  assert.deepEqual(readdirSync(r.tmp), []);
});
// Like noWorktree, but the run may print results; the fixture's worktree list must match afterward.
async function noWorktreeLeft(dir, fn) { const before = wtList(dir); const r = await fn(); assert.equal(wtList(dir), before, 'a runner worktree is left'); return r; }

test('C6c: between mutations the edit and untracked files are gone and setup ignored files remain', async () => {
  const dir = repo();
  const w = scratch();
  const setups = join(w, 'setups');
  const m1 = mk('m1', 'alpha', { cmd: 'touch untracked.txt; sh t/c_alpha.sh' });
  const m2 = mk('m2', 'beta', { cmd: 'test -f ign.txt || exit 0; test -e untracked.txt && exit 0; grep -q alpha src/a.txt || exit 0; sh t/c_beta.sh' });
  const r = await go(dir, [m1, m2], ['--jobs', '1', '--setup', `echo s >> ${setups}; touch ign.txt`]);
  assert.equal(r.results.m1.status, 'killed');
  assert.equal(r.results.m2.status, 'killed');
  assert.equal(lines(setups).length, 1, 'setup ran once: the restore kept its ignored output');
});

test('C6d: setup output that is untracked and not ignored survives restore', async () => {
  const dir = repo();
  const gate = (w) => `test -d deps || exit 0; sh t/c_${w}.sh`;
  const r = await go(dir, [mk('m1', 'alpha', { cmd: gate('alpha') }), mk('m2', 'beta', { cmd: gate('beta') })], ['--jobs', '1', '--setup', 'mkdir -p deps; touch deps/x']);
  assert.equal(r.results.m1.status, 'killed');
  assert.equal(r.results.m2.status, 'killed');
});

// ---- command environment ----------------------------------------------------------------------------------------

function allowlist() {
  const text = readFileSync(join(ROOT, 'scripts', 'test-all.sh'), 'utf8');
  const m = /build_child_env\(\) \{[\s\S]*?case "\$name" in\n([\s\S]*?)\)\n\s*CHILD_ENV\+=\("\$name=/.exec(text);
  assert.ok(m, 'found the case list in build_child_env');
  return m[1].replace(/\\\n/g, '').split('|').map((s) => s.trim()).filter(Boolean);
}
const envNames = (file) => readFileSync(file, 'utf8').split('\n').map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1]).filter(Boolean);
const envOf = (file) => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const logsMatching = (dir, re) => readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));

test('C7a: no denied or unlisted variable reaches baseline, setup or mutation commands', async () => {
  const dir = repo();
  const live = scratch('live');
  const hostile = { BORK_RUN_DIR: join(live, 'run'), BORK_RUN_ID: 'live-run', OFFLOAD_HANDOFF: join(live, 'h.md'), OFFLOAD_SESSION_ID: 'live-sess', CLAUDE_X: '1', CODEX_X: '1', HERDR_ENV: '1', UNLISTED_X: '1', AGENT_HANDOFFS_DIR: live };
  const r = await go(dir, [mk('a', 'alpha', { cmd: 'env; sh t/c_alpha.sh' })], ['--jobs', '1', '--setup', 'env'], { envExtra: hostile });
  assert.equal(r.results.a.status, 'killed');
  const allowed = new Set([...allowlist().filter((n) => !n.includes('*')), 'TMPDIR', 'AGENT_HANDOFFS_DIR', 'BORK_RUNS_HOME', 'ORCHESTRATOR_HOME', 'BORK_REPO_RULES_DIR', 'PYTHONDONTWRITEBYTECODE', 'PWD', 'SHLVL', 'OLDPWD', '_']);
  const files = [...logsMatching(r.logDir, /^setup-/), ...logsMatching(r.logDir, /^baseline-/), r.results.a.log];
  assert.equal(files.length, 3, 'a setup, a baseline and a mutation log');
  for (const f of files) {
    for (const name of envNames(f)) assert.ok(allowed.has(name) || name.startsWith('LC_'), `${name} reached ${f}`);
    assert.notEqual(envOf(f).AGENT_HANDOFFS_DIR, live, 'the live handoffs dir is not passed');
  }
});

test('C7b: every name test-all allows reaches the cmd and LANG gets a UTF-8 default', async () => {
  const dir = repo();
  const names = allowlist().filter((n) => !n.includes('*'));
  assert.ok(names.includes('NODE_EXTRA_CA_CERTS') && names.includes('http_proxy'), 'parsed the real list');
  const want = Object.fromEntries([...names, 'LC_TEST'].map((n) => [n, `v-${n}`]));
  want.PATH = process.env.PATH; want.HOME = BOX; want.LANG = 'C.UTF-8';
  const rtmp = scratch('rtmp');
  const r = await go(dir, [mk('a', 'alpha', { cmd: 'env; sh t/c_alpha.sh' })], [], { env: { ...want, TMPDIR: rtmp } });
  assert.equal(r.results.a?.status, 'killed', r.stderr);
  const got = envOf(r.results.a.log);
  for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, k);
  const r2 = await go(dir, [mk('a', 'alpha', { cmd: 'env; sh t/c_alpha.sh' })], [], { env: { PATH: process.env.PATH, HOME: BOX, TMPDIR: rtmp } });
  assert.equal(envOf(r2.results.a.log).LANG, 'en_US.UTF-8');
});

test('C7c: pass-env passes a named variable and a denied name exits 2', async () => {
  const dir = repo();
  const r = await go(dir, [mk('a', 'alpha', { cmd: 'env; sh t/c_alpha.sh' })], ['--pass-env', 'SSH_AUTH_SOCK'], { envExtra: { SSH_AUTH_SOCK: '/tmp/agent-sock-test' } });
  assert.equal(envOf(r.results.a.log).SSH_AUTH_SOCK, '/tmp/agent-sock-test');
  for (const name of ['BORK_RUN_DIR', 'BORK_RUN_ID', 'OFFLOAD_HANDOFF', 'CLAUDE_X', 'CODEX_X', 'HERDR_ENV', 'GIT_DIR']) {
    const d = await noWorktree(dir, () => go(dir, [mk('a')], ['--pass-env', name], { envExtra: { [name]: 'x' } }));
    assert.equal(d.status, 2, name);
    assert.match(d.stderr, new RegExp(name), name);
  }
});

test('C7d: every command run gets its own fresh TMPDIR and empty state directories', async () => {
  const out = join(scratch(), 'probe.out');
  const probe = [
    'for d in AGENT_HANDOFFS_DIR BORK_RUNS_HOME ORCHESTRATOR_HOME BORK_REPO_RULES_DIR; do',
    '  eval "v=\\$$d"',
    '  case "$v" in "$TMPDIR"/*) ;; *) echo "bad-path $d" >> "$1" ;; esac',
    '  [ -d "$v" ] || echo "missing $d" >> "$1"',
    '  [ -z "$(ls -A "$v")" ] || echo "not-empty $d" >> "$1"',
    'done',
    '[ -e "$TMPDIR/marker" ] && echo "marker-present" >> "$1"',
    'touch "$TMPDIR/marker"',
    'echo "tmp $TMPDIR" >> "$1"',
  ].join('\n');
  const d2 = repo({ 't/probe.sh': probe });
  const cmd = `sh t/probe.sh ${out} && sh t/c_all.sh`;
  const r = await go(d2, [mk('a', 'alpha', { cmd }), mk('b', 'beta', { cmd })], ['--jobs', '1']);
  assert.equal(r.results.a.status, 'killed');
  assert.equal(r.results.b.status, 'killed');
  const got = lines(out);
  assert.deepEqual(got.filter((l) => !l.startsWith('tmp ')), [], 'no state directory problem, no marker carried over');
  const tmps = got.filter((l) => l.startsWith('tmp '));
  assert.equal(tmps.length, 3, 'baseline plus two mutations');
  assert.equal(new Set(tmps).size, 3, 'every run has its own TMPDIR');
});

test('C7e: pass-env cannot point TMPDIR or a state directory at live state', async () => {
  const dir = repo();
  const live = scratch('live');
  writeFileSync(join(live, 'canary'), 'x');
  const runnerTmp = scratch('rtmp');
  const r = await go(dir, [mk('a', 'alpha', { cmd: 'env; sh t/c_alpha.sh' })],
    ['--pass-env', 'AGENT_HANDOFFS_DIR', '--pass-env', 'TMPDIR', '--pass-env', 'BORK_RUNS_HOME'],
    { env: { PATH: process.env.PATH, HOME: BOX, TMPDIR: runnerTmp, AGENT_HANDOFFS_DIR: live, BORK_RUNS_HOME: live } });
  assert.equal(r.status, 0, r.stderr);
  const got = envOf(r.results.a.log);
  assert.notEqual(got.TMPDIR, runnerTmp);
  assert.ok(got.TMPDIR.length > 0);
  for (const n of ['AGENT_HANDOFFS_DIR', 'BORK_RUNS_HOME']) {
    assert.notEqual(got[n], live, n);
    assert.ok(got[n].startsWith(`${got.TMPDIR}/`), `${n} is under the run's TMPDIR`);
  }
  assert.deepEqual(readdirSync(live), ['canary']);
});

test('C7f: a planted secret appears in no output, log or results file', async () => {
  const dir = repo();
  const secret = `SECRET-${Math.random().toString(36).slice(2)}${Date.now()}`;
  const r = await go(dir, [mk('a', 'alpha', { cmd: 'env; sh t/c_alpha.sh' })], [], { envExtra: { SECRET_MARKER: secret } });
  assert.equal(r.results.a.status, 'killed');
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
  for (const f of readdirSync(r.logDir)) assert.ok(!readFileSync(join(r.logDir, f), 'utf8').includes(secret), f);
  assert.ok(existsSync(r.resultsFile));
});

test('C7g: the runner git calls run no repository hook', async () => {
  const dir = repo();
  const w = scratch();
  const marker = join(w, 'hook-ran');
  const hook = join(dir, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\nenv > ${marker}.env\ntouch ${marker}\n`);
  chmodSync(hook, 0o755);
  const probe = join(BOX, `probe-wt-${next()}`);
  git(dir, 'worktree', 'add', '--detach', probe);
  assert.ok(existsSync(marker), 'control: the hook fires for a plain git worktree add');
  git(dir, 'worktree', 'remove', '--force', probe);
  rmSync(marker); rmSync(`${marker}.env`);
  const r = await go(dir, [mk('a'), mk('b', 'beta')], ['--jobs', '2']);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(marker), 'the runner ran a repository hook');
});

// ---- pool -------------------------------------------------------------------------------------------------------

test('C8a: with jobs 3 three mutations run at the same time', { timeout: 60000 }, async () => {
  const bar = scratch('barrier');
  const gate = [
    'grep -q alpha src/a.txt && exit 0',
    `D=${bar}`,
    'touch "$D/$1"',
    'i=0',
    'while [ "$(ls "$D" | wc -l)" -lt 3 ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done',
    'if [ "$(ls "$D" | wc -l)" -ge 3 ]; then exit 1; fi',
    'exit 0',
  ].join('\n');
  const dir = repo({ 'gate.sh': gate });
  const r = await go(dir, ['a', 'b', 'c'].map((x) => mk(x, 'alpha', { cmd: `sh gate.sh ${x}` })), ['--jobs', '3']);
  for (const x of ['a', 'b', 'c']) assert.equal(r.results[x].status, 'killed', x);
});

test('C8b: serial runs one command at a time', { timeout: 60000 }, async () => {
  const lock = join(scratch('lock'), 'held');
  const script = ['grep -q alpha src/a.txt && exit 0', `if mkdir ${lock} 2>/dev/null; then sleep 0.3; rmdir ${lock}; exit 1; fi`, 'exit 0'].join('\n');
  const dir = repo({ 'lock.sh': script });
  const r = await go(dir, ['a', 'b', 'c'].map((x) => mk(x, 'alpha', { cmd: 'sh lock.sh' })), ['--serial']);
  for (const x of ['a', 'b', 'c']) assert.equal(r.results[x].status, 'killed', x);
});

test('C8c: the pool size line is the smaller of jobs and the mutation count, and 1 under serial', async () => {
  const dir = repo();
  const def = Math.max(1, Math.min(8, availableParallelism() - 1));
  const rows = [
    [['a', 'b'], [], Math.min(def, 2)],
    [['a', 'b', 'c'], ['--jobs', '8'], 3],
    [['a', 'b', 'c'], ['--serial'], 1],
  ];
  for (const [ids, args, pool] of rows) {
    const out = join(scratch(), 'wtcount');
    const muts = ids.map((x) => mk(x, 'alpha', { cmd: `git worktree list | wc -l >> ${out}; sh t/c_alpha.sh` }));
    const r = await go(dir, muts, args);
    assert.equal(r.header.pool, String(pool), args.join(' '));
    for (const n of lines(out)) assert.equal(Number(n.trim()), pool + 1, `worktrees seen by a cmd (${args.join(' ')})`);
    assert.ok(lines(out).length > 0);
  }
});

test('C9: head resolves once and every mutation runs at that sha', async () => {
  const dir = repo();
  const h1 = head(dir);
  commitFiles(dir, { 'src/a.txt': 'omega\nbeta\ngamma\n' }, 'drop alpha');
  const h2 = head(dir);
  assert.notEqual(h1, h2);
  const r = await go(dir, [mk('a')], ['--head', 'HEAD~1'], { noHead: true });
  assert.equal(r.results.a.status, 'killed');
  assert.equal(r.header.head, h1);
  assert.equal(resultsOf(r).head, h1);
  assert.equal(head(dir), h2, 'the main checkout HEAD did not move');
});

// ---- cleanup ----------------------------------------------------------------------------------------------------

test('C10a: a normal run leaves the worktree list and temp root as they were', async () => {
  const dir = repo();
  const before = wtList(dir);
  const r = await go(dir, [mk('a'), mk('b', 'beta')], ['--jobs', '2']);
  assert.equal(r.status, 0);
  assert.equal(wtList(dir), before);
  assert.deepEqual(readdirSync(r.tmp), []);
});

// A mutated cmd that leaves a background sleep and waits; the test signals the runner once it has started.
async function interrupted(dir, sig, extraArgs = []) {
  const w = scratch();
  const pidf = join(w, 'pid');
  const mark = join(w, 'mark');
  const tmp = join(w, 'tmp');
  mkdirSync(tmp);
  const cmd = `if grep -q alpha src/a.txt; then exit 0; fi; sleep 600 >/dev/null 2>&1 & echo $! > ${pidf}; echo started > ${mark}; wait`;
  const input = join(w, 'in.json');
  writeFileSync(input, JSON.stringify([mk('hang', 'alpha', { cmd })]));
  const logDir = join(w, 'log');
  const child = spawn(process.execPath, [RUNNER, input, '--repo', dir, '--head', head(dir), '--log-dir', logDir, ...extraArgs], { env: { PATH: process.env.PATH, HOME: BOX, TMPDIR: tmp }, stdio: 'ignore' });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  try {
    await waitFor(() => existsSync(mark), 20000, 'the mutated cmd to start');
    child.kill(sig);
    const ex = await Promise.race([exited, sleep(15000).then(() => 'timeout')]);
    assert.notEqual(ex, 'timeout', 'the runner exited after the signal');
    const pid = readPid(pidf);
    assert.ok(pid > 1);
    await waitFor(() => !alive(pid), 3000, 'the sleep to die');
    return { ex, tmp };
  } finally {
    const pid = readPid(pidf);
    if (pid > 1) killQuiet(pid);
    killQuiet(child.pid);
  }
}

test('C10b: SIGINT mid run kills the command group, removes every worktree and exits 130', { timeout: 30000 }, async () => {
  const dir = repo();
  const before = wtList(dir);
  const { ex, tmp } = await interrupted(dir, 'SIGINT');
  assert.equal(ex.code, 130);
  assert.equal(wtList(dir), before);
  assert.deepEqual(readdirSync(tmp), []);
});

test('C10c: SIGTERM and SIGHUP mid run kill the command group, remove every worktree and exit 143 and 129', { timeout: 30000 }, async () => {
  const dir = repo();
  const before = wtList(dir);
  for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
    const { ex, tmp } = await interrupted(dir, sig);
    assert.equal(ex.code, code, sig);
    assert.equal(wtList(dir), before, sig);
    assert.deepEqual(readdirSync(tmp), [], sig);
  }
});

test('C10d: when writing the results file fails the runner still removes every worktree and exits nonzero', { timeout: 30000 }, async () => {
  const dir = repo();
  const before = wtList(dir);
  const logDir = join(BOX, `log-chmod-${next()}`);
  try {
    const ran = join(scratch(), 'ran');
    const cmd = `grep -q alpha src/a.txt && exit 0; echo x > ${ran}; chmod 500 ${logDir}; exit 1`;
    const r = await go(dir, [mk('a', 'alpha', { cmd })], [], { logDir });
    assert.ok(existsSync(ran), 'the mutated cmd ran and locked the log dir');
    assert.equal(statSync(logDir).mode & 0o200, 0, 'the log dir is read-only');
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, null);
    assert.ok(!existsSync(join(logDir, 'results.json')));
    assert.equal(wtList(dir), before);
    assert.deepEqual(readdirSync(r.tmp), []);
  } finally {
    try { chmodSync(logDir, 0o700); } catch { /* never created */ }
  }
});

test('C10e: a foreign worktree and a stale worktree entry are still listed after the run', { timeout: 30000 }, async () => {
  const dir = repo();
  const foreign = join(BOX, `foreign-${next()}`);
  const stale = join(BOX, `stale-${next()}`);
  git(dir, 'worktree', 'add', '-q', '--detach', foreign);
  git(dir, 'worktree', 'add', '-q', '--detach', stale);
  rmSync(stale, { recursive: true, force: true });
  const listed = () => { const l = wtList(dir); return [foreign, stale].map((p) => l.includes(`worktree ${p}\n`) || l.includes(`worktree ${p}`)); };
  assert.deepEqual(listed(), [true, true], 'control: both are listed before');
  await go(dir, [mk('a')]);
  assert.deepEqual(listed(), [true, true], 'after a normal run');
  await interrupted(dir, 'SIGINT');
  assert.deepEqual(listed(), [true, true], 'after a SIGINT run');
});

test('C10f: the main checkout keeps its branch, staged change and dirty file', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'staged.txt'), 'staged\n');
  git(dir, 'add', 'staged.txt');
  writeFileSync(join(dir, 'README'), 'readme edited\n');
  writeFileSync(join(dir, 'untracked.txt'), 'u\n');
  const snap = () => [git(dir, 'status', '--porcelain=v2', '--branch'), git(dir, 'diff', '--cached'), git(dir, 'diff')].join('\n--\n');
  const before = snap();
  const r = await go(dir, [mk('a'), mk('b', 'beta')], ['--jobs', '2']);
  assert.equal(r.status, 0);
  assert.equal(snap(), before);
});

// ---- output -----------------------------------------------------------------------------------------------------

test('C11a: the first lines are Head with the full sha, Logs and Pool', async () => {
  const dir = repo();
  const h = head(dir);
  const r = await go(dir, [mk('a')]);
  const first = r.stdout.split('\n').slice(0, 3);
  assert.match(first[0], /^Head: [0-9a-f]{40}$/);
  assert.equal(first[0], `Head: ${h}`);
  assert.equal(first[1], `Logs: ${r.logDir}`);
  assert.match(first[2], /^Pool: \d+$/);
  const r2 = await go(dir, [mk('a')], ['--since', r.resultsFile]);
  assert.equal(r2.stdout.split('\n')[3], `Since: ${h}`);
});

test('C11b: result lines follow input order in the exact formats', async () => {
  const dir = repo();
  const muts = [mk('s1', 'alpha', { cmd: 'sh t/slow.sh' }), mk('k2', 'beta'), mk('v3', 'gamma', { cmd: 'sh t/c_alpha.sh' }), mk('e4', 'alpha', { find: 'nothere' }), mk('b5', 'alpha', { cmd: 'exit 1' })];
  const r = await go(dir, muts, ['--jobs', '3']);
  assert.deepEqual(r.order, ['s1', 'k2', 'v3', 'e4', 'b5']);
  assert.deepEqual(r.unparsed, []);
  assert.deepEqual(['s1', 'k2'].map((i) => r.results[i].status), ['killed', 'killed']);
  assert.equal(r.results.v3.status, 'survived');
  assert.equal(r.results.e4.token, 'edit-not-found');
  assert.equal(r.results.b5.token, 'baseline-red');
  const TOKENS = 'edit-not-found edit-ambiguous patch-failed baseline-red no-tests setup-failed timeout signal spawn-failed restore-failed'.split(' ');
  for (const id of ['e4', 'b5']) assert.ok(TOKENS.includes(r.results[id].token));
  const r2 = await go(dir, muts, ['--since', r.resultsFile]);
  assert.equal(r2.results.s1.status, 'carried');
  assert.match(r2.stdout, new RegExp(`^carried  s1  @${head(dir)}$`, 'm'));
  assert.deepEqual(r2.order, ['s1', 'k2', 'v3', 'e4', 'b5']);
});

test('C11c: the last line gives counts and wall time', async () => {
  const dir = repo();
  const r = await go(dir, [mk('a'), mk('s', 'gamma', { cmd: 'sh t/c_alpha.sh' }), mk('e', 'alpha', { find: 'nothere' })]);
  const last = r.stdout.trimEnd().split('\n').at(-1);
  assert.match(last, /^killed=\d+ survived=\d+ error=\d+ carried=\d+ wall=[0-9.]+s$/);
  assert.match(last, /^killed=1 survived=1 error=1 carried=0 /);
});

test('C11d: the results file holds the schema, head and every field per mutation, and every printed log path exists after the run', async () => {
  const dir = repo({ 't/helper.mjs': 'export const x = 1;\n', 't/test_h.mjs': "import { x } from './helper.mjs';\nvoid x;\n" });
  const patch = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n-alpha\n+ALPHA\n beta\n gamma\n';
  const r = await go(dir, [mk('f', 'beta', { cmd: 'sh t/c_beta.sh t/test_h.mjs' }), { id: 'p', file: 'src/a.txt', patch, cmd: 'sh t/c_alpha.sh' }], [], { noLog: true });
  assert.equal(r.status, 0, r.stderr);
  const logs = r.header.logs;
  try {
    const res = JSON.parse(readFileSync(join(logs, 'results.json'), 'utf8'));
    assert.equal(res.schema, 1);
    assert.equal(res.head, head(dir));
    assert.equal(res.mutations.length, 2);
    const f = res.mutations.find((m) => m.id === 'f');
    assert.deepEqual(Object.keys(f).sort(), ['cmd', 'deps', 'exit', 'file', 'find', 'head', 'id', 'log', 'replace', 'status', 'tests'].sort());
    assert.equal(f.status, 'killed');
    assert.equal(f.head, head(dir));
    assert.deepEqual(f.deps.sort(), ['t/helper.mjs', 't/test_h.mjs'].concat(['t/c_beta.sh']).sort());
    const p = res.mutations.find((m) => m.id === 'p');
    assert.equal(p.patch, patch);
    assert.ok(!('find' in p));
    for (const l of Object.values(r.results)) assert.ok(existsSync(l.log), `log ${l.log} exists after cleanup`);
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
});

// ---- --since ----------------------------------------------------------------------------------------------------

const COUNTED = (counter, w = 'alpha') => `echo x >> ${counter}; sh t/c_${w}.sh`;
async function twoRounds(dir, round1, edit, round2 = round1) {
  const w = scratch();
  const r1 = await go(dir, round1);
  const h1 = head(dir);
  const h2 = edit();
  const r2 = await go(dir, round2, ['--since', r1.resultsFile]);
  return { r1, r2, h1, h2, w };
}

test('C12a: an unchanged killed mutation whose file and tests did not change is carried with its recorded head', async () => {
  const dir = repo();
  const counter = join(scratch(), 'count');
  const muts = [mk('a', 'alpha', { cmd: COUNTED(counter) })];
  const { r1, r2, h1 } = await twoRounds(dir, muts, () => commitFiles(dir, { README: 'readme 2\n' }));
  assert.equal(r1.results.a.status, 'killed');
  const before = lines(counter).length;
  assert.equal(r2.results.a.status, 'carried');
  assert.equal(r2.results.a.sha, h1);
  assert.equal(resultsOf(r2).mutations[0].head, h1);
  assert.equal(r2.status, 0);
  assert.equal(lines(counter).length, before, 'its cmd did not run again');
  assert.equal(before, 2);
});

test('C12b: a mutation whose previous status was survived or error reruns', async () => {
  const dir = repo();
  const counter = join(scratch(), 'count');
  const surv = mk('s', 'gamma', { cmd: COUNTED(counter) });
  const base = mk('e', 'alpha', { cmd: `echo y >> ${counter}.e; exit 1` });
  const { r1, r2 } = await twoRounds(dir, [surv, base], () => commitFiles(dir, { README: 'readme 2\n' }));
  assert.equal(r1.results.s.status, 'survived');
  assert.equal(r1.results.e.status, 'error');
  assert.equal(r2.results.s.status, 'survived', 'reran, so not carried');
  assert.equal(r2.results.e.status, 'error');
  assert.equal(r2.results.e.token, 'baseline-red');
  assert.equal(lines(counter).length, 4, 'baseline + mutation in each round');
  assert.equal(lines(`${counter}.e`).length, 2);
});

test('C12c: a mutation whose file, edit or cmd changed under the same id reruns', async () => {
  const patchA = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n-alpha\n+ALPHA\n beta\n gamma\n';
  const patchB = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n-alpha\n+ALPHB\n beta\n gamma\n';
  const rows = [
    ['file', mk('m'), mk('m', 'alpha', { file: 'src/b.txt' })],
    ['find', mk('m'), mk('m', 'alpha', { find: 'beta', replace: 'BETA' })],
    ['replace', mk('m'), mk('m', 'alpha', { replace: 'ALPHA2' })],
    ['patch', { id: 'm', file: 'src/a.txt', patch: patchA, cmd: 'sh t/c_alpha.sh' }, { id: 'm', file: 'src/a.txt', patch: patchB, cmd: 'sh t/c_alpha.sh' }],
    ['cmd', mk('m'), mk('m', 'alpha', { cmd: 'sh t/c_alpha.sh && true' })],
  ];
  for (const [what, a, b] of rows) {
    const dir = repo();
    const { r1, r2 } = await twoRounds(dir, [a], () => commitFiles(dir, { README: 'readme 2\n' }), [b]);
    assert.equal(r1.results.m.status, 'killed', what);
    assert.notEqual(r2.results.m.status, 'carried', `${what} changed, so it reruns`);
  }
});

test('C12d: a mutation whose recorded head is not an ancestor reruns', async () => {
  const dir = repo();
  const base = head(dir);
  commitFiles(dir, { README: 'on main\n' }, 'main side');
  const r1 = await go(dir, [mk('a')]);
  git(dir, 'checkout', '-q', '-b', 'alt', base);
  const h2 = commitFiles(dir, { README: 'rewritten\n' }, 'rewritten branch');
  const r2 = await go(dir, [mk('a')], ['--since', r1.resultsFile], { head: h2 });
  assert.equal(r2.results.a.status, 'killed');
});

test('C12e: a mutation whose file changed since its recorded head reruns', async () => {
  const dir = repo();
  const { r2 } = await twoRounds(dir, [mk('a')], () => commitFiles(dir, { 'src/a.txt': 'alpha\nbeta\ngamma\ndelta\n' }));
  assert.equal(r2.results.a.status, 'killed');
});

test('C12f: a mutation whose test file changed since its recorded head reruns', async () => {
  const dir = repo({ 't/other.sh': 'true\n' });
  const derived = await twoRounds(dir, [mk('a')], () => commitFiles(dir, { 't/c_alpha.sh': 'grep -q alpha src/a.txt # edited\n' }));
  assert.equal(derived.r2.results.a.status, 'killed', 'derived tests: reran');
  const dir2 = repo({ 't/other.sh': 'true\n' });
  const explicit = await twoRounds(dir2, [mk('a', 'alpha', { tests: ['t/other.sh'] })], () => commitFiles(dir2, { 't/other.sh': 'true # edited\n' }));
  assert.equal(explicit.r1.results.a.status, 'killed');
  assert.equal(explicit.r2.results.a.status, 'killed', 'explicit tests: reran');
});

test('C12g: a mutation with no derivable test file never carries', async () => {
  const dir = repo();
  const m = mk('a', 'alpha', { cmd: "sh -c 'grep -q alpha src/a.txt'" });
  const { r1, r2 } = await twoRounds(dir, [m], () => commitFiles(dir, { README: 'readme 2\n' }));
  assert.equal(r1.results.a.status, 'killed');
  assert.deepEqual(resultsOf(r1).mutations[0].tests, []);
  assert.equal(r2.results.a.status, 'killed', 'reran');
});

test('C12h: tests are derived from cmd tokens that name files tracked at the head', async () => {
  const dir = repo();
  const r = await go(dir, [
    mk('d', 'alpha', { cmd: "node --test --test-name-pattern='^x$' t/test_a.mjs untracked.mjs" }),
    mk('x', 'alpha', { tests: ['t/c_alpha.sh', 'not/tracked.sh'] }),
  ]);
  const res = resultsOf(r).mutations;
  assert.deepEqual(res.find((m) => m.id === 'd').tests, ['t/test_a.mjs']);
  assert.deepEqual(res.find((m) => m.id === 'x').tests, ['t/c_alpha.sh', 'not/tracked.sh']);
});

test('C12i: a missing or malformed since file exits 2', async () => {
  const dir = repo();
  const w = scratch();
  const bad = join(w, 'bad.json'); writeFileSync(bad, '{nope');
  const other = join(w, 'other.json'); writeFileSync(other, JSON.stringify({ schema: 1, head: 'deadbeef'.repeat(5), mutations: [] }));
  const shape = join(w, 'shape.json'); writeFileSync(shape, JSON.stringify({ schema: 1, head: head(dir) }));
  for (const since of [join(w, 'missing.json'), bad, other, shape]) {
    const r = await noWorktree(dir, () => go(dir, [mk('a')], ['--since', since]));
    assert.equal(r.status, 2, since);
    assert.deepEqual(r.order, [], 'nothing carried or run');
  }
});

test('C12j: a carried mutation carries again with its original head', async () => {
  const dir = repo();
  const counter = join(scratch(), 'count');
  const muts = [mk('a', 'alpha', { cmd: COUNTED(counter) })];
  const r1 = await go(dir, muts);
  const h1 = head(dir);
  commitFiles(dir, { README: 'two\n' });
  const r2 = await go(dir, muts, ['--since', r1.resultsFile]);
  assert.equal(r2.results.a.status, 'carried');
  commitFiles(dir, { README: 'three\n' });
  const r3 = await go(dir, muts, ['--since', r2.resultsFile]);
  assert.match(r3.stdout, new RegExp(`^carried  a  @${h1}$`, 'm'));
  assert.equal(lines(counter).length, 2, 'the cmd ran only in round 1');
});

test('C12k: a mutation whose test file was renamed or deleted reruns', async () => {
  const dir = repo();
  const r1 = await go(dir, [mk('a')]);
  git(dir, 'mv', 't/c_alpha.sh', 't/c_alpha2.sh');
  git(dir, 'commit', '-q', '-m', 'rename the test');
  const renamed = await go(dir, [mk('a')], ['--since', r1.resultsFile]);
  assert.notEqual(renamed.results.a.status, 'carried', 'renamed');
  const dir2 = repo();
  const r1b = await go(dir2, [mk('a')]);
  git(dir2, 'rm', '-q', 't/c_alpha.sh');
  git(dir2, 'commit', '-q', '-m', 'delete the test');
  const deleted = await go(dir2, [mk('a')], ['--since', r1b.resultsFile]);
  assert.notEqual(deleted.results.a.status, 'carried', 'deleted');
});

test('C12l: a mutation whose test file imports a changed helper reruns', async () => {
  const dir = repo({ 't/helper.mjs': 'export const x = 1;\n', 't/test_i.mjs': "import { x } from './helper.mjs';\nvoid x;\n" });
  const m = mk('a', 'alpha', { cmd: 'sh t/c_alpha.sh t/test_i.mjs' });
  const { r1, r2 } = await twoRounds(dir, [m], () => commitFiles(dir, { 't/helper.mjs': 'export const x = 2;\n' }));
  assert.ok(resultsOf(r1).mutations[0].deps.includes('t/helper.mjs'));
  assert.equal(r2.results.a.status, 'killed', 'reran');
});

test('C12m: a merge commit between the recorded and the new head carries nothing', async () => {
  const dir = repo();
  const r1 = await go(dir, [mk('a')]);
  git(dir, 'checkout', '-q', '-b', 'side');
  commitFiles(dir, { 'other.txt': 'side\n' }, 'side change');
  git(dir, 'checkout', '-q', 'main');
  commitFiles(dir, { README: 'main change\n' }, 'main change');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  assert.ok(git(dir, 'rev-list', '--merges', `${r1.header.head}..HEAD`));
  const r2 = await go(dir, [mk('a')], ['--since', r1.resultsFile]);
  assert.equal(r2.results.a.status, 'killed');
});

// ---- entry points and usage -------------------------------------------------------------------------------------

test('C13a: runs from a repo subdirectory and from outside the repo with the repo option under a stripped environment', async () => {
  const dir = repo();
  const env = { PATH: process.env.PATH, HOME: BOX };
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'm.json'), JSON.stringify([mk('a'), mk('b', 'beta')]));
  const h = head(dir);
  const a = await exec([RUNNER, 'm.json', '--head', h, '--log-dir', join(BOX, `log-${next()}`)], { env, cwd: join(dir, 'sub') });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(parse(a.stdout).results.a.status, 'killed');
  const outside = scratch('elsewhere');
  const b = await exec([RUNNER, join(dir, 'sub', 'm.json'), '--repo', dir, '--head', h, '--log-dir', join(BOX, `log-${next()}`)], { env, cwd: outside });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(parse(b.stdout).results.b.status, 'killed');
});

test('C13b: no arguments, a missing head option, an unknown option or an unresolvable head exits 2 before any worktree', async () => {
  const dir = repo();
  const env = { PATH: process.env.PATH, HOME: BOX, TMPDIR: BOX };
  const input = join(BOX, `in-${next()}.json`);
  writeFileSync(input, JSON.stringify([mk('a')]));
  const rows = [
    ['no arguments', []],
    ['missing --head', [input, '--repo', dir]],
    ['unknown option', [input, '--repo', dir, '--head', head(dir), '--bogus']],
    ['unresolvable head', [input, '--repo', dir, '--head', 'no-such-rev']],
  ];
  for (const [what, args] of rows) {
    const r = await noWorktree(dir, () => exec([RUNNER, ...args], { env }));
    assert.equal(r.status, 2, what);
    assert.ok(r.stderr.length > 0, what);
  }
  const h = await exec([RUNNER, '--help'], { env });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /usage/i);
});

test('C13c: an unwritable log directory exits nonzero before any worktree', async () => {
  const dir = repo();
  const parent = scratch('ro');
  chmodSync(parent, 0o500);
  try {
    const logDir = join(parent, 'sub');
    const r = await noWorktree(dir, () => go(dir, [mk('a')], [], { logDir }));
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(logDir), 'stderr names the path');
  } finally {
    chmodSync(parent, 0o700);
  }
});

test('C13d: an empty mutations array exits 2', async () => {
  const dir = repo();
  const r = await noWorktree(dir, () => go(dir, []));
  assert.equal(r.status, 2);
});

test('C13e: unsafe input exits 2 before any worktree', async () => {
  const link = repo();
  symlinkSync('src/a.txt', join(link, 'link.txt'));
  git(link, 'add', 'link.txt');
  git(link, 'commit', '-q', '-m', 'symlink');
  const two = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,3 +1,3 @@\n-alpha\n+ALPHA\n beta\n gamma\n--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1 +1 @@\n-alpha\n+ALPHA\n';
  const used = join(BOX, `used-${next()}`);
  mkdirSync(used); writeFileSync(join(used, 'f'), 'x');
  const rows = [
    ['unknown key', [{ ...mk('u'), test: 'x' }], []],
    ['id with a slash', [mk('../x')], []],
    ['empty find', [mk('u', 'alpha', { find: '' })], []],
    ['replace equals find', [mk('u', 'alpha', { replace: 'alpha' })], []],
    ['symlink file', [{ ...mk('u'), file: 'link.txt' }], []],
    ['patch touching two files', [{ id: 'u', file: 'src/a.txt', patch: two, cmd: 'sh t/c_alpha.sh' }], []],
    ['serial with jobs 3', [mk('u')], ['--serial', '--jobs', '3']],
    ['jobs 0', [mk('u')], ['--jobs', '0']],
    ['non-empty log dir', [mk('u')], ['--log-dir', used]],
  ];
  for (const [what, muts, args] of rows) {
    const r = await noWorktree(link, () => go(link, muts, args, { noLog: args.includes('--log-dir') }));
    assert.equal(r.status, 2, what);
    assert.ok(r.stderr.length > 0, what);
  }
});

test('C13f: a replacement with dollar patterns is inserted byte for byte', async () => {
  const dir = repo();
  const r = await go(dir, [mk('d', 'alpha', { replace: '$&$$', cmd: "! grep -qF '$&$$' src/a.txt" })]);
  assert.equal(r.results.d.status, 'killed');
});

// ---- docs -------------------------------------------------------------------------------------------------------

test('C17: every mutate flag the skill docs name is one the runner accepts', async () => {
  const docs = ['skills/core/offload/SKILL.md', 'skills/core/offload/correctives.md', 'skills/core/complete/codex-orchestration.md', 'skills/core/do/SKILL.md', 'skills/core/do/references/briefs.md'];
  const flags = new Set();
  for (const d of docs) {
    for (const line of readFileSync(join(ROOT, d), 'utf8').split('\n')) {
      if (!line.includes('mutate.mjs')) continue;
      for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) flags.add(m[1]);
    }
  }
  assert.ok(flags.has('--head'), 'the docs name --head on a mutate.mjs line');
  const env = { PATH: process.env.PATH, HOME: BOX, TMPDIR: BOX };
  for (const f of flags) {
    const r = await exec([RUNNER, f], { env });
    assert.doesNotMatch(r.stderr, /unknown option/i, `${f} is rejected as unknown`);
  }
});
