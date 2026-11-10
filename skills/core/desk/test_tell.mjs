// test_tell.mjs — runs.mjs tell and reopen: usage, preflight refusals, the locked write, delivery, reopen
// (slice 1 of the desk-tell run; criteria C1-C10, C14-C15). The stub herdr speaks the 0.9.3 shapes (testkit.mjs).
import assert from 'node:assert';
import test from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  QOPTS, RUNS, ask, barePath, calls, claim, debris, mkRun, newBox, nudges, rawLog, readRec, recPath, resetLog, run, sha, writeRec,
} from './testkit.mjs';

const b = newBox();
const PANE = 'w9:p7';
const TAB = 'w9:t7';
const LIVE = { HERDR_STUB_AGENTS: PANE };
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const ok = (r, m) => assert.equal(r.code, 0, `${m ?? ''} exit ${r.code}: ${r.err}`);

// A run whose architect has a herdr pane; `patch` overrides record fields.
function mk(patch = {}, box = b) {
  const r = mkRun(box);
  writeRec(r.dir, { architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: TAB, pane: PANE }, ...patch });
  return r;
}
const finish = (id, state = 'done') => ok(run(b, ['set', id, '--state', state, '--summary', 'sum', '--delivery', 'shipped as PR 7']));
const tell = (id, msg = 'more work', extra = LIVE, more = []) => run(b, ['tell', id, '--message', msg, ...more], extra);

// Exit 1, the stable token, the run id, nothing written, no lock or tmp left and no nudge.
function refusedWith(r, dir, id, token, ...mentions) {
  assert.equal(r.code, 1, `${token}: exit ${r.code} ${r.err}`);
  assert.ok(r.err.includes(`runs: tell refused (${token}): `), r.err);
  for (const m of [id, ...mentions]) assert.ok(r.err.includes(m), `${token} names ${m}: ${r.err}`);
  assert.equal(r.out, '');
  assert.deepEqual(debris(dir), []);
  assert.deepEqual(nudges(b), []);
}

// ---- usage --------------------------------------------------------------------------------------------------

test('C1a-c tell usage errors exit 2 with the tell usage line and write nothing', () => {
  const { dir, id } = mk();
  const before = sha(recPath(dir));
  const f = join(b.root, 'm.txt');
  writeFileSync(f, 'x');
  for (const args of [['tell', id], ['tell', id, '--message', ''], ['tell', id, '--message', ' \n\t '], ['tell', id, '--message', 'a', '--message-file', f],
    ['tell', id, '--message-file', join(b.root, 'no-such-file')]]) {
    const r = run(b, args, LIVE);
    assert.equal(r.code, 2, `${args.slice(2).join(' ')}: ${r.err}`);
    assert.match(r.err, /usage: runs\.mjs tell/);
    assert.equal(r.out, '');
  }
  assert.equal(sha(recPath(dir)), before);
  assert.deepEqual(calls(b), []);
});

test('C1d the 64 KiB cap is bytes: 65536 is accepted, 65537 is not, for --message and --message-file', () => {
  const cases = [['a'.repeat(65536), true], ['a'.repeat(65537), false], ['€'.repeat(21845), true], ['€'.repeat(21846), false]];
  for (const [text, accepted] of cases) {
    for (const via of ['message', 'message-file']) {
      const { dir, id } = mk();
      const args = ['tell', id];
      if (via === 'message') args.push('--message', text);
      else { const f = join(b.root, 'big.txt'); writeFileSync(f, text); args.push('--message-file', f); }
      const before = sha(recPath(dir));
      const r = run(b, args, LIVE);
      if (accepted) { ok(r, `${via} ${text.length} chars`); assert.equal(readRec(dir).messages[0].text, text); } else {
        assert.equal(r.code, 2, `${via} ${text.length} chars: ${r.err}`);
        assert.equal(sha(recPath(dir)), before);
      }
    }
  }
});

test('C1e --message-file stores the file text byte for byte', () => {
  const { dir, id } = mk();
  const text = '  two lines\n\n  with “quotes”, a tab\t and no final newline';
  const f = join(b.root, 'm2.txt');
  writeFileSync(f, text);
  ok(run(b, ['tell', id, '--message-file', f], LIVE));
  assert.equal(readRec(dir).messages[0].text, text);
});

