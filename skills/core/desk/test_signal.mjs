// test_signal.mjs — run signal: signal_revision, wait, ack, nudges, claim/release
// (spec v2 sections 1 and 3; criteria A17-A28).
import assert from 'node:assert';
import test from 'node:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HERE, QOPTS, ask, barePath, calls, claim, mkRun, newBox, nudges, orchestratorRun, rawLog, readRec, recPath, resetLog, run,
  runAsync, sha, sleep, spawnChild, writeRec,
} from './testkit.mjs';

const b = newBox();
const ok = (r, m) => assert.equal(r.code, 0, `${m ?? ''} exit ${r.code}: ${r.err}`);

test('signal_revision moves only on a move into a signal state or on ask', () => {
  const { dir, id } = mkRun(b);
  const sig = () => readRec(dir).signal_revision;
  assert.equal(sig(), 0);
  run(b, ['set', id, '--state', 'blocked', '--summary', 's']);
  const atBlock = sig();
  assert.equal(atBlock, readRec(dir).revision);
  run(b, ['set', id, '--note', 'still blocked']);
  run(b, ['set', id, '--state', 'blocked']);
  run(b, ['ack', id]);
  assert.equal(sig(), atBlock, 'note, same-state set and ack do not signal');
  run(b, ['set', id, '--state', 'running']);
  assert.equal(sig(), atBlock, 'running is not a signal state');
  ask(b, id);
  const atAsk = sig();
  assert.ok(atAsk > atBlock);
  ask(b, id, 'second question');
  assert.ok(sig() > atAsk, 'a second ask signals again');
  for (const s of ['failed']) {
    run(b, ['set', id, '--state', s]);
    assert.equal(sig(), readRec(dir).revision);
  }
});

test('wait prints exactly one RUN line per firing run with no question or summary text, and exits 0', () => {
  const wb = newBox();
  const { dir, id } = mkRun(wb);
  run(wb, ['set', id, '--summary', 'SUMMARY_MARKER_1']);
  run(wb, ['ask', id, '--question', 'QUESTION_MARKER_2', '--options', QOPTS, '--recommendation', 'A', '--context', 'CTX_MARKER_3']);
  const d = mkRun(wb, { slug: 'second' });
  run(wb, ['set', d.id, '--state', 'done', '--summary', 'SUMMARY_MARKER_4', '--delivery', 'x']);
  const r = run(wb, ['wait', '--timeout', '5']);
  ok(r);
  const lines = r.out.trim().split('\n').sort();
  assert.deepEqual(lines, [`RUN ${d.id} done r${readRec(d.dir).signal_revision}`, `RUN ${id} needs-me r${readRec(dir).signal_revision} Q1`].sort());
  assert.ok(!/MARKER/.test(r.out));
});

test('ack --revision n silences that signal, and a later ask fires again', () => {
  const { dir, id } = mkRun(b);
  ask(b, id);
  const w = run(b, ['wait', '--run', id, '--timeout', '3']);
  ok(w);
  const n = w.out.match(/ r(\d+)/)[1];
  ok(run(b, ['ack', id, '--revision', n]));
  assert.equal(run(b, ['wait', '--run', id, '--timeout', '1']).code, 124);
  ask(b, id, 'again');
  const again = run(b, ['wait', '--run', id, '--timeout', '3']);
  ok(again);
  assert.match(again.out, /Q1|Q2/);
  assert.ok(readRec(dir).signal_revision > Number(n));
});

