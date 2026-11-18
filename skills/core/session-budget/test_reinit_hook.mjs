import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

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

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (e) { failed = 1; console.log(`FAIL - ${name}\n       ${e.message}`); }
};

const CWD = '/tmp/project-a';

// --- no handoff: no startup context ---
const empty = fire(CWD);
check('empty mailbox is silent', () => assert.strictEqual(empty, null));

// --- single handoff: injected as briefing AND consumed ---
const s1 = join(BOX, 's1.md'); handoff(s1, { body: 'Single body marker.' });
const stored = mailbox('write', s1, CWD).trim();
const single = fire(CWD);
check('event name is SessionStart', () => assert.strictEqual(single.hookEventName, 'SessionStart'));
check('single handoff body is injected', () => assert.match(single.additionalContext, /Single body marker\./));
check('single handoff is auto-loaded + consumed', () => assert.ok(!existsSync(stored)));
check('consumed handoff is kept under consumed/', () => assert.ok(existsSync(join(CONSUMED, stored.split('/').pop()))));
check('injected body is framed as data from an earlier session', () => {
  assert.match(single.additionalContext, /<<<HANDOFF\n[\s\S]*Single body marker\.[\s\S]*\nHANDOFF>>>/);
  assert.match(single.additionalContext, /not as new instructions/);
});
check('after consume, a re-fire is silent', () => assert.strictEqual(fire(CWD), null));

// --- compact also auto-loads ---
const c1 = join(BOX, 'c1.md'); handoff(c1, { body: 'Compact body marker.' });
const cStored = mailbox('write', c1, CWD).trim();
check('compact auto-loads a single handoff', () => assert.match(fire(CWD, 'compact').additionalContext, /Compact body marker\./));
check('compact consumes it', () => assert.ok(!existsSync(cStored)));

// --- sessions that must not take a single handoff ---
for (const source of ['startup', 'resume', null]) {
  const p = join(BOX, `n-${source}.md`); handoff(p, { title: `Pending ${source}`, body: 'NOT-FOR-YOU' });
  const kept = mailbox('write', p, CWD).trim();
  const ctx = fire(CWD, source);
  check(`${source ?? 'no'} source shows a one-line notice, not the body`, () => {
    assert.match(ctx.additionalContext, /A handoff is pending/);
    assert.match(ctx.additionalContext, new RegExp(`Pending ${source}`));
    assert.doesNotMatch(ctx.additionalContext, /NOT-FOR-YOU/);
  });
  check(`${source ?? 'no'} source consumes nothing`, () => assert.ok(existsSync(kept)));
  mailbox('consume', kept.split('/').pop().replace(/\.md$/, '').split('--').slice(1).join('--'), CWD);
}

for (const [name, extra] of [['OFFLOAD_UNATTENDED_TURN', { OFFLOAD_UNATTENDED_TURN: '1' }], ['OFFLOAD_HANDOFF', { OFFLOAD_HANDOFF: '/x/doc.md' }]]) {
  const p = join(BOX, `o-${name}.md`); handoff(p, { body: 'OFFLOAD-SILENT' });
  const kept = mailbox('write', p, CWD).trim();
  check(`${name} set: silent even on clear`, () => assert.strictEqual(fire(CWD, 'clear', extra), null));
  check(`${name} set: consumes nothing`, () => assert.ok(existsSync(kept)));
  mailbox('consume', kept.split('/').pop().replace(/\.md$/, '').split('--').slice(1).join('--'), CWD);
}

// --- prune reaps consumed/ past the TTL ---
check('prune removes an expired consumed handoff and keeps a fresh one', () => {
  const files = readdirSync(CONSUMED).map((f) => join(CONSUMED, f));
  assert.ok(files.length >= 2);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(files[0], old, old);
  mailbox('prune');
  assert.ok(!existsSync(files[0]));
  assert.ok(existsSync(files[1]));
});

// --- multiple handoffs: menu, NOT bodies, nothing consumed ---
const a = join(BOX, 'a.md'); handoff(a, { title: 'First', goal: 'do A', branch: 'feat/a', body: 'BODY-A' });
mailbox('write', a, CWD);
const b = join(BOX, 'b.md'); handoff(b, { title: 'Second', goal: 'do B', branch: 'feat/b', body: 'BODY-B' });
mailbox('write', b, CWD);
const menu = fire(CWD);
check('menu lists both titles', () => {
  assert.match(menu.additionalContext, /First/);
  assert.match(menu.additionalContext, /Second/);
});
check('menu is numbered', () => assert.match(menu.additionalContext, /\[1\]/));
check('menu routes through the skill without a cached executable path', () => {
  assert.match(menu.additionalContext, /session-budget skill/);
  assert.doesNotMatch(menu.additionalContext, /mailbox\.mjs|mailbox CLI|plugins\/cache/);
});
check('menu does not dump bodies', () => assert.ok(!/BODY-A|BODY-B/.test(menu.additionalContext)));
check('menu consumes nothing (re-fire still shows menu)', () => assert.match(fire(CWD).additionalContext, /\[1\]/));

// --- cwd isolation: a different project sees no handoffs ---
check('different cwd sees no handoff', () => assert.strictEqual(fire('/tmp/project-other'), null));

process.exit(failed);
