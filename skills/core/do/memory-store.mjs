#!/usr/bin/env node
// memory-store.mjs — print the Claude Code auto memory directory for a repo, or its session transcripts.
//
//   node memory-store.mjs [path]                             -> <config dir>/projects/<project>/memory
//   node memory-store.mjs --sessions [--since YYYY-MM-DD] [path]
//                                                            -> one transcript path per line, newest first
//
// Claude Code derives <project> from the git repository, so every worktree and subdirectory of a repo
// shares one store: <project> is the real path of the main checkout with each character that is not a
// letter or a digit replaced by '-'. Outside a git repo the path itself is used. The config dir is
// $CLAUDE_CONFIG_DIR or ~/.claude. --sessions lists only the transcripts in that same project directory;
// a session started inside a worktree is filed under the worktree's own path and is not listed.
//
// This script only reads. It prints the store path even when the store does not exist yet. It fails
// closed (nonzero, empty stdout) when the location cannot be derived from the path alone: a bare repo,
// CLAUDE_CODE_PROJECT_DIR_NAME, or an autoMemoryDirectory setting in the user or project settings.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const die = (msg, code = 1) => {
  process.stderr.write(`memory-store: ${msg}\n`);
  process.exit(code);
};

// An inherited GIT_DIR (git hooks, `submodule foreach`) would override the path argument.
const GIT_ENV = { ...process.env };
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete GIT_ENV[v];

const args = process.argv.slice(2);
const usage = () => die('usage: memory-store.mjs [--sessions [--since YYYY-MM-DD]] [path]', 2);
let wantSessions = false;
let since = null;
const paths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sessions') wantSessions = true;
  else if (args[i] === '--since') {
    since = args[++i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since || '') || Number.isNaN(Date.parse(since))) usage();
  } else if (args[i].startsWith('--')) usage();
  else paths.push(args[i]);
}
if (paths.length > 1 || (since && !wantSessions)) usage();

let start;
try {
  start = realpathSync(resolve(paths[0] || process.cwd()));
} catch {
  die('the path does not exist');
}

let root = start;
try {
  const common = realpathSync(
    resolve(start, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: start, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()),
  );
  if (basename(common) !== '.git') die('a bare repository has no main checkout; no store');
  root = dirname(common);
} catch {
  // Not a git repository: Claude Code uses the project root itself.
}

if (process.env.CLAUDE_CODE_PROJECT_DIR_NAME) die('CLAUDE_CODE_PROJECT_DIR_NAME is set; the store is not derived from the path');
const config = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
for (const f of [join(config, 'settings.json'), join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')]) {
  if (!existsSync(f)) continue;
  let custom;
  try {
    custom = JSON.parse(readFileSync(f, 'utf8')).autoMemoryDirectory;
  } catch {
    die(`cannot read ${f}; the store location is unknown`);
  }
  if (custom) die(`autoMemoryDirectory is set in ${f}; the store is not derived from the path`);
}

const project = join(config, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
if (!wantSessions) {
  process.stdout.write(`${join(project, 'memory')}\n`);
} else {
  const floor = since ? Date.parse(`${since}T00:00:00`) : 0;
  let names = [];
  try {
    names = readdirSync(project).filter((n) => n.endsWith('.jsonl'));
  } catch {
    // No project directory: no sessions.
  }
  const rows = names
    .map((n) => ({ file: join(project, n), mtime: statSync(join(project, n)).mtimeMs }))
    .filter((r) => r.mtime >= floor)
    .sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : 1));
  for (const r of rows) process.stdout.write(`${r.file}\n`);
}
