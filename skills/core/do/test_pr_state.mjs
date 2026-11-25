// test_pr_state.mjs — pr-state.mjs (X3): tiers, exit codes, pagination, fetch errors, gh override, environment.
// Criteria C6a-C6t, C15a, C15c, C23, C24, C25. gh is always a stub written into a temp dir; the child
// environments are built from scratch, so a real gh on the runner's PATH is never reachable.
import assert from 'node:assert';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify } from './pr-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'pr-state.mjs');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'prstate-')));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
let seq = 0;

const U1 = 'https://github.com/o/r/pull/1';
const U2 = 'https://github.com/o/r/pull/2';
const U3 = 'https://github.com/o/r/pull/3';
const key = (u) => { const m = /\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(u); return `${m[1]}/${m[2]}#${m[3]}`; };

// ---- the stub gh ------------------------------------------------------------------------------------------
// Answers `gh api graphql` from a config file: cfg[owner/name#n] (or cfg['*']) = { main, threadPages, checkPages }.
// main is a response object or { __raw, __exit, __stderr, __sleep }. A call with `after=cN` gets page N-1.
function stubSource(cfgPath, logPath) {
  return `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: a, environ: process.env }) + '\\n');
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, 'utf8'));
const kv = {};
for (let i = 0; i < a.length; i++) if (a[i] === '-f' || a[i] === '-F') { const s = a[i + 1]; kv[s.slice(0, s.indexOf('='))] = s.slice(s.indexOf('=') + 1); }
const entry = cfg[kv.owner + '/' + kv.name + '#' + kv.number] ?? cfg['*'];
if (kv.after) {
  const kind = kv.query.includes('reviewThreads') ? 'threads' : 'checks';
  const page = entry[kind + 'Pages'][Number(kv.after.slice(1)) - 1];
  const mainHead = (entry.main.data ?? {}).repository?.pullRequest?.headRefOid;
  const head = (entry.checksHeads ?? [])[Number(kv.after.slice(1)) - 1] ?? mainHead;
  const pr = kind === 'threads' ? { reviewThreads: page } : { headRefOid: head, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: page } } }] } };
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: pr } } }));
  process.exit(0);
}
const m = entry.main;
const finish = () => {
  if (m.__exit) { process.stderr.write(m.__stderr ?? ''); process.exit(m.__exit); }
  process.stdout.write(m.__raw !== undefined ? m.__raw : JSON.stringify(m));
};
if (m.__sleep) setTimeout(finish, m.__sleep); else finish();
`;
}

function makeBox() {
  const dir = join(root, `b${seq++}`);
  mkdirSync(dir);
  const box = { dir, cfg: join(dir, 'cfg.json'), log: join(dir, 'calls.log'), stub: join(dir, 'ghstub'), home: join(dir, 'home') };
  mkdirSync(box.home);
  writeFileSync(box.stub, stubSource(box.cfg, box.log));
  chmodSync(box.stub, 0o755);
  return box;
}
const calls = (box) => (existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---- GraphQL response builders -----------------------------------------------------------------------------
const run = (status, conclusion = null) => ({ __typename: 'CheckRun', name: 'c', status, conclusion });
const ctx = (state) => ({ __typename: 'StatusContext', context: 's', state });
const page = (nodes, next = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });
const resp = (o = {}) => {
  const checks = o.checks ?? [run('COMPLETED', 'SUCCESS')];
  const rollup = o.rollup === null ? null : { state: o.rollupState ?? 'SUCCESS', contexts: o.contexts ?? page(checks) };
  return { data: { repository: { pullRequest: {
    headRefOid: o.head ?? 'a'.repeat(40), isDraft: o.isDraft ?? false, mergeable: o.mergeable ?? 'MERGEABLE',
    mergeStateStatus: o.merge ?? 'CLEAN', reviewDecision: o.review === undefined ? null : o.review,
    reviewThreads: o.threadPage ?? page(o.threads ?? []), commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
  } } } };
};

function goodEnv(box, extra = {}) {
  // The stub runs as node's argument: macOS checks each newly written executable on its first run, which costs more
  // than the test. C6r and C24 still run the stub, or a copy of it, as an executable.
  const e = { HOME: box.home, PATH: '/usr/bin:/bin', PR_STATE_GH: `${process.execPath} ${box.stub}`, ...extra };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}
