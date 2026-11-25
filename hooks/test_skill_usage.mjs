import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'skill-usage.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'su-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));
const LOG = join(BOX, 'usage', 'skills.jsonl');

const run = (args, input, env = {}) =>
  execFileSync(NODE, [HOOK, ...args], {
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, AGENT_HANDOFFS_DIR: BOX, BORK_SKILL_USAGE_LOG: '', ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const fire = (payload, env) => run([], payload, env);
const lines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// Most checks share one log, so each builds on the writes before it. A step runs
// once and keeps its result or error; a test calls the steps it needs, so it
// also passes when run alone.
const once = (step) => {
  let ran;
  return () => {
    if (!ran) {
      try { ran = { value: step() }; } catch (error) { ran = { error }; }
    }
    if (ran.error) throw ran.error;
    return ran.value;
  };
};

const tool = (skill, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill, args: 'secret args' },
  session_id: 's1', cwd: '/repo', ...extra,
});
const prompt = (text) => ({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: 's2', cwd: '/repo' });

const toolLogged = once(() => {
  assert.strictEqual(fire(tool('bork:do')), '');
});
test('Skill tool call: logs one tool line with no output', () => {
  toolLogged();
  const l = lines();
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual({ via: l[0].via, skill: l[0].skill, session: l[0].session, cwd: l[0].cwd }, { via: 'tool', skill: 'bork:do', session: 's1', cwd: '/repo' });
  assert.match(l[0].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('never records skill arguments', () => {
  toolLogged();
  assert.doesNotMatch(readFileSync(LOG, 'utf8'), /secret/);
});

test('log directory is 700 and file is 600', () => {
  toolLogged();
  assert.strictEqual(statSync(join(BOX, 'usage')).mode & 0o777, 0o700);
  assert.strictEqual(statSync(LOG).mode & 0o777, 0o600);
});

const subagentLogged = once(() => {
  toolLogged();
  fire(tool('bork:review', { agent_type: 'general-purpose' }));
});
test('subagent call records the agent type', () => {
  subagentLogged();
  assert.strictEqual(lines().at(-1).agent, 'general-purpose');
});

test('other tools are ignored', () => {
  subagentLogged();
  const before = lines().length;
  fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1' });
  assert.strictEqual(lines().length, before);
});

const slashLogged = once(() => {
  subagentLogged();
  fire(prompt('/bork:review the auth branch please'));
});
test('slash prompt logs the command name only', () => {
  slashLogged();
  const l = lines().at(-1);
  assert.deepStrictEqual([l.via, l.skill], ['slash', 'bork:review']);
  assert.doesNotMatch(readFileSync(LOG, 'utf8'), /auth branch/);
});

const tagLogged = once(() => {
  slashLogged();
  fire(prompt('  /do'));
  fire(prompt('<command-message>handoff</command-message>\n<command-name>/bork:handoff</command-name>'));
});
test('unprefixed slash and expanded command tag are both read', () => {
  tagLogged();
  assert.deepStrictEqual(lines().slice(-2).map((l) => l.skill), ['do', 'bork:handoff']);
});

test('plain prompts and file paths are not logged', () => {
  tagLogged();
  const before = lines().length;
  fire(prompt('please review this'));
  fire(prompt('/Users/me/project/file.md has a bug'));
  fire(prompt('a/b is fine'));
  assert.strictEqual(lines().length, before);
});

test('Code Mode background output (source poll_event) is never read as a slash command', () => {
  // Its own log directory, so the report checks below keep their counts.
  const box = mkdtempSync(join(tmpdir(), 'su-poll-'));
  const log = join(box, 'usage', 'skills.jsonl');
  try {
    fire({ ...prompt('/done\nall 12 files checked'), source: 'poll_event' }, { AGENT_HANDOFFS_DIR: box });
    assert.strictEqual(existsSync(log), false);
    fire({ ...prompt('/bork:layman'), source: 'user' }, { AGENT_HANDOFFS_DIR: box });
    assert.deepStrictEqual(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).skill), ['bork:layman']);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test('BORK_SKILL_USAGE_LOG=0 turns logging off', () => {
  tagLogged();
  const before = lines().length;
  fire(tool('bork:do'), { BORK_SKILL_USAGE_LOG: '0' });
  assert.strictEqual(lines().length, before);
});

test('bad input exits 0 silently', () => {
  assert.strictEqual(run([], 'not json'), '');
  assert.strictEqual(run([], ''), '');
});

const hostileLogged = once(() => {
  tagLogged();
  fire(tool('bork:do\n{"x":1}'));
});
test('hostile skill names are sanitized', () => {
  hostileLogged();
  assert.strictEqual(lines().at(-1).skill, 'bork:do___x_:1_');
});

// The log the report checks read: the calls above, one bad line and one 2020 entry.
const reportLog = once(() => {
  hostileLogged();
  appendFileSync(LOG, 'garbage line\n');
  appendFileSync(LOG, `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', via: 'tool', skill: 'bork:council', session: 'old' })}\n`);
});
test('report counts, merges unprefixed bork slash names and lists unused skills', () => {
  reportLog();
  const r = JSON.parse(run(['report', '--json']));
  const byName = Object.fromEntries(r.skills.map((s) => [s.skill, s]));
  assert.strictEqual(byName['bork:do'].tool, 1);
  assert.strictEqual(byName['bork:do'].slash, 1); // "/do" folded into bork:do
  assert.strictEqual(byName['bork:review'].total, 2);
  assert.strictEqual(r.unreadable_lines, 1);
  const unused = r.unused.map((u) => u.name);
  assert.ok(unused.includes('bork:layman'), 'layman is unused');
  assert.ok(!unused.includes('bork:do'), 'do is used');
  assert.ok(unused.includes('bork:writing-plan-documents'), 'uses the frontmatter name, not the directory');
  assert.ok(!unused.includes('bork:council'), 'council used in 2020');
});

test('report --since excludes older entries', () => {
  reportLog();
  const r = JSON.parse(run(['report', '--since', '2021-01-01', '--json']));
  assert.ok(!r.skills.some((s) => s.skill === 'bork:council'));
  assert.ok(r.unused.some((u) => u.name === 'bork:council'));
});

test('report rejects a malformed --since', () => {
  reportLog();
  assert.throws(() => run(['report', '--since', 'yesterday']), /YYYY-MM-DD/);
});

test('text report renders a table', () => {
  reportLog();
  const out = run(['report']);
  assert.match(out, /^Skill usage: \d+ invocations/);
  assert.match(out, /bork:do\s+2\s+1\s+1/);
  assert.match(out, /no invocation in this window: .*bork:layman/);
});

test('a Skill call right after the same slash command is a reload, not a second use', () => {
  const dir = join(BOX, 'reload');
  const log = join(dir, 'usage', 'skills.jsonl');
  const at = (s) => new Date(Date.parse('2026-11-13T14:00:00.000Z') + s * 1000).toISOString();
  const e = (s, via, skill, session = 'a') => `${JSON.stringify({ ts: at(s), via, skill, session })}\n`;
  // Written out of order on purpose: the report sorts by time.
  fire(tool('bork:x'), { AGENT_HANDOFFS_DIR: dir }); // creates the directory
  appendFileSync(log, e(2, 'tool', 'bork:layman') + e(0, 'slash', 'bork:layman') + e(1, 'slash', 'layman', 'b')
    + e(3, 'tool', 'bork:layman', 'b') + e(5, 'tool', 'bork:layman') + e(10, 'slash', 'bork:do') + e(200, 'tool', 'bork:do'));
  const r = JSON.parse(run(['report', '--since', '2026-11-13', '--json'], '', { AGENT_HANDOFFS_DIR: dir }));
  const s = Object.fromEntries(r.skills.map((x) => [x.skill, x]));
  // a: slash at 0, reload at 2, a real second use at 5. b: unprefixed slash at 1, reload at 3.
  assert.deepStrictEqual([s['bork:layman'].slash, s['bork:layman'].reload, s['bork:layman'].tool, s['bork:layman'].total], [2, 2, 1, 3]);
  // Outside the window, a tool call is its own use.
  assert.deepStrictEqual([s['bork:do'].slash, s['bork:do'].reload, s['bork:do'].tool], [1, 0, 1]);
});

test('report on a missing log is empty, not an error', () => {
  const r = JSON.parse(run(['report', '--json'], '', { AGENT_HANDOFFS_DIR: join(BOX, 'none') }));
  assert.strictEqual(r.total, 0);
  assert.ok(r.unused.length > 20);
});
