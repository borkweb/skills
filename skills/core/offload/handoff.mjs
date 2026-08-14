#!/usr/bin/env node
// Persistent, session-keyed offload handoff. Reuses session-budget mailbox.mjs
// helpers (via dir.mjs) for cwd hashing, listing, field parsing, age and prune —
// but NOT the consume-once lifecycle: an offload handoff lives for the whole
// session and is updated in place by the architect (Claude) and the dispatched builder.
//
//   node handoff.mjs resolve  <cwd>                       -> canonical path for $CLAUDE_CODE_SESSION_ID (create if missing)
//   node handoff.mjs init     <cwd> <sessionId> [title]  -> ensure doc, print path
//   node handoff.mjs path     <cwd> <sessionId>          -> print computed path (no create)
//   node handoff.mjs list     <cwd>                       -> JSONL {path,token,title,branch,status,age}
//   node handoff.mjs reattach <path> <sessionId> [--steal] -> take over doc for sessionId, print path
//   node handoff.mjs status   <path> <value> [--steal]     -> set status + bump updated (ownership-guarded)
//   node handoff.mjs ready    <path> [--steal]             -> status=results-ready + bump updated (ownership-guarded)
//   node handoff.mjs blocked  <path> [--steal]             -> status=blocked + bump updated (ownership-guarded); the
//                                                             builder calls this before stopping on a mid-slice blocker
//                                                             so the wait bridge wakes the architect to arbitrate
//   node handoff.mjs end      <path>                      -> delete doc
//   node handoff.mjs prune                                -> TTL reap + orphaned-sidecar sweep
//
//   node handoff.mjs section  get   <path> <heading>                 -> print one section's body
//   node handoff.mjs section  append|set <path> <heading> [--text s|--file f]
//   node handoff.mjs section  clear <path> <heading>
//     Section writes are ownership-guarded exactly like status writes. They exist
//     so the architect stops hand-splicing markdown with ad-hoc regex — that is a
//     corruption surface on the one file the loop trusts. With no --text/--file,
//     the body is read from stdin.
//
//   node handoff.mjs ledger   {init|path|show|add|set|goal} <cwd> ...  -> the architect's slice ledger
//   node handoff.mjs board    <cwd> [--json] [--no-git]                -> reconciled roll-up of every slice
//     See ledger.mjs. The ledger is the ONLY place a slice's terminal state
//     lives; `board` reconciles it against each doc, builder pid and bridge so
//     "finished and exited" can never keep reading as "running".
//
// Ownership guard: every MUTATING write (resolve/status/ready/reattach) is keyed
// to a session id. The id is taken from $CLAUDE_CODE_SESSION_ID (or, for reattach,
// the explicit arg). A write to a doc whose `claude_session` frontmatter does NOT
// match that id is REFUSED (non-zero exit) unless `--steal` is passed. This makes
// a silent wrong-document write impossible — the failure mode that motivated it
// was the loop re-deriving a path under an empty/foreign session id (e.g. the
// builder's own session) and clobbering or minting the wrong file.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DIR, fileFor, listFiles, tokenOf, field, age, prune } from './dir.mjs';
import {
  SLICE_STATES, addSlice, initLedger, ledgerFor, pruneLedgers, readLedger,
  renderBoard, setGoal, setSlice,
} from './ledger.mjs';

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
    // A doc that exists is not a builder that is running. The architect flips
    // this to `dispatched` at dispatch time (offload SKILL step 6); starting it
    // there made every not-yet-launched slice read as in-flight.
    b = setField(b, 'status', 'specced');
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

// `status` is the ONE field the wait bridge and every progress readout key on.
// It used to accept anything, including `undefined` from a call that forgot its
// value — which wrote `status: undefined`, exited 0, and permanently broke the
// bridge's `results-ready`/`blocked` matching on that doc. Validate or refuse.
function setStatus(p, value, steal) {
  requireDoc(p);
  if (value === undefined || value === null || String(value).trim() === '') {
    die(
      'refusing: `status` needs a value.\n' +
      `usage: handoff.mjs status <path> <${SLICE_STATES.join('|')}>`,
    );
  }
  const v = String(value).trim();
  if (!SLICE_STATES.includes(v)) {
    die(
      `refusing: "${v}" is not a valid status.\n` +
      `valid: ${SLICE_STATES.join(' | ')}\n` +
      'An unrecognized status is invisible to the wait bridge — it would wait forever.',
    );
  }
  const expected = requireSession(
    envSession(),
    'A status write must verify ownership against $CLAUDE_CODE_SESSION_ID, which is empty here.',
  );
  assertOwner(p, expected, steal, `set status=${v} on`);
  let b = readFileSync(p, 'utf8');
  b = setField(b, 'status', v);
  b = setField(b, 'updated', nowIso());
  writeFileSync(p, b);
}