function pr(box, urls, cfg, extra = {}, nodeArgs = [SCRIPT]) {
  if (cfg) writeFileSync(box.cfg, JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [...nodeArgs, ...urls], { env: goodEnv(box, extra), encoding: 'utf8', timeout: 60000 });
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)); // every stdout line must be a JSON object (C6s)
  for (const l of lines) assert.ok(l && typeof l === 'object' && !Array.isArray(l));
  return { code: r.status, lines, err: r.stderr, out: r.stdout };
}
const one = (o, extra) => { const box = makeBox(); return pr(box, [U1], { '*': { main: resp(o) } }, extra); };

// ---- usage ----------------------------------------------------------------------------------------------------

test('C6a no arguments exit 2 and never call gh', () => {
  const box = makeBox();
  const r = pr(box, []);
  assert.equal(r.code, 2);
  assert.deepEqual(calls(box), []);
});

test('C6b an argument that is not a PR URL exits 2 before any gh call', () => {
  for (const bad of ['https://github.com/o/r/issues/1', 'https://github.com/o/r/pull/abc', 'not-a-url', 'https://github.com/o/r/pull/', 'http://github.com/o/r/pull/1', 'https://github.com/o/r/pull/1/files']) {
    const box = makeBox();
    const r = pr(box, [U1, bad], { '*': { main: resp() } });
    assert.equal(r.code, 2, bad);
    assert.deepEqual(calls(box), [], `${bad}: a bad URL stops everything before the first call`);
    assert.equal(r.out, '');
  }
});

// ---- tiers (C6c-C6l, C23): classify() on what inspect() hands it ----------------------------------------------------

const classified = (o) => {
  const pull = resp(o).data.repository.pullRequest;
  const rollup = pull.commits.nodes[0].commit.statusCheckRollup;
  return classify(pull, pull.reviewThreads.nodes, rollup, rollup ? rollup.contexts.nodes : []);
};