// ---- preflight refusals --------------------------------------------------------------------------------------

test('C2a-c failed, open-question and predates refusals', () => {
  const failed = mk();
  ok(run(b, ['set', failed.id, '--state', 'failed', '--summary', 'x']));
  resetLog(b);
  let before = sha(recPath(failed.dir));
  let r = tell(failed.id);
  refusedWith(r, failed.dir, failed.id, 'run_failed', failed.dir);
  assert.match(r.err, /start a new run/);
  assert.equal(sha(recPath(failed.dir)), before);
  assert.deepEqual(calls(b), []);

  const needs = mk();
  ask(b, needs.id);
  const blockedAsk = mk();
  ask(b, blockedAsk.id);
  ok(run(b, ['set', blockedAsk.id, '--state', 'blocked']));
  assert.equal(readRec(blockedAsk.dir).state, 'blocked', 'the C2b row: blocked, with Q1 still open');
  assert.equal(readRec(blockedAsk.dir).questions[0].status, 'open');
  for (const x of [needs, blockedAsk]) {
    before = sha(recPath(x.dir));
    r = tell(x.id);
    refusedWith(r, x.dir, x.id, 'question_open', 'Q1');
    assert.equal(sha(recPath(x.dir)), before);
  }

  const old = mk();
  const rec = readRec(old.dir);
  delete rec.messages;
  writeFileSync(recPath(old.dir), JSON.stringify(rec));
  before = sha(recPath(old.dir));
  r = tell(old.id);
  refusedWith(r, old.dir, old.id, 'predates_tell', TAB);
  assert.match(r.err, /continue in the run's tab/);
  assert.equal(sha(recPath(old.dir)), before);
});

test('C2d no_pane makes no herdr call; a pane that cannot be a herdr id counts as no pane', () => {
  for (const pane of [null, '-flag', 'w1 p2']) {
    const { dir, id } = mk({ architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: TAB, pane } });
    resetLog(b);
    refusedWith(tell(id), dir, id, 'no_pane');
    assert.deepEqual(calls(b), []);
  }
});

test('C2e herdr_unreachable: not on PATH, a non-agent_not_found error, a hang, a spawn error, an unusable answer', { timeout: 60000 }, () => {
  const rows = [
    ['not on PATH', { PATH: barePath() }],
    ['exit 1 with another error code', { ...LIVE, HERDR_STUB_AGENT_MODE: 'fail' }],
    ['a hang', { ...LIVE, HERDR_STUB_AGENT_MODE: 'hang' }],
    ['exit 0 and not JSON', { ...LIVE, HERDR_STUB_AGENT_MODE: 'malformed' }],
    ['a spawn error', { PATH: `${join(b.root, 'dirbin')}:${barePath()}` }],
  ];
  mkdirSync(join(b.root, 'dirbin', 'herdr'), { recursive: true });
  for (const [label, extra] of rows) {
    const { dir, id } = mk();
    const before = sha(recPath(dir));
    refusedWith(tell(id, 'm', extra), dir, id, 'herdr_unreachable', TAB);
    assert.equal(sha(recPath(dir)), before, label);
  }
});

test('C2f agent_not_found on stderr with empty stdout (the real 0.9.3 shape) is agent_gone, and only that', () => {
  const { dir, id } = mk();
  const before = sha(recPath(dir));
  const r = tell(id, 'm', { HERDR_STUB_AGENTS: undefined });
  refusedWith(r, dir, id, 'agent_gone', PANE);
  assert.match(r.err, /start a new run with this work, or set the run failed/);
  assert.equal(sha(recPath(dir)), before);
});

test('C2i a blocked agent refuses agent_blocked and names the tab', () => {
  const { dir, id } = mk();
  const r = tell(id, 'm', { ...LIVE, HERDR_STUB_STATUS: JSON.stringify({ [PANE]: 'blocked' }) });
  refusedWith(r, dir, id, 'agent_blocked', TAB);
  assert.match(r.err, /answer the dialog in tab w9:t7/);
});

