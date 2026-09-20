// The journal is authoritative. The replaceable snapshot is only a convenience.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { requireThat, text } from './policy.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const defaultRoot = () => resolve(process.env.BORK_DO_STATE_DIR || join(homedir(), '.bork', 'do', 'runs'));
export function ensurePrivateDirectory(path) {
  const absolute = resolve(path);
  let cursor = absolute;
  while (!existsSync(cursor)) { const parent = dirname(cursor); requireThat(parent !== cursor, 'cannot resolve state directory'); cursor = parent; }
  requireThat(realpathSync(cursor) === cursor, 'state directory ancestors must not be symlinks');
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  requireThat(realpathSync(absolute) === absolute, 'state directory must not be a symlink');
  return absolute;
}
export function readRun(dir) {
  const journal = join(resolve(dir), 'events.jsonl');
  requireThat(!lstatSync(journal).isSymbolicLink(), 'journal must not be a symlink');
  const raw = readFileSync(journal, 'utf8');
  requireThat(raw.endsWith('\n'), 'incomplete journal tail; preserve files and recover explicitly');
  let previous = null; let state;
  for (const line of raw.trimEnd().split('\n')) {
    const event = JSON.parse(line);
    requireThat(event.previous === previous, 'journal chain mismatch');
    requireThat(event.digest === hash(JSON.stringify({ previous: event.previous, state: event.state })), 'journal digest mismatch');
    requireThat(event.state.schemaVersion === 1 && event.state.revision === (state?.revision ?? -1) + 1, 'unsupported state schema or invalid revision');
    state = event.state; previous = event.digest;
  }
  requireThat(state && state.runDir === resolve(dir), 'run path mismatch');
  return { state, digest: previous };
}
function save(dir, state, previous) {
  const body = { previous, state };
  const line = JSON.stringify({ ...body, digest: hash(JSON.stringify(body)) }) + '\n';
  const fd = openSync(join(dir, 'events.jsonl'), 'a', 0o600);
  try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
  const tmp = join(dir, `snapshot-${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(tmp, join(dir, 'state.json'));
}
export function createRun(root, repo, initial) {
  // Reject the target before mkdir; even an invalid start must not edit source.
  requireThat(resolve(root) !== repo && !resolve(root).startsWith(repo + sep), 'run state must be outside the task repository');
  const base = ensurePrivateDirectory(root);
  requireThat(base !== repo && !base.startsWith(repo + sep), 'run state must be outside the task repository');
  const runId = randomUUID(); const dir = join(base, runId);
  mkdirSync(dir, { mode: 0o700 });
  const state = { ...initial, schemaVersion: 1, runId, runDir: dir, revision: 0 };
  save(dir, state, null); return state;
}
export function transact(dir, owner, revision, operation) {
  text(owner, 'owner'); requireThat(Number.isSafeInteger(revision), 'revision is required');
  const absolute = realpathSync(dir);
  requireThat(absolute === resolve(dir), 'run directory must not be a symlink');
  requireThat(!existsSync(join(absolute, 'recovery.lock')), 'lock recovery is in progress');
  const lock = join(absolute, 'writer.lock'); let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('writer lock exists; never steal a live or unknown lock. Use recover-lock after confirming its local process exited.');
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() })); fsyncSync(fd);
    const { state, digest } = readRun(absolute);
    requireThat(state.owner === owner, 'controller ownership mismatch');
    requireThat(state.revision === revision, `stale revision: current is ${state.revision}`);
    const next = structuredClone(state); operation(next);
    next.revision++; next.updated = new Date().toISOString(); save(absolute, next, digest); return next;
  } finally { closeSync(fd); unlinkSync(lock); }
}
export function recoverLock(dir) {
  const lock = join(realpathSync(dir), 'writer.lock');
  requireThat(!lstatSync(lock).isSymbolicLink(), 'invalid writer lock');
  const raw = readFileSync(lock, 'utf8'); const data = JSON.parse(raw);
  requireThat(data.host === hostname() && Number.isSafeInteger(data.pid) && data.pid > 0, 'unknown lock owner; preserve and inspect manually');
  try { process.kill(data.pid, 0); throw new Error('lock process is still alive'); } catch (error) { requireThat(error.code === 'ESRCH', 'lock owner is alive or cannot be verified'); }
  // A competing recovery can only remove this stale lock, never a replacement.
  requireThat(readFileSync(lock, 'utf8') === raw, 'lock changed while recovering');
  // Recovery itself uses a separate exclusive guard; ordinary writers respect it.
  const guard = join(realpathSync(dir), 'recovery.lock'); const fd = openSync(guard, 'wx', 0o600);
  try { requireThat(readFileSync(lock, 'utf8') === raw, 'lock changed while recovering'); unlinkSync(lock); }
  finally { closeSync(fd); unlinkSync(guard); }
  return { recovered: true };
}
