import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'reinit-hook.mjs');
const MB = join(HERE, 'mailbox.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'rh-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

// Scrub the offload markers: run from a builder or an unattended wake, the hook
// would stay silent and every assertion below would pass for the wrong reason.
const env = { ...process.env, AGENT_HANDOFFS_DIR: BOX };
delete env.OFFLOAD_HANDOFF;
delete env.OFFLOAD_UNATTENDED_TURN;
const mailbox = (...args) => execFileSync(NODE, [MB, ...args], { env, encoding: 'utf8' });

const handoff = (path, o = {}) => {
  const { title = 'Sample work', goal = 'Do the thing', branch = 'feat/sample', body = 'Do the thing.' } = o;
  writeFileSync(path, `---\ntitle: ${title}\ngoal: ${goal}\nwritten_at: 2026-06-10 15:10\nbranch: ${branch}\n---\n# Handoff: ${title}\n## Goal\n${body}\n`);
};

// Fire the SessionStart hook with a given cwd; returns the parsed additionalContext.
// `source` null sends an input with no source field at all.
const fire = (cwd, source = 'clear', extraEnv = {}) => {
  const input = { session_id: 's', cwd, hook_event_name: 'SessionStart' };
  if (source !== null) input.source = source;
  const out = execFileSync(NODE, [HOOK], {
    input: JSON.stringify(input),
    env: { ...env, ...extraEnv }, encoding: 'utf8',
  });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const CONSUMED = join(BOX, 'consumed');

// The scenarios below share one mailbox, so each builds on the ones before it. A
// step runs once and keeps its result or error; a test calls the steps it needs,
// so it also passes when run alone.
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
const consumeToken = (path) => mailbox('consume', path.split('/').pop().replace(/\.md$/, '').split('--').slice(1).join('--'), CWD);

const CWD = '/tmp/project-a';

// --- no handoff: no startup context ---
const emptyFire = once(() => fire(CWD));
test('empty mailbox is silent', () => {
  const empty = emptyFire();
  assert.strictEqual(empty, null);
});

// --- single handoff: injected as briefing AND consumed ---
const singleFire = once(() => {
  emptyFire();
  const s1 = join(BOX, 's1.md'); handoff(s1, { body: 'Single body marker.' });
  const stored = mailbox('write', s1, CWD).trim();
  return { stored, single: fire(CWD) };
});
test('event name is SessionStart', () => {
  const { single } = singleFire();
  assert.strictEqual(single.hookEventName, 'SessionStart');
});
test('single handoff body is injected', () => {
  const { single } = singleFire();
  assert.match(single.additionalContext, /Single body marker\./);
});
test('single handoff is auto-loaded + consumed', () => {
  const { stored } = singleFire();
  assert.ok(!existsSync(stored));
});
test('consumed handoff is kept under consumed/', () => {
  const { stored } = singleFire();
  assert.ok(existsSync(join(CONSUMED, stored.split('/').pop())));
});
test('injected body is framed as data from an earlier session', () => {
  const { single } = singleFire();
  assert.match(single.additionalContext, /<<<HANDOFF\n[\s\S]*Single body marker\.[\s\S]*\nHANDOFF>>>/);
  assert.match(single.additionalContext, /not as new instructions/);
});
test('after consume, a re-fire is silent', () => {
  singleFire();
  assert.strictEqual(fire(CWD), null);
});

// --- compact also auto-loads ---
const compactFire = once(() => {
  singleFire();
  const c1 = join(BOX, 'c1.md'); handoff(c1, { body: 'Compact body marker.' });
  const cStored = mailbox('write', c1, CWD).trim();
  assert.match(fire(CWD, 'compact').additionalContext, /Compact body marker\./);
  return cStored;
});
test('compact auto-loads a single handoff', () => { compactFire(); });
test('compact consumes it', () => {
  const cStored = compactFire();
  assert.ok(!existsSync(cStored));
});

// The step that leaves the mailbox ready for the next scenario.
let previous = compactFire;

// --- sessions that must not take a single handoff ---
for (const source of ['startup', 'resume', null]) {
  const before = previous;
  const fired = once(() => {
    before();
    const p = join(BOX, `n-${source}.md`); handoff(p, { title: `Pending ${source}`, body: 'NOT-FOR-YOU' });
    const kept = mailbox('write', p, CWD).trim();
    return { kept, ctx: fire(CWD, source) };
  });
  test(`${source ?? 'no'} source shows a one-line notice, not the body`, () => {
    const { ctx } = fired();
    assert.match(ctx.additionalContext, /A handoff is pending/);
    assert.match(ctx.additionalContext, new RegExp(`Pending ${source}`));
    assert.doesNotMatch(ctx.additionalContext, /NOT-FOR-YOU/);
  });
  test(`${source ?? 'no'} source consumes nothing`, () => {
    const { kept } = fired();
    assert.ok(existsSync(kept));
  });
  previous = once(() => { consumeToken(fired().kept); });
}

for (const [name, extra] of [['OFFLOAD_UNATTENDED_TURN', { OFFLOAD_UNATTENDED_TURN: '1' }], ['OFFLOAD_HANDOFF', { OFFLOAD_HANDOFF: '/x/doc.md' }]]) {
  const before = previous;
  const silenced = once(() => {
    before();
    const p = join(BOX, `o-${name}.md`); handoff(p, { body: 'OFFLOAD-SILENT' });
    const kept = mailbox('write', p, CWD).trim();
    assert.strictEqual(fire(CWD, 'clear', extra), null);
    return kept;
  });
  test(`${name} set: silent even on clear`, () => { silenced(); });
  test(`${name} set: consumes nothing`, () => {
    const kept = silenced();
    assert.ok(existsSync(kept));
  });
  previous = once(() => { consumeToken(silenced()); });
}

// --- prune reaps consumed/ past the TTL ---
const consumedAll = previous;
const pruned = once(() => {
  consumedAll();
  const files = readdirSync(CONSUMED).map((f) => join(CONSUMED, f));
  assert.ok(files.length >= 2);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(files[0], old, old);
  mailbox('prune');
  assert.ok(!existsSync(files[0]));
  assert.ok(existsSync(files[1]));
});
test('prune removes an expired consumed handoff and keeps a fresh one', () => { pruned(); });

// --- multiple handoffs: menu, NOT bodies, nothing consumed ---
const menuFire = once(() => {
  pruned();
  const a = join(BOX, 'a.md'); handoff(a, { title: 'First', goal: 'do A', branch: 'feat/a', body: 'BODY-A' });
  mailbox('write', a, CWD);
  const b = join(BOX, 'b.md'); handoff(b, { title: 'Second', goal: 'do B', branch: 'feat/b', body: 'BODY-B' });
  mailbox('write', b, CWD);
  return fire(CWD);
});
test('menu lists both titles', () => {
  const menu = menuFire();
  assert.match(menu.additionalContext, /First/);
  assert.match(menu.additionalContext, /Second/);
});
test('menu is numbered', () => {
  const menu = menuFire();
  assert.match(menu.additionalContext, /\[1\]/);
});
test('menu routes through the skill without a cached executable path', () => {
  const menu = menuFire();
  assert.match(menu.additionalContext, /session-budget skill/);
  assert.doesNotMatch(menu.additionalContext, /mailbox\.mjs|mailbox CLI|plugins\/cache/);
});
test('menu does not dump bodies', () => {
  const menu = menuFire();
  assert.ok(!/BODY-A|BODY-B/.test(menu.additionalContext));
});
test('menu consumes nothing (re-fire still shows menu)', () => {
  menuFire();
  assert.match(fire(CWD).additionalContext, /\[1\]/);
});

// --- cwd isolation: a different project sees no handoffs ---
test('different cwd sees no handoff', () => {
  menuFire();
  assert.strictEqual(fire('/tmp/project-other'), null);
});