const TABLE = [
  // [name, response options, tier]
  ['CLEAN is ready', {}, 'ready'],
  ['HAS_HOOKS is ready', { merge: 'HAS_HOOKS' }, 'ready'],
  ['UNSTABLE with every check passing is ready', { merge: 'UNSTABLE' }, 'ready'],
  ['APPROVED is ready', { review: 'APPROVED' }, 'ready'],
  ['NEUTRAL and SKIPPED conclusions pass', { checks: [run('COMPLETED', 'NEUTRAL'), run('COMPLETED', 'SKIPPED'), ctx('SUCCESS')] }, 'ready'],
  ['DIRTY is a conflict', { merge: 'DIRTY' }, 'conflict'],
  ['BEHIND is a conflict', { merge: 'BEHIND' }, 'conflict'],
  ['mergeable CONFLICTING is a conflict', { mergeable: 'CONFLICTING' }, 'conflict'],
  ['one unresolved thread', { threads: [{ isResolved: true }, { isResolved: false }] }, 'threads'],
  ...['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].map((c) => [`CheckRun ${c} is failing`, { checks: [run('COMPLETED', c)] }, 'ci-failing']),
  ...['FAILURE', 'ERROR'].map((s) => [`StatusContext ${s} is failing`, { checks: [ctx(s)] }, 'ci-failing']),
  ['rollup FAILURE alone is failing', { checks: [], rollupState: 'FAILURE' }, 'ci-failing'],
  ...['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'].map((s) => [`CheckRun ${s} (null conclusion) is pending`, { checks: [run(s, null)] }, 'ci-pending']),
  // gh can send '' for a run with no conclusion yet; the status, not the conclusion, says whether it finished.
  ['CheckRun QUEUED (empty conclusion) is pending', { checks: [run('QUEUED', '')] }, 'ci-pending'],
  ...['PENDING', 'EXPECTED'].map((s) => [`StatusContext ${s} is pending`, { checks: [ctx(s)] }, 'ci-pending']),
  ['a null statusCheckRollup is pending', { rollup: null }, 'ci-pending'],
  ['mergeStateStatus UNKNOWN is pending', { merge: 'UNKNOWN' }, 'ci-pending'],
  ['mergeable UNKNOWN is pending', { mergeable: 'UNKNOWN' }, 'ci-pending'],
  ['isDraft', { isDraft: true }, 'draft-or-changes-requested'],
  ['mergeStateStatus DRAFT', { merge: 'DRAFT' }, 'draft-or-changes-requested'],
  ['CHANGES_REQUESTED', { review: 'CHANGES_REQUESTED' }, 'draft-or-changes-requested'],
  ['REVIEW_REQUIRED', { review: 'REVIEW_REQUIRED' }, 'draft-or-changes-requested'],
  ['BLOCKED with nothing else wrong', { merge: 'BLOCKED' }, 'draft-or-changes-requested'],
  // priority: the highest blocker wins (C6k)
  ['DIRTY + thread + failing + draft -> conflict', { merge: 'DIRTY', threads: [{ isResolved: false }], checks: [ctx('FAILURE')], isDraft: true }, 'conflict'],
  ['thread + failing -> threads', { threads: [{ isResolved: false }], checks: [ctx('FAILURE')] }, 'threads'],
  ['failing + pending + draft -> ci-failing', { checks: [ctx('FAILURE'), run('QUEUED')], isDraft: true }, 'ci-failing'],
  ['draft + pending -> draft-or-changes-requested', { isDraft: true, checks: [run('IN_PROGRESS')] }, 'draft-or-changes-requested'],
  ['BLOCKED + pending -> ci-pending (BLOCKED is only the fallback)', { merge: 'BLOCKED', checks: [run('QUEUED')] }, 'ci-pending'],
];
for (const [name, opts, tier] of TABLE) {
  test(`tier: ${name}`, () => assert.equal(classified(opts).tier, tier));
}

test('C30 C31 every line carries integer checksPending and checksFailing counts, whatever the tier', () => {
  const cases = [
    [{ checks: [run('COMPLETED', 'SUCCESS'), ctx('SUCCESS')] }, 0, 0, 'ready'],
    [{ checks: [run('QUEUED'), ctx('PENDING'), run('COMPLETED', 'FAILURE')] }, 2, 1, 'ci-failing'],
    [{ checks: [run('IN_PROGRESS'), run('WAITING')], isDraft: true }, 2, 0, 'draft-or-changes-requested'],
    [{ checks: [ctx('ERROR'), ctx('FAILURE'), run('COMPLETED', 'TIMED_OUT')], merge: 'DIRTY' }, 0, 3, 'conflict'],
    [{ checks: [run('COMPLETED', 'NEUTRAL'), run('COMPLETED', 'SKIPPED')], threads: [{ isResolved: false }] }, 0, 0, 'threads'],
    [{ review: 'REVIEW_REQUIRED', checks: [run('IN_PROGRESS')] }, 1, 0, 'draft-or-changes-requested'], // C30: tier is not the count
    [{ review: 'REVIEW_REQUIRED', checks: [run('COMPLETED', 'FAILURE')] }, 0, 1, 'ci-failing'], // the same PR once the check finished
    [{ contexts: page([]) }, 1, 0, 'ci-pending'], // C31: a rollup whose contexts.nodes is []
    [{ checks: [], rollup: null }, 1, 0, 'ci-pending'], // no checks reported yet (null rollup): one pending, so a watcher waits
    [{ checks: [], rollupState: 'SUCCESS' }, 1, 0, 'ci-pending'], // a rollup with zero contexts: same
  ];
  for (const [opts, pending, failing, tier] of cases) {
    const got = classified(opts);
    const l = got.signals;
    assert.ok(Number.isInteger(l.checksPending) && Number.isInteger(l.checksFailing), JSON.stringify(l));
    assert.equal(got.tier, tier);
    assert.equal(l.checksPending, pending, JSON.stringify(opts));
    assert.equal(l.checksFailing, failing, JSON.stringify(opts));
  }
});

test('C6i an unrecognized value never yields ready or exit 0', () => {
  const cases = [
    { merge: 'NEW_STATE' }, { mergeable: 'MAYBE' }, { review: 'NEW_DECISION' },
    { checks: [run('COMPLETED', 'FUTURE_VALUE')] }, { checks: [run('SOMETHING_NEW')] }, { checks: [ctx('NEW_STATE')] },
    { checks: [run('COMPLETED', null)] }, { checks: [{ __typename: 'Other' }] }, { checks: [], rollupState: 'NEW_ROLLUP' },
  ];
  for (const c of cases) assert.throws(() => classified(c), /unrecognized/, JSON.stringify(c));
});

// ---- end to end: one row per exit code, the script run by its path -------------------------------------------------

for (const [name, opts, tier, code] of [
  ['a ready PR exits 0', {}, 'ready', 0],
  ['a conflict exits 3', { merge: 'DIRTY' }, 'conflict', 3],
  ['an unresolved thread exits 4', { threads: [{ isResolved: false }] }, 'threads', 4],
  ['a failing check exits 5', { checks: [run('COMPLETED', 'FAILURE')] }, 'ci-failing', 5],
  ['a draft exits 6', { merge: 'DRAFT' }, 'draft-or-changes-requested', 6],
  ['a pending check exits 7', { checks: [run('QUEUED')] }, 'ci-pending', 7],
]) {
  test(`e2e: ${name}`, () => {
    const r = one({ head: 'f'.repeat(40), ...opts });
    assert.equal(r.code, code, `${r.err}`);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].tier, tier);
    assert.equal(r.lines[0].url, U1);
    assert.equal(r.lines[0].head, 'f'.repeat(40));
    assert.equal(r.lines[0].mergeStateStatus, opts.merge ?? 'CLEAN', 'the raw mergeStateStatus is always printed');
  });
}

