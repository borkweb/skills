// test_init_herdr.mjs — `init` records the herdr tab of a self-launched run (desk board slice, B6).
// The testkit defaults stay as they are (pane set, tab unset); each case passes its own herdr ids.
import assert from 'node:assert';
import test from 'node:test';
import { ask, calls, claim, mkRepo, newBox, nudges, readRec, resetLog, run } from './testkit.mjs';

const b = newBox();
const NONE = { frontend: null, tab: null, pane: null };
const archOf = (dir) => { const { frontend, tab, pane } = readRec(dir).architect; return { frontend, tab, pane }; };
const init = (extra, args = []) => {
  const r = run(b, ['init', '--goal', 'g', '--slug', 'job', ...args], extra);
  assert.equal(r.code, 0, r.err);
  return r.out.split('\n')[0];
};
const HERDR = { HERDR_TAB_ID: 'tw:t1' };

test('B6 init records herdr, tab and pane from the herdr env on a new run', () => {
  assert.deepEqual(archOf(init(HERDR)), { frontend: 'herdr', tab: 'tw:t1', pane: 'tw:p1' });
});

test('B6 init --json prints the recorded architect fields, not only the file', () => {
  const r = run(b, ['init', '--goal', 'g', '--slug', 'job', '--json'], { HERDR_TAB_ID: 'tw:t2', HERDR_PANE_ID: 'tw:p2' });
  assert.equal(r.code, 0, r.err);
  const { architect } = JSON.parse(r.out);
  assert.deepEqual({ frontend: architect.frontend, tab: architect.tab, pane: architect.pane }, { frontend: 'herdr', tab: 'tw:t2', pane: 'tw:p2' });
});

test('B6 init records null with HERDR_ENV removed', () => {
  assert.deepEqual(archOf(init({ ...HERDR, HERDR_ENV: undefined })), NONE);
});

test('B6 init records null with HERDR_ENV empty', () => {
  assert.deepEqual(archOf(init({ ...HERDR, HERDR_ENV: '' })), NONE);
});

test('B6 init records null with the testkit default env (pane set, tab unset)', () => {
  assert.deepEqual(archOf(init({})), NONE);
});

test('B6 init records null with the tab set and the pane removed', () => {
  assert.deepEqual(archOf(init({ ...HERDR, HERDR_PANE_ID: undefined })), NONE);
});

for (const bad of ['-x', 'w1 t2', 'w1:t2\n', '']) {
  test(`B6 init records null for HERDR_TAB_ID ${JSON.stringify(bad)}`, () => {
    assert.deepEqual(archOf(init({ HERDR_TAB_ID: bad })), NONE);
  });
  test(`B6 init records null for HERDR_PANE_ID ${JSON.stringify(bad)}`, () => {
    assert.deepEqual(archOf(init({ ...HERDR, HERDR_PANE_ID: bad })), NONE);
  });
}

test('B6 init on an existing record leaves its architect fields unchanged', () => {
  const first = init(HERDR);
  const again = run(b, ['init', '--goal', 'other', '--run-dir', first], { HERDR_TAB_ID: 'tw:t9', HERDR_PANE_ID: 'tw:p9' });
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(archOf(first), { frontend: 'herdr', tab: 'tw:t1', pane: 'tw:p1' });
});

test('B6 show on a B6 run reports architect gone when the stub knows no agent', () => {
  const dir = init(HERDR);
  const r = run(b, ['show', readRec(dir).id], { HERDR_STUB_AGENTS: undefined });
  assert.match(r.out, /architect gone/);
});

test('B6 answer without --no-nudge sends the nudge to the pane init recorded', () => {
  const dir = init(HERDR);
  const { id } = readRec(dir);
  ask(b, id);
  resetLog(b);
  assert.equal(run(b, ['answer', id, 'Q1', '--answer', 'A', '--by', 'user']).code, 0);
  assert.deepEqual(nudges(b), [['agent', 'prompt', 'tw:p1', `bork run ${id}: answered Q1`]]);
});

// start keeps the architect it creates: init's env read never reaches the shared createRun path.
test('B6 start with a herdr tab in the env records the created tab, not the coordinator tab', () => {
  const sb = newBox();
  const repo = mkRepo(sb, 'target');
  assert.equal(claim(sb).code, 0);
  const r = run(sb, ['start', '--repo', repo, '--goal', 'g'], HERDR);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(archOf(`${sb.runs}/${r.out.split('\n')[0]}`), { frontend: 'herdr', tab: 'w9:t7', pane: 'w9:p7' });
});

test('B6 a failed start with a herdr tab in the env leaves a failed record with a null architect', () => {
  const sb = newBox();
  const repo = mkRepo(sb, 'target');
  const r = run(sb, ['start', '--repo', repo, '--goal', 'g'], { ...HERDR, HERDR_STUB_MODE: 'fail-create' });
  assert.notEqual(r.code, 0);
  const id = /\(run (\S+) marked failed\)/.exec(r.err)?.[1];
  assert.ok(id, r.err);
  assert.equal(readRec(`${sb.runs}/${id}`).state, 'failed');
  assert.deepEqual(archOf(`${sb.runs}/${id}`), NONE);
  assert.ok(calls(sb).length > 0);
});
