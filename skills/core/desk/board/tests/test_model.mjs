// test_model.mjs — the pure half of the desk board, and its record checks held to the real runs.mjs.
// Run: node --test skills/core/desk/board/tests/test_*.mjs (node 22 strips the types of model.ts).
import assert from 'node:assert';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ageText, buildBoard, bandText, clean, fit, headOf, herdrMessage, homeDisplay, isDirName, isHerdrId, isOldFinished, isTerminalApp,
  lookOf, parseRecord, reasonOf, repoName, runsHome, toast, workspaceOf,
} from '../hooks/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, '..', '..', 'runs.mjs');
const NOW = Date.parse('2026-11-10T12:00:00Z');
const MIN = 60e3;
const HOUR = 3600e3;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const rec = (id, patch = {}) => ({
  schema: 1, id, run_dir: `/x/${id}`, repo: '/code/skills', goal: 'Ship the board', task: null, state: 'running', summary: '', delivery: null,
  questions: [], architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: 'w66:t7', pane: 'w66:p8' }, launched_by: 'orchestrator',
  revision: 1, signal_revision: 0, orchestrator_ack: 0, created_at: iso(HOUR), updated_at: iso(MIN), history: [], ...patch,
});
const board = (recs, extra = {}) => buildBoard({ items: recs.map((r) => ({ dir: r.id, rec: r })), bad: 0, now: NOW, home: '~/runs', thisPane: null, readAt: NOW, ...extra });
const rowsOf = (b) => b.groups.flatMap((g) => g.rows);
const keysOf = (b, id) => b.groups.find((g) => g.id === id)?.rows.map((r) => r.key) ?? [];
const shuffled = (list) => [...list].sort((a, b) => (a.id < b.id ? 1 : -1));

// ---- the record checks, against the real CLI -----------------------------------------------------------------------------

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deskboard-')));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'runs');
  mkdirSync(home);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, BORK_RUNS_HOME: home, ORCHESTRATOR_HOME: join(root, 'orch') };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [RUNS, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const make = (slug, goal = 'Ship the board') => {
    const dir = cli('init', '--goal', goal, '--slug', slug);
    return { dir, id: dir.split('/').pop() };
  };
  const opts = '[{"label":"A","description":"a"},{"label":"B","description":"b"}]';
  const q = ['--question', 'Which db?', '--options', opts, '--recommendation', 'A'];
  const runs = {
    running: make('run'),
    asking: make('ask', 'Pick a store\nwith detail'),
    blocked: make('blk'),
    done: make('done'),
    failed: make('fail'),
    old: make('old'),
  };
  cli('ask', runs.asking.id, ...q);
  cli('ask', runs.asking.id, '--question', 'And the cache?', '--options', opts, '--recommendation', 'A');
  cli('set', runs.blocked.id, '--state', 'blocked', '--summary', 'circuit breaker');
  cli('set', runs.done.id, '--state', 'done', '--delivery', 'merged');
  cli('set', runs.failed.id, '--state', 'failed', '--summary', 'boom');
  cli('set', runs.old.id, '--state', 'done', '--delivery', 'old delivery');
  const oldFile = join(runs.old.dir, 'run.json');
  const o = JSON.parse(readFileSync(oldFile, 'utf8'));
  o.updated_at = new Date(Date.now() - 50 * HOUR).toISOString();
  writeFileSync(oldFile, `${JSON.stringify(o, null, 2)}\n`);
  return { root, home, cli, runs, env };
}

// One malformed copy per branch of runs.mjs invalidReason (runs.mjs:71-86), then the board's own date checks.
const MALFORMED = {
  'not an object': () => [],
  null: () => null,
  schema: (r) => ({ ...r, schema: 2 }),
  state: (r) => ({ ...r, state: 'weird' }),
  questions: (r) => ({ ...r, questions: null }),
  history: (r) => ({ ...r, history: null }),
  revision: (r) => ({ ...r, revision: 1.5 }),
  signal_revision: (r) => ({ ...r, signal_revision: 'x' }),
  orchestrator_ack: (r) => ({ ...r, orchestrator_ack: null }),
  'id differs from the dir': (r) => ({ ...r, id: 'other' }),
  goal: (r) => ({ ...r, goal: 5 }),
  architect: (r) => ({ ...r, architect: null }),
  launched_by: (r) => ({ ...r, launched_by: 'x' }),
  'malformed question': (r) => ({ ...r, questions: [{ id: 'x' }] }),
  'question with a bad status': (r) => ({ ...r, questions: [{ id: 'Q1', status: 'nope', options: [] }] }),
};
const BOARD_ONLY = {
  'updated_at is empty': (r) => ({ ...r, updated_at: '' }),
  'updated_at is not a date': (r) => ({ ...r, updated_at: 'not a date' }),
  'updated_at is month 13': (r) => ({ ...r, updated_at: '2026-13-01T00:00:00Z' }),
  'created_at is not a date': (r) => ({ ...r, created_at: 'nope' }),
};

