#!/usr/bin/env node
// PreToolUse guard that offload's SKILL.md registers in its frontmatter, so it is
// active only after the offload skill loads (Claude Code only; Codex keeps the
// prose rule). The architect does not write implementation code, so an Edit,
// Write, MultiEdit or NotebookEdit is refused when its target is a file git
// does not ignore inside a checkout that is on a branch: the main checkout or a
// builder's worktree.
//
// Allowed: paths outside any git checkout (handoffs, run directories, temp
// specs), anything under AGENT_HANDOFFS_DIR, git-ignored files, and detached
// worktrees, where the architect runs its throwaway mutation checks.
//
// The user can lift the guard for one session with `touch <marker>`; the refusal
// prints the exact command. This is a guard against drift, not a security
// boundary: Bash can still write files, and every error allows the edit.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const HANDOFFS = process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs');
const TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const allow = () => process.exit(0);

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

function real(p) {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function nearestDir(p) {
  let d = dirname(p);
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return d;
}

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { allow(); }
if (input?.hook_event_name !== 'PreToolUse' || !TOOLS.has(input.tool_name)) allow();

const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (typeof raw !== 'string' || raw === '') allow();

const session = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
const marker = join(HANDOFFS, 'architect-guard', `allow-${session}`);
if (existsSync(marker)) allow();

const target = isAbsolute(raw) ? raw : resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd(), raw);
const dir = nearestDir(target);
if (!dir) allow();
const realTarget = join(real(dir), relative(dir, target));
if (inside(realTarget, real(HANDOFFS))) allow();

const top = git(dir, ['rev-parse', '--show-toplevel']);
if (!top) allow(); // not in a git checkout
const branch = git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
if (!branch) allow(); // detached HEAD: a throwaway mutation-check worktree
try {
  execFileSync('git', ['-C', top, 'check-ignore', '-q', '--', realTarget], { stdio: 'ignore', timeout: 3000 });
  allow(); // exit 0: ignored
} catch (e) {
  if (e.status !== 1) allow(); // 1 means not ignored; anything else is an error
}

process.stderr.write(
  `architect-guard: offload made this session the ARCHITECT, and the architect does not write implementation code. ` +
  `${realTarget} is a tracked or trackable file in ${top} on branch ${branch}. ` +
  `Write a tighter slice or a corrective for the builder instead. ` +
  `A mutation check belongs in a throwaway detached worktree (git worktree add --detach), which this guard allows. ` +
  `If the user explicitly told you to edit this file yourself, ask them to lift the guard for this session by running: ! mkdir -p "${dirname(marker)}" && touch "${marker}"\n`,
);
process.exit(2);