test('ack --revision above signal_revision exits 2; bare ack acks the current one; an older ack leaves the newer signal firing', () => {
  const { dir, id } = mkRun(b);
  ask(b, id);
  const sr = readRec(dir).signal_revision;
  const before = sha(recPath(dir));
  const bad = run(b, ['ack', id, '--revision', String(sr + 1)]);
  assert.equal(bad.code, 2);
  assert.equal(sha(recPath(dir)), before);
  ok(run(b, ['ack', id, '--revision', String(sr - 1)]));
  assert.equal(readRec(dir).orchestrator_ack, sr - 1);
  assert.equal(run(b, ['wait', '--run', id, '--timeout', '3']).code, 0, 'older ack leaves the newer signal firing');
  ok(run(b, ['ack', id]));
  assert.equal(readRec(dir).orchestrator_ack, sr);
  assert.equal(readRec(dir).signal_revision, sr, 'ack never changes signal_revision');
  ok(run(b, ['ack', id, '--revision', '1']));
  assert.equal(readRec(dir).orchestrator_ack, sr, 'an ack never moves backwards');
});

test('ack --all acks every valid run; --before acks only runs updated before the cutoff; invalid files are skipped with a warning', () => {
  const ab = newBox();
  const mk = (slug, updated) => {
    const r = mkRun(ab, { slug });
    run(ab, ['set', r.id, '--state', 'done', '--delivery', 'd']);
    writeRec(r.dir, { updated_at: updated });
    return r;
  };
  const [o1, o2, n1] = [mk('o1', '2026-01-01T00:00:00.000Z'), mk('o2', '2026-03-01T00:00:00.000Z'), mk('n1', '2026-06-01T00:00:00.000Z')];
  const bad = join(ab.runs, '2026-01-01-bad-aaaa');
  run(ab, ['init', '--goal', 'g', '--run-dir', bad]);
  writeFileSync(recPath(bad), '{nope');
  const acked = (r) => readRec(r.dir).orchestrator_ack === readRec(r.dir).signal_revision;
  const part = run(ab, ['ack', '--all', '--before', '2026-04-01T00:00:00.000Z']);
  ok(part);
  assert.deepEqual([acked(o1), acked(o2), acked(n1)], [true, true, false]);
  assert.ok(part.err.includes(recPath(bad)), 'warns about the invalid file');
  const all = run(ab, ['ack', '--all']);
  ok(all);
  assert.equal(acked(n1), true);
  assert.equal(readFileSync(recPath(bad), 'utf8'), '{nope');
});

test('wait with no --run fires at start for a done run with an unacknowledged signal', () => {
  const wb = newBox();
  const { id } = mkRun(wb);
  run(wb, ['set', id, '--state', 'done', '--delivery', 'd']);
  const r = run(wb, ['wait', '--timeout', '3']);
  ok(r);
  assert.match(r.out, new RegExp(`^RUN ${id} done r\\d+$`, 'm'));
});

test('wait fires within 5 s for a run created and asked after it started', async () => {
  const wb = newBox();
  const w = spawnChild(wb, ['wait', '--timeout', '30']);
  await sleep(700);
  const { id } = mkRun(wb);
  const t0 = Date.now();
  ask(wb, id);
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^RUN ${id} needs-me r\\d+ Q1$`, 'm'));
  assert.ok(Date.now() - t0 < 5000, `fired ${Date.now() - t0} ms after the write`);
});

test('wait --run a ignores a signal on run b; wait --timeout 1 on running runs exits 124', async () => {
  const wb = newBox();
  const a = mkRun(wb, { slug: 'a' });
  const c = mkRun(wb, { slug: 'c' });
  const quiet = await runAsync(wb, ['wait', '--timeout', '1']);
  assert.equal(quiet.code, 124);
  assert.ok(quiet.ms < 4000);
  ask(wb, c.id);
  const w = await runAsync(wb, ['wait', '--run', a.id, '--timeout', '2']);
  assert.equal(w.code, 124);
  assert.equal(w.out, '');
});

test('wait without --timeout is still waiting after 2 s (default 3600 s)', async () => {
  const wb = newBox();
  mkRun(wb);
  const w = spawnChild(wb, ['wait']);
  await sleep(2000);
  w.kill();
  const r = await w.done;
  assert.equal(r.sig, 'SIGKILL');
  assert.match(readFileSync(join(HERE, 'runs.mjs'), 'utf8'), /3600/);
});

test('a second signal after an atomic rename is caught: fire, ack, wait again, ask again', async () => {
  const wb = newBox();
  const { id } = mkRun(wb);
  ask(wb, id, 'one');
  const first = run(wb, ['wait', '--run', id, '--timeout', '3']);
  ok(first);
  ok(run(wb, ['ack', id, '--revision', first.out.match(/ r(\d+)/)[1]]));
  const w = spawnChild(wb, ['wait', '--run', id, '--timeout', '20']);
  await sleep(800);
  const t0 = Date.now();
  run(wb, ['answer', id, 'Q1', '--answer', 'A', '--by', 'user', '--no-nudge']);
  ask(wb, id, 'two');
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  assert.match(r.out, /Q2/);
});

test('C18 a wait armed on a settled run fires when the run is reopened and finishes again', async () => {
  const wb = newBox();
  const { id } = mkRun(wb);
  ok(run(wb, ['set', id, '--state', 'done', '--delivery', 'first']));
  ok(run(wb, ['ack', id]));
  const w = spawnChild(wb, ['wait', '--run', id, '--timeout', '20']);
  await sleep(1500);
  ok(run(wb, ['reopen', id]));
  await sleep(1500);
  ok(run(wb, ['set', id, '--state', 'done', '--delivery', 'second']));
  const t0 = Date.now();
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^RUN ${id} done r\\d+\\n$`));
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

