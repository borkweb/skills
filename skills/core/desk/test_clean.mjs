// test_clean.mjs — `clean` and set's cleanup hook: a done or failed run loses its git
// worktrees and keeps its text files; anything git could lose stays.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkRepo, mkRun, newBox, run, sleep, writeRec } from './testkit.mjs';

const b = newBox();
const ok = (r, msg) => assert.equal(r.code, 0, `${msg ?? ''} exit ${r.code}: ${r.err}`);
const gitEnv = { PATH: '/usr/bin:/bin', HOME: b.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: gitEnv });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// A finished run with: a clean branch worktree, a dirty one, one with an orphaned
// commit, a clean one full of ignored files, a full clone and a plain notes file.
function fixture(name, state = 'done') {
  const repo = mkRepo(b, `repo-${name}`);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore');
  const { id, dir } = mkRun(b, { slug: name });
  if (state !== 'running') writeRec(dir, { state });
  writeFileSync(join(dir, 'notes.md'), 'notes\n');
  mkdirSync(join(dir, 'pr-1'));
  writeFileSync(join(dir, 'pr-1', 'fixes.patch'), 'patch\n');
  git(repo, 'worktree', 'add', '-q', '-b', `clean-${name}`, join(dir, 'pr-1', 'worktree'));
  git(repo, 'worktree', 'add', '-q', '-b', `dirty-${name}`, join(dir, 'dirty'));
  writeFileSync(join(dir, 'dirty', 'f.txt'), 'changed\n');
  git(repo, 'worktree', 'add', '-q', '--detach', join(dir, 'orphan'));
  writeFileSync(join(dir, 'orphan', 'new.txt'), 'n\n');
  git(join(dir, 'orphan'), 'add', 'new.txt');
  git(join(dir, 'orphan'), 'commit', '-q', '-m', 'orphan');
  git(repo, 'worktree', 'add', '-q', '-b', `deps-${name}`, join(dir, 'wt'));
  mkdirSync(join(dir, 'wt', 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'wt', 'node_modules', 'pkg', 'index.js'), '1\n');
  git(repo, 'worktree', 'add', '-q', '-b', `lavish-${name}`, join(dir, 'lavish'));
  mkdirSync(join(dir, 'lavish', '.lavish'));
  writeFileSync(join(dir, 'lavish', '.lavish', 'session.json'), '{}\n');
  git(dir, 'clone', '-q', repo, join(dir, 'clone'));
  return { id, dir, repo, name };
}

const byPath = (rows) => Object.fromEntries(rows.map((r) => [r.path, r]));

test('clean removes clean linked worktrees, keeps every one git could lose, and keeps text files', () => {
  const f = fixture('a');
  const r = run(b, ['clean', f.id, '--json']);
  ok(r);
  const rows = byPath(JSON.parse(r.out)[0].results);
  assert.equal(rows['pr-1/worktree'].action, 'removed');
  assert.equal(rows['pr-1/worktree'].branch, 'clean-a');
  assert.equal(rows.wt.action, 'removed', 'ignored files do not block removal');
  assert.equal(rows.lavish.action, 'removed', 'an untracked .lavish/ alone is scratch');
  assert.deepEqual([rows.dirty.action, rows.dirty.reason], ['kept', 'uncommitted changes']);
  assert.deepEqual([rows.orphan.action, rows.orphan.reason], ['kept', 'commits that no branch or remote holds']);
  assert.deepEqual([rows.clone.action, rows.clone.reason], ['kept', 'a full clone, not a linked worktree']);
  assert.ok(!existsSync(join(f.dir, 'pr-1', 'worktree')) && !existsSync(join(f.dir, 'wt')));
  for (const p of ['notes.md', 'pr-1/fixes.patch', 'run.json', 'dirty/f.txt', 'orphan/new.txt', 'clone/f.txt']) assert.ok(existsSync(join(f.dir, p)), `${p} stays`);
  assert.match(git(f.repo, 'branch', '--list', 'clean-a'), /clean-a/, 'the branch stays in the main repo');
  assert.doesNotMatch(git(f.repo, 'worktree', 'list'), /pr-1\/worktree/, 'git forgets the removed worktree');
  const log = readFileSync(join(f.dir, 'cleanup.log'), 'utf8');
  assert.match(log, /removed pr-1\/worktree branch clean-a head [0-9a-f]{40}/);
  assert.match(log, /kept dirty: uncommitted changes/);
});

test('--dry-run reports and changes nothing; a run that is not finished is refused', () => {
  const f = fixture('b');
  const r = run(b, ['clean', f.id, '--dry-run']);
  ok(r);
  assert.match(r.out, /would remove pr-1\/worktree \(branch clean-b\)/);
  assert.ok(existsSync(join(f.dir, 'pr-1', 'worktree', 'f.txt')));
  assert.ok(!existsSync(join(f.dir, 'cleanup.log')));
  const live = fixture('c', 'running');
  const refused = run(b, ['clean', live.id]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /only a done or failed run is cleaned/);
  assert.ok(existsSync(join(live.dir, 'pr-1', 'worktree', 'f.txt')));
});

test('--all cleans done and failed runs and skips the rest; a builder may not clean', () => {
  const done = fixture('d');
  const failed = fixture('e', 'failed');
  const blocked = fixture('f', 'blocked');
  assert.equal(run(b, ['clean', '--all'], { OFFLOAD_HANDOFF: '/x' }).code, 1);
  assert.ok(existsSync(join(done.dir, 'pr-1', 'worktree')));
  ok(run(b, ['clean', '--all']));
  assert.ok(!existsSync(join(done.dir, 'pr-1', 'worktree')));
  assert.ok(!existsSync(join(failed.dir, 'pr-1', 'worktree')));
  assert.ok(existsSync(join(blocked.dir, 'pr-1', 'worktree', 'f.txt')), 'a blocked run can reopen; it keeps its worktree');
  assert.equal(run(b, ['clean', '--all', done.id]).code, 2);
});

test('set --state done cleans the run in the background; set --state blocked does not', async () => {
  const f = fixture('g', 'running');
  ok(run(b, ['set', f.id, '--state', 'blocked', '--summary', 's']));
  await sleep(500);
  assert.ok(existsSync(join(f.dir, 'pr-1', 'worktree')));
  ok(run(b, ['reopen', f.id]));
  const r = run(b, ['set', f.id, '--state', 'done', '--summary', 'shipped']);
  ok(r);
  assert.equal(r.out.trim(), `${f.id} done`, 'set output is unchanged');
  for (let i = 0; i < 100 && existsSync(join(f.dir, 'pr-1', 'worktree')); i++) await sleep(100);
  assert.ok(!existsSync(join(f.dir, 'pr-1', 'worktree')));
  assert.ok(existsSync(join(f.dir, 'dirty', 'f.txt')));
});
