// test_start.mjs — the herdr launcher and the generated launch.sh
// (spec v2 section 2; criteria A29-A36). Every herdr, claude and codex here is a
// stub on an isolated PATH.
import assert from 'node:assert';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, NODE_DIR, barePath, calls, mkRepo, newBox, readRec, resetLog, run, sha } from './testkit.mjs';

const b = newBox();
const repo = mkRepo(b, 'target');
const ok = (r, m) => assert.equal(r.code, 0, `${m ?? ''} exit ${r.code}: ${r.err}`);
const FIXED = (dir) => `Read ${dir}/launch-prompt.md and follow it.`;
const read = (p) => readFileSync(p, 'utf8');
const argvLog = (box) => (existsSync(box.argv) ? read(box.argv).trim().split('\n').map((l) => JSON.parse(l)) : []);

function start(box, args, extra = {}) {
  const r = run(box, ['start', ...args], extra);
  return { ...r, id: r.out.split('\n')[0], dir: join(box.runs, r.out.split('\n')[0]) };
}
// What a herdr tab does: a fresh environment, bash launch.sh, nothing inherited.
function runLaunch(box, dir, stubEnv = {}) {
  return spawnSync('bash', [join(dir, 'launch.sh')], {
    env: { PATH: `${box.bin}:${NODE_DIR}:/usr/bin:/bin`, HOME: box.home, STUB_ARGV_LOG: box.argv, HERDR_STUB_LOG: box.log, ...stubEnv },
    encoding: 'utf8', cwd: '/',
  });
}

test('start refuses without HERDR_ENV or herdr on PATH, creating nothing and calling no herdr', () => {
  for (const x of [{ HERDR_ENV: undefined }, { PATH: barePath() }]) {
    const before = readdirSync(b.runs).length;
    resetLog(b);
    const r = start(b, ['--repo', repo, '--goal', 'g'], x);
    assert.notEqual(r.code, 0);
    assert.equal(readdirSync(b.runs).length, before);
    assert.deepEqual(calls(b), []);
  }
});

test('start refuses a non-git path, an unknown project and an unknown harness the same way', () => {
  const plain = join(b.root, 'plain');
  mkdirSync(plain);
  const before = readdirSync(b.runs).length;
  for (const a of [['--repo', plain, '--goal', 'g'], ['--repo', 'no-such-project', '--goal', 'g'], ['--repo', repo, '--goal', 'g', '--harness', 'gemini']]) {
    resetLog(b);
    const r = start(b, a);
    assert.notEqual(r.code, 0, a.join(' '));
    assert.equal(readdirSync(b.runs).length, before);
    assert.deepEqual(calls(b), []);
  }
});

test('project names resolve from the real projects.md shape, skills before skills-private, ~ expanded', () => {
  const pb = newBox();
  const priv = mkRepo(pb, 'home/git/skills-private');
  const pub = mkRepo(pb, 'home/git/skills');
  const abs = mkRepo(pb, 'elsewhere');
  writeFileSync(join(pb.orch, 'projects.md'), [
    '# Projects',
    '- skills-private [no-mistakes] - Private skills (path: ~/git/skills-private) (borkweb/skills-private) (added 2026-07-10)',
    '- skills [no-mistakes] - Agent skills/commands/hooks toolkit (path: ~/git/skills) (borkweb/skills; installable via skills.sh and as the "bork" plugin) (added 2026-07-10)',
    `- other - An absolute one (path: ${abs}) (added 2026-07-10)`, '',
  ].join('\n'));
  const a = start(pb, ['--repo', 'skills', '--goal', 'g', '--json']);
  ok(a);
  assert.equal(JSON.parse(a.out).repo, pub);
  assert.notEqual(JSON.parse(a.out).repo, priv);
  const o = start(pb, ['--repo', 'other', '--goal', 'g', '--json']);
  ok(o);
  assert.equal(JSON.parse(o.out).repo, abs);
});

