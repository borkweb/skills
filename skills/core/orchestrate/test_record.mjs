// test_record.mjs — homes, run record, state rules, lock, show/list, questions
// (spec v2 sections 1 and 4; criteria A6-A16).
import assert from 'node:assert';
import test from 'node:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  NODE, QOPTS, ask, calls, claim, debris, mkRepo, mkRun, newBox, readRec, recPath, resetLog, run, runAsync, sha, writeRec,
} from './testkit.mjs';

const b = newBox();
const ok = (r, msg) => assert.equal(r.code, 0, `${msg ?? ''} exit ${r.code}: ${r.err}`);
const refused = (r, msg) => assert.notEqual(r.code, 0, `${msg ?? ''} should be refused: ${r.out}`);

test('init writes the frozen record shape under the runs home with mode 700', () => {
  const r = run(b, ['init', '--goal', 'ship it', '--slug', 'fix-it']);
  ok(r);
  const dir = r.out.split('\n')[0];
  assert.equal(join(b.runs, dir.split('/').pop()), dir);
  assert.match(dir.split('/').pop(), /^\d{4}-\d{2}-\d{2}-fix-it-[a-z0-9]{4}$/);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const rec = readRec(dir);
  assert.equal(rec.schema, 1);
  assert.equal(rec.id, dir.split('/').pop());
  assert.equal(rec.run_dir, dir);
  assert.equal(rec.repo, null);
  assert.equal(rec.goal, 'ship it');
  assert.equal(rec.state, 'running');
  assert.equal(rec.summary, '');
  assert.equal(rec.delivery, null);
  assert.deepEqual(rec.questions, []);
  assert.deepEqual(rec.architect, { harness: null, session_id: null, frontend: null, tab: null, pane: null });
  assert.equal(rec.launched_by, 'self');
  assert.equal(rec.revision, 1);
  assert.equal(rec.signal_revision, 0);
  assert.equal(rec.orchestrator_ack, 0);
  assert.ok(!Number.isNaN(Date.parse(rec.created_at)) && !Number.isNaN(Date.parse(rec.updated_at)));
  assert.equal(rec.history.length, 1);
  assert.equal(rec.history[0].state, 'running');
});

test('init records the git top level, null without --repo, and refuses a non-git dir', () => {
  const repo = mkRepo(b, 'gitrepo');
  mkdirSync(join(repo, 'sub'));
  const a = run(b, ['init', '--goal', 'g', '--repo', join(repo, 'sub')]);
  ok(a);
  assert.equal(readRec(a.out.split('\n')[0]).repo, repo);
  const before = readdirSync(b.runs).length;
  const plain = join(b.root, 'plain');
  mkdirSync(plain);
  refused(run(b, ['init', '--goal', 'g', '--repo', plain]));
  assert.equal(readdirSync(b.runs).length, before, 'no dir created for a refused repo');
});

test('the goal round-trips byte for byte through --goal and --goal-file', () => {
  const goal = 'line one\n"quoted" \'single\' `tick` $(touch PWNED) ${HOME} \\n ünï ✓ --flag\n';
  const viaFlag = mkRun(b, { goal });
  assert.equal(JSON.parse(run(b, ['show', viaFlag.id, '--json']).out).goal, goal);
  const f = join(b.root, 'goal.txt');
  writeFileSync(f, goal);
  const r = run(b, ['init', '--goal-file', f]);
  ok(r);
  assert.equal(JSON.parse(run(b, ['show', r.out.split('\n')[0], '--json']).out).goal, goal);
  assert.ok(!existsSync(join(b.root, 'PWNED')));
});

test('init --run-dir on a valid run prints it and changes nothing', () => {
  const { dir } = mkRun(b);
  const before = sha(recPath(dir));
  const r = run(b, ['init', '--goal', 'other', '--run-dir', dir]);
  ok(r);
  assert.equal(r.out.split('\n')[0], dir);
  assert.equal(sha(recPath(dir)), before);
});