test('C2j several conditions at once: the first token in table order wins', () => {
  const a = mk({ architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: TAB, pane: null } });
  const rec = readRec(a.dir);
  delete rec.messages;
  rec.state = 'failed';
  writeFileSync(recPath(a.dir), JSON.stringify(rec));
  refusedWith(tell(a.id), a.dir, a.id, 'run_failed');

  const c = mk({ architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: TAB, pane: null } });
  ask(b, c.id);
  refusedWith(tell(c.id), c.dir, c.id, 'question_open');

  const d = mk({ architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: TAB, pane: null } });
  const drec = readRec(d.dir);
  delete drec.messages;
  writeFileSync(recPath(d.dir), JSON.stringify(drec));
  refusedWith(tell(d.id), d.dir, d.id, 'predates_tell');

  const e = mk();
  refusedWith(tell(e.id, 'm', { HERDR_STUB_AGENTS: undefined, HERDR_STUB_STATUS: JSON.stringify({ [PANE]: 'blocked' }) }), e.dir, e.id, 'agent_gone');
});

// ---- the locked write -------------------------------------------------------------------------------------------

test('C3 the in-lock re-check refuses what changed after the preflight', () => {
  for (const [hook, token] of [[(id) => ['ask', id, '--question', 'q', '--options', QOPTS, '--recommendation', 'A'], 'question_open'], [(id) => ['set', id, '--state', 'failed'], 'run_failed']]) {
    const { dir, id } = mk();
    rmSync(`${b.log}.hook`, { force: true });
    const r = tell(id, 'm', { ...LIVE, HERDR_STUB_HOOK: JSON.stringify([hook(id)]), HERDR_STUB_RUNS: RUNS });
    refusedWith(r, dir, id, token);
    assert.deepEqual(readRec(dir).messages, []);
    assert.deepEqual(debris(dir), []);
  }
});

test('C4 no herdr call runs while the run lock is held', () => {
  const { dir, id } = mk();
  const lockLog = join(b.root, 'lock.log');
  rmSync(lockLog, { force: true });
  finish(id);
  resetLog(b);
  ok(tell(id, 'm', { ...LIVE, HERDR_STUB_LOCK_LOG: lockLog, HERDR_STUB_LOCK_DIR: dir }));
  const seen = readFileSync(lockLog, 'utf8').trim().split('\n');
  assert.deepEqual(seen, ['agent get false', 'agent prompt false'], 'the preflight and the nudge each ran with no lock held');
  assert.equal(nudges(b).length, 1);
});

test('C5a/b done and blocked reopen with the message recorded, the old delivery kept in the note', () => {
  for (const state of ['done', 'blocked']) {
    const { dir, id } = mk();
    finish(id, state);
    const sigBefore = readRec(dir).signal_revision;
    ok(tell(id, 'one more thing'));
    const rec = readRec(dir);
    assert.deepEqual(rec.messages.map(({ at, ...m }) => m), [{ id: 'M1', text: 'one more thing', by: 'user' }]);
    assert.match(rec.messages[0].at, ISO);
    assert.equal(rec.state, 'running');
    const last = rec.history.at(-1);
    assert.equal(last.state, 'running');
    assert.ok(last.note.startsWith('reopened by M1'), last.note);
    assert.ok(last.note.includes('shipped as PR 7'), last.note);
    assert.equal(rec.summary, 'reopened by M1');
    assert.equal(rec.delivery, null);
    assert.equal(rec.signal_revision, sigBefore, 'running is not a signal state');
  }
});

test('C5a a reopen with no old delivery has a plain note', () => {
  const { dir, id } = mk();
  ok(run(b, ['set', id, '--state', 'blocked', '--summary', 'stuck']));
  ok(tell(id));
  assert.equal(readRec(dir).history.at(-1).note, 'reopened by M1');
});

