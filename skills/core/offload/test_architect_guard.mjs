// Tests for architect-guard.mjs against a real temporary git repo.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'architect-guard.mjs');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'ag-')));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const ENV = {
  PATH: process.env.PATH, HOME: join(BOX, 'home'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
mkdirSync(ENV.HOME);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, stdio: 'pipe', encoding: 'utf8' });

const REPO = join(BOX, 'repo');
mkdirSync(join(REPO, 'src'), { recursive: true });
git(BOX, 'init', '-q', '-b', 'main', REPO);
writeFileSync(join(REPO, 'src', 'app.js'), 'x\n');
writeFileSync(join(REPO, '.gitignore'), 'notes/\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-q', '-m', 'init');
const BUILDER = join(BOX, 'wt-builder');
git(REPO, 'worktree', 'add', '-q', '-b', 'slice-1', BUILDER);
const MUTATION = join(BOX, 'wt-mutation');
git(REPO, 'worktree', 'add', '-q', '--detach', MUTATION);
const HANDOFFS = join(REPO, 'handoffs-inside-repo'); // a handoffs dir that happens to sit in a checkout
const OUTSIDE = join(BOX, 'plain');
mkdirSync(OUTSIDE);

const fire = (payload, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [GUARD], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...ENV, AGENT_HANDOFFS_DIR: HANDOFFS, ...extraEnv }, encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr, out: r.stdout };
};
const edit = (file_path, tool_name = 'Edit', extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path }, session_id: 'sess-1', cwd: REPO, ...extra,
});
const blocked = (r) => { assert.strictEqual(r.code, 2, `expected block, got ${r.code}: ${r.err}`); assert.match(r.err, /architect-guard/); };
const allowed = (r) => { assert.strictEqual(r.code, 0, `expected allow, got ${r.code}: ${r.err}`); assert.strictEqual(r.out, ''); };

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (e) { failed = 1; console.log(`FAIL - ${name}\n       ${e.message}`); }
};

check('tracked file in the main checkout is blocked', () => blocked(fire(edit(join(REPO, 'src', 'app.js')))));
check('refusal names the branch and the exact lift command', () => {
  const r = fire(edit(join(REPO, 'src', 'app.js')));
  assert.match(r.err, /on branch main/);
  assert.match(r.err, /touch ".*architect-guard\/allow-sess-1"/);
});
check('a new untracked file in a new directory is blocked', () => blocked(fire(edit(join(REPO, 'src', 'new', 'deep.js'), 'Write'))));
check('a builder worktree on a branch is blocked', () => blocked(fire(edit(join(BUILDER, 'src', 'app.js'), 'MultiEdit'))));
check('a relative path resolves against the hook cwd', () => blocked(fire(edit('src/app.js'))));
check('NotebookEdit uses notebook_path', () => blocked(fire({ hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: join(REPO, 'n.ipynb') }, session_id: 's', cwd: REPO })));
check('a detached mutation worktree is allowed', () => allowed(fire(edit(join(MUTATION, 'src', 'app.js')))));
check('a git-ignored file is allowed', () => allowed(fire(edit(join(REPO, 'notes', 'scratch.md'), 'Write'))));
check('a path outside any checkout is allowed', () => allowed(fire(edit(join(OUTSIDE, 'spec.md'), 'Write'))));
check('the handoffs dir is allowed even inside a checkout', () => allowed(fire(edit(join(HANDOFFS, 'runs', 'x', 'notes.md'), 'Write'))));
check('the session marker lifts the guard for that session only', () => {
  mkdirSync(join(HANDOFFS, 'architect-guard'), { recursive: true });
  writeFileSync(join(HANDOFFS, 'architect-guard', 'allow-sess-1'), '');
  allowed(fire(edit(join(REPO, 'src', 'app.js'))));
  blocked(fire(edit(join(REPO, 'src', 'app.js'), 'Edit', { session_id: 'sess-2' })));
});
check('other tools, other events and bad input are allowed', () => {
  allowed(fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, session_id: 's2', cwd: REPO }));
  allowed(fire({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(REPO, 'src', 'app.js') }, session_id: 's2' }));
  allowed(fire('not json'));
  allowed(fire({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, session_id: 's2' }));
});
check('git unavailable allows the edit (fails open by design)', () => {
  allowed(fire(edit(join(REPO, 'src', 'app.js'), 'Edit', { session_id: 's3' }), { PATH: '/nonexistent' }));
});

process.exit(failed);