test('e2e: an unrecognized value exits 1', () => {
  const r = one({ merge: 'NEW_STATE' });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.out, '', 'a PR that cannot be classified prints no tier line');
  assert.ok(r.err.includes(U1), r.err);
  assert.match(r.err, /unrecognized/);
});

test('e2e: a head with no reported checks counts one pending check', () => {
  const r = one({ rollup: null });
  assert.equal(r.code, 7, r.err);
  assert.equal(r.lines[0].checksPending, 1);
});

test('C31 counts cover every page of checks', () => {
  const box = makeBox();
  const r = pr(box, [U1], { '*': { main: resp({ contexts: page([run('QUEUED')], 'c1') }), checksPages: [page([run('COMPLETED', 'FAILURE'), run('IN_PROGRESS')])] } });
  const l = r.lines[0];
  assert.ok(Number.isInteger(l.checksPending) && Number.isInteger(l.checksFailing), JSON.stringify(l));
  assert.equal(l.tier, 'ci-failing');
  assert.equal(l.checksPending, 2, 'counts cover every page');
  assert.equal(l.checksFailing, 1);
});

// ---- starting the CLI (C6u) and importing the module (C6v) -----------------------------------------------------------
// A start path that skips main exits 0, which the host watcher reads as "every PR ready".

function pendingRun(box, nodeArgs) {
  const r = pr(box, [U1], { '*': { main: resp({ checks: [run('QUEUED')] }) } }, {}, nodeArgs);
  assert.equal(r.code, 7, r.err);
  assert.deepEqual(r.lines.map((l) => l.tier), ['ci-pending']);
}
const linkedScript = (box) => {
  const link = join(box.dir, 'link.mjs');
  symlinkSync(SCRIPT, link);
  return link;
};

test('C6u run by its own path, a pending PR exits 7', () => pendingRun(makeBox(), [SCRIPT]));

test('C6u run through a symlink, a pending PR exits 7', () => {
  const box = makeBox();
  pendingRun(box, [linkedScript(box)]);
});

test('C6u run through a symlinked directory whose path has a space, a pending PR exits 7', (t) => {
  const dirLink = join(root, 'dir link');
  symlinkSync(HERE, dirLink);
  t.after(() => unlinkSync(dirLink)); // gone before the temp root is removed: it points at the real source dir
  pendingRun(makeBox(), [join(dirLink, 'pr-state.mjs')]);
  // That link resolves to a path without the space. A copy in a real directory with one fails a comparison of unencoded URL text.
  const real = join(root, 'real dir');
  mkdirSync(real);
  copyFileSync(SCRIPT, join(real, 'pr-state.mjs'));
  pendingRun(makeBox(), [join(real, 'pr-state.mjs')]);
});

test('C6u run through a symlink with --preserve-symlinks-main, a pending PR exits 7', () => {
  const box = makeBox();
  pendingRun(box, ['--preserve-symlinks-main', linkedScript(box)]);
});

