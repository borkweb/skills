#!/usr/bin/env node
// Persistent, session-keyed offload handoff. Reuses session-budget mailbox.mjs
// helpers (via dir.mjs) for cwd hashing, listing, field parsing, age and prune —
// but NOT the consume-once lifecycle: an offload handoff lives for the whole
// session and is updated in place by the architect (Claude) and builder (codex).
//
//   node handoff.mjs resolve  <cwd>                       -> canonical path for $CLAUDE_CODE_SESSION_ID (create if missing)
//   node handoff.mjs init     <cwd> <sessionId> [title]  -> ensure doc, print path
//   node handoff.mjs path     <cwd> <sessionId>          -> print computed path (no create)
//   node handoff.mjs list     <cwd>                       -> JSONL {path,token,title,branch,status,age}
//   node handoff.mjs reattach <path> <sessionId> [--steal] -> take over doc for sessionId, print path
//   node handoff.mjs status   <path> <value> [--steal]     -> set status + bump updated (ownership-guarded)
//   node handoff.mjs ready    <path> [--steal]             -> status=results-ready + bump updated (ownership-guarded)
//   node handoff.mjs end      <path>                      -> delete doc
//   node handoff.mjs prune                                -> TTL reap
//
// Ownership guard: every MUTATING write (resolve/status/ready/reattach) is keyed
// to a session id. The id is taken from $CLAUDE_CODE_SESSION_ID (or, for reattach,
// the explicit arg). A write to a doc whose `claude_session` frontmatter does NOT
// match that id is REFUSED (non-zero exit) unless `--steal` is passed. This makes
// a silent wrong-document write impossible — the failure mode that motivated it
// was the loop re-deriving a path under an empty/foreign session id (e.g. the
// codex builder's own session) and clobbering or minting the wrong file.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DIR, fileFor, listFiles, tokenOf, field, age, prune } from './dir.mjs';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'handoff.md');
const nowIso = () => new Date().toISOString();

function setField(body, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(body)) return body.replace(re, () => `${key}: ${value}`);
  return body.replace(/^---\n/, () => `---\n${key}: ${value}\n`); // insert into frontmatter
}

function die(msg) { process.stderr.write(msg.replace(/\n*$/, '\n')); process.exit(1); }

function requireDoc(p) {
  if (!p) die('refusing: no handoff path given');
  if (!existsSync(p)) die(`no handoff at ${p}`);
}

// Trimmed session id, or '' when unset/blank. A blank id can never key a file:
// `hash(cwd)--.md` is a degenerate path that silently collides across sessions.
function cleanSession(id) { return (id == null ? '' : String(id)).trim(); }
const envSession = () => cleanSession(process.env.CLAUDE_CODE_SESSION_ID);

function requireSession(id, hint) {
  const s = cleanSession(id);
  if (!s) {
    die(
      'refusing: empty session id — cannot key a handoff to no session.\n' +
      (hint || 'Set $CLAUDE_CODE_SESSION_ID (or pass an explicit session id).'),
    );
  }
  return s;
}

// The session id recorded in a doc's frontmatter, or '' if absent/unreadable.
function ownerOf(p) {
  try { return cleanSession(field(p, 'claude_session')); } catch { return ''; }
}

// Refuse to mutate a doc that belongs to a different session. An empty owner
// (legacy/malformed doc) is permitted — only a definite id-vs-id mismatch blocks.
function assertOwner(p, expected, steal, action) {
  const owner = ownerOf(p);
  if (owner && expected && owner !== expected && !steal) {
    die(
      `refusing to ${action}: handoff at ${p}\n` +
      `  is owned by session ${owner}\n` +
      `  but this caller is session ${expected}.\n` +
      'This is the wrong-document tripwire. If the takeover is intentional, ' +
      're-run with --steal. Otherwise resolve YOUR own handoff with: ' +
      `node handoff.mjs resolve "<cwd>"`,
    );
  }
}

function hasFlag(rest, flag) { return rest.includes(flag); }
function positional(rest) { return rest.filter((a) => !a.startsWith('--')); }

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

// Create a doc at the canonical path for (cwd, sessionId) if absent. Returns path.
function ensureDoc(cwd, sessionId, title) {
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
  return p;
}