test('the board accepts exactly the records runs.mjs list accepts, plus its own date checks (real CLI fixture)', () => {
  const f = fixture();
  const base = JSON.parse(readFileSync(join(f.runs.running.dir, 'run.json'), 'utf8'));
  let n = 0;
  const writeBad = (patch, text) => {
    const name = `bad-${n++}`;
    mkdirSync(join(f.home, name));
    writeFileSync(join(f.home, name, 'run.json'), text ?? JSON.stringify(patch({ ...base, id: name })));
    return name;
  };
  const malformed = [...Object.values(MALFORMED).map((m) => writeBad(m)), writeBad(null, '{')];
  const dateBad = Object.values(BOARD_ONLY).map((m) => writeBad(m));
  mkdirSync(join(f.home, 'no-record'));
  const listed = new Set(JSON.parse(f.cli('list', '--json')).map((r) => r.id));
  const board = new Set();
  const bad = new Set();
  let none = 0;
  for (const name of readdirSync(f.home)) {
    let text;
    try { text = readFileSync(join(f.home, name, 'run.json'), 'utf8'); } catch { none += 1; continue; }
    const got = parseRecord(text, name);
    if ('rec' in got) board.add(name); else bad.add(name);
  }
  assert.deepEqual([...board].sort(), [...listed].filter((id) => !dateBad.includes(id)).sort(), 'good ids differ from runs.mjs list');
  assert.deepEqual([...bad].sort(), [...malformed, ...dateBad].sort(), 'bad ids are the malformed copies and the date copies');
  assert.equal(bad.size, malformed.length + dateBad.length);
  assert.equal(none, 1);
  for (const id of dateBad) assert.ok(listed.has(id), `${id}: runs.mjs does not check dates, the board does`);
});

test('conservation: rows drawn + old finished hidden + bad + run dirs without run.json = run dirs', () => {
  const f = fixture();
  mkdirSync(join(f.home, 'no-record'));
  mkdirSync(join(f.home, 'bad-json'));
  writeFileSync(join(f.home, 'bad-json', 'run.json'), '{');
  const items = [];
  let bad = 0;
  let none = 0;
  const names = readdirSync(f.home).filter((n) => isDirName(n));
  for (const name of names) {
    let text;
    try { text = readFileSync(join(f.home, name, 'run.json'), 'utf8'); } catch { none += 1; continue; }
    const got = parseRecord(text, name);
    if ('rec' in got) items.push({ dir: name, rec: got.rec }); else bad += 1;
  }
  const hidden = items.filter((i) => isOldFinished(i.rec, Date.now())).length;
  const b = buildBoard({ items, bad, now: Date.now(), home: '~/runs', thisPane: null, readAt: 1 });
  assert.equal(hidden, 1);
  assert.equal(b.rows + hidden + bad + none, names.length);
  assert.equal(b.rows, 5);
  assert.equal(b.bad, 1);
});

test('real runs.mjs records draw: needs-me shows the last open question, blocked and done their text', () => {
  const f = fixture();
  const items = [];
  for (const { id, dir } of Object.values(f.runs)) {
    const got = parseRecord(readFileSync(join(dir, 'run.json'), 'utf8'), id);
    assert.ok('rec' in got, `${id}: ${got.bad}`);
    items.push({ dir: id, rec: got.rec });
  }
  const b = buildBoard({ items, bad: 0, now: Date.now(), home: '~/runs', thisPane: null, readAt: 1 });
  const byState = (s) => rowsOf(b).find((r) => r.state === s);
  assert.equal(byState('needs-me').line2, 'Q2: And the cache?');
  assert.equal(byState('needs-me').goal, 'Pick a store');
  assert.equal(byState('blocked').line2, 'circuit breaker');
  assert.equal(byState('failed').line2, 'boom');
  assert.equal(rowsOf(b).find((r) => r.line2 === 'merged')?.state, 'done');
  assert.equal(rowsOf(b).length, 5, 'the old finished run is hidden');
});