test('C5c a running run keeps its state, summary and delivery; one history note names the message', () => {
  const { dir, id } = mk();
  run(b, ['set', id, '--summary', 'working on it']);
  const before = readRec(dir);
  ok(tell(id));
  const rec = readRec(dir);
  assert.equal(rec.state, 'running');
  assert.equal(rec.summary, 'working on it');
  assert.equal(rec.delivery, before.delivery);
  assert.equal(rec.history.length, before.history.length + 1);
  assert.deepEqual(rec.history.at(-1), { at: rec.history.at(-1).at, state: 'running', note: 'message M1' });
});

test('C5d a reopen does not signal and does not nudge the orchestrator pane', () => {
  const { dir, id } = mk({ launched_by: 'orchestrator' });
  ok(claim(b, 'tw:p9'));
  finish(id);
  resetLog(b);
  const sig = readRec(dir).signal_revision;
  ok(tell(id));
  assert.equal(readRec(dir).signal_revision, sig);
  assert.deepEqual(nudges(b).map((n) => n[2]), [PANE], 'only the architect pane is nudged');
});

test('C5e two tells make M1 then M2; the second pane line names M2 and show lists both in order', () => {
  const { id } = mk();
  ok(tell(id, 'first words'));
  ok(tell(id, 'second words'));
  const lines = nudges(b).slice(-2).map((n) => n[3]);
  assert.match(lines[0], /new instruction M1 /);
  assert.match(lines[1], /new instruction M2 /);
  const s = run(b, ['show', id], LIVE).out;
  assert.match(s, /messages:\n  M1 \([^)]+\): first words\n  M2 \([^)]+\): second words/);
});

// ---- delivery -----------------------------------------------------------------------------------------------------

test('C6 the pane line is the fixed sentence; stdout is "M<n> sent"', () => {
  const { id } = mk();
  resetLog(b);
  const r = tell(id);
  ok(r);
  assert.equal(r.out, 'M1 sent\n');
  assert.deepEqual(nudges(b), [['agent', 'prompt', PANE, `bork run ${id}: new instruction M1 from the user; read it with runs.mjs show ${id}`]]);
});

test('C7 the message text never reaches herdr', () => {
  const marker = 'ZZ-SECRET-7f3';
  const text = `-${marker}\n\u001b[31m ${marker}`;
  for (const via of ['message', 'message-file']) {
    const { id } = mk();
    resetLog(b);
    const args = ['tell', id];
    if (via === 'message') args.push('--message', text);
    else { const f = join(b.root, 'secret.txt'); writeFileSync(f, text); args.push('--message-file', f); }
    ok(run(b, args, LIVE));
    assert.ok(!rawLog(b).includes(marker), `${via}: ${rawLog(b)}`);
    assert.ok(rawLog(b).includes('agent'));
  }
});

test('C8 a nudge failure after the write: recorded, not delivered, exit 3, the reopen stays', () => {
  for (const mode of ['prompt-live-blocked', 'prompt-live-notfound', 'prompt-blocked']) {
    const { dir, id } = mk();
    finish(id);
    const r = tell(id, 'm', { ...LIVE, HERDR_STUB_MODE: mode });
    assert.equal(r.code, 3, `${mode}: ${r.err}`);
    assert.match(r.out, /^M1 recorded, not delivered \(agent_(blocked|not_found)\)\n$/, mode);
    const rec = readRec(dir);
    assert.equal(rec.state, 'running');
    assert.equal(rec.messages.length, 1);
  }
});

test('C9 --json prints message, state and delivered with the same exit codes', () => {
  const a = mk();
  const r = tell(a.id, 'hello', LIVE, ['--json']);
  ok(r);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j).sort(), ['delivered', 'message', 'state']);
  assert.equal(j.delivered, true);
  assert.equal(j.state, 'running');
  assert.equal(j.message.text, 'hello');
  const c = mk();
  const f = tell(c.id, 'hello', { ...LIVE, HERDR_STUB_MODE: 'prompt-live-blocked' }, ['--json']);
  assert.equal(f.code, 3);
  assert.equal(JSON.parse(f.out).delivered, false);
});

test('G7 --json on a refusal or a usage error prints nothing on stdout', () => {
  const { id } = mk();
  ask(b, id);
  for (const args of [['tell', id, '--message', 'x', '--json'], ['tell', id, '--json']]) {
    const r = run(b, args, LIVE);
    assert.ok([1, 2].includes(r.code));
    assert.equal(r.out, '');
    assert.notEqual(r.err, '');
  }
});

