#!/usr/bin/env node
// Persistent, session-keyed offload handoff. Reuses session-budget mailbox.mjs
// helpers (via dir.mjs) for cwd hashing, listing, field parsing, age and prune —
// but NOT the consume-once lifecycle: an offload handoff lives for the whole
// session and is updated in place by the architect (Claude) and builder (codex).
//
//   node handoff.mjs init     <cwd> <sessionId> [title]  -> ensure doc, print path
//   node handoff.mjs path     <cwd> <sessionId>          -> print computed path (no create)
//   node handoff.mjs list     <cwd>                       -> JSONL {path,token,title,branch,status,age}
//   node handoff.mjs reattach <path> <sessionId>          -> refresh claude_session, print path
//   node handoff.mjs status   <path> <value>              -> set status + bump updated
//   node handoff.mjs ready    <path>                      -> status=results-ready + bump updated
//   node handoff.mjs end      <path>                      -> delete doc
//   node handoff.mjs prune                                -> TTL reap
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DIR, fileFor, listFiles, tokenOf, field, age, prune } from './dir.mjs';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'handoff.md');
const nowIso = () => new Date().toISOString();

function setField(body, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(body)) return body.replace(re, () => `${key}: ${value}`);
  return body.replace(/^---\n/, () => `---\n${key}: ${value}\n`); // insert into frontmatter
}

function requireDoc(p) {
  if (!existsSync(p)) { process.stderr.write(`no handoff at ${p}\n`); process.exit(1); }
}

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function init(cwd, sessionId, title) {
  mkdirSync(DIR, { recursive: true });
  const p = fileFor(cwd, sessionId);
  if (!existsSync(p)) {
    let b = readFileSync(TEMPLATE, 'utf8');
    const t = nowIso();
    b = setField(b, 'title', title || '(untitled)');
    b = setField(b, 'cwd', cwd);
    b = setField(b, 'branch', gitBranch(cwd));
    b = setField(b, 'claude_session', sessionId);
    b = setField(b, 'status', 'dispatched');
    b = setField(b, 'created', t);
    b = setField(b, 'updated', t);
    writeFileSync(p, b);
  }
  process.stdout.write(p + '\n');
}

function path(cwd, sessionId) { process.stdout.write(fileFor(cwd, sessionId) + '\n'); }

function list(cwd) {
  prune();
  for (const f of listFiles(cwd)) {
    process.stdout.write(JSON.stringify({
      path: f, token: tokenOf(f), title: field(f, 'title'),
      branch: field(f, 'branch'), status: field(f, 'status'), age: age(f),
    }) + '\n');
  }
}

function reattach(p, sessionId) {
  requireDoc(p);
  let b = readFileSync(p, 'utf8');
  b = setField(b, 'claude_session', sessionId);
  b = setField(b, 'updated', nowIso());
  writeFileSync(p, b);
  process.stdout.write(p + '\n');
}

function setStatus(p, value) {
  requireDoc(p);
  let b = readFileSync(p, 'utf8');
  b = setField(b, 'status', value);
  b = setField(b, 'updated', nowIso());
  writeFileSync(p, b);
}

function end(p) { rmSync(p, { force: true }); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':     init(rest[0], rest[1], rest[2]); break;
    case 'path':     path(rest[0], rest[1]); break;
    case 'list':     list(rest[0] ?? process.cwd()); break;
    case 'reattach': reattach(rest[0], rest[1]); break;
    case 'status':   setStatus(rest[0], rest[1]); break;
    case 'ready':    setStatus(rest[0], 'results-ready'); break;
    case 'end':      end(rest[0]); break;
    case 'prune':    prune(); break;
    default:
      process.stderr.write('usage: handoff.mjs {init|path|list|reattach|status|ready|end|prune} ...\n');
      process.exit(2);
  }
}