test('C6v importing pr-state.mjs runs no CLI: no gh call, no output, exitCode unset', () => {
  const box = makeBox();
  writeFileSync(box.cfg, JSON.stringify({ '*': { main: resp() } }));
  const code = `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)}); if (process.exitCode !== undefined) process.exit(9);`;
  const importer = join(box.dir, 'importer.mjs');
  writeFileSync(importer, code);
  // with no process.argv[1] (node -e), and from another script that was itself given a PR URL
  for (const args of [['--input-type=module', '-e', code], [importer, U1]]) {
    const r = spawnSync(process.execPath, args, { env: goodEnv(box), encoding: 'utf8', timeout: 60000 });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], args[0]);
  }
  assert.deepEqual(calls(box), []);
});

// ---- pagination (C6f) ------------------------------------------------------------------------------------------------

test('C6f a thread on page two is found; the cursor is followed', () => {
  const box = makeBox();
  const r = pr(box, [U1], { '*': {
    main: resp({ threadPage: page([{ isResolved: true }], 'c1') }),
    threadsPages: [page([{ isResolved: true }, { isResolved: false }], null)],
  } });
  assert.equal(r.code, 4, r.err);
  assert.equal(r.lines[0].tier, 'threads');
  const c = calls(box);
  assert.equal(c.length, 2);
  assert.ok(c[1].argv.includes('after=c1'));
});

test('C6f three pages of resolved threads stay ready; a failing check on page two of the checks is found', () => {
  const box = makeBox();
  const r = pr(box, [U1], { '*': {
    main: resp({ threadPage: page([{ isResolved: true }], 'c1'), contexts: page([run('COMPLETED', 'SUCCESS')], 'c1') }),
    threadsPages: [page([{ isResolved: true }], 'c2'), page([{ isResolved: true }], null)],
    checksPages: [page([run('COMPLETED', 'FAILURE')], null)],
  } });
  assert.equal(r.code, 5, r.err);
  assert.equal(calls(box).length, 4);
  const ready = pr(makeBox(), [U1], { '*': { main: resp({ threadPage: page([{ isResolved: true }], 'c1') }), threadsPages: [page([{ isResolved: true }], null)] } });
  assert.equal(ready.code, 0);
});

test('C6f a hasNextPage with no cursor is a fetch error, never ready', () => {
  const r = one({ threadPage: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } });
  assert.equal(r.code, 1);
  assert.ok(r.lines.every((l) => l.tier !== 'ready'));
});

// ---- hosts and tokens (K1), head change while paging (K9) -----------------------------------------------------

test('K1 only github.com and github.a8c.com are accepted; any other host exits 2 before a gh call', () => {
  const bad = ['https://attacker.example/o/r/pull/1', 'https://github.com.evil.example/o/r/pull/1', 'https://evil.github.com/o/r/pull/1',
    'https://github.a8c.com.evil.example/o/r/pull/1', 'https://xgithub.com/o/r/pull/1', 'https://github.comx/o/r/pull/1', 'https://127.0.0.1/o/r/pull/1'];
  for (const url of bad) {
    const box = makeBox();
    const r = pr(box, [U1, url], { '*': { main: resp() } }, { GH_ENTERPRISE_TOKEN: 'ent', GITHUB_ENTERPRISE_TOKEN: 'ent' });
    assert.equal(r.code, 2, url);
    assert.deepEqual(calls(box), [], `${url}: no gh call, not even for the good URL`);
    assert.equal(r.out, '');
    assert.ok(r.err.includes('github.com'), r.err);
  }
});

test('K1 the host match ignores case, and gh gets the lower-case host', () => {
  const box = makeBox();
  const r = pr(box, ['https://GitHub.COM/o/r/pull/1', 'https://GITHUB.A8C.COM/o/r/pull/2'], { '*': { main: resp() } });
  assert.equal(r.code, 0, r.err);
  const argvs = calls(box).map((c) => c.argv);
  assert.ok(!argvs[0].includes('--hostname'));
  assert.equal(argvs[1][argvs[1].indexOf('--hostname') + 1], 'github.a8c.com');
});

