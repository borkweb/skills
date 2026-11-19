// test_memory_store.mjs — drives memory-store.mjs only as a child process, against real `git init` and
// `git worktree add` repos in a temp dir. The child env is built from scratch (temp HOME and config dir,
// empty global git config), so a run never reads the real ~/.claude.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test, { after } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'memory-store.mjs');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'mst-')));
const HOME = join(BOX, 'home');
const CONFIG = join(BOX, 'config');
mkdirSync(HOME);
mkdirSync(CONFIG);
writeFileSync(join(BOX, 'gitconfig'), '');
after(() => rmSync(BOX, { recursive: true, force: true }));

const ENV = {
  PATH: process.env.PATH,
  HOME,
  CLAUDE_CONFIG_DIR: CONFIG,
  GIT_CONFIG_GLOBAL: join(BOX, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: BOX,
};

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};
const run = (args, env = ENV) => spawnSync('node', [SCRIPT, ...args], { env, encoding: 'utf8' });
const encode = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const storeOf = (root) => join(CONFIG, 'projects', encode(root), 'memory');

let n = 0;
const repo = (name = `repo-${n++}`) => {
  const d = join(BOX, name);
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-q');
  git(d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  return d;
};

test('a repo, its subdirectory and its worktree share one store', () => {
  const d = repo();
  mkdirSync(join(d, 'sub'));
  const wt = join(BOX, `wt-${n++}`);
  git(d, 'worktree', 'add', '-q', '--detach', wt);
  for (const p of [d, join(d, 'sub'), wt]) {
    const r = run([p]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, `${storeOf(d)}\n`);
  }
});

test('every character that is not a letter or digit becomes a dash', () => {
  const d = repo('.dot_and space');
  const r = run([d]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().endsWith('--dot-and-space/memory'), r.stdout);
});

test('outside a git repo the path itself names the store', () => {
  const d = join(BOX, 'plain');
  mkdirSync(d);
  assert.strictEqual(run([d]).stdout, `${storeOf(d)}\n`);
});

test('a custom memory location fails closed with empty stdout', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'));
  writeFileSync(join(d, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '~/elsewhere' }));
  const r = run([d]);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /autoMemoryDirectory/);

  const named = run([repo()], { ...ENV, CLAUDE_CODE_PROJECT_DIR_NAME: 'shared' });
  assert.notStrictEqual(named.status, 0);
  assert.strictEqual(named.stdout, '');

  const broken = repo();
  mkdirSync(join(broken, '.claude'));
  writeFileSync(join(broken, '.claude', 'settings.json'), '{ not json');
  assert.notStrictEqual(run([broken]).status, 0);
});

test('a bare repo and a missing path fail closed', () => {
  const bare = join(BOX, 'bare.git');
  mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  for (const p of [bare, join(BOX, 'nope')]) {
    const r = run([p]);
    assert.notStrictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  }
});

test('--sessions lists transcripts newest first and --since drops older ones', () => {
  const d = repo();
  const project = dirname(storeOf(d));
  mkdirSync(join(project, 'memory'), { recursive: true });
  const at = (name, iso) => {
    const f = join(project, name);
    writeFileSync(f, '{}\n');
    const t = new Date(iso);
    utimesSync(f, t, t);
    return f;
  };
  const old = at('old.jsonl', '2026-01-05T12:00:00');
  const mid = at('mid.jsonl', '2026-03-10T12:00:00');
  const recent = at('new.jsonl', '2026-03-20T12:00:00');
  at('notes.txt', '2026-03-20T12:00:00');
  writeFileSync(join(project, 'memory', 'MEMORY.md'), '');

  assert.strictEqual(run(['--sessions', d]).stdout, `${recent}\n${mid}\n${old}\n`);
  assert.strictEqual(run(['--sessions', '--since', '2026-03-10', d]).stdout, `${recent}\n${mid}\n`);
  assert.strictEqual(run(['--sessions', repo()]).stdout, '');
});

test('bad arguments exit 2', () => {
  for (const a of [['--since', '2026-03-10'], ['--sessions', '--since', 'yesterday'], ['--nope'], ['a', 'b']]) {
    assert.strictEqual(run(a).status, 2, a.join(' '));
  }
});
