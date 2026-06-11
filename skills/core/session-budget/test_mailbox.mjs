import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

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

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (e) { failed = 1; console.log(`FAIL - ${name}\n       ${e.message}`); }
};

const handoff = (path, o = {}) => {
  const { title = 'Sample work', goal = 'Do the thing', branch = 'feat/sample', body = 'Do the thing.' } = o;
  writeFileSync(path, `---\ntitle: ${title}\ngoal: ${goal}\nwritten_at: 2026-06-10 15:10\nbranch: ${branch}\n---\n# Handoff: ${title}\n## Goal\n${body}\n`);
};

const CWD = '/tmp/project-a';

// --- write ---
const src = join(BOX, 'src.md'); handoff(src);
const stored = run('write', src, CWD).trim();
check('write prints a stored path', () => assert.ok(existsSync(stored)));
check('write removes the source file', () => assert.ok(!existsSync(src)));

// --- single reinit ---
const out = run('reinit', CWD);
check('reinit single emits the handoff body', () => assert.match(out, /Do the thing\./));
check('reinit single emits a consume token', () => assert.match(out, /CONSUME_TOKEN=/));

// --- empty ---
check('reinit with no handoffs prints NONE', () => assert.strictEqual(run('reinit', '/tmp/project-zzz').trim(), 'NONE'));

// --- menu (two handoffs, same cwd) ---
const CWD2 = '/tmp/project-b';
const s1 = join(BOX, 's1.md'); handoff(s1); run('write', s1, CWD2);
const s2 = join(BOX, 's2.md'); handoff(s2, { title: 'Second task', goal: 'Write the spec', branch: 'feat/second', body: 'Write the spec.' });
const p2 = run('write', s2, CWD2).trim();
const menu = run('reinit', CWD2);
check('menu shows first title', () => assert.match(menu, /Sample work/));
check('menu shows second title', () => assert.match(menu, /Second task/));
check('menu is numbered', () => assert.match(menu, /\[1\]/));
check('menu starts with MENU', () => assert.match(menu, /^MENU/));
check('menu withholds body', () => assert.ok(!menu.includes('Write the spec.')));

// --- show / consume by token ---
const tok2 = p2.replace(/.*--/, '').replace(/\.md$/, '');
check('show emits chosen body', () => assert.match(run('show', tok2, CWD2), /Write the spec\./));
run('consume', tok2, CWD2);
check('after consuming one, the other auto-loads', () => assert.match(run('reinit', CWD2), /Do the thing\./));

// --- TTL prune ---
const CWD3 = '/tmp/project-c';
const s3 = join(BOX, 's3.md'); handoff(s3); const p3 = run('write', s3, CWD3).trim();
const old = new Date('2020-01-01T00:00:00Z'); utimesSync(p3, old, old);
check('stale handoff is pruned, mailbox reads empty', () => assert.strictEqual(run('reinit', CWD3).trim(), 'NONE'));
check('stale handoff file is deleted', () => assert.ok(!existsSync(p3)));
const s4 = join(BOX, 's4.md'); handoff(s4); run('write', s4, CWD3);
check('fresh handoff survives prune', () => assert.match(run('reinit', CWD3), /Do the thing\./));

// --- default cwd fallback (omit cwd arg -> process.cwd()) ---
const sDef = join(BOX, 'sDef.md'); handoff(sDef, { body: 'Default cwd body.' });
run('write', sDef);            // no cwd -> child process.cwd()
const defOut = run('reinit');  // no cwd -> same default cwd
check('default cwd: write+reinit round-trips without explicit cwd', () => assert.match(defOut, /Default cwd body\./));

// --- prune subcommand (global, age-based) ---
const CWD4 = '/tmp/project-d';
const sOld = join(BOX, 'sOld.md'); handoff(sOld); const pOld = run('write', sOld, CWD4).trim();
const oldDate = new Date('2020-01-01T00:00:00Z'); utimesSync(pOld, oldDate, oldDate);
const sNew = join(BOX, 'sNew.md'); handoff(sNew); const pNew = run('write', sNew, CWD4).trim();
run('prune');
check('prune subcommand deletes stale files', () => assert.ok(!existsSync(pOld)));
check('prune subcommand keeps fresh files', () => assert.ok(existsSync(pNew)));

process.exit(failed);