test('K1 the enterprise tokens reach gh only for github.a8c.com; GH_TOKEN reaches both', () => {
  const box = makeBox();
  const extra = { GH_ENTERPRISE_TOKEN: 'ent1', GITHUB_ENTERPRISE_TOKEN: 'ent2', GH_TOKEN: 'tok' };
  const r = pr(box, [U1, 'https://github.a8c.com/team/repo/pull/9'], { '*': { main: resp() } }, extra);
  assert.equal(r.code, 0, r.err);
  const [com, ghe] = calls(box).map((c) => c.environ);
  for (const name of ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    assert.ok(!(name in com), `${name} must not reach gh for a github.com URL`);
    assert.equal(ghe[name], name === 'GH_ENTERPRISE_TOKEN' ? 'ent1' : 'ent2');
  }
  assert.equal(com.GH_TOKEN, 'tok');
  assert.equal(ghe.GH_TOKEN, 'tok');
});

test('K9 a later check page from a different head fails closed', () => {
  const box = makeBox();
  const cfg = { '*': { main: resp({ head: 'a'.repeat(40), contexts: page([run('COMPLETED', 'SUCCESS')], 'c1') }), checksPages: [page([run('COMPLETED', 'SUCCESS')])], checksHeads: ['b'.repeat(40)] } };
  const r = pr(box, [U1], cfg);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /head changed/);
  assert.ok(r.lines.every((l) => l.tier !== 'ready'));
  cfg['*'].checksHeads = ['a'.repeat(40)];
  assert.equal(pr(makeBox(), [U1], cfg).code, 0, 'the same head on every page stays ready');
});

// ---- several PRs (C6m, C6o) ----------------------------------------------------------------------------------------------

test('C6m several PRs print one line each in input order and the lowest nonzero code wins', () => {
  const cfg = (...os) => Object.fromEntries(os.map((o, i) => [key(`https://github.com/o/r/pull/${i + 1}`), { main: resp(o) }]));
  const urls = [U1, U2, U3];
  let r = pr(makeBox(), urls, cfg({}, { threads: [{ isResolved: false }] }, { checks: [run('QUEUED')] }));
  assert.equal(r.code, 4);
  assert.deepEqual(r.lines.map((l) => l.url), urls);
  assert.deepEqual(r.lines.map((l) => l.tier), ['ready', 'threads', 'ci-pending']);
  r = pr(makeBox(), [U1, U2], cfg({}, {}));
  assert.equal(r.code, 0);
  assert.equal(r.lines.length, 2);
  r = pr(makeBox(), urls, cfg({ merge: 'DIRTY' }, { threads: [{ isResolved: false }] }, {}));
  assert.equal(r.code, 3);
});

test('C6o a fetch error is never hidden by another PR', () => {
  const box = makeBox();
  const r = pr(box, [U1, U2], { [key(U1)]: { main: resp() }, [key(U2)]: { main: { __exit: 1, __stderr: 'boom' } } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines.map((l) => [l.url, l.tier]), [[U1, 'ready']], 'the failed PR prints no stdout line; its error is on stderr');
  assert.ok(r.err.includes(U2));
  const r2 = pr(makeBox(), [U2, U1], { [key(U1)]: { main: resp({ merge: 'DIRTY' }) }, [key(U2)]: { main: { __exit: 1 } } });
  assert.equal(r2.code, 1, 'a fetch error beats a conflict too');
  assert.deepEqual(r2.lines.map((l) => l.tier), ['conflict']);
});

// ---- fetch errors (C6n, C6p, C25) ----------------------------------------------------------------------------------------

test('C6n every kind of fetch failure exits 1, names the URL on stderr and prints no ready line', () => {
  const good = JSON.stringify(resp());
  const cases = {
    'gh exits 1': { __exit: 1, __stderr: 'HTTP 502' },
    'errors array': { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }], data: { repository: { pullRequest: null } } },
    'null pullRequest': { data: { repository: { pullRequest: null } } },
    'non-JSON': { __raw: 'Welcome to gh' },
    'truncated JSON': { __raw: good.slice(0, Math.floor(good.length / 2)) },
    'JSON null': { __raw: 'null' },
    'wrong shape': { data: { repository: { pullRequest: { headRefOid: 'a', reviewThreads: 'x' } } } },
  };
  for (const [name, main] of Object.entries(cases)) {
    const r = pr(makeBox(), [U1], { '*': { main } });
    assert.equal(r.code, 1, name);
    assert.ok(r.err.includes(U1), `${name}: stderr names the URL: ${r.err}`);
    assert.ok(r.lines.every((l) => l.tier !== 'ready'), name);
    assert.ok(!/\n\s+at /.test(r.err), `${name}: no stack trace`);
  }
});