// ---- dates ---------------------------------------------------------------------------------------------------------------

for (const bad of ['', 'not a date', '2026-13-01T00:00:00Z']) {
  test(`updated_at ${JSON.stringify(bad)} makes a record bad`, () => {
    assert.ok('bad' in parseRecord(JSON.stringify(rec('a', { updated_at: bad })), 'a'));
  });
}

// ---- ordering, aging, line 2 ----------------------------------------------------------------------------------------------

test('Needs you is newest updated first, In motion oldest created first, Finished newest first, each from shuffled input', () => {
  const recs = [
    rec('n1', { state: 'needs-me', updated_at: iso(3 * HOUR) }), rec('n2', { state: 'blocked', updated_at: iso(MIN) }), rec('n3', { state: 'needs-me', updated_at: iso(2 * HOUR) }),
    rec('m1', { created_at: iso(5 * HOUR) }), rec('m2', { created_at: iso(9 * HOUR) }), rec('m3', { created_at: iso(7 * HOUR) }),
    rec('f1', { state: 'done', updated_at: iso(5 * HOUR) }), rec('f2', { state: 'failed', updated_at: iso(MIN) }), rec('f3', { state: 'done', updated_at: iso(3 * HOUR) }),
  ];
  for (const input of [recs, shuffled(recs), [...recs].reverse()]) {
    const b = board(input);
    assert.deepEqual(keysOf(b, 'needs'), ['n2', 'n3', 'n1']);
    assert.deepEqual(keysOf(b, 'motion'), ['m2', 'm3', 'm1']);
    assert.deepEqual(keysOf(b, 'finished'), ['f2', 'f3', 'f1']);
  }
});

test('headings carry counts and an empty group is absent', () => {
  const b = board([rec('a', { state: 'needs-me' }), rec('b', { state: 'blocked' }), rec('c')]);
  assert.deepEqual(b.groups.map((g) => g.title), ['Needs you · 2', 'In motion · 1']);
});

test('finished runs are Finished today to 24 h, Yesterday to 48 h, then hidden', () => {
  const b = board([
    rec('today', { state: 'done', updated_at: iso(23 * HOUR + 59 * MIN) }),
    rec('yday-new', { state: 'failed', updated_at: iso(24 * HOUR + MIN) }),
    rec('yday-old', { state: 'done', updated_at: iso(47 * HOUR + 59 * MIN) }),
    rec('gone', { state: 'failed', updated_at: iso(48 * HOUR + MIN) }),
  ]);
  assert.deepEqual(keysOf(b, 'finished'), ['today']);
  assert.deepEqual(keysOf(b, 'earlier'), ['yday-new', 'yday-old']);
  assert.equal(rowsOf(b).some((r) => r.key === 'gone'), false);
  assert.equal(b.rows, 3);
  assert.deepEqual(b.groups.map((g) => g.title), ['Finished today · 1', 'Yesterday · 2']);
});

test('Yesterday rows are newest first, aged in hours and dimmed', () => {
  const b = board([
    rec('e40', { state: 'done', updated_at: iso(40 * HOUR) }),
    rec('e25', { state: 'failed', updated_at: iso(25 * HOUR + 30 * MIN) }),
    rec('e30', { state: 'done', updated_at: iso(30 * HOUR) }),
  ]);
  assert.deepEqual(keysOf(b, 'earlier'), ['e25', 'e30', 'e40']);
  assert.deepEqual(b.groups[0].rows.map((r) => r.age), ['25h', '30h', '40h']);
  assert.ok(b.groups[0].rows.every((r) => r.isDimRow));
});

test('a finished record is old (never drawn again) only past 48 h', () => {
  assert.equal(isOldFinished(rec('a', { state: 'done', updated_at: iso(47 * HOUR) }), NOW), false);
  assert.equal(isOldFinished(rec('a', { state: 'failed', updated_at: iso(49 * HOUR) }), NOW), true);
  assert.equal(isOldFinished(rec('a', { state: 'running', updated_at: iso(49 * HOUR) }), NOW), false);
});