test('wait survives a watched run dir deleted mid-wait and still fires for another run', async () => {
  const wb = newBox();
  const gone = mkRun(wb, { slug: 'gone' });
  const live = mkRun(wb, { slug: 'live' });
  const w = spawnChild(wb, ['wait', '--timeout', '20']);
  await sleep(800);
  rmSync(gone.dir, { recursive: true });
  await sleep(500);
  ask(wb, live.id);
  const r = await w.done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`RUN ${live.id} needs-me`));
  assert.ok(!/ {4}at /.test(r.err), r.err);
});

// ---- nudges ------------------------------------------------------------------

const GRAMMAR = (id) => new RegExp(`^bork run ${id}: (needs-me Q\\d+|blocked|done|failed|answered Q\\d+)$`);

test('run.json is written before the nudge is sent', () => {
  const nb = newBox();
  ok(claim(nb));
  const { dir, id } = orchestratorRun(nb);
  const snapEnv = { HERDR_STUB_SNAP_SRC: recPath(dir) };
  ok(run(nb, ['ask', id, '--question', 'q', '--options', QOPTS, '--recommendation', 'A'], snapEnv));
  const snap = JSON.parse(readFileSync(nb.log + '.snap', 'utf8'));
  assert.equal(snap.state, 'needs-me');
  assert.equal(snap.signal_revision, readRec(dir).signal_revision);
  run(nb, ['set', id, '--state', 'failed', '--summary', 's'], snapEnv);
  assert.equal(JSON.parse(readFileSync(nb.log + '.snap', 'utf8')).state, 'failed');
});

test('a signal on an orchestrator run nudges the claimed pane with agent prompt and no --wait; nothing uses pane run', () => {
  const nb = newBox();
  ok(claim(nb, 'tw:p9'));
  for (const [state, line] of [['blocked', 'blocked'], ['done', 'done'], ['failed', 'failed']]) {
    const { id } = orchestratorRun(nb, { slug: state });
    resetLog(nb);
    ok(run(nb, ['set', id, '--state', state, '--summary', 's', '--delivery', 'd']));
    assert.deepEqual(calls(nb), [['agent', 'prompt', 'tw:p9', `bork run ${id}: ${line}`]]);
  }
  const { id } = orchestratorRun(nb, { slug: 'q' });
  resetLog(nb);
  ask(nb, id);
  assert.deepEqual(calls(nb), [['agent', 'prompt', 'tw:p9', `bork run ${id}: needs-me Q1`]]);
  assert.ok(calls(nb).every((c) => c[1] !== 'run' && !c.includes('--wait')));
  resetLog(nb);
  ask(nb, id, 'second');
  assert.equal(nudges(nb)[0][3], `bork run ${id}: needs-me Q2`);
  resetLog(nb);
  run(nb, ['set', id, '--note', 'only a note']);
  run(nb, ['ack', id]);
  assert.deepEqual(calls(nb), [], 'no new signal, no nudge');
});