test('C6p gh not found exits 1 with a message that names gh and no stack trace', () => {
  const box = makeBox();
  const empty = join(box.dir, 'empty');
  mkdirSync(empty);
  const r = pr(box, [U1], undefined, { PR_STATE_GH: undefined, PATH: empty });
  assert.equal(r.code, 1);
  assert.match(r.err, /\bgh\b/);
  assert.ok(!/ENOENT|\n\s+at /.test(r.err), r.err);
  assert.ok(r.lines.every((l) => l.tier !== 'ready'));
});

test('C25 a gh call that outlives PR_STATE_TIMEOUT_MS exits 1 and the message names the timeout', () => {
  const t0 = Date.now();
  const box = makeBox();
  const slow = pr(box, [U1], { '*': { main: { __sleep: 5000 } } }, { PR_STATE_TIMEOUT_MS: '500' });
  assert.equal(slow.code, 1);
  assert.match(slow.err, /timed out after 500 ms/);
  assert.ok(Date.now() - t0 < 4500, 'the sleeping stub was killed, not waited for');
});

// ---- gh override and host (C6q, C6r, C24) ---------------------------------------------------------------------------------

test('C6q github.a8c.com calls carry --hostname github.a8c.com; github.com calls carry none', () => {
  const box = makeBox();
  const GHE = 'https://github.a8c.com/team/repo/pull/9';
  const r = pr(box, [U1, GHE], { '*': { main: resp({ threadPage: page([{ isResolved: true }], 'c1') }), threadsPages: [page([])] } });
  assert.equal(r.code, 0, r.err);
  const c = calls(box).map((x) => x.argv);
  assert.equal(c.length, 4);
  for (const argv of c.slice(0, 2)) assert.ok(!argv.includes('--hostname'), argv.join(' '));
  for (const argv of c.slice(2)) {
    const i = argv.indexOf('--hostname');
    assert.equal(argv[i + 1], 'github.a8c.com');
    assert.ok(argv.includes('owner=team') && argv.includes('name=repo') && argv.includes('number=9'));
  }
});

test('C6r PR_STATE_GH splits on runs of whitespace, runs without a shell and puts its words before the gh arguments', () => {
  const box = makeBox();
  const r = pr(box, [U1], { '*': { main: resp() } }, { PR_STATE_GH: `  ${box.stub}   --marker  ;touch\t${join(box.dir, 'pwned')} ` });
  assert.equal(r.code, 0, r.err);
  const argv = calls(box)[0].argv;
  assert.deepEqual(argv.slice(0, 4), ['--marker', ';touch', join(box.dir, 'pwned'), 'api']);
  assert.ok(!existsSync(join(box.dir, 'pwned')), 'no shell ran the line');
});

