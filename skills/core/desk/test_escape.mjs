// test_escape.mjs — runs.mjs escape (X4): an append-only list of post-merge escapes on a run record.
// Criteria C5a-C5o, C19, C20, C27. Environments are built from scratch by testkit.mjs.
import assert from 'node:assert';
import test from 'node:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  debris, mkRun, newBox, readRec, recPath, run, runAsync, sha, writeRec,
} from './testkit.mjs';

const b = newBox();
const KINDS = ['revert', 'fix-forward', 'review-defect', 'post-merge-ci'];
const URL1 = 'https://github.com/o/r/pull/1';
const ok = (r, m) => assert.equal(r.code, 0, `${m ?? ''} exit ${r.code}: ${r.err}`);
const esc = (id, kind, ref, extra = [], env = {}) => run(b, ['escape', id, '--kind', kind, '--ref', ref, ...extra], env);

test('C5a escape appends exactly one {kind, ref, at, note} entry to a running run', () => {
  const { id, dir } = mkRun(b);
  ok(esc(id, 'revert', 'abc1234', ['--note', 'n']));
  const { escapes } = readRec(dir);
  assert.equal(escapes.length, 1);
  assert.deepEqual(Object.keys(escapes[0]).sort(), ['at', 'kind', 'note', 'ref']);
  assert.equal(escapes[0].kind, 'revert');
  assert.equal(escapes[0].ref, 'abc1234');
  assert.equal(escapes[0].note, 'n');
  assert.ok(!Number.isNaN(Date.parse(escapes[0].at)));
  const shown = JSON.parse(run(b, ['show', id, '--json']).out);
  assert.deepEqual(shown.escapes, escapes);
});

test('C5b all four kinds are accepted and kept in call order', () => {
  const { id, dir } = mkRun(b);
  const refs = ['abc1234', 'def5678', URL1, 'https://github.com/o/r/pull/2'];
  KINDS.forEach((k, i) => ok(esc(id, k, refs[i]), k));
  assert.deepEqual(readRec(dir).escapes.map((e) => e.kind), KINDS);
  assert.deepEqual(readRec(dir).escapes.map((e) => e.ref), refs);
});

test('C5c a bad --kind exits 2, names the four kinds and leaves run.json byte-identical', () => {
  const { id, dir } = mkRun(b);
  const before = sha(recPath(dir));
  for (const kind of ['Revert', 'revert ', '', 'revert,fix-forward', 'bogus']) {
    const r = esc(id, kind, 'abc1234');
    assert.equal(r.code, 2, `kind ${JSON.stringify(kind)}: ${r.err}`);
    for (const k of KINDS) assert.ok(r.err.includes(k), `${JSON.stringify(kind)} stderr names ${k}: ${r.err}`);
    assert.equal(sha(recPath(dir)), before);
  }
});

test('C5d a missing or empty --ref exits 2 and writes nothing', () => {
  const { id, dir } = mkRun(b);
  const before = sha(recPath(dir));
  assert.equal(run(b, ['escape', id, '--kind', 'revert']).code, 2);
  assert.equal(esc(id, 'revert', '').code, 2);
  assert.equal(sha(recPath(dir)), before);
});

test('C5e escape is a writer: OFFLOAD_HANDOFF refuses it and nothing is written', () => {
  const { id, dir } = mkRun(b);
  const before = sha(recPath(dir));
  const r = esc(id, 'revert', 'abc1234', [], { OFFLOAD_HANDOFF: '/x' });
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('OFFLOAD_HANDOFF'), r.err);
  assert.equal(sha(recPath(dir)), before);
});

test('C5f a run that is not a direct child of the runs home is refused with exit 1 and nothing changes', () => {
  mkRun(b);
  const out = join(b.root, 'outside');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'run.json'), '{}');
  const r = esc(out, 'revert', 'abc1234');
  assert.equal(r.code, 1, r.err);
  assert.equal(readFileSync(join(out, 'run.json'), 'utf8'), '{}');
  assert.deepEqual(readdirSync(out), ['run.json']);
});

test('C5g escape works on done and failed runs without changing their state', () => {
  for (const state of ['done', 'failed']) {
    const { id } = mkRun(b);
    ok(run(b, ['set', id, '--state', state, '--summary', 's']));
    ok(esc(id, 'revert', 'abc1234'), state);
    const rec = JSON.parse(run(b, ['show', id, '--json']).out);
    assert.equal(rec.state, state);
    assert.equal(rec.escapes.length, 1);
  }
});

test('C5h escape leaves state, signal_revision, orchestrator_ack and history alone, so an armed wait stays quiet', () => {
  const { id, dir } = mkRun(b);
  ok(run(b, ['set', id, '--state', 'done', '--summary', 's']));
  const before = readRec(dir);
  ok(run(b, ['ack', '--revision', String(before.signal_revision), id]));
  const acked = readRec(dir);
  ok(esc(id, 'revert', 'abc1234'));
  const after = readRec(dir);
  assert.equal(after.state, acked.state);
  assert.equal(after.signal_revision, acked.signal_revision);
  assert.equal(after.orchestrator_ack, acked.orchestrator_ack);
  assert.deepEqual(after.history, acked.history);
  const w = run(b, ['wait', '--run', id, '--timeout', '1']);
  assert.equal(w.code, 124, `${w.out}${w.err}`);
  assert.ok(!/^RUN /m.test(w.out), w.out);
});