test('init --run-dir creates a missing direct child (and a missing home) with mode 700', () => {
  rmSync(b.runs, { recursive: true, force: true });
  const dir = join(b.runs, '2026-01-01-manual-x1y2');
  const r = run(b, ['init', '--goal', 'g', '--run-dir', dir]);
  ok(r);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(readRec(dir).id, '2026-01-01-manual-x1y2');
});

test('a slug with a slash or dot-dot is refused and nothing is created', () => {
  const before = readdirSync(b.handoffs).join(',') + '|' + readdirSync(b.runs).join(',');
  for (const slug of ['a/b', '..', '../x', 'a..b', '']) refused(run(b, ['init', '--goal', 'g', '--slug', slug]), slug);
  assert.equal(readdirSync(b.handoffs).join(',') + '|' + readdirSync(b.runs).join(','), before);
});

test('ids that fail the id rule, and unknown ids, are refused by every id-taking command', () => {
  const victim = join(b.handoffs, 'x');
  const { dir } = mkRun(b);
  mkdirSync(victim);
  writeFileSync(recPath(victim), JSON.stringify(readRec(dir)));
  const vsha = sha(recPath(victim));
  const cmds = {
    show: (id) => ['show', id],
    set: (id) => ['set', id, '--state', 'blocked'],
    ask: (id) => ['ask', id, '--question', 'q', '--options', QOPTS, '--recommendation', 'A'],
    answer: (id) => ['answer', id, 'Q1', '--answer', 'A'],
    withdraw: (id) => ['withdraw', id, 'Q1'],
    ack: (id) => ['ack', id],
    wait: (id) => ['wait', '--run', id, '--timeout', '1'],
  };
  for (const id of ['..', '../x', '.h', 'a..b', 'no-such-run']) {
    for (const [name, mk] of Object.entries(cmds)) {
      const r = run(b, mk(id));
      refused(r, `${name} ${id}`);
      if (id !== 'no-such-run') assert.match(r.err, /invalid run id/, `${name} ${id} fails the id rule itself, not only the realpath check`);
    }
  }
  assert.equal(sha(recPath(victim)), vsha, 'a traversal id must not touch a dir outside the home');
  assert.deepEqual(debris(dir), []);
  assert.deepEqual(debris(victim), []);
});

test('a run dir must be a direct child of the home by realpath', () => {
  const { dir, id } = mkRun(b);
  ok(run(b, ['show', dir]));
  const outside = join(b.root, 'outside');
  mkdirSync(outside);
  writeFileSync(recPath(outside), JSON.stringify(readRec(dir)));
  symlinkSync(outside, join(b.runs, 'link-out'));
  refused(run(b, ['show', join(b.runs, 'link-out')]), 'symlink out');
  refused(run(b, ['show', 'link-out']), 'symlink out by id');
  refused(run(b, ['show', outside]), 'plain outside dir');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(recPath(join(dir, 'sub')), JSON.stringify(readRec(dir)));
  refused(run(b, ['show', join(dir, 'sub')]), 'nested dir');
  if (dir.startsWith('/private/var/')) ok(run(b, ['show', dir.replace('/private/var/', '/var/')]), '/var spelling');
  assert.ok(id);
});