test('C6r an unset, empty or whitespace-only PR_STATE_GH runs the gh found on PATH', () => {
  for (const v of [undefined, '', ' ', ' \t ']) {
    const box = makeBox();
    const bin = join(box.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), readFileSync(box.stub, 'utf8'));
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(box.cfg, JSON.stringify({ '*': { main: resp() } }));
    const r = pr(box, [U1], undefined, { PR_STATE_GH: v, PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(r.code, 0, `${JSON.stringify(v)}: ${r.err}`);
    assert.equal(calls(box).length, 1);
  }
});

test('C24 a leading ~/ in a PR_STATE_GH token expands to HOME', () => {
  const box = makeBox();
  writeFileSync(join(box.home, 'stub-gh'), readFileSync(box.stub, 'utf8'));
  chmodSync(join(box.home, 'stub-gh'), 0o755);
  writeFileSync(box.cfg, JSON.stringify({ '*': { main: resp() } }));
  const r = pr(box, [U1], undefined, { PR_STATE_GH: '~/stub-gh' });
  assert.equal(r.code, 0, r.err);
  assert.equal(calls(box).length, 1);
});

// ---- environment (C15a) ---------------------------------------------------------------------------------------------------

test('C15a the gh child gets an allowlisted environment: no ambient secret or run pointer reaches it', () => {
  const box = makeBox();
  const canary = `K1_CANARY_${Math.random().toString(16).slice(2, 10)}`;
  const hostile = {
    [canary]: '1', ANTHROPIC_API_KEY: 'hostile', OPENAI_API_KEY: 'hostile', AWS_SECRET_ACCESS_KEY: 'hostile', BORK_RUN_DIR: '/hostile',
    OFFLOAD_HANDOFF: '/hostile', CLAUDE_CODE_SESSION_ID: 'hostile', GH_HOST: 'h', GH_TOKEN: 't', HTTPS_PROXY: 'p',
  };
  const r = pr(box, [U1], { '*': { main: resp() } }, hostile);
  assert.equal(r.code, 0, r.err);
  const env = calls(box)[0].environ;
  for (const name of [canary, 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'BORK_RUN_DIR', 'OFFLOAD_HANDOFF', 'CLAUDE_CODE_SESSION_ID', 'PR_STATE_GH', 'GH_HOST']) {
    assert.ok(!(name in env), `${name} must not reach gh`);
  }
  for (const name of ['GH_TOKEN', 'HOME', 'PATH', 'HTTPS_PROXY']) assert.equal(env[name], goodEnv(box, hostile)[name], name);
  const allowed = new Set(['GH_TOKEN', 'HOME', 'PATH', 'HTTPS_PROXY', 'GH_PROMPT_DISABLED', 'PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING']); // the last five are added by the OS or the shell, not passed on
  assert.deepEqual(Object.keys(env).filter((k) => !allowed.has(k)), []);
});

// ---- the recorded real response (C6t) -----------------------------------------------------------------------------------

// Selection-set shapes from a GraphQL query text: { field: subSelection | null }, fragments merged in.
function selection(query) {
  const toks = query.match(/\.\.\.|[A-Za-z_$][\w$]*|[{}()]/g);
  let i = 0;
  const skipParens = () => { let d = 0; do { if (toks[i] === '(') d++; if (toks[i] === ')') d--; i++; } while (d > 0); };
  const set = () => {
    const out = {};
    i++; // {
    while (toks[i] !== '}') {
      if (toks[i] === '...') { i += 2; Object.assign(out, set()); continue; } // ... on Type { }
      const name = toks[i++];
      if (toks[i] === '(') skipParens();
      out[name] = toks[i] === '{' ? set() : null;
    }
    i++; // }
    return out;
  };
  if (toks[i] === 'query') { i++; if (toks[i] === '(') skipParens(); }
  return set();
}
function conforms(sel, value, path = '') {
  if (Array.isArray(value)) { for (const v of value) conforms(sel, v, path); return; }
  if (value === null || typeof value !== 'object') return;
  for (const k of Object.keys(value)) assert.ok(k in sel, `${path}.${k} is in the response but not in the query`);
  for (const [k, sub] of Object.entries(sel)) if (sub) conforms(sub, value[k], `${path}.${k}`);
}

test('C6t the recorded real gh api graphql response matches the query pr-state sends and classifies', () => {
  const fx = JSON.parse(readFileSync(join(HERE, 'fixtures', 'pr-state-recorded.json'), 'utf8'));
  assert.match(fx.gh_version, /^gh version \d/);
  const box = makeBox();
  const r = pr(box, [U1], { '*': { main: fx.response } });
  const sent = calls(box)[0].argv.find((x) => x.startsWith('query=')).slice('query='.length);
  assert.equal(sent, fx.query, 'the fixture was recorded for the query pr-state sends now; re-record it when the query changes');
  const pull = fx.response.data.repository.pullRequest;
  conforms(selection(fx.query).repository.pullRequest, pull);
  for (const k of Object.keys(selection(fx.query).repository.pullRequest)) assert.ok(k in pull, `${k} is in the query but absent from the response`);
  assert.equal(r.lines[0].head, pull.headRefOid);
  assert.equal(r.lines[0].mergeStateStatus, pull.mergeStateStatus);
  assert.ok(r.lines[0].tier !== 'ready' || r.code === 0);
  assert.equal(r.code, EXIT[r.lines[0].tier]);
});
const EXIT = { ready: 0, conflict: 3, threads: 4, 'ci-failing': 5, 'draft-or-changes-requested': 6, 'ci-pending': 7 };