// --- sections -------------------------------------------------------------
// A section is `## <heading>` through the line before the next `## ` (or EOF).

const SIDECAR_SUFFIXES = ['.builder', '.activity', '.turn-ended'];

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

function splitSection(body, heading) {
  const re = new RegExp(`^## ${reEscape(heading)}[ \\t]*$`, 'm');
  const m = re.exec(body);
  if (!m) return null;
  const bodyStart = m.index + m[0].length + 1;
  const rest = body.slice(bodyStart);
  const next = /^## /m.exec(rest);
  const bodyEnd = next ? bodyStart + next.index : body.length;
  return { headStart: m.index, bodyStart, bodyEnd };
}

function requireSection(p, heading) {
  const body = readFileSync(p, 'utf8');
  const span = splitSection(body, heading);
  if (!span) {
    const found = [...body.matchAll(/^## (.+)$/gm)].map((x) => x[1].trim());
    die(`no "## ${heading}" section in ${p}\nsections present: ${found.join(', ') || '(none)'}`);
  }
  return { body, span };
}

function sectionGet(p, heading) {
  requireDoc(p);
  const { body, span } = requireSection(p, heading);
  process.stdout.write(`${body.slice(span.bodyStart, span.bodyEnd).replace(/\n*$/, '\n')}`);
}

function readPayload(rest) {
  const i = rest.indexOf('--text');
  if (i !== -1 && rest[i + 1] !== undefined) return rest[i + 1];
  const j = rest.indexOf('--file');
  if (j !== -1 && rest[j + 1] !== undefined) return readFileSync(rest[j + 1], 'utf8');
  // Only fall back to stdin when something is actually piped in — reading fd 0
  // on a TTY would hang the caller with no indication why.
  if (process.stdin.isTTY) return '';
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function sectionWrite(p, heading, text, mode, steal) {
  requireDoc(p);
  const expected = requireSession(
    envSession(),
    'A section write must verify ownership against $CLAUDE_CODE_SESSION_ID, which is empty here.',
  );
  assertOwner(p, expected, steal, `write section "${heading}" of`);
  const { body, span } = requireSection(p, heading);
  const current = body.slice(span.bodyStart, span.bodyEnd);
  const payload = String(text ?? '').replace(/\n*$/, '');
  let next;
  if (mode === 'clear') next = '\n';
  else if (mode === 'set') next = payload ? `\n${payload}\n\n` : '\n';
  else next = `${current.replace(/\n*$/, '')}\n${payload}\n\n`.replace(/^\n*/, '\n');
  let out = body.slice(0, span.bodyStart) + next + body.slice(span.bodyEnd);
  out = setField(out, 'updated', nowIso());
  writeFileSync(p, out);
}

// prune() only knows .md/.state, so every dispatch left its .builder/.activity/
// .turn-ended sidecars behind forever. A stale .builder holding a recycled pid
// makes the liveness check report a dead builder as alive.
function pruneSidecars() {
  const gone = [];
  if (!existsSync(DIR)) return gone;
  for (const f of readdirSync(DIR)) {
    const suffix = SIDECAR_SUFFIXES.find((s) => f.endsWith(s));
    if (!suffix) continue;
    const base = join(DIR, f.slice(0, -suffix.length));
    if (!existsSync(base)) { rmSync(join(DIR, f), { force: true }); gone.push(f); }
  }
  return gone;
}

function pruneAll() {
  prune(); // TTL reap of .md/.state (shared mailbox helper)
  const sidecars = pruneSidecars();
  const ledgers = pruneLedgers(7 * 24 * 60 * 60 * 1000);
  const reaped = [...sidecars, ...ledgers];
  if (reaped.length) process.stderr.write(`pruned ${reaped.length} orphaned file(s): ${reaped.join(', ')}\n`);
}

// --- ledger + board -------------------------------------------------------

// --id 3 --title "x" --state dispatched  ->  {id:'3', title:'x', state:'dispatched'}
// --slice-cwd maps to `cwd` so it never collides with the ledger's own root cwd.
function flagFields(rest) {
  const f = {};
  const map = {
    '--id': 'id', '--title': 'title', '--branch': 'branch', '--slice-cwd': 'cwd',
    '--handoff': 'handoff', '--pane': 'pane', '--state': 'state', '--verdict': 'verdict',
    '--pr': 'pr', '--note': 'note',
  };
  for (let i = 0; i < rest.length; i++) {
    const key = map[rest[i]];
    if (key && rest[i + 1] !== undefined) { f[key] = rest[i + 1]; i++; }
  }
  return f;
}

function ledgerCmd(rest) {
  const [sub, ...args] = rest;
  const pos = positional(args);
  const sid = requireSession(envSession(), 'The ledger is keyed to $CLAUDE_CODE_SESSION_ID, which is empty here.');
  const cwd = pos[0] ?? process.cwd();
  switch (sub) {
    case 'init': process.stdout.write(`${initLedger(cwd, sid, pos[1])}\n`); break;
    case 'path': process.stdout.write(`${ledgerFor(cwd, sid)}\n`); break;
    case 'show': {
      const l = readLedger(ledgerFor(cwd, sid));
      if (!l) die(`no ledger for this session.\nStart one: handoff.mjs ledger init "${cwd}" "<goal>"`);
      process.stdout.write(`${JSON.stringify(l, null, 2)}\n`);
      break;
    }
    case 'add': process.stdout.write(`${JSON.stringify(addSlice(cwd, sid, flagFields(args)))}\n`); break;
    case 'set': {
      if (!pos[1]) die('usage: handoff.mjs ledger set <cwd> <slice-id> --state <state> [...]');
      process.stdout.write(`${JSON.stringify(setSlice(cwd, sid, pos[1], flagFields(args)))}\n`);
      break;
    }
    case 'goal': {
      if (!pos[1]) die('usage: handoff.mjs ledger goal <cwd> "<goal text>"');
      setGoal(cwd, sid, pos[1]);
      break;
    }
    default:
      process.stderr.write('usage: handoff.mjs ledger {init|path|show|add|set|goal} <cwd> ...\n');
      process.exit(2);
  }
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
    case 'blocked':  setStatus(pos[0], 'blocked', steal); break;
    case 'end':      end(pos[0]); break;
    case 'prune':    pruneAll(); break;
    case 'section': {
      const [sub, ...args] = rest;
      const sp = positional(args);
      if (!sp[0] || !sp[1]) {
        process.stderr.write('usage: handoff.mjs section {get|append|set|clear} <path> <heading> [--text s|--file f]\n');
        process.exit(2);
      }
      if (sub === 'get') sectionGet(sp[0], sp[1]);
      else if (sub === 'append' || sub === 'set') sectionWrite(sp[0], sp[1], readPayload(args), sub, steal);
      else if (sub === 'clear') sectionWrite(sp[0], sp[1], '', 'clear', steal);
      else {
        process.stderr.write('usage: handoff.mjs section {get|append|set|clear} <path> <heading> [--text s|--file f]\n');
        process.exit(2);
      }
      break;
    }
    case 'ledger':   ledgerCmd(rest); break;
    case 'board': {
      const sid = requireSession(envSession(), 'The board is keyed to $CLAUDE_CODE_SESSION_ID, which is empty here.');
      process.stdout.write(renderBoard(pos[0] ?? process.cwd(), sid, {
        json: hasFlag(rest, '--json'),
        withGit: !hasFlag(rest, '--no-git'),
      }));
      break;
    }
    default:
      process.stderr.write(
        'usage: handoff.mjs {resolve|init|path|list|reattach|status|ready|blocked|end|prune|section|ledger|board} ...\n',
      );
      process.exit(2);
  }
}