test('a signal on a self-launched run makes no herdr call even with a claimed pane', () => {
  const nb = newBox();
  ok(claim(nb));
  const { id } = mkRun(nb);
  resetLog(nb);
  ask(nb, id);
  run(nb, ['set', id, '--state', 'blocked', '--summary', 's']);
  assert.deepEqual(calls(nb), []);
});

test('answer nudges architect.pane; --no-nudge and a null pane make no call', () => {
  const nb = newBox();
  const rows = [['w9:p7', [], 1], ['w9:p7', ['--no-nudge'], 0], [null, [], 0]];
  for (const [pane, extra, n] of rows) {
    const { dir, id } = mkRun(nb);
    ask(nb, id);
    writeRec(dir, { architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: 't', pane } });
    resetLog(nb);
    ok(run(nb, ['answer', id, 'Q1', '--answer', 'A', '--by', 'user', ...extra]));
    assert.equal(nudges(nb).length, n, `${pane} ${extra}`);
    if (n) assert.deepEqual(nudges(nb)[0], ['agent', 'prompt', 'w9:p7', `bork run ${id}: answered Q1`]);
  }
});

test('every nudge is one short line from the fixed grammar with no control characters or slash', () => {
  const nb = newBox();
  ok(claim(nb));
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const { dir, id } = orchestratorRun(nb, { slug: `g${i}` });
    writeRec(dir, { architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: 't', pane: 'w9:p7' } });
    ask(nb, id);
    run(nb, ['answer', id, 'Q1', '--answer', 'A', '--by', 'user']);
    run(nb, ['set', id, '--state', ['done', 'failed', 'blocked'][i], '--summary', 's', '--delivery', 'd']);
    seen.push(id);
  }
  const all = nudges(nb);
  assert.ok(all.length >= 9);
  for (const call of all) {
    const line = call[3];
    const id = line.match(/^bork run (\S+):/)[1];
    assert.ok(seen.includes(id));
    assert.match(line, GRAMMAR(id));
    assert.ok(line.length <= 300);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f/]/.test(line));
  }
});

test('text planted in summary, note, question, context, options, answer and goal never reaches herdr', () => {
  const nb = newBox();
  ok(claim(nb));
  const goal = 'ZZ_GOAL_ZZ plant';
  const r = run(nb, ['init', '--goal', goal, '--slug', 'plant']);
  const dir = r.out.split('\n')[0];
  const id = dir.split('/').pop();
  writeRec(dir, { launched_by: 'orchestrator', architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: 't', pane: 'w9:p7' } });
  const opts = JSON.stringify([{ label: 'ZZ_LA_ZZ', description: 'ZZ_DA_ZZ' }, { label: 'ZZ_LB_ZZ', description: 'ZZ_DB_ZZ' }]);
  run(nb, ['set', id, '--state', 'blocked', '--summary', 'ZZ_SUM_ZZ', '--note', 'ZZ_NOTE_ZZ']);
  run(nb, ['ask', id, '--question', 'ZZ_Q_ZZ', '--options', opts, '--recommendation', 'ZZ_LA_ZZ', '--context', 'ZZ_CTX_ZZ']);
  run(nb, ['answer', id, 'Q1', '--answer', 'ZZ_ANS_ZZ', '--by', 'user']);
  run(nb, ['set', id, '--state', 'running']);
  run(nb, ['set', id, '--state', 'done', '--summary', 'ZZ_SUM2_ZZ', '--delivery', 'ZZ_DEL_ZZ']);
  assert.ok(nudges(nb).length >= 3);
  assert.ok(!/ZZ_/.test(rawLog(nb)), rawLog(nb));
});

