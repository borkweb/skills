// test_repo_rules_key.mjs — drives repo-rules-key.mjs only as a child process,
// against real `git init` / `git worktree add` repos in a temp dir. The child
// env is built from scratch (no GIT_DIR leaks, empty global git config, temp
// HOME and store root), so a run never touches the real ~/.agent-handoffs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test, { after } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = join(HERE, 'repo-rules-key.mjs');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'rrk-')));
const HOME = join(BOX, 'home');
const ROOT = join(BOX, 'store');
mkdirSync(HOME);
writeFileSync(join(BOX, 'gitconfig'), '');
after(() => rmSync(BOX, { recursive: true, force: true }));

const ENV = {
  PATH: process.env.PATH,
  HOME,
  GIT_CONFIG_GLOBAL: join(BOX, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: BOX,
  BORK_REPO_RULES_DIR: ROOT,
};

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let n = 0;
const repo = (origin) => {
  const d = join(BOX, `repo-${n++}`);
  mkdirSync(d);
  git(d, 'init', '-q');
  git(d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git(d, 'remote', 'add', 'origin', origin);
  return d;
};

const run = (args, { cwd, env = ENV } = {}) => {
  const r = spawnSync(process.execPath, [KEY, ...args], { env, cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const keyOf = (dir) => {
  const r = run([dir]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.endsWith('\n') && r.out.trim() && !r.out.trim().includes('\n'), `one line expected: ${r.out}`);
  return r.out.trim();
};
// A missing or crashing script also exits 1 with empty stdout, so require the script's own message.
const refused = (r) => {
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.out, '');
  assert.ok(r.err.startsWith('repo-rules-key: '), `refusal must come from the script: ${r.err}`);
};
const localKey = (commonDir) => `local/${createHash('sha256').update(realpathSync(commonDir)).digest('hex').slice(0, 16)}`;

const WPCOM = 'github.a8c.com/automattic/wpcom';

test('SCP SSH remote gives host/owner/repo, lowercased, .git stripped (C2a)', () => {
  assert.strictEqual(run([repo('git@github.a8c.com:Automattic/wpcom.git')]).out, `${WPCOM}\n`);
});

test('HTTPS remote gives the same key as the SCP form (C2b)', () => {
  assert.strictEqual(keyOf(repo('https://github.a8c.com/Automattic/wpcom.git')), WPCOM);
});

test('ssh:// remote gives the same key as the SCP form (C2c)', () => {
  assert.strictEqual(keyOf(repo('ssh://git@github.a8c.com/Automattic/wpcom.git')), WPCOM);
});

test('remote without .git keeps the path (C2d)', () => {
  assert.strictEqual(keyOf(repo('https://github.com/borkweb/skills')), 'github.com/borkweb/skills');
});

test('a port and a trailing slash are dropped', () => {
  assert.strictEqual(keyOf(repo('ssh://git@github.a8c.com:2222/Automattic/wpcom.git')), WPCOM);
  assert.strictEqual(keyOf(repo('https://GitHub.A8C.com:8443/Automattic/wpcom/')), WPCOM);
});

test('a token in the remote never reaches stdout or stderr (C4)', () => {
  const ok = run([repo('https://x-access-token:S2SECRETMARK@github.com/o/r.git')]);
  assert.strictEqual(ok.out, 'github.com/o/r\n');
  const bad = run([repo('https://x-access-token:S2SECRETMARK@github.com/o/../r.git')]);
  refused(bad);
  // The script lowercases the URL, so a leak could be lowercased too.
  for (const text of [ok.out, ok.err, bad.out, bad.err]) assert.ok(!text.toLowerCase().includes('s2secretmark'));
});

test('a . or .. segment, an empty segment, a two-segment remote or a local-path remote is refused', () => {
  for (const origin of ['https://github.com/o/../r.git', 'https://github.com/o/./r.git', 'https://github.com//r.git', '/srv/git/r.git', 'https://github.com/o/r%2Fx.git', 'https://github.com/r.git', 'https://local/0123456789abcdef']) {
    refused(run([repo(origin)]));
  }
});

test('no remote: key is local/<16 hex of sha256 of the absolute realpath of the common dir> (C5a, D4-G2)', () => {
  const d = repo();
  const k = keyOf(d);
  assert.strictEqual(k, localKey(join(d, '.git')));
  assert.match(k, /^local\/[0-9a-f]{16}$/);
  assert.notStrictEqual(k, keyOf(repo()), 'a relative .git would give every repo one key');
});

test('no remote: a symlinked path and its realpath give one key (C5d)', () => {
  const d = repo();
  const link = join(BOX, 'link');
  symlinkSync(d, link);
  assert.strictEqual(keyOf(link), keyOf(d));
  // BOX is already a realpath; tmpdir() is /var/... where /var is a symlink to /private/var on macOS.
  assert.strictEqual(keyOf(join(tmpdir(), basename(BOX), basename(d))), keyOf(d));
});

test('no remote: main checkout and a linked worktree share one key (C5b)', () => {
  const d = repo();
  const wt = join(BOX, 'wt-link');
  git(d, 'worktree', 'add', '-q', wt, '-b', 'side');
  assert.strictEqual(keyOf(wt), keyOf(d));
});

test('a subdirectory gives the same key as the root (C5c)', () => {
  const d = repo();
  mkdirSync(join(d, 'a', 'b'), { recursive: true });
  assert.strictEqual(keyOf(join(d, 'a', 'b')), keyOf(d));
});

test('outside a git repo, or on a missing path, it fails closed (C6a, C6b)', () => {
  const plain = join(BOX, 'plain');
  mkdirSync(plain);
  refused(run([plain]));
  refused(run([join(BOX, 'no-such-dir')]));
});

test('no argument uses the cwd (C7a)', () => {
  const d = repo('git@github.a8c.com:Automattic/wpcom.git');
  assert.strictEqual(run([], { cwd: d }).out, run([d]).out);
  assert.strictEqual(run([], { cwd: d }).out, `${WPCOM}\n`);
});

test('--dir prints <store root>/<key> under the root and creates nothing', () => {
  const d = repo('git@github.a8c.com:Automattic/wpcom.git');
  const r = run(['--dir', d]);
  assert.strictEqual(r.out, `${join(ROOT, WPCOM)}\n`);
  const nr = repo();
  const fb = run(['--dir', nr]).out.trim();
  assert.ok(fb.startsWith(ROOT + sep));
  assert.strictEqual(fb, join(ROOT, keyOf(nr)));
  assert.ok(!existsSync(ROOT), 'KEY must not create the store');
});

test('--dir with BORK_REPO_RULES_DIR unset uses $HOME/.agent-handoffs/repo-rules', () => {
  const env = { ...ENV };
  delete env.BORK_REPO_RULES_DIR;
  const d = repo('https://github.com/o/r.git');
  assert.strictEqual(run(['--dir', d], { env }).out, `${join(HOME, '.agent-handoffs', 'repo-rules', 'github.com/o/r')}\n`);
});

test('an inherited GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR cannot override the path argument (P4)', () => {
  const target = repo('https://github.com/o/target.git');
  const other = repo('https://github.com/o/other.git');
  const env = { ...ENV, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: join(other, '.git') };
  assert.strictEqual(run([target], { env }).out, 'github.com/o/target\n');
});

test('bad usage exits 2 with empty stdout', () => {
  const r = run(['a', 'b']);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.out, '');
});