// Canonical entrypoint: the ONE handoff for this session, derived from the
// environment so the loop never re-derives a path by hand. Errors loudly if the
// session is unknown rather than minting a degenerate file.
function resolve(cwd, title) {
  const sid = requireSession(
    envSession(),
    '`resolve` reads the session from $CLAUDE_CODE_SESSION_ID, which is empty here.',
  );
  process.stdout.write(ensureDoc(cwd, sid, title) + '\n');
}

function init(cwd, sessionId, title) {
  const sid = requireSession(sessionId);
  process.stdout.write(ensureDoc(cwd, sid, title) + '\n');
}

function path(cwd, sessionId) {
  const sid = requireSession(sessionId);
  process.stdout.write(fileFor(cwd, sid) + '\n');
}

function list(cwd) {
  prune();
  for (const f of listFiles(cwd)) {
    process.stdout.write(JSON.stringify({
      path: f, token: tokenOf(f), title: field(f, 'title'),
      branch: field(f, 'branch'), status: field(f, 'status'), age: age(f),
    }) + '\n');
  }
}

// The filename token IS the owning session id (fileFor keys on it), so taking
// over a doc means RENAMING it to the new session's canonical path — otherwise a
// later `resolve` (which recomputes the path from the session) would diverge from
// the reattached file and mint a fresh empty doc. We reuse the existing hash
// prefix from the filename rather than re-hashing the cwd, so the file stays put
// for the same repo and only the token changes.
function reattach(p, sessionId, steal) {
  requireDoc(p);
  const sid = requireSession(sessionId);
  const owner = ownerOf(p);
  if (owner && owner !== sid && !steal) {
    die(
      `refusing to reattach: handoff at ${p}\n` +
      `  is currently owned by session ${owner}.\n` +
      `Taking it over for ${sid} is a deliberate act — re-run with --steal.`,
    );
  }
  const hashPrefix = basename(p).split('--')[0];
  const dest = join(dirname(p), `${hashPrefix}--${sid}.md`);
  if (dest !== p && existsSync(dest)) {
    die(
      `refusing to reattach: a handoff for session ${sid} already exists at\n  ${dest}\n` +
      'Reattaching here would clobber it. Resolve your own handoff instead: ' +
      'node handoff.mjs resolve "<cwd>"',
    );
  }
  let b = readFileSync(p, 'utf8');
  b = setField(b, 'claude_session', sid);
  b = setField(b, 'updated', nowIso());
  writeFileSync(p, b);
  if (dest !== p) {
    renameSync(p, dest);
    process.stderr.write(`reattach: ownership ${owner || '(none)'} -> ${sid}; moved to ${dest}\n`);
  }
  process.stdout.write(dest + '\n');
}

function setStatus(p, value, steal) {
  requireDoc(p);
  const expected = requireSession(
    envSession(),
    'A status write must verify ownership against $CLAUDE_CODE_SESSION_ID, which is empty here.',
  );
  assertOwner(p, expected, steal, `set status=${value} on`);
  let b = readFileSync(p, 'utf8');
  b = setField(b, 'status', value);
  b = setField(b, 'updated', nowIso());
  writeFileSync(p, b);
}

function end(p) { rmSync(p, { force: true }); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const pos = positional(rest);
  const steal = hasFlag(rest, '--steal');
  switch (cmd) {
    case 'resolve':  resolve(pos[0] ?? process.cwd(), pos[1]); break;
    case 'init':     init(pos[0], pos[1], pos[2]); break;
    case 'path':     path(pos[0], pos[1]); break;
    case 'list':     list(pos[0] ?? process.cwd()); break;
    case 'reattach': reattach(pos[0], pos[1], steal); break;
    case 'status':   setStatus(pos[0], pos[1], steal); break;
    case 'ready':    setStatus(pos[0], 'results-ready', steal); break;
    case 'end':      end(pos[0]); break;
    case 'prune':    prune(); break;
    default:
      process.stderr.write('usage: handoff.mjs {resolve|init|path|list|reattach|status|ready|end|prune} ...\n');
      process.exit(2);
  }
}
