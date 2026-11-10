// test_agent.mjs — the herdr agent status in runs.mjs list and show (display only; criteria C20-C27).
import assert from 'node:assert';
import test from 'node:test';
import { barePath, calls, mkRun, newBox, readRec, recPath, resetLog, run, sha, writeRec } from './testkit.mjs';

const arch = (pane) => ({ harness: 'claude', session_id: null, frontend: 'herdr', tab: 'w9:t7', pane });
// A box with one running run per pane; returns the box and the run records' ids.
function world(panes) {
  const b = newBox();
  const runs = panes.map((pane) => { const r = mkRun(b); writeRec(r.dir, { architect: arch(pane) }); return { ...r, pane }; });
  return { b, runs };
}
const lineOf = (out, id) => out.split('\n').find((l) => l.startsWith(`${id}  `));
const ok = (r) => assert.equal(r.code, 0, r.err);

test('C20 list words: one row per raw status, the bare word "done" never describes the agent', () => {
  const rows = [['working', 'agent working'], ['blocked', 'agent blocked'], ['idle', 'agent idle'], ['done', 'agent turn ended'], ['unknown', 'agent unknown'], ['zz-new', 'agent unknown']];
  for (const [raw, word] of rows) {
    const { b, runs } = world(['w9:p1']);
    const r = run(b, ['list'], { HERDR_STUB_AGENTS: 'w9:p1', HERDR_STUB_STATUS: JSON.stringify({ 'w9:p1': raw }) });
    ok(r);
    assert.ok(lineOf(r.out, runs[0].id).includes(`running [${word}]`), `${raw}: ${r.out}`);
    assert.ok(!/agent done\b/.test(r.out), r.out);
  }
});

test('C21 a pane missing from a successful list is architect gone, placed before the other flags', () => {
  const { b, runs } = world(['w9:p1', 'w9:p2']);
  writeRec(runs[0].dir, { updated_at: new Date(Date.now() - 30 * 3600e3).toISOString() });
  const r = run(b, ['list'], { HERDR_STUB_AGENTS: 'w9:p2' });
  assert.ok(lineOf(r.out, runs[0].id).includes('running [architect gone, stale]'), r.out);
  assert.ok(lineOf(r.out, runs[1].id).includes('running [agent idle]'), r.out);
  const j = JSON.parse(run(b, ['list', '--json'], { HERDR_STUB_AGENTS: 'w9:p2' }).out);
  assert.deepEqual(j.find((x) => x.id === runs[0].id).flags, ['architect gone', 'stale'], 'G8: JSON flags keep architect gone');
});

test('C22 herdr missing, failing, hanging or unreadable gives no status, no gone and exit 0', { timeout: 120000 }, () => {
  const rows = [
    ['not on PATH', { PATH: barePath() }],
    ['exit 1', { HERDR_STUB_AGENTS: 'w9:p1', HERDR_STUB_AGENT_MODE: 'fail' }],
    ['hang', { HERDR_STUB_AGENTS: 'w9:p1', HERDR_STUB_AGENT_MODE: 'hang' }],
    ['not JSON', { HERDR_STUB_AGENTS: 'w9:p1', HERDR_STUB_AGENT_MODE: 'malformed' }],
    ['cut mid-JSON', { HERDR_STUB_AGENTS: 'w9:p1', HERDR_STUB_AGENT_MODE: 'truncated' }],
  ];
  for (const [label, extra] of rows) {
    const { b, runs } = world(['w9:p1']);
    for (const args of [['list'], ['show', runs[0].id]]) {
      const r = run(b, args, extra);
      ok(r);
      assert.ok(!/agent (working|idle|blocked|unknown|turn ended)|architect gone|^agent:/m.test(r.out), `${label} ${args[0]}: ${r.out}`);
    }
    for (const args of [['list', '--json'], ['show', runs[0].id, '--json']]) {
      const j = JSON.parse(run(b, args, extra).out);
      const row = Array.isArray(j) ? j[0] : j;
      assert.ok(!('agent_status' in row), `${label}: ${JSON.stringify(row.flags)}`);
      assert.ok(!row.flags.includes('architect gone'));
    }
  }
});

test('C23a three running runs with panes: one agent list, no agent get', () => {
  const { b } = world(['w9:p1', 'w9:p2', 'w9:p3']);
  ok(run(b, ['list'], { HERDR_STUB_AGENTS: 'w9:p1,w9:p2,w9:p3' }));
  assert.deepEqual(calls(b), [['agent', 'list']]);
});