test('a successful start opens a labeled tab, runs launch.sh, records the pane and prints id, tab line, or --json', () => {
  const sb = newBox();
  const r = start(sb, ['--repo', repo, '--goal', 'fix the flaky login test', '--task', 'T-12']);
  ok(r);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}-target-[a-z0-9]{4}$/, 'the slug names the repo, not the goal');
  assert.ok(lines[1].includes('w9:t7'), lines[1]);
  const rec = readRec(r.dir);
  assert.deepEqual([rec.launched_by, rec.architect.harness, rec.architect.frontend, rec.architect.tab, rec.architect.pane, rec.task, rec.repo],
    ['orchestrator', 'claude', 'herdr', 'w9:t7', 'w9:p7', 'T-12', repo]);
  const c = calls(sb);
  const create = c.find((x) => x[0] === 'tab' && x[1] === 'create' && !x.includes('--help'));
  assert.equal(create[create.indexOf('--label') + 1], 'do: target');
  assert.equal(create[create.indexOf('--cwd') + 1], repo);
  assert.notEqual(create[create.indexOf('--label') + 1], 'builder');
  const pr = c.find((x) => x[0] === 'pane' && x[1] === 'run');
  assert.deepEqual(pr.slice(0, 3), ['pane', 'run', 'w9:p7']);
  assert.equal(pr[3], `bash '${join(r.dir, 'launch.sh')}'`);
  assert.equal(c.filter((x) => x[0] === 'pane' && x[1] === 'run').length, 1, 'the launcher is the only pane run');
  const j = start(sb, ['--repo', repo, '--goal', 'g2', '--json']);
  ok(j);
  assert.equal(JSON.parse(j.out).architect.pane, 'w9:p7');
});

test('start sends no goal text to herdr and writes none into launch.sh, even plain lowercase words', () => {
  const sb = newBox();
  const r = start(sb, ['--repo', repo, '--goal', 'zzgoalzz zzsecondzz --task-ish', '--task', 'T-1']);
  ok(r);
  assert.ok(!/zzgoalzz|zzsecondzz/.test(readFileSync(sb.log, 'utf8')), readFileSync(sb.log, 'utf8'));
  assert.ok(!/zzgoalzz|zzsecondzz/.test(read(join(r.dir, 'launch.sh'))));
  assert.ok(!/zzgoalzz/.test(r.id));
  assert.ok(read(join(r.dir, 'launch-prompt.md')).includes('zzgoalzz zzsecondzz'), 'the goal lives only in launch-prompt.md');
});

test('the workspace comes from HERDR_WORKSPACE_ID, else from pane current', () => {
  const sb = newBox();
  for (const [ws, want] of [['tw', 'tw'], [undefined, 'wc']]) {
    resetLog(sb);
    ok(start(sb, ['--repo', repo, '--goal', 'g'], { HERDR_WORKSPACE_ID: ws }));
    const create = calls(sb).find((x) => x[0] === 'tab' && x[1] === 'create' && !x.includes('--help'));
    assert.equal(create[create.indexOf('--workspace') + 1], want);
  }
});

test('--no-focus is passed only when tab create --help lists it', () => {
  const sb = newBox();
  for (const [help, has] of [[undefined, true], ['without', false]]) {
    resetLog(sb);
    ok(start(sb, ['--repo', repo, '--goal', 'g'], { HERDR_STUB_HELP: help }));
    const create = calls(sb).find((x) => x[0] === 'tab' && x[1] === 'create' && !x.includes('--help'));
    assert.equal(create.includes('--no-focus'), has);
  }
});

test('failures: tab create, pane run and pane current each fail the run and exit non-zero', () => {
  for (const [mode, ws, closes, noteRe] of [['fail-create', 'tw', false, /workspace not found/], ['fail-run', 'tw', true, /pane w9:p7 not found/], ['fail-current', undefined, false, /no current pane/]]) {
    const fb = newBox();
    const r = start(fb, ['--repo', repo, '--goal', 'g'], { HERDR_STUB_MODE: mode, HERDR_WORKSPACE_ID: ws });
    assert.notEqual(r.code, 0, mode);
    const ids = readdirSync(fb.runs);
    assert.equal(ids.length, 1, 'the failed run is kept as a record');
    const rec = readRec(join(fb.runs, ids[0]));
    assert.equal(rec.state, 'failed', mode);
    assert.match(rec.history.at(-1).note, noteRe, mode);
    const c = calls(fb);
    assert.equal(c.some((x) => x[0] === 'tab' && x[1] === 'close' && x[2] === 'w9:t7'), closes, mode);
    if (mode === 'fail-current') assert.ok(!c.some((x) => x[0] === 'tab' && x[1] === 'create' && !x.includes('--help')));
  }
});