// ---- reopen ---------------------------------------------------------------------------------------------------------

test('C10a/b reopen: done and blocked run again; the note and summary are --note or "reopened"; delivery moves into the note', () => {
  for (const state of ['done', 'blocked']) {
    for (const note of [undefined, 'continuing the work']) {
      const { dir, id } = mk();
      finish(id, state);
      const sig = readRec(dir).signal_revision;
      resetLog(b);
      const r = run(b, ['reopen', id, ...(note ? ['--note', note] : [])]);
      ok(r);
      assert.equal(r.out, `${id} running\n`);
      const rec = readRec(dir);
      const want = note ?? 'reopened';
      assert.equal(rec.state, 'running');
      assert.equal(rec.summary, want);
      assert.equal(rec.delivery, null);
      assert.equal(rec.history.at(-1).note, `${want}; previous delivery: shipped as PR 7`);
      assert.equal(rec.signal_revision, sig);
      assert.deepEqual(calls(b), [], 'reopen makes no herdr call');
    }
  }
});

test('C10c reopen on a running run: exit 0, "already open", no write', () => {
  const { dir, id } = mk();
  const before = sha(recPath(dir));
  resetLog(b);
  const r = run(b, ['reopen', id]);
  ok(r);
  assert.equal(r.out, `${id} running (already open)\n`);
  assert.equal(sha(recPath(dir)), before);
  assert.deepEqual(debris(dir), []);
  assert.deepEqual(calls(b), [], 'reopen makes no herdr call');
});

test('C10d/e reopen refuses an open question (any state) and a failed run; nothing is written, no herdr call', () => {
  const needs = mk();
  ask(b, needs.id);
  const failed = mk();
  ok(run(b, ['set', failed.id, '--state', 'failed']));
  resetLog(b);
  for (const [x, token] of [[needs, 'question_open'], [failed, 'run_failed']]) {
    const before = sha(recPath(x.dir));
    const r = run(b, ['reopen', x.id]);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(`runs: reopen refused (${token}): `), r.err);
    assert.equal(sha(recPath(x.dir)), before);
  }
  assert.deepEqual(calls(b), []);
});

test('G9 reopen adds an empty messages list to a record that has none, so a later tell works', () => {
  const { dir, id } = mk();
  finish(id);
  const rec = readRec(dir);
  delete rec.messages;
  writeFileSync(recPath(dir), JSON.stringify(rec));
  ok(run(b, ['reopen', id]));
  assert.deepEqual(readRec(dir).messages, []);
  ok(tell(id));
});

// ---- the rest of the record changes -----------------------------------------------------------------------------------

test('C11 init writes messages: []', () => {
  assert.deepEqual(readRec(mkRun(b).dir).messages, []);
});

test('C14 set and ask on a done run point to reopen; the failed text is unchanged', () => {
  const { id } = mk();
  finish(id);
  const want = `run is done; to continue it run runs.mjs reopen ${id} (or tell), or start a new run`;
  for (const args of [['set', id, '--state', 'running'], ['ask', id, '--question', 'q', '--options', QOPTS, '--recommendation', 'A']]) {
    const r = run(b, args);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(want), r.err);
  }
  const f = mk();
  run(b, ['set', f.id, '--state', 'failed']);
  assert.match(run(b, ['set', f.id, '--state', 'running']).err, /run is failed; a finished run only accepts ack/);
});

test('C15 show lists messages oldest first with control characters removed; show --json carries them', () => {
  const { id } = mk();
  ok(tell(id, 'plain one'));
  ok(tell(id, 'red \u001b[31mtext\u0007 here\nsecond line'));
  const s = run(b, ['show', id], LIVE).out;
  assert.match(s, /messages:\n  M1 \([^)]+\): plain one\n  M2 \([^)]+\): red \[31mtext here\n    second line/);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(s), 'no control byte but newline');
  const j = JSON.parse(run(b, ['show', id, '--json'], LIVE).out);
  assert.deepEqual(j.messages.map((m) => m.id), ['M1', 'M2']);
});