test('C23b herdr is called only when a shown non-terminal run has a pane', () => {
  const { b, runs } = world(['w9:p1']);
  const x = mkRun(b);
  writeRec(x.dir, { architect: arch(null) });
  ok(run(b, ['set', runs[0].id, '--state', 'done']));
  // A done run with a pane and a running run without one: nothing to ask about.
  ok(run(b, ['list']));
  assert.deepEqual(calls(b), []);
  ok(run(b, ['show', runs[0].id]));
  assert.deepEqual(calls(b), [], 'show on a terminal run');
  // A running run with a pane exists, but `list --state done` shows only terminal runs.
  const y = mkRun(b);
  writeRec(y.dir, { architect: arch('w9:p2') });
  resetLog(b);
  ok(run(b, ['list', '--state', 'done']));
  assert.deepEqual(calls(b), []);
  ok(run(b, ['list']));
  assert.deepEqual(calls(b), [['agent', 'list']]);
});

test('C24a/b JSON agent_status: raw value, unknown for a new word, gone for an absent pane, omitted when herdr fails', () => {
  const { b, runs } = world(['w9:p1', 'w9:p2', 'w9:p3']);
  const extra = { HERDR_STUB_AGENTS: 'w9:p1,w9:p2', HERDR_STUB_STATUS: JSON.stringify({ 'w9:p1': 'done', 'w9:p2': 'zz-new' }) };
  const list = JSON.parse(run(b, ['list', '--json'], extra).out);
  const by = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.equal(by[runs[0].id].agent_status, 'done');
  assert.equal(by[runs[1].id].agent_status, 'unknown');
  assert.equal(by[runs[2].id].agent_status, 'gone');
  assert.ok(by[runs[2].id].flags.includes('architect gone'));
  for (const r of runs) assert.equal(JSON.parse(run(b, ['show', r.id, '--json'], extra).out).agent_status, by[r.id].agent_status);
});

test('C25 show prints an agent line for a non-terminal run with a pane, never for a terminal run or without a status', () => {
  const { b, runs } = world(['w9:p1']);
  const live = { HERDR_STUB_AGENTS: 'w9:p1', HERDR_STUB_STATUS: JSON.stringify({ 'w9:p1': 'done' }) };
  assert.match(run(b, ['show', runs[0].id], live).out, /^agent: turn ended$/m);
  assert.ok(!/^agent:/m.test(run(b, ['show', runs[0].id], { ...live, HERDR_STUB_AGENT_MODE: 'fail' }).out));
  assert.ok(!/^agent:/m.test(run(b, ['show', runs[0].id], { HERDR_STUB_AGENTS: undefined }).out), 'gone shows only as the flag');
  assert.match(run(b, ['show', runs[0].id], { HERDR_STUB_AGENTS: undefined }).out, /\(architect gone\)/);
  ok(run(b, ['set', runs[0].id, '--state', 'done']));
  resetLog(b);
  assert.ok(!/^agent:/m.test(run(b, ['show', runs[0].id], live).out));
  assert.deepEqual(calls(b), []);
});

test('C26 status is display only: list and show never change the record, for every status including gone', () => {
  for (const raw of ['working', 'blocked', 'idle', 'done', 'unknown', 'gone']) {
    const { b, runs } = world(['w9:p1']);
    const extra = { HERDR_STUB_AGENTS: raw === 'gone' ? undefined : 'w9:p1', HERDR_STUB_STATUS: JSON.stringify({ 'w9:p1': raw }) };
    const before = sha(recPath(runs[0].dir));
    for (const args of [['list'], ['list', '--json'], ['show', runs[0].id], ['show', runs[0].id, '--json']]) ok(run(b, args, extra));
    assert.equal(sha(recPath(runs[0].dir)), before, raw);
    assert.equal(readRec(runs[0].dir).state, 'running');
  }
});

test('C27 only pane_id and agent_status are read: a hostile terminal_title never reaches the output', () => {
  const { b, runs } = world(['w9:p1']);
  const extra = { HERDR_STUB_AGENTS: 'w9:p1', HERDR_STUB_TITLE: 'ZZ-TITLE-9\u001b[31m\u0007 rm -rf' };
  for (const args of [['list'], ['list', '--json'], ['show', runs[0].id], ['show', runs[0].id, '--json']]) {
    const r = run(b, args, extra);
    ok(r);
    assert.ok(!r.out.includes('ZZ-TITLE-9') && !r.err.includes('ZZ-TITLE-9'), args.join(' '));
  }
});