test('each state has its own glyph, color and word; a stale run is gray', () => {
  const looks = Object.fromEntries(['needs-me', 'blocked', 'running', 'done', 'failed'].map((s) => [s, lookOf({ state: s, isStale: false })]));
  assert.deepEqual(looks['needs-me'], { glyph: '◆', color: 'warning', word: 'needs you' });
  assert.deepEqual(looks.blocked, { glyph: '■', color: 'error', word: 'blocked' });
  assert.deepEqual(looks.running, { glyph: '●', color: 'suggestion', word: 'running' });
  assert.deepEqual(looks.done, { glyph: '✓', color: 'success', word: 'done' });
  assert.deepEqual(looks.failed, { glyph: '✗', color: 'error', word: 'failed' });
  assert.deepEqual(lookOf({ state: 'running', isStale: true }), { glyph: '○', color: 'inactive', word: 'stale' });
});

test('a card head reads repo · word, then this session and no tab', () => {
  const row = (patch) => ({ ...rowsOf(board([rec('a')]))[0], ...patch });
  assert.equal(headOf(row({})), 'skills · running');
  assert.equal(headOf(row({ state: 'needs-me', isThis: true })), 'skills · needs you · (this session)');
  assert.equal(headOf(row({ isStale: true, tab: null })), 'skills · stale · no tab');
});

test('a needs-me or blocked run 30 days old is still in Needs you', () => {
  const b = board([rec('a', { state: 'needs-me', updated_at: iso(30 * 24 * HOUR) }), rec('b', { state: 'blocked', updated_at: iso(30 * 24 * HOUR) })]);
  assert.deepEqual(keysOf(b, 'needs').sort(), ['a', 'b']);
});

test('needs-me line 2: last open question, then earlier open one, then summary, then waiting on you', () => {
  const two = [{ id: 'Q1', question: 'first?', status: 'open', options: [] }, { id: 'Q2', question: 'second?', status: 'open', options: [] }];
  const line = (r) => rowsOf(board([r]))[0].line2;
  assert.equal(line(rec('a', { state: 'needs-me', questions: two })), 'Q2: second?');
  assert.equal(line(rec('a', { state: 'needs-me', questions: [two[0], { ...two[1], status: 'answered' }] })), 'Q1: first?');
  assert.equal(line(rec('a', { state: 'needs-me', questions: [{ ...two[0], status: 'withdrawn' }], summary: 'on hold' })), 'on hold');
  assert.equal(line(rec('a', { state: 'needs-me' })), 'waiting on you');
});

test('line 2 for done falls back delivery, summary, goal; blocked and failed summary then goal; running the goal', () => {
  const line = (r) => rowsOf(board([r]))[0].line2;
  assert.equal(line(rec('a', { state: 'done', delivery: 'merged', summary: 's' })), 'merged');
  assert.equal(line(rec('a', { state: 'done', delivery: null, summary: 's' })), 's');
  assert.equal(line(rec('a', { state: 'done', goal: 'first\nsecond' })), 'first');
  assert.equal(line(rec('a', { state: 'blocked', summary: 'stuck' })), 'stuck');
  assert.equal(line(rec('a', { state: 'failed', goal: 'the goal' })), 'the goal');
  assert.equal(line(rec('a', { goal: 'the goal\nmore' })), 'the goal');
});

test('a repo of null draws - and otherwise the basename', () => {
  assert.equal(repoName(null), '-');
  assert.equal(repoName('/code/skills'), 'skills');
  assert.equal(repoName('/code/skills/'), 'skills');
  assert.equal(repoName(7), '-');
});

test('non-string repo, summary, delivery and question text are treated as absent, not as a failure', () => {
  const r = rec('a', { state: 'done', repo: 7, summary: { x: 1 }, delivery: 9 });
  assert.equal(rowsOf(board([r]))[0].repo, '-');
  assert.equal(rowsOf(board([r]))[0].line2, 'Ship the board');
  const q = rec('b', { state: 'needs-me', questions: [{ id: 'Q1', question: { x: 1 }, status: 'open', options: [] }] });
  assert.equal(rowsOf(board([q]))[0].line2, 'waiting on you');
});

test('age text is now at 59 s, 1m at 60 s, 3h at 3 h and 2d at 2 d', () => {
  assert.equal(ageText(59e3), 'now');
  assert.equal(ageText(60e3), '1m');
  assert.equal(ageText(3 * HOUR), '3h');
  assert.equal(ageText(2 * 24 * HOUR), '2d');
  assert.equal(ageText(-5000), 'now');
});

