import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const env = { ...process.env, AGENT_HANDOFFS_DIR: BOX };
const mailbox = (...args) => execFileSync(NODE, [MB, ...args], { env, encoding: 'utf8' });

const handoff = (path, o = {}) => {
  const { title = 'Sample work', goal = 'Do the thing', branch = 'feat/sample', body = 'Do the thing.' } = o;
  writeFileSync(path, `---\ntitle: ${title}\ngoal: ${goal}\nwritten_at: 2026-06-10 15:10\nbranch: ${branch}\n---\n# Handoff: ${title}\n## Goal\n${body}\n`);
};

// Fire the SessionStart hook with a given cwd; returns the parsed additionalContext.
const fire = (cwd) => {
  const out = execFileSync(NODE, [HOOK], {
    input: JSON.stringify({ session_id: 's', cwd, hook_event_name: 'SessionStart', source: 'clear' }),
    env, encoding: 'utf8',
  });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};

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
check('after consume, a re-fire is silent', () => assert.strictEqual(fire(CWD), null));

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