test('a failed send (non-zero exit, error body, agent_blocked) warns once, exits 0 and keeps the record', () => {
  for (const mode of ['prompt-fail', 'prompt-error', 'prompt-blocked']) {
    const nb = newBox();
    ok(claim(nb));
    const { dir, id } = orchestratorRun(nb);
    const r = run(nb, ['set', id, '--state', 'blocked', '--summary', 's'], { HERDR_STUB_MODE: mode });
    ok(r, mode);
    assert.equal(r.err.split('\n').filter((l) => /warn/i.test(l)).length, 1, `${mode}: ${r.err}`);
    assert.equal(readRec(dir).state, 'blocked');
  }
});

test('with herdr absent, no claim, or a null pane, set/ask/answer succeed and send nothing', () => {
  const nb = newBox();
  const { dir, id } = orchestratorRun(nb);
  // no orchestrator.json
  resetLog(nb);
  ok(ask(nb, id));
  assert.deepEqual(calls(nb), []);
  // pane: null
  ok(run(nb, ['claim'], { HERDR_PANE_ID: undefined }));
  assert.equal(JSON.parse(readFileSync(join(nb.orch, 'orchestrator.json'), 'utf8')).pane, null);
  ok(run(nb, ['answer', id, 'Q1', '--answer', 'A', '--by', 'user']));
  ok(run(nb, ['set', id, '--state', 'blocked', '--summary', 's']));
  assert.deepEqual(calls(nb), []);
  // herdr absent from PATH with a claimed pane
  ok(claim(nb));
  const bare = { PATH: barePath() };
  ok(run(nb, ['set', id, '--state', 'running'], bare));
  ok(run(nb, ['ask', id, '--question', 'q', '--options', QOPTS, '--recommendation', 'A'], bare));
  ok(run(nb, ['answer', id, 'Q2', '--answer', 'A', '--by', 'user'], bare));
  assert.deepEqual(calls(nb), []);
  assert.ok(readRec(dir).revision > 5);
});

test('herdr is run without a shell: a pane id of $(touch PWNED) creates no file', () => {
  const nb = newBox();
  ok(run(nb, ['claim', '--pane', '$(touch PWNED)']));
  const { id } = orchestratorRun(nb);
  ok(run(nb, ['set', id, '--state', 'blocked', '--summary', 's']));
  assert.ok(!existsSync(join(nb.root, 'PWNED')));
  assert.deepEqual(nudges(nb)[0].slice(0, 3), ['agent', 'prompt', '$(touch PWNED)']);
});

// ---- claim / release ---------------------------------------------------------

test('claim writes pane, claimed_at and harness, defaults to HERDR_PANE_ID, and prints the previous claimant', () => {
  const cb = newBox();
  const first = run(cb, ['claim'], { HERDR_PANE_ID: 'w1:p1' });
  ok(first);
  const j = JSON.parse(readFileSync(join(cb.orch, 'orchestrator.json'), 'utf8'));
  assert.equal(j.pane, 'w1:p1');
  assert.ok(Date.parse(j.claimed_at));
  assert.ok('harness' in j);
  const second = run(cb, ['claim', '--pane', 'w2:p2']);
  ok(second);
  assert.ok(second.out.includes('w1:p1'), second.out);
  assert.equal(JSON.parse(readFileSync(join(cb.orch, 'orchestrator.json'), 'utf8')).pane, 'w2:p2');
});

test('claim outside herdr records pane null; release removes the file and is idempotent', () => {
  const cb = newBox();
  ok(run(cb, ['claim'], { HERDR_PANE_ID: undefined }));
  assert.equal(JSON.parse(readFileSync(join(cb.orch, 'orchestrator.json'), 'utf8')).pane, null);
  ok(run(cb, ['release']));
  assert.ok(!existsSync(join(cb.orch, 'orchestrator.json')));
  ok(run(cb, ['release']));
});