test('C5i ten concurrent appends lose nothing and leave no lock or tmp file', async () => {
  const { id, dir } = mkRun(b);
  const rs = await Promise.all([...Array(10).keys()].map((i) => runAsync(b, ['escape', id, '--kind', 'revert', '--ref', `abcdef${i}`])));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const refs = readRec(dir).escapes.map((e) => e.ref);
  assert.equal(refs.length, 10);
  assert.equal(new Set(refs).size, 10);
  assert.deepEqual(debris(dir), []);
});

test('C5j C5k show prints one line per escape and strips control characters from note and ref', () => {
  const { id } = mkRun(b);
  ok(esc(id, 'revert', 'abc1234', ['--note', 'n']));
  ok(esc(id, 'fix-forward', URL1, ['--note', 'a\u001b[31mb\u0007c\nsecond']));
  const text = run(b, ['show', id]).out;
  assert.match(text, /revert.*abc1234.*n$/m);
  assert.match(text, /fix-forward.*pull\/1.*a\[31mbc/m);
  assert.ok(!text.includes('\u001b'), 'no ESC byte reaches the terminal');
  assert.ok(!text.includes('\u0007'));
  const lines = text.split('\n').filter((l) => /^\s+(revert|fix-forward) /.test(l));
  assert.equal(lines.length, 2);
});

test('C5l C5m a record without escapes reads as empty: show, show --json and list work and nothing is rewritten', () => {
  const { id, dir } = mkRun(b);
  const before = sha(recPath(dir));
  assert.ok(!('escapes' in readRec(dir)));
  for (const args of [['show', id], ['show', id, '--json'], ['list']]) {
    const r = run(b, args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.equal(r.err, '');
  }
  assert.equal(sha(recPath(dir)), before);
  const j = JSON.parse(run(b, ['show', id, '--json']).out);
  assert.ok(!('escapes' in j) || (Array.isArray(j.escapes) && j.escapes.length === 0));
  assert.ok(!/escape/i.test(run(b, ['show', id]).out), 'text show prints nothing about escapes when there are none');
});

test('C19 a malformed escapes value warns in one line, prints the record and exits 0; list still works', () => {
  for (const bad of ['x', [null], [{ kind: 'revert' }], { a: 1 }]) {
    const { id, dir } = mkRun(b);
    const good = mkRun(b);
    writeRec(dir, { escapes: bad });
    const r = run(b, ['show', id]);
    assert.equal(r.code, 0, r.err);
    assert.ok(!/TypeError/.test(r.err), r.err);
    assert.match(r.err, /warning: .*escapes.*malformed/);
    assert.equal(r.err.trim().split('\n').length, 1);
    assert.ok(r.out.includes(`run: ${id}`));
    const j = run(b, ['show', id, '--json']);
    assert.equal(j.code, 0, j.err);
    assert.equal(JSON.parse(j.out).id, id);
    const l = run(b, ['list']);
    assert.equal(l.code, 0, l.err);
    assert.ok(l.out.includes(good.id));
  }
});

test('C19 escape refuses to append to a malformed escapes value and leaves the file untouched', () => {
  const { id, dir } = mkRun(b);
  writeRec(dir, { escapes: 'x' });
  const before = sha(recPath(dir));
  const r = esc(id, 'revert', 'abc1234');
  assert.equal(r.code, 1);
  assert.match(r.err, /escapes/);
  assert.equal(sha(recPath(dir)), before);
});

test('C20 a (kind, ref) pair already recorded is a no-op that says so', () => {
  const { id, dir } = mkRun(b);
  ok(esc(id, 'revert', 'abc1234', ['--note', 'first']));
  const before = sha(recPath(dir));
  const r = esc(id, 'revert', 'abc1234', ['--note', 'second']);
  ok(r);
  assert.match(r.out, /already recorded/);
  assert.equal(sha(recPath(dir)), before);
  assert.equal(readRec(dir).escapes.length, 1);
  // same ref under another kind is a different escape
  ok(esc(id, 'fix-forward', 'abc1234'));
  assert.equal(readRec(dir).escapes.length, 2);
});

test('C27 --ref takes 7-64 hex characters or an http(s) URL; anything else exits 2 and writes nothing', () => {
  const { id, dir } = mkRun(b);
  const before = sha(recPath(dir));
  for (const ref of ['abc123', 'a'.repeat(65), 'xyz1234', 'abc 1234', 'ftp://h/x', 'https://', 'HEAD', '--kind']) {
    assert.equal(esc(id, 'revert', ref).code, 2, ref);
  }
  assert.equal(sha(recPath(dir)), before);
  for (const ref of ['abc1234', 'a'.repeat(64), 'ABCDEF1', 'http://h/x', URL1]) ok(esc(id, 'review-defect', ref), ref);
  assert.equal(readRec(dir).escapes.length, 5);
});

test('C27 --note-file reads the note from a file; both note options together exit 2', () => {
  const { id, dir } = mkRun(b);
  const f = join(b.root, 'note.txt');
  writeFileSync(f, 'from a file\n');
  ok(esc(id, 'revert', 'abc1234', ['--note-file', f]));
  assert.equal(readRec(dir).escapes[0].note, 'from a file');
  assert.equal(esc(id, 'revert', 'abc1235', ['--note-file', join(b.root, 'missing')]).code, 2);
  assert.equal(esc(id, 'revert', 'abc1236', ['--note', 'a', '--note-file', f]).code, 2);
  assert.equal(readRec(dir).escapes.length, 1);
});

test('C5o usage lists escape and a wrong positional count exits 2', () => {
  const r = run(b, []);
  assert.match(r.err, /escape/);
  assert.equal(run(b, ['escape', '--kind', 'revert', '--ref', 'abc1234']).code, 2);
});