test('age is measured from updated_at', () => {
  const b = board([rec('a', { created_at: iso(5 * HOUR), updated_at: iso(2 * MIN) })]);
  assert.equal(rowsOf(b)[0].age, '2m');
});

test('only a running run older than 24 h is stale', () => {
  const b = board([rec('r', { updated_at: iso(25 * HOUR) }), rec('n', { state: 'needs-me', updated_at: iso(25 * HOUR) }), rec('fresh', { updated_at: iso(HOUR) })]);
  const by = (k) => rowsOf(b).find((r) => r.key === k);
  assert.equal(by('r').isStale, true);
  assert.equal(by('n').isStale, false);
  assert.equal(by('fresh').isStale, false);
});

test('this session is the run whose architect pane is HERDR_PANE_ID, and the band does not count it', () => {
  const recs = [rec('own', { state: 'needs-me', architect: { frontend: 'herdr', tab: 'w9:t9', pane: 'w9:p9' } }), rec('other', { state: 'needs-me' })];
  const b = board(recs, { thisPane: 'w9:p9' });
  assert.equal(rowsOf(b).find((r) => r.key === 'own').isThis, true);
  assert.equal(b.needs, 1);
  assert.equal(board(recs, { thisPane: null }).needs, 2);
  assert.equal(board([rec('x', { state: 'needs-me', architect: {} })], { thisPane: '' }).needs, 1);
});

test('an empty HERDR_PANE_ID never matches an empty architect pane', () => {
  const r = rec('x', { state: 'needs-me', architect: { frontend: null, tab: null, pane: '' } });
  assert.equal(rowsOf(board([r], { thisPane: '' }))[0].isThis, false);
  assert.equal(board([r], { thisPane: '' }).needs, 1);
  const n = rec('y', { state: 'needs-me', architect: { frontend: null, tab: null, pane: null } });
  assert.equal(board([n], { thisPane: null }).needs, 1);
});

test('band text: nothing at zero Needs you on the terminal; one needs you; two need you; desktop quiet with rows', () => {
  const b = (n, m) => ({ needs: n, motion: m, rows: n + m });
  assert.equal(bandText(b(0, 3), false), null);
  assert.equal(bandText(b(1, 3), false), 'Desk: 1 needs you · 3 in motion');
  assert.equal(bandText(b(2, 0), false), 'Desk: 2 need you · 0 in motion');
  assert.equal(bandText(b(0, 3), true), 'Desk: 3 in motion');
  assert.equal(bandText(b(0, 0), true), null);
});

// ---- text is data, ids are checked ---------------------------------------------------------------------------------------------

test('clean strips control characters, flattens line breaks and cuts to the cap', () => {
  assert.equal(clean('a\u001b[31mb\u0007c\rd\ne'), 'a[31mbc d e');
  assert.equal(clean('x'.repeat(300)).length, 200);
  assert.equal(clean(7), '');
  assert.equal(clean('\u0085hidden\u009f'), 'hidden');
});

test('fit cuts at the end with an ellipsis and never exceeds the width', () => {
  assert.equal(fit('abcdef', 6), 'abcdef');
  assert.equal(fit('abcdefg', 6), 'abcde…');
  assert.equal(Array.from(fit('x'.repeat(100), 40)).length, 40);
});

for (const bad of ['-x', 'w1 t2', '', 'a/b', 123, null, undefined, 'w1:t2\n']) {
  test(`isHerdrId rejects ${JSON.stringify(bad)}`, () => {
    assert.equal(isHerdrId(bad), false);
  });
}
test('isHerdrId accepts herdr ids', () => {
  for (const ok of ['w66:t7', 'w5Y:t1', 'tw:p1', 'a.b_c-d']) assert.equal(isHerdrId(ok), true, ok);
});

for (const bad of ['..x', 'a..b', '.hidden', '-x', 'a b', '', 7]) {
  test(`isDirName rejects ${JSON.stringify(bad)}`, () => {
    assert.equal(isDirName(bad), false);
  });
}
test('isDirName accepts run ids', () => {
  for (const ok of ['2026-11-10-skills-6jiv', 'a', 'a.b']) assert.equal(isDirName(ok), true, ok);
});

test('terminalApp must be a bundle id: no leading dash, space, semicolon or leading dot', () => {
  for (const bad of ['-a', 'com.x y', 'com.x;rm', '.com', '', 7]) assert.equal(isTerminalApp(bad), false, String(bad));
  assert.equal(isTerminalApp('com.mitchellh.ghostty'), true);
});