function launchFor(box, args = []) {
  const r = start(box, ['--repo', repo, '--goal', 'GOALBYTES-unique', ...args]);
  ok(r);
  return r;
}

test('launch.sh passes claude exactly the model, a v4 session id and the fixed prompt, and records the same session id', () => {
  const sb = newBox();
  const r = launchFor(sb, ['--model', 'opus']);
  const rec = readRec(r.dir);
  const out = runLaunch(sb, r.dir);
  assert.equal(out.status, 0, out.stderr);
  const [call] = argvLog(sb);
  assert.equal(call.bin, 'claude');
  assert.deepEqual(call.argv.slice(0, 2), ['--model', 'opus']);
  assert.equal(call.argv[2], '--session-id');
  assert.match(call.argv[3], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(call.argv[3], rec.architect.session_id);
  assert.deepEqual(call.argv.slice(4), [FIXED(r.dir)]);
  assert.equal(call.cwd, repo);
  assert.ok(read(join(r.dir, 'launch.sh')).includes(rec.architect.session_id));
});

// Decisions 16 (user ruling 6): herdr is blocked inside Codex's workspace-write sandbox
// ("herdr pane list" fails with Operation not permitted), so a Codex architect cannot send
// pane messages. Launching one is refused until that changes; the Codex-only launch line was removed.
test('start --harness codex exits 2 before any side effect, and says why and what still works', () => {
  const sb = newBox();
  const rp = mkRepo(sb, 'codex-target');
  const before = readdirSync(sb.runs).length;
  for (const [args, x] of [
    [['--repo', rp, '--goal', 'g', '--harness', 'codex'], {}],
    [['--repo', rp, '--goal', 'g', '--harness', 'codex', '--model', 'gpt-x'], {}],
    [['--repo', rp, '--goal', 'g', '--harness', 'codex'], { HERDR_ENV: undefined }],
    [['--repo', join(sb.root, 'not-a-repo'), '--goal', 'g', '--harness', 'codex'], {}],
  ]) {
    resetLog(sb);
    const r = start(sb, args, x);
    assert.equal(r.code, 2, `${args.join(' ')}: exit ${r.code}: ${r.err}`);
    assert.match(r.err, /Codex architect launch is disabled/, r.err);
    assert.match(r.err, /herdr is not reachable inside Codex's sandbox/, r.err);
    assert.match(r.err, /Codex sessions can still coordinate \(claim, wait, show, answer, ack\)/, r.err);
    assert.equal(readdirSync(sb.runs).length, before, 'no run dir');
    assert.deepEqual(calls(sb), [], 'no herdr call');
    assert.ok(!existsSync(sb.argv), 'codex never ran');
  }
  // The default harness is unchanged.
  const ok1 = start(sb, ['--repo', rp, '--goal', 'g']);
  assert.equal(ok1.code, 0, ok1.err);
  assert.equal(readRec(ok1.dir).architect.harness, 'claude');
});

test('launch.sh holds no goal bytes and no permission-bypass or sandbox flags, and never execs the architect', () => {
  const sb = newBox();
  const r = launchFor(sb, ['--harness', 'claude']);
  const sh = read(join(r.dir, 'launch.sh'));
  assert.ok(!sh.includes('GOALBYTES-unique'));
  for (const bad of ['--dangerously-skip-permissions', '--permission-mode', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '-a never', 'danger-full-access', 'read-only', '--sandbox', 'codex']) assert.ok(!sh.includes(bad), bad);
  assert.ok(!/\bexec /.test(sh), 'no exec');
});

test('a repo path with a space and a quote, a home with a space and a hostile --model all reach the stub as exact argv', () => {
  const sb = newBox();
  const weird = mkRepo(sb, "my repo's dir");
  const home = join(sb.root, 'h o me');
  const x = { AGENT_HANDOFFS_DIR: home, BORK_RUNS_HOME: join(home, 'runs') };
  const r = start(sb, ['--repo', weird, '--goal', 'g', '--model', 'x; touch PWNED'], x);
  ok(r);
  const dir = join(home, 'runs', r.id);
  assert.equal(runLaunch(sb, dir).status, 0);
  const [call] = argvLog(sb);
  assert.deepEqual(call.argv.slice(0, 2), ['--model', 'x; touch PWNED']);
  assert.equal(call.cwd, weird);
  assert.ok(!existsSync(join(sb.root, 'PWNED')) && !existsSync(join(weird, 'PWNED')) && !existsSync('/PWNED'));
  const pr = calls(sb).find((c) => c[0] === 'pane' && c[1] === 'run');
  assert.equal(pr[3], `bash '${join(dir, 'launch.sh')}'`);
});

test('launch-prompt.md holds the goal byte for byte, the do instruction, the run dir and the runs.mjs path with a re-resolve note', () => {
  const sb = newBox();
  const goal = 'Do ```fenced``` things\n$(rm -rf nothing) "q" ü\n';
  const r = start(sb, ['--repo', repo, '--goal', goal]);
  ok(r);
  const p = read(join(r.dir, 'launch-prompt.md'));
  assert.ok(p.includes(goal));
  assert.ok(p.includes('use the bork `do` skill for this goal'));
  assert.ok(p.includes(r.dir));
  assert.ok(p.includes(join(HERE, 'runs.mjs')));
  assert.match(p, /re-resolve[^\n]*desk skill/i);
  assert.match(p, /runs\.mjs[^\n]*ask|ask[^\n]*runs\.mjs/);
});

test('launch.sh works from a bare herdr-spawned env: the architect can ask against the same run.json', () => {
  const sb = newBox();
  const x = { AGENT_HANDOFFS_DIR: join(sb.root, 'custom-handoffs'), BORK_RUNS_HOME: undefined, ORCHESTRATOR_HOME: join(sb.root, 'custom-orch') };
  const r = start(sb, ['--repo', repo, '--goal', 'g'], x);
  ok(r);
  const dir = join(sb.root, 'custom-handoffs', 'runs', r.id);
  const out = runLaunch(sb, dir, { STUB_ACTION: 'ask' });
  assert.equal(out.status, 0, out.stderr);
  const rec = readRec(dir);
  assert.equal(rec.questions.length, 1, 'the ask reached the same run.json');
  assert.deepEqual(rec.history.map((h) => h.state).slice(-2), ['needs-me', 'blocked'], 'the stub exited after asking, so launch.sh then blocked the run');
});

test('when the architect exits non-terminal launch.sh sets blocked and signals; a done run is left alone', () => {
  const sb = newBox();
  assert.equal(run(sb, ['claim', '--pane', 'tw:p9']).code, 0);
  const r = launchFor(sb);
  const out = runLaunch(sb, r.dir, { STUB_ACTION: 'exit3' });
  assert.equal(out.status, 3);
  let rec = readRec(r.dir);
  assert.equal(rec.state, 'blocked');
  assert.equal(rec.summary, 'architect exited (code 3)');
  assert.equal(rec.signal_revision, rec.revision);
  const d = launchFor(sb);
  runLaunch(sb, d.dir, { STUB_ACTION: 'done' });
  assert.equal(readRec(d.dir).state, 'done');
  const before = sha(join(d.dir, 'run.json'));
  runLaunch(sb, d.dir);
  assert.equal(sha(join(d.dir, 'run.json')), before, 'a terminal run gets no history entry or revision from launch.sh');
});

test('a started run dir holds exactly run.json, launch-prompt.md and launch.sh', () => {
  const sb = newBox();
  const r = launchFor(sb);
  assert.deepEqual(readdirSync(r.dir).sort(), ['launch-prompt.md', 'launch.sh', 'run.json']);
});
