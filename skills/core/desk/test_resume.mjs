// test_resume.mjs — runs.mjs resume: pick, reopen or create a do run's directory in one call.
import assert from 'node:assert';
import test from 'node:test';
import { readdirSync, statSync } from 'node:fs';
import { mkRepo, mkRun, newBox, readRec, run, writeRec } from './testkit.mjs';

const b = newBox();
const ok = (r, msg) => assert.equal(r.code, 0, `${msg ?? ''} exit ${r.code}: ${r.err}`);
const lines = (r) => r.out.trim().split('\n');
const count = () => readdirSync(b.runs).length;

test('with no candidate it creates a run like init, mode 700, and says created', () => {
  const before = count();
  const r = run(b, ['resume', '--goal', 'ship it', '--slug', 'fresh']);
  ok(r);
  const [dir, action] = lines(r);
  assert.match(dir.split('/').pop(), /^\d{4}-\d{2}-\d{2}-fresh-[a-z0-9]{4}$/);
  assert.equal(action, 'created running');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(readRec(dir).goal, 'ship it');
  assert.equal(count(), before + 1);
});

test('a running BORK_RUN_DIR is resumed without a new run', () => {
  const { dir } = mkRun(b, { slug: 'env' });
  const before = count();
  const r = run(b, ['resume', '--goal', 'g'], { BORK_RUN_DIR: dir });
  ok(r);
  assert.deepEqual(lines(r), [dir, 'resumed running']);
  assert.equal(count(), before);
});

test('BORK_RUN_DIR wins over a candidate, and a candidate is used when the env run is unusable', () => {
  const a = mkRun(b, { slug: 'enva' }).dir;
  const c = mkRun(b, { slug: 'canda' }).dir;
  assert.equal(lines(run(b, ['resume', '--goal', 'g', '--candidate', c], { BORK_RUN_DIR: a }))[0], a);
  writeRec(a, { state: 'failed' });
  const r = run(b, ['resume', '--goal', 'g', '--candidate', c], { BORK_RUN_DIR: a });
  ok(r);
  assert.deepEqual(lines(r), [c, 'resumed running']);
  assert.match(r.err, /failed runs are final/);
});

test('a done run is skipped without --continue and reopened with it', () => {
  const { dir } = mkRun(b, { slug: 'done' });
  writeRec(dir, { state: 'done', delivery: 'committed abc123' });
  const skip = run(b, ['resume', '--goal', 'unrelated', '--candidate', dir]);
  ok(skip);
  assert.notEqual(lines(skip)[0], dir);
  assert.equal(lines(skip)[1], 'created running');
  assert.match(skip.err, /pass --continue/);
  const again = run(b, ['resume', '--goal', 'more of the same', '--candidate', dir, '--continue']);
  ok(again);
  assert.deepEqual(lines(again), [dir, 'reopened running']);
  const rec = readRec(dir);
  assert.equal(rec.delivery, null);
  assert.match(rec.history.at(-1).note, /previous delivery: committed abc123/);
});

test('a blocked run is resumed as blocked, and reopened with --continue', () => {
  const { dir } = mkRun(b, { slug: 'blk' });
  writeRec(dir, { state: 'blocked' });
  assert.deepEqual(lines(run(b, ['resume', '--goal', 'g', '--candidate', dir])), [dir, 'resumed blocked']);
  assert.deepEqual(lines(run(b, ['resume', '--goal', 'g', '--candidate', dir, '--continue'])), [dir, 'reopened running']);
});

test('--new ignores BORK_RUN_DIR and candidates', () => {
  const { dir } = mkRun(b, { slug: 'old' });
  const r = run(b, ['resume', '--goal', 'g', '--new', '--candidate', dir], { BORK_RUN_DIR: dir });
  ok(r);
  assert.notEqual(lines(r)[0], dir);
  assert.equal(lines(r)[1], 'created running');
});

test('--new with --continue is a usage error', () => {
  assert.notEqual(run(b, ['resume', '--goal', 'g', '--new', '--continue']).code, 0);
});

test('a missing or outside candidate is skipped with a reason, not an error', () => {
  const r = run(b, ['resume', '--goal', 'g', '--candidate', '/nonexistent/run', '--candidate', '2020-01-01-nope-abcd']);
  ok(r);
  assert.equal(lines(r)[1], 'created running');
  assert.equal((r.err.match(/runs: skipped/g) || []).length, 2);
});

test('--repo records the git top, and --json reports the action and skips', () => {
  const repo = mkRepo(b);
  const r = run(b, ['resume', '--goal', 'g', '--repo', repo, '--json']);
  ok(r);
  const j = JSON.parse(r.out);
  assert.equal(j.action, 'created');
  assert.equal(j.state, 'running');
  assert.deepEqual(j.skipped, []);
  assert.equal(readRec(j.run_dir).repo, repo);
});

test('a builder process cannot resume or create runs', () => {
  const r = run(b, ['resume', '--goal', 'g'], { OFFLOAD_HANDOFF: '/tmp/x.md' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /OFFLOAD_HANDOFF/);
});