test('the runs home takes absolute BORK_RUNS_HOME, then AGENT_HANDOFFS_DIR/runs, then HOME', () => {
  assert.equal(runsHome('/b', '/h', '/u'), '/b');
  assert.equal(runsHome('rel', '/h', '/u'), '/h/runs');
  assert.equal(runsHome(undefined, 'rel', '/u'), '/u/.agent-handoffs/runs');
  assert.equal(runsHome('', '', '/u/'), '/u/.agent-handoffs/runs');
  assert.equal(runsHome(undefined, undefined, undefined), null);
  assert.equal(homeDisplay('/u/.agent-handoffs/runs', '/u'), '~/.agent-handoffs/runs');
  assert.equal(homeDisplay('/data/runs', '/u'), '/data/runs');
});

// ---- herdr output, byte for byte ------------------------------------------------------------------------------------------------

// herdr 0.9.3 on this machine (spec-review probe): `herdr tab get w66:t7`, exit 0.
const TAB_GET_0_9_3 = '{"id":"cli:tab:get","result":{"tab":{"agent_status":"working","focused":false,"label":"do: skills","number":7,"pane_count":1,"tab_id":"w66:t7","workspace_id":"w66"},"type":"tab_info"}}';
// herdr 0.9.3: `herdr tab get w66:t99999`, exit 1, on stderr.
const TAB_MISSING_0_9_3 = '{"error":{"code":"tab_not_found","message":"tab w66:t99999 not found"},"id":"cli:tab:get"}';

test('herdr 0.9.3 tab get stdout gives the workspace id w66', () => {
  assert.equal(workspaceOf(TAB_GET_0_9_3), 'w66');
});

test('a tab get answer without a usable workspace id gives null', () => {
  for (const bad of ['', 'not json', '{}', TAB_MISSING_0_9_3, '{"result":{"tab":{"workspace_id":"-rf"}}}', '{"result":{"tab":{"workspace_id":7}}}']) assert.equal(workspaceOf(bad), null, bad);
});

test('herdr 0.9.3 tab_not_found error body gives its message as plain text', () => {
  assert.equal(herdrMessage(TAB_MISSING_0_9_3, 1), 'tab w66:t99999 not found');
});

test('a stderr that is not JSON gives its first line, cut to 120 with no control characters', () => {
  assert.equal(herdrMessage('boom\nsecond', 2), 'boom');
  assert.equal(herdrMessage('', 3), 'herdr exited 3');
  const long = herdrMessage(JSON.stringify({ error: { message: `\u001b${'m'.repeat(300)}` } }), 1);
  assert.equal(long.length, 120);
  assert.ok(!/[\u0000-\u001f]/.test(long));
});

test('toast texts match the spec', () => {
  assert.equal(toast.switched('skills', 'w66:t7', false), 'Switched herdr to skills (w66:t7)');
  assert.equal(toast.switched('skills', 'w66:t7', true), 'Switched herdr to skills (w66:t7) — switch to your terminal');
  assert.equal(toast.failed('skills', 'tab gone'), 'Could not switch to skills: tab gone');
  assert.equal(toast.timeout('skills'), 'Could not switch to skills: herdr did not answer');
  assert.equal(toast.noWorkspace('skills', 'w66:t7'), 'Could not switch to skills: herdr gave no workspace for w66:t7');
  assert.equal(toast.cannot('w66:t7'), "Can't switch tabs from here: run herdr tab focus w66:t7");
});

// The engine's own lead on an fs rejection, as seen live with a chmod 000 runs home (architect L1).
test('reasonOf drops the real engine lead and keeps the file system error', () => {
  assert.equal(reasonOf('desk-board: $.fs.list(/Users/matt/.agent-handoffs/runs) failed: EACCES'), 'EACCES');
  assert.equal(reasonOf('desk-board: $.fs.list(/tmp/a (b)/runs) failed: EACCES: permission denied\nsecond'), 'EACCES: permission denied');
});

test('reasonOf also drops the test kit lead and leaves other text alone', () => {
  assert.equal(reasonOf('desk-board: $.fs.list: EACCES: permission denied, scandir'), 'EACCES: permission denied, scandir');
  assert.equal(reasonOf('EACCES: permission denied'), 'EACCES: permission denied');
  assert.equal(reasonOf('other: not an engine lead: EIO'), 'other: not an engine lead: EIO');
});
