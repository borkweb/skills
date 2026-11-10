#!/usr/bin/env node
// repo-rules-key.mjs — print the per-repo rules key for a repo, or its store dir.
//
//   node repo-rules-key.mjs [path]          -> key, e.g. github.a8c.com/automattic/wpcom
//   node repo-rules-key.mjs --dir [path]    -> <store root>/<key>
//
// The key is the normalized `origin` URL: scheme, user, password, port, trailing
// .git and letter case dropped, so SSH and HTTPS forms of one repo agree. With no
// origin it is local/<16 hex of sha256(realpath of git's common dir)>, which every
// worktree of the repo shares. The store root is $BORK_REPO_RULES_DIR or
// ~/.agent-handoffs/repo-rules. This script only reads: it never creates the store.
// It fails closed (nonzero, empty stdout) and never echoes a remote URL, which can
// carry a token. It deliberately does not import offload/dir.mjs, which rewrites
// AGENT_HANDOFFS_DIR.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const die = (msg, code = 1) => {
  process.stderr.write(`repo-rules-key: ${msg}\n`);
  process.exit(code);
};

// An inherited GIT_DIR (git hooks, `submodule foreach`) would override the path argument.
const GIT_ENV = { ...process.env };
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete GIT_ENV[v];

const git = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function normalize(url) {
  let s = url.trim().toLowerCase();
  let host;
  let path;
  const scheme = s.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) {
    s = s.slice(scheme[0].length);
    const slash = s.indexOf('/');
    if (slash < 0) return null;
    host = s.slice(0, slash).replace(/^.*@/, '').replace(/:\d*$/, '');
    path = s.slice(slash + 1);
  } else {
    const scp = s.match(/^(?:[^@/]*@)?([^:/]+):(.*)$/);
    if (!scp) return null;
    [, host, path] = scp;
  }
  const segments = [host, ...path.replace(/\/+$/, '').replace(/\.git$/, '').split('/')];
  const ok = segments.length >= 3 && segments.every((p) => /^[a-z0-9._-]+$/.test(p) && p !== '.' && p !== '..');
  return ok ? segments.join('/') : null;
}

function keyFor(dir) {
  let common;
  try {
    common = realpathSync(resolve(dir, git(dir, ['rev-parse', '--git-common-dir'])));
  } catch {
    die('not a git repository, or the path does not exist');
  }
  let origin = '';
  try {
    origin = git(dir, ['config', '--get', 'remote.origin.url']);
  } catch {
    // No origin: fall back to the common dir below.
  }
  if (!origin) return `local/${createHash('sha256').update(common).digest('hex').slice(0, 16)}`;
  return normalize(origin) || die('origin URL is not a host/owner/repo form; no key');
}

const args = process.argv.slice(2);
const wantDir = args.includes('--dir');
const paths = args.filter((a) => a !== '--dir');
if (paths.length > 1) die('usage: repo-rules-key.mjs [--dir] [path]', 2);

const key = keyFor(paths[0] || process.cwd());
if (!wantDir) {
  process.stdout.write(`${key}\n`);
} else {
  const root = resolve(process.env.BORK_REPO_RULES_DIR || join(homedir(), '.agent-handoffs', 'repo-rules'));
  process.stdout.write(`${join(root, key)}\n`);
}