const BAD = {
  'malformed json': '{not json',
  'missing state': (r) => { delete r.state; return JSON.stringify(r); },
  'unknown state': (r) => JSON.stringify({ ...r, state: 'weird' }),
  'questions not a list': (r) => JSON.stringify({ ...r, questions: {} }),
  'newer schema': (r) => JSON.stringify({ ...r, schema: 2 }),
};
function plantBad(name, body) {
  const good = readRec(mkRun(b).dir);
  const dir = join(b.runs, `2026-01-01-bad-${name.replace(/\W+/g, '')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(recPath(dir), typeof body === 'function' ? body({ ...good }) : body);
  return dir;
}

test('an invalid run.json makes every command exit non-zero naming the path, bytes untouched', () => {
  for (const [name, body] of Object.entries(BAD)) {
    const dir = plantBad(name, body);
    const id = dir.split('/').pop();
    const before = sha(recPath(dir));
    const cmds = [
      ['set', id, '--state', 'blocked'], ['ask', id, '--question', 'q', '--options', QOPTS, '--recommendation', 'A'],
      ['answer', id, 'Q1', '--answer', 'A'], ['withdraw', id, 'Q1'], ['ack', id], ['show', id],
      ['init', '--goal', 'g', '--run-dir', dir],
    ];
    for (const c of cmds) {
      const r = run(b, c);
      refused(r, `${name}: ${c[0]}`);
      assert.ok(r.err.includes(recPath(dir)), `${name}: ${c[0]} names the path: ${r.err}`);
    }
    assert.equal(sha(recPath(dir)), before, name);
    assert.deepEqual(debris(dir), [], name);
  }
});

test('list and wait skip each invalid run.json with exactly one warning and report the valid run', () => {
  const lb = newBox();
  const good = mkRun(lb);
  run(lb, ['set', good.id, '--state', 'done', '--summary', 's']);
  const bads = Object.entries(BAD).map(([n, body]) => {
    const g = readRec(good.dir);
    const dir = join(lb.runs, `2026-01-01-bad-${n.replace(/\W+/g, '')}`);
    mkdirSync(dir);
    writeFileSync(recPath(dir), typeof body === 'function' ? body({ ...g }) : body);
    return dir;
  });
  const l = run(lb, ['list']);
  ok(l);
  assert.ok(l.out.includes(good.id));
  const warnLines = (s) => s.split('\n').filter((x) => /warn/i.test(x));
  assert.equal(warnLines(l.err).length, bads.length, l.err);
  for (const d of bads) assert.equal(l.err.split(recPath(d)).length - 1, 1, `one warning for ${d}`);
  const w = run(lb, ['wait', '--timeout', '5']);
  ok(w);
  assert.match(w.out, new RegExp(`^RUN ${good.id} done r\\d+$`, 'm'));
  assert.equal(warnLines(w.err).length, bads.length, w.err);
});

test('default homes: runs under $HOME/.agent-handoffs, AGENT_HANDOFFS_DIR/runs, never offload/runs; claim under $HOME/.borkweb-skills', () => {
  const hb = newBox();
  const bare = { BORK_RUNS_HOME: undefined, AGENT_HANDOFFS_DIR: undefined, ORCHESTRATOR_HOME: undefined };
  const r1 = run(hb, ['init', '--goal', 'g'], bare);
  ok(r1);
  assert.equal(r1.out.split('\n')[0].replace(/\/[^/]+$/, ''), join(hb.home, '.agent-handoffs', 'runs'));
  const x = join(hb.root, 'custom');
  const r2 = run(hb, ['init', '--goal', 'g'], { ...bare, AGENT_HANDOFFS_DIR: x });
  ok(r2);
  assert.equal(r2.out.split('\n')[0].replace(/\/[^/]+$/, ''), join(x, 'runs'));
  assert.ok(!existsSync(join(x, 'offload')));
  ok(run(hb, ['claim', '--pane', 'tw:p3'], bare));
  assert.ok(existsSync(join(hb.home, '.borkweb-skills', 'orchestrator', 'orchestrator.json')));
});

test('with OFFLOAD_HANDOFF set every writing command is refused and bytes stay; reads still work', () => {
  const wb = newBox();
  const repo = mkRepo(wb);
  const { dir, id } = mkRun(wb);
  ask(wb, id);
  ok(claim(wb));
  const oj = join(wb.orch, 'orchestrator.json');
  const [rs, os] = [sha(recPath(dir)), sha(oj)];
  const B = { OFFLOAD_HANDOFF: '/tmp/x' };
  const runsBefore = readdirSync(wb.runs).join(',');
  const writers = [
    ['init', '--goal', 'g'], ['set', id, '--state', 'blocked'], ['ask', id, '--question', 'q', '--options', QOPTS, '--recommendation', 'A'],
    ['answer', id, 'Q1', '--answer', 'A'], ['withdraw', id, 'Q1'], ['ack', id], ['ack', '--all'],
    ['claim', '--pane', 'tw:p4'], ['release'], ['start', '--repo', repo, '--goal', 'g'],
  ];
  for (const w of writers) refused(run(wb, w, B), w[0]);
  assert.deepEqual(debris(dir), [], 'a refused builder write leaves no lock or tmp file');
  assert.equal(sha(recPath(dir)), rs);
  assert.equal(sha(oj), os);
  assert.equal(readdirSync(wb.runs).join(','), runsBefore);
  ok(run(wb, ['show', id], B));
  ok(run(wb, ['list'], B));
  assert.ok([0, 124].includes(run(wb, ['wait', '--timeout', '1'], B).code), 'wait still works');
});

test('runs.mjs never touches backlog.md, coordination.sqlite or assignments/', () => {
  const ob = newBox();
  const repo = mkRepo(ob);
  const guard = { 'backlog.md': 'b', 'coordination.sqlite': 'sqlite-bytes', 'projects.md': `- demo - d (path: ${repo}) (added 2026-01-01)\n` };
  for (const [f, c] of Object.entries(guard)) writeFileSync(join(ob.orch, f), c);
  mkdirSync(join(ob.orch, 'assignments'));
  writeFileSync(join(ob.orch, 'assignments', 'x'), 'a');
  const snap = () => ['backlog.md', 'coordination.sqlite', 'projects.md', 'assignments/x'].map((f) => sha(join(ob.orch, f))).join();
  const before = snap();
  const { id } = mkRun(ob);
  ask(ob, id);
  ok(run(ob, ['claim', '--pane', 'tw:p3']));
  ok(run(ob, ['answer', id, 'Q1', '--answer', 'A', '--no-nudge']));
  ok(run(ob, ['set', id, '--state', 'blocked']));
  ok(run(ob, ['ack', '--all']));
  ok(run(ob, ['list']));
  ok(run(ob, ['start', '--repo', 'demo', '--goal', 'g']));
  ok(run(ob, ['release']));
  assert.equal(snap(), before);
  assert.deepEqual(readdirSync(ob.orch).sort(), ['assignments', 'backlog.md', 'coordination.sqlite', 'projects.md']);
});

test('every subcommand runs on its valid path; no args and unknown subcommands exit 2', () => {
  const sb = newBox();
  const repo = mkRepo(sb);
  const bad = run(sb, []);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /usage/i);
  assert.equal(run(sb, ['frobnicate']).code, 2);
  const { id } = mkRun(sb);
  ok(run(sb, ['set', id, '--state', 'blocked', '--summary', 's']), 'set');
  ok(run(sb, ['show', id]), 'show');
  ok(run(sb, ['list']), 'list');
  ok(run(sb, ['claim', '--pane', 'tw:p3']), 'claim');
  ok(ask(sb, id), 'ask');
  ok(run(sb, ['wait', '--run', id, '--timeout', '5']), 'wait');
  ok(run(sb, ['ack', id]), 'ack');
  ok(run(sb, ['answer', id, 'Q1', '--answer', 'A']), 'answer');
  ok(ask(sb, id, 'again'), 'ask 2');
  ok(run(sb, ['withdraw', id, 'Q2']), 'withdraw');
  ok(run(sb, ['start', '--repo', repo, '--goal', 'g']), 'start');
  ok(run(sb, ['release']), 'release');
  ok(run(sb, ['init', '--goal', 'g']), 'init');
});

// ---- state rules -----------------------------------------------------------

const noChange = (dir, fn) => {
  const before = sha(recPath(dir));
  const r = fn();
  assert.equal(sha(recPath(dir)), before, 'bytes unchanged');
  assert.deepEqual(debris(dir), []);
  return r;
};

test('done and running are refused while a question is open; needs-me is never settable', () => {
  const { dir, id } = mkRun(b);
  refused(noChange(dir, () => run(b, ['set', id, '--state', 'needs-me'])), 'needs-me without question');
  ok(ask(b, id));
  refused(noChange(dir, () => run(b, ['set', id, '--state', 'done'])), 'done');
  refused(noChange(dir, () => run(b, ['set', id, '--state', 'running'])), 'running');
  refused(noChange(dir, () => run(b, ['set', id, '--state', 'needs-me'])), 'needs-me with question');
});

test('blocked and failed succeed from running and from needs-me with an open question', () => {
  for (const to of ['blocked', 'failed']) {
    const a = mkRun(b);
    ok(run(b, ['set', a.id, '--state', to, '--summary', 'why']));
    assert.equal(readRec(a.dir).state, to);
    const c = mkRun(b);
    ask(b, c.id);
    ok(run(b, ['set', c.id, '--state', to, '--summary', 'why']));
    assert.equal(readRec(c.dir).state, to);
  }
});

test('answering or withdrawing the last open question resumes only a needs-me run', () => {
  const two = mkRun(b);
  ask(b, two.id, 'one');
  ask(b, two.id, 'two');
  ok(run(b, ['answer', two.id, 'Q1', '--answer', 'A']));
  assert.equal(readRec(two.dir).state, 'needs-me');
  ok(run(b, ['withdraw', two.id, 'Q2']));
  assert.equal(readRec(two.dir).state, 'running');
  const blocked = mkRun(b);
  ask(b, blocked.id);
  ok(run(b, ['set', blocked.id, '--state', 'blocked', '--summary', 'stuck']));
  ok(run(b, ['answer', blocked.id, 'Q1', '--answer', 'B']));
  assert.equal(readRec(blocked.dir).state, 'blocked');
  const w = mkRun(b);
  ask(b, w.id);
  ok(run(b, ['withdraw', w.id, 'Q1']));
  assert.equal(readRec(w.dir).state, 'running');
  const wb = mkRun(b);
  ask(b, wb.id);
  run(b, ['set', wb.id, '--state', 'blocked', '--summary', 's']);
  ok(run(b, ['withdraw', wb.id, 'Q1']));
  assert.equal(readRec(wb.dir).state, 'blocked');
});

test('ask on a blocked run keeps the blocked reason in history before the needs-me entry', () => {
  const { dir, id } = mkRun(b);
  ok(run(b, ['set', id, '--state', 'blocked', '--summary', 'waiting on creds', '--note', 'creds missing']));
  ok(ask(b, id));
  const h = readRec(dir).history;
  const bi = h.findIndex((e) => e.state === 'blocked' && e.note === 'creds missing');
  const ni = h.findIndex((e) => e.state === 'needs-me');
  assert.ok(bi >= 0 && ni > bi, JSON.stringify(h));
});

test('a done or failed run refuses every change but ack; show marks open questions moot on failed', () => {
  for (const term of ['done', 'failed']) {
    const { dir, id } = mkRun(b);
    ask(b, id);
    if (term === 'done') { run(b, ['answer', id, 'Q1', '--answer', 'A']); ok(run(b, ['set', id, '--state', 'done', '--delivery', 'd'])); } else ok(run(b, ['set', id, '--state', 'failed', '--summary', 'x']));
    const changes = [
      ['set', id, '--state', 'blocked'], ['set', id, '--note', 'n'], ['ask', id, '--question', 'q', '--options', QOPTS, '--recommendation', 'A'],
      ['answer', id, 'Q1', '--answer', 'B'], ['withdraw', id, 'Q1'],
    ];
    for (const c of changes) refused(noChange(dir, () => run(b, c)), `${term} ${c[0]}`);
    ok(run(b, ['ack', id]));
    const s = run(b, ['show', id]);
    ok(s);
    if (term === 'failed') {
      assert.match(s.out, /moot/i);
      assert.equal(JSON.parse(run(b, ['show', id, '--json']).out).questions[0].moot, true);
    }
    assert.ok(run(b, ['list']).out.includes(id));
  }
});

test('--state outside the five states is refused', () => {
  const { dir, id } = mkRun(b);
  for (const s of ['Done', 'merged', '']) refused(noChange(dir, () => run(b, ['set', id, '--state', s])), JSON.stringify(s));
});

test('each write bumps revision by one; state changes and notes add one history entry each; ack adds none', () => {
  const { dir, id } = mkRun(b);
  const snap = () => readRec(dir);
  let r = snap();
  assert.equal([r.revision, r.history.length].join(), '1,1');
  run(b, ['set', id, '--summary', 'only summary']);
  r = snap();
  assert.equal([r.revision, r.history.length].join(), '2,1', 'summary alone is not a history event');
  run(b, ['set', id, '--note', 'a note']);
  r = snap();
  assert.equal([r.revision, r.history.length].join(), '3,2');
  run(b, ['set', id, '--state', 'blocked', '--note', 'n2']);
  r = snap();
  assert.equal([r.revision, r.history.length].join(), '4,3', 'state change plus note is one entry');
  assert.deepEqual(Object.keys(r.history[2]).sort(), ['at', 'note', 'state']);
  ask(b, id);
  r = snap();
  assert.equal([r.revision, r.history.length].join(), '5,4');
  run(b, ['ack', id]);
  r = snap();
  assert.equal([r.revision, r.history.length].join(), '6,4');
});

// ---- lock and atomic writes -----------------------------------------------

test('20 parallel writers keep every change', async () => {
  const { dir, id } = mkRun(b);
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(runAsync(b, ['ask', id, '--question', `q${i}`, '--options', QOPTS, '--recommendation', 'A']));
    jobs.push(runAsync(b, ['set', id, '--note', `note-${i}`]));
  }
  const rs = await Promise.all(jobs);
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const rec = readRec(dir);
  assert.deepEqual(rec.questions.map((q) => q.id), Array.from({ length: 10 }, (_, i) => `Q${i + 1}`));
  assert.equal(new Set(rec.questions.map((q) => q.question)).size, 10);
  for (let i = 0; i < 10; i++) assert.ok(rec.history.some((e) => e.note === `note-${i}`), `note-${i}`);
  assert.equal(rec.revision, 1 + 20);
  assert.deepEqual(debris(dir), []);
});

const staleLock = (dir, pid, ageSec) => {
  const p = join(dir, 'run.json.lock');
  writeFileSync(p, JSON.stringify({ pid, at: new Date(Date.now() - ageSec * 1000).toISOString() }));
  const t = new Date(Date.now() - ageSec * 1000);
  utimesSync(p, t, t);
  return p;
};
const deadPid = () => spawnSync(NODE, ['-e', '']).pid;

test('a lock older than 10 s whose pid is dead is broken and the write succeeds', () => {
  const { dir, id } = mkRun(b);
  staleLock(dir, deadPid(), 30);
  ok(run(b, ['set', id, '--note', 'after stale']));
  assert.deepEqual(debris(dir), []);
  assert.equal(readRec(dir).history.at(-1).note, 'after stale');
});

test('a young lock, or an old lock held by a live pid, fails the writer in about 5 s naming the lock', async () => {
  const rows = [[deadPid(), 1], [process.pid, 30]];
  await Promise.all(rows.map(async ([pid, age]) => {
    const { dir, id } = mkRun(b);
    const lock = staleLock(dir, pid, age);
    const before = sha(recPath(dir));
    const r = await runAsync(b, ['set', id, '--note', 'x']);
    assert.notEqual(r.code, 0);
    assert.ok(r.ms < 9000, `gave up in ${r.ms} ms`);
    assert.ok(r.err.includes(lock), r.err);
    assert.equal(sha(recPath(dir)), before);
    rmSync(lock);
    assert.deepEqual(debris(dir), []);
  }));
});

test('20 concurrent claims leave one valid orchestrator.json naming one pane', async () => {
  const cb = newBox();
  const panes = Array.from({ length: 20 }, (_, i) => `w1:p${i}`);
  const rs = await Promise.all(panes.map((p) => runAsync(cb, ['claim', '--pane', p])));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const j = JSON.parse(readFileSync(join(cb.orch, 'orchestrator.json'), 'utf8'));
  assert.ok(panes.includes(j.pane));
  assert.deepEqual(readdirSync(cb.orch), ['orchestrator.json']);
});

// ---- show and list ---------------------------------------------------------

test('show prints state, summary, delivery, open questions with options and recommendation, run dir, architect tab', () => {
  const { dir, id } = mkRun(b, { goal: 'the goal' });
  writeRec(dir, { architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: 'w9:t7', pane: null } });
  run(b, ['set', id, '--state', 'blocked', '--summary', 'sum-line', '--delivery', 'deliv-line']);
  ask(b, id, 'pick one?');
  const s = run(b, ['show', id]);
  ok(s);
  for (const need of ['needs-me', 'sum-line', 'deliv-line', 'pick one?', 'A', 'da', 'B', 'db', 'recommendation', dir, 'w9:t7']) assert.ok(s.out.includes(need), `show has ${need}\n${s.out}`);
  assert.equal(run(b, ['show', dir]).out, s.out);
});

test('architect gone is flagged only when the pane is set and herdr reports no agent', () => {
  const { dir, id } = mkRun(b);
  const rows = [['w9:p7', undefined, true], ['w9:p7', 'w9:p7', false], [null, undefined, false]];
  for (const [pane, agents, gone] of rows) {
    writeRec(dir, { architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: 't', pane } });
    resetLog(b);
    const s = run(b, ['show', id], { HERDR_STUB_AGENTS: agents });
    const l = run(b, ['list'], { HERDR_STUB_AGENTS: agents });
    for (const o of [s.out, l.out]) assert.equal(/architect gone/.test(o), gone, `${pane}/${agents}: ${o}`);
    if (pane === null) assert.deepEqual(calls(b), [], 'no herdr call without a pane');
  }
});

test('stale flags a running run idle for 25 h, not 23 h, not a blocked run; the file is untouched', () => {
  const hours = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const rows = [['running', 25, true], ['running', 23, false], ['blocked', 25, false]];
  for (const [state, h, stale] of rows) {
    const { dir, id } = mkRun(b);
    writeRec(dir, { state, updated_at: hours(h) });
    const before = sha(recPath(dir));
    const s = run(b, ['show', id]).out;
    const l = run(b, ['list']).out.split('\n').find((x) => x.includes(id));
    assert.equal(/stale/.test(s), stale, `show ${state} ${h}h`);
    assert.equal(/stale/.test(l), stale, `list ${state} ${h}h`);
    assert.equal(sha(recPath(dir)), before);
  }
});

test('list skips dirs without run.json, orders newest first, filters by state, and is empty without a home', () => {
  const lb = newBox();
  const a = mkRun(lb, { slug: 'old' });
  const c = mkRun(lb, { slug: 'new' });
  writeRec(a.dir, { created_at: '2026-01-01T00:00:00.000Z' });
  writeRec(c.dir, { created_at: '2026-06-01T00:00:00.000Z' });
  mkdirSync(join(lb.runs, '2026-02-02-empty-aaaa'));
  const l = run(lb, ['list']);
  ok(l);
  const ids = l.out.split('\n').filter(Boolean).map((x) => x.split(/\s+/)[0]);
  assert.deepEqual(ids, [c.id, a.id]);
  run(lb, ['set', a.id, '--state', 'blocked', '--summary', 's']);
  ask(lb, c.id);
  const f = run(lb, ['list', '--state', 'blocked,needs-me', '--json']);
  assert.equal(JSON.parse(f.out).length, 2);
  assert.equal(JSON.parse(run(lb, ['list', '--state', 'blocked', '--json']).out).length, 1);
  rmSync(lb.runs, { recursive: true });
  const e = run(lb, ['list']);
  assert.equal(e.code, 0);
  assert.equal(e.out, '');
});

// ---- questions -------------------------------------------------------------

test('ask appends Q<n> open, goes needs-me, sets signal_revision and prints Q<n>', () => {
  const { dir, id } = mkRun(b);
  const r = ask(b, id, 'which db?');
  ok(r);
  assert.equal(r.out.trim(), 'Q1');
  const rec = readRec(dir);
  assert.equal(rec.state, 'needs-me');
  assert.equal(rec.signal_revision, rec.revision);
  const q = rec.questions[0];
  assert.deepEqual([q.id, q.question, q.status, q.recommendation, q.answer, q.choice], ['Q1', 'which db?', 'open', 'A', null, null]);
  assert.deepEqual(q.options, JSON.parse(QOPTS));
  assert.ok(q.asked_at);
  assert.equal(ask(b, id, 'second').out.trim(), 'Q2');
});

test('ask refuses bad options, labels and recommendations with bytes unchanged', () => {
  const { dir, id } = mkRun(b);
  const o = (arr) => JSON.stringify(arr);
  const L = (l) => ({ label: l, description: 'd' });
  const rows = [
    [o([L('A')]), 'A'], [o([L(''), L('B')]), 'B'], [o([L('A'), L('A')]), 'A'], [QOPTS, 'a'], [QOPTS, 'C'], [QOPTS, ''],
    ['{not json', 'A'], [o({ label: 'A' }), 'A'], [o([{ description: 'x' }, L('B')]), 'B'],
  ];
  for (const [opts, rec] of rows) refused(noChange(dir, () => run(b, ['ask', id, '--question', 'q', '--options', opts, '--recommendation', rec])), `${opts} / ${rec}`);
  refused(noChange(dir, () => run(b, ['ask', id, '--options', QOPTS, '--recommendation', 'A'])), 'no question');
});

test('answer records answer, who and when; choice only for a label; refuses a second answer or an unknown Q', () => {
  const { dir, id } = mkRun(b);
  ask(b, id);
  ask(b, id, 'two');
  ok(run(b, ['answer', id, 'Q1', '--answer', 'B', '--by', 'user']));
  let q = readRec(dir).questions[0];
  assert.deepEqual([q.status, q.answer, q.choice, q.answered_by], ['answered', 'B', 'B', 'user']);
  assert.ok(q.answered_at);
  ok(run(b, ['answer', id, 'Q2', '--answer', 'something free-form', '--by', 'orchestrator']));
  q = readRec(dir).questions[1];
  assert.deepEqual([q.status, q.choice, q.answered_by], ['answered', null, 'orchestrator']);
  refused(noChange(dir, () => run(b, ['answer', id, 'Q1', '--answer', 'A'])), 'second answer');
  refused(noChange(dir, () => run(b, ['answer', id, 'Q9', '--answer', 'A'])), 'unknown Q');
  refused(noChange(dir, () => run(b, ['answer', id, 'Q2', '--answer', 'A'])), 'answered Q2');
});

test('withdraw sets withdrawn and applies the state rules; a second withdraw is refused', () => {
  const { dir, id } = mkRun(b);
  ask(b, id);
  ok(run(b, ['withdraw', id, 'Q1', '--note', 'no longer needed']));
  const rec = readRec(dir);
  assert.equal(rec.questions[0].status, 'withdrawn');
  assert.equal(rec.state, 'running');
  refused(noChange(dir, () => run(b, ['withdraw', id, 'Q1'])));
});
