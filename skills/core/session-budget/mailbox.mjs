#!/usr/bin/env node
// Consume-once handoff mailbox. Usable two ways:
//   - as a CLI:    node mailbox.mjs {write|reinit|show|consume|prune} ...
//   - as a module: import { listFiles, field, age, tokenOf, consumeFile, prune } from './mailbox.mjs'
// The SessionStart reinit hook imports the helpers so there is no duplicated logic.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, utimesSync,
} from 'node:fs';

export const DIR = process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const hash = (cwd) => createHash('sha1').update(cwd).digest('hex').slice(0, 12);
export const tokenOf = (file) => basename(file).replace(/\.md$/, '').split('--').slice(1).join('--');
export const fileFor = (cwd, token) => join(DIR, `${hash(cwd)}--${token}.md`);

export function listFiles(cwd) {
  if (!existsSync(DIR)) return [];
  const prefix = `${hash(cwd)}--`;
  return readdirSync(DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .map((f) => join(DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); // newest first
}

export function field(file, key) {
  const m = readFileSync(file, 'utf8').match(new RegExp(`^${key}: (.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

export function age(file) {
  const secs = (Date.now() - statSync(file).mtimeMs) / 1000;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function genToken() {
  const d = new Date();
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join('');
  return `${t}-${Math.floor(Math.random() * 1e5)}`;
}

// Consumed handoffs are kept here until the TTL, so a handoff that the wrong
// session loaded can still be read back.
export const CONSUMED = join(DIR, 'consumed');

function reap(dir, now) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') && !f.endsWith('.state')) continue;
    const p = join(dir, f);
    try { if (now - statSync(p).mtimeMs > TTL_MS) rmSync(p, { force: true }); } catch { /* raced */ }
  }
}

export function prune() {
  const now = Date.now();
  reap(DIR, now);
  reap(CONSUMED, now);
}

// Take a handoff out of the mailbox. It moves to consumed/ (owner-only) and
// returns the new path. The TTL counts from the consume, not from the write.
// When the move fails the file is deleted, so a handoff is never loaded twice.
export function consumeFile(path) {
  if (!existsSync(path)) return null;
  try {
    mkdirSync(CONSUMED, { recursive: true, mode: 0o700 });
    const dest = join(CONSUMED, basename(path));
    renameSync(path, dest);
    const now = new Date();
    try { utimesSync(dest, now, now); } catch { /* keep the old mtime */ }
    return dest;
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

function write(src, cwd) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const dest = fileFor(cwd, genToken());
  try {
    renameSync(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') { // src on a different filesystem than DIR
      copyFileSync(src, dest);
      rmSync(src, { force: true });
    } else throw e;
  }
  process.stdout.write(`${dest}\n`);
}

function show(token, cwd) {
  const f = fileFor(cwd, token);
  if (!existsSync(f)) {
    process.stderr.write(`no handoff for token ${token}\n`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(f, 'utf8'));
}

function consume(token, cwd) {
  consumeFile(fileFor(cwd, token));
}

function reinit(cwd) {
  prune();
  const files = listFiles(cwd);
  if (files.length === 0) { process.stdout.write('NONE\n'); return; }
  if (files.length === 1) {
    const f = files[0];
    process.stdout.write(readFileSync(f, 'utf8').replace(/\n*$/, '\n'));
    process.stdout.write(`CONSUME_TOKEN=${tokenOf(f)}\n`);
    return;
  }
  let out = `MENU ${files.length} pending handoffs for this project:\n`;
  files.forEach((f, i) => {
    out += `  [${i + 1}] ${tokenOf(f)} "${field(f, 'title')}" — ${field(f, 'goal')} · ${field(f, 'branch')} · ${age(f)} old\n`;
  });
  out += 'Load which? (number, or none)\n';
  process.stdout.write(out);
}

// Run the CLI only when executed directly (node mailbox.mjs ...), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const cwdArg = (i) => rest[i] ?? process.cwd();
  switch (cmd) {
    case 'write':   write(rest[0], cwdArg(1)); break;
    case 'reinit':  reinit(cwdArg(0)); break;
    case 'show':    show(rest[0], cwdArg(1)); break;
    case 'consume': consume(rest[0], cwdArg(1)); break;
    case 'prune':   prune(); break;
    default:
      process.stderr.write('usage: node mailbox.mjs {write|reinit|show|consume|prune} ...\n');
      process.exit(2);
  }
}
