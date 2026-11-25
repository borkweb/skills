import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const MB = join(HERE, 'mailbox.mjs');
const NODE = process.execPath; // robust cross-platform node path
const BOX = mkdtempSync(join(tmpdir(), 'mb-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const run = (...args) =>
  execFileSync(NODE, [MB, ...args], {
    env: { ...process.env, AGENT_HANDOFFS_DIR: BOX },
    encoding: 'utf8',
  });

// Some checks build on earlier mailbox calls. A step runs once and keeps its
// result or error; a test calls the steps it needs, so it also passes when run
// alone.
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

const handoff = (path, o = {}) => {
  const { title = 'Sample work', goal = 'Do the thing', branch = 'feat/sample', body = 'Do the thing.' } = o;
  writeFileSync(path, `---\ntitle: ${title}\ngoal: ${goal}\nwritten_at: 2026-06-10 15:10\nbranch: ${branch}\n---\n# Handoff: ${title}\n## Goal\n${body}\n`);
};

const CWD = '/tmp/project-a';

// --- write ---
const src = join(BOX, 'src.md');
const written = once(() => {
  handoff(src);
  return run('write', src, CWD).trim();
});
test('write prints a stored path', () => {
  const stored = written();
  assert.ok(existsSync(stored));
});
test('write removes the source file', () => {
  written();
  assert.ok(!existsSync(src));
});

// --- single reinit ---
const singleReinit = once(() => {
  written();
  return run('reinit', CWD);
});
test('reinit single emits the handoff body', () => {
  const out = singleReinit();
  assert.match(out, /Do the thing\./);
});
test('reinit single emits a consume token', () => {
  const out = singleReinit();
  assert.match(out, /CONSUME_TOKEN=/);
});

// --- empty ---
test('reinit with no handoffs prints NONE', () => assert.strictEqual(run('reinit', '/tmp/project-zzz').trim(), 'NONE'));

// --- menu (two handoffs, same cwd) ---
const CWD2 = '/tmp/project-b';
const twoHandoffs = once(() => {
  const s1 = join(BOX, 's1.md'); handoff(s1); run('write', s1, CWD2);
  const s2 = join(BOX, 's2.md'); handoff(s2, { title: 'Second task', goal: 'Write the spec', branch: 'feat/second', body: 'Write the spec.' });
  const p2 = run('write', s2, CWD2).trim();
  return { p2, menu: run('reinit', CWD2) };
});
test('menu shows first title', () => {
  const { menu } = twoHandoffs();
  assert.match(menu, /Sample work/);
});
test('menu shows second title', () => {
  const { menu } = twoHandoffs();
  assert.match(menu, /Second task/);
});
test('menu is numbered', () => {
  const { menu } = twoHandoffs();
  assert.match(menu, /\[1\]/);
});
test('menu starts with MENU', () => {
  const { menu } = twoHandoffs();
  assert.match(menu, /^MENU/);
});
test('menu withholds body', () => {
  const { menu } = twoHandoffs();
  assert.ok(!menu.includes('Write the spec.'));
});

// --- show / consume by token ---
const shown = once(() => {
  const tok2 = twoHandoffs().p2.replace(/.*--/, '').replace(/\.md$/, '');
  assert.match(run('show', tok2, CWD2), /Write the spec\./);
  return tok2;
});
test('show emits chosen body', () => { shown(); });
test('after consuming one, the other auto-loads', () => {
  run('consume', shown(), CWD2);
  assert.match(run('reinit', CWD2), /Do the thing\./);
});

// --- TTL prune ---
const CWD3 = '/tmp/project-c';
const stalePruned = once(() => {
  const s3 = join(BOX, 's3.md'); handoff(s3); const p3 = run('write', s3, CWD3).trim();
  const old = new Date('2020-01-01T00:00:00Z'); utimesSync(p3, old, old);
  assert.strictEqual(run('reinit', CWD3).trim(), 'NONE');
  return p3;
});
test('stale handoff is pruned, mailbox reads empty', () => { stalePruned(); });
test('stale handoff file is deleted', () => {
  const p3 = stalePruned();
  assert.ok(!existsSync(p3));
});
test('fresh handoff survives prune', () => {
  stalePruned();
  const s4 = join(BOX, 's4.md'); handoff(s4); run('write', s4, CWD3);
  assert.match(run('reinit', CWD3), /Do the thing\./);
});

// --- default cwd fallback (omit cwd arg -> process.cwd()) ---
test('default cwd: write+reinit round-trips without explicit cwd', () => {
  const sDef = join(BOX, 'sDef.md'); handoff(sDef, { body: 'Default cwd body.' });
  run('write', sDef);            // no cwd -> child process.cwd()
  const defOut = run('reinit');  // no cwd -> same default cwd
  assert.match(defOut, /Default cwd body\./);
});

// --- prune subcommand (global, age-based) ---
const CWD4 = '/tmp/project-d';
const pruneRan = once(() => {
  const sOld = join(BOX, 'sOld.md'); handoff(sOld); const pOld = run('write', sOld, CWD4).trim();
  const oldDate = new Date('2020-01-01T00:00:00Z'); utimesSync(pOld, oldDate, oldDate);
  const sNew = join(BOX, 'sNew.md'); handoff(sNew); const pNew = run('write', sNew, CWD4).trim();
  run('prune');
  return { pOld, pNew };
});
test('prune subcommand deletes stale files', () => {
  const { pOld } = pruneRan();
  assert.ok(!existsSync(pOld));
});
test('prune subcommand keeps fresh files', () => {
  const { pNew } = pruneRan();
  assert.ok(existsSync(pNew));
});
