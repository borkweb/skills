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
//   node handoff.mjs coverage <path>                      -> print the frozen criterion IDs that have no line under
//                                                             Gate results, one per line; exit 0 when all are covered,
//                                                             4 when some are missing. Read-only, needs no session.
//                                                             `ready` and `status results-ready` run the same check
//                                                             and refuse with `incomplete:` (exit 4), after ownership
//                                                             and even with --steal; it checks coverage, not freshness
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
//   node handoff.mjs ledger   {init|path|show|add|set|goal|report} <cwd> ...  -> the architect's slice ledger
//   node handoff.mjs board    <cwd> [--json] [--no-git] [--no-pane]    -> reconciled roll-up of every slice
//     See ledger.mjs. The ledger is the ONLY place a slice's terminal state
//     lives; `board` reconciles it against each doc, builder pid, bridge and the
//     provenance of its herdr pane, so "finished and exited" can never keep
//     reading as "running" and a builder started outside dispatch.sh cannot
//     masquerade as a dispatched slice.
//
// Ownership guard: every MUTATING write (resolve/status/ready/reattach) is keyed
// to a session id. The id is taken from $CLAUDE_CODE_SESSION_ID (or, for reattach,
// the explicit arg). A write to a doc whose `claude_session` frontmatter does NOT
// match that id is REFUSED (non-zero exit) unless `--steal` is passed. This makes
// a silent wrong-document write impossible — the failure mode that motivated it
// was the loop re-deriving a path under an empty/foreign session id (e.g. the
// builder's own session) and clobbering or minting the wrong file.
//
// A dispatched builder writes its handoff as the architect. Claude Code replaces
// an inherited $CLAUDE_CODE_SESSION_ID with the builder's own session id inside
// its tool calls, so dispatch.sh also carries the architect's id in
// $OFFLOAD_SESSION_ID. Status and section writes honor that id only for the one
// doc named in $OFFLOAD_HANDOFF; every other doc still keys on the caller's own
// session, so the tripwire holds everywhere else.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DIR, fileFor, listFiles, tokenOf, field, age, prune } from './dir.mjs';
import {
  SLICE_STATES, addSlice, allLedgers, clearHalt, initLedger, readHalt, setHalt, ledgerFor, pruneLedgers, readLedger, renderReport, renderVerdicts, reportLedger,
  renderBoard, setGoal, setSlice,
} from './ledger.mjs';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'handoff.md');
const nowIso = () => new Date().toISOString();

function setField(body, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(body)) return body.replace(re, () => `${key}: ${value}`);
  return body.replace(/^---\n/, () => `---\n${key}: ${value}\n`); // insert into frontmatter
}

function die(msg, code = 1) { process.stderr.write(msg.replace(/\n*$/, '\n')); process.exit(code); }

function requireDoc(p) {
  if (!p) die('refusing: no handoff path given');
  if (!existsSync(p)) die(`no handoff at ${p}`);
}

// Trimmed session id, or '' when unset/blank. A blank id can never key a file:
// `hash(cwd)--.md` is a degenerate path that silently collides across sessions.
function cleanSession(id) { return (id == null ? '' : String(id)).trim(); }
const envSession = () => {
  const claude = cleanSession(process.env.CLAUDE_CODE_SESSION_ID);
  if (claude) return claude;
  const codex = cleanSession(process.env.CODEX_SESSION_ID);
  if (!codex) return '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(codex)) die('refusing: invalid Codex session id');
  return `codex:${codex}`;
};

function setOwner(body, sessionId) {
  body = setField(body, 'architect_session', sessionId);
  // Preserve legacy Claude readers without mislabelling a Codex native identity.
  return setField(body, 'claude_session', sessionId.startsWith('codex:') ? '' : sessionId);
}

// One canonical spelling of a path, so `/a/./b.md` and a symlinked tmpdir name
// the same doc.
function canonicalPath(p) {
  const abs = resolvePath(String(p));
  try { return realpathSync(abs); } catch { return abs; }
}

// The session a status or section write to `p` is checked against: the
// architect id dispatch.sh carried in $OFFLOAD_SESSION_ID when `p` is the
// builder's assigned $OFFLOAD_HANDOFF, else the caller's own session.
function writerSession(p) {
  const carried = cleanSession(process.env.OFFLOAD_SESSION_ID);
  const assigned = cleanSession(process.env.OFFLOAD_HANDOFF);
  if (carried && assigned && canonicalPath(assigned) === canonicalPath(p)) return carried;
  return envSession();
}

function requireSession(id, hint) {
  const s = cleanSession(id);
  if (!s) {
    die(
      'refusing: empty session id — cannot key a handoff to no session.\n' +
      (hint || 'Provide a native $CLAUDE_CODE_SESSION_ID or $CODEX_SESSION_ID (or pass an explicit session id).'),
    );
  }
  return s;
}

// The session id recorded in a doc's frontmatter, or '' if absent/unreadable.
function ownerOf(p) {
  try { return cleanSession(field(p, 'architect_session')) || cleanSession(field(p, 'claude_session')); } catch { return ''; }
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
    b = setOwner(b, sessionId);
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
    '`resolve` reads the session from $CLAUDE_CODE_SESSION_ID or $CODEX_SESSION_ID, both empty here.',
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
  b = setOwner(b, sid);
  b = setField(b, 'updated', nowIso());
  writeFileSync(p, b);
  if (dest !== p) {
    renameSync(p, dest);
    process.stderr.write(`reattach: ownership ${owner || '(none)'} -> ${sid}; moved to ${dest}\n`);
  }
  process.stdout.write(dest + '\n');
}

// The architect and a builder both write the same doc (status, Next slice,
// Gate results). A plain read-modify-write lets one writer silently drop the
// other's edit, and a half-written doc would be read as truth. So: read, apply
// the change, re-read just before writing, and retry on the fresh text if
// someone else wrote in between; then write a temp file and rename it over the
// doc so a reader never sees a partial write.
export function updateDoc(p, transform, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const before = readFileSync(p, 'utf8');
    const next = transform(before);
    if (readFileSync(p, 'utf8') !== before) continue;
    const tmp = `${p}.tmp-${process.pid}-${i}`;
    writeFileSync(tmp, next);
    renameSync(tmp, p);
    return next;
  }
  die(`refusing: ${p} kept changing under this write (${tries} tries). Re-read it and retry.`);
  return null;
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
    writerSession(p),
    'A status write must verify ownership against $CLAUDE_CODE_SESSION_ID or $CODEX_SESSION_ID, both empty here.',
  );
  assertOwner(p, expected, steal, `set status=${v} on`);
  // Coverage runs on the same text the write replaces, so the check and the
  // write cannot see different docs. --steal reaches only assertOwner above.
  updateDoc(p, (b) => {
    if (v === 'results-ready') {
      const missing = missingCriteria(b);
      if (missing.length) die(incompleteMessage(missing), 4);
    }
    return setField(setField(b, 'status', v), 'updated', nowIso());
  });
}

// --- criterion coverage ---------------------------------------------------
// An ID is `C<digits><optional lowercase letter>` and counts only as the first
// token of a line: after leading space and an optional list marker (`-`, `*`,
// `1.`), table pipe, `**` or backtick. A leading ID followed by another ID
// (separated by space, `,`, `;`, `/`, `&`, `+`, a dash, `and`, `or`, `to` or
// `through`) counts for none, so a line that lists IDs or a range covers none
// of them. A comment starts only where `<!--` is the first text on a line and
// runs to the next `-->`; with no `-->` left it ends at the next blank line, so a
// stray opener cannot swallow the rest of the doc. A `<!--` in the middle of a
// line (in a code span, say) is plain text. dispatch-slice.sh freezes with a
// copy of these two patterns; test_dispatch_slice.mjs asserts they agree.
const ID_FIRST = /^\s*(?:(?:[-*]|\d+[.)])\s+)?(?:\|\s*)?(?:\*\*|`)?(C\d+[a-z]?)(?![A-Za-z0-9_])(?!(?:\s*(?:[-–—/,;&+]|and\b|or\b|to\b|through\b)\s*|\s+)C\d)/;
const COMMENT = /^[ \t]*<!--(?:[\s\S]*?-->|[^\n]*(?:\n(?![ \t]*(?:\n|$))[^\n]*)*)/gm;

// The IDs that lead a line of `text`, in order, ignoring CRLF and comments.
function leadingIds(text) {
  const plain = text.replace(/\r\n?/g, '\n').replace(COMMENT, (m) => m.replace(/[^\n]/g, ''));
  return plain.split('\n').map((l) => ID_FIRST.exec(l)?.[1]).filter(Boolean);
}

// The body of `## <heading>` in LF text, '' when the heading is absent. The
// heading must match exactly, so a CRLF doc has to be normalized first or its
// Frozen gates would silently vanish (a fail-open).
function sectionText(text, heading) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.replace(/[ \t]+$/, '') === `## ${heading}`);
  if (at === -1) return '';
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  return lines.slice(at + 1, end === -1 ? lines.length : end).join('\n');
}

// Frozen IDs with no line under Gate results. A parent that has frozen
// sub-IDs (C1 beside C1a) is covered by them and needs no line of its own.
function missingCriteria(doc) {
  const text = doc.replace(/\r\n?/g, '\n');
  const frozen = [...new Set(leadingIds(sectionText(text, 'Frozen gates')))];
  const have = new Set(leadingIds(sectionText(text, 'Gate results')));
  const leaf = (id) => !frozen.some((o) => o !== id && /^C\d+[a-z]$/.test(o) && o.slice(0, -1) === id);
  return frozen.filter((id) => leaf(id) && !have.has(id));
}

const incompleteMessage = (missing) =>
  `incomplete: Gate results has no line for ${missing.join(', ')}.\n` +
  'add one line per criterion: evidence, NOT MET or NOT RUN with the reason. ' +
  'One line per ID, the ID first; a line that lists several IDs or a range covers none of them.';

function coverage(p) {
  requireDoc(p);
  const missing = missingCriteria(readFileSync(p, 'utf8'));
  if (!missing.length) return;
  process.stdout.write(`${missing.join('\n')}\n`);
  die(incompleteMessage(missing), 4);
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
    writerSession(p),
    'A section write must verify ownership against $CLAUDE_CODE_SESSION_ID or $CODEX_SESSION_ID, both empty here.',
  );
  assertOwner(p, expected, steal, `write section "${heading}" of`);
  requireSection(p, heading);
  const payload = String(text ?? '').replace(/\n*$/, '');
  // The splice is applied to whatever text updateDoc reads, so a retry after a
  // concurrent write splices into the fresh doc instead of the stale one.
  updateDoc(p, (body) => {
    const span = splitSection(body, heading);
    if (!span) die(`"## ${heading}" disappeared from ${p} during the write`);
    const current = body.slice(span.bodyStart, span.bodyEnd);
    let next;
    if (mode === 'clear') next = '\n';
    else if (mode === 'set') next = payload ? `\n${payload}\n\n` : '\n';
    else next = `${current.replace(/\n*$/, '')}\n${payload}\n\n`.replace(/^\n*/, '\n');
    return setField(body.slice(0, span.bodyStart) + next + body.slice(span.bodyEnd), 'updated', nowIso());
  });
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
  const [sub, ...rawArgs] = rest;
  // Value flags come out before positional parsing, so their values are never
  // read as a cwd or a goal.
  let args = rawArgs;
  const takeValue = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = String(args[i + 1] ?? '');
    args = args.filter((_, j) => j !== i && j !== i + 1);
    return v;
  };
  // --since YYYY-MM-DD keeps runs whose ledger was last updated on or after
  // that day: the dreaming pass reads only what arrived since its last pass.
  const since = takeValue('--since') ?? '';
  if (since !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(since)) die('--since needs a date: YYYY-MM-DD');
  if (rawArgs.includes('--since') && !since) die('--since needs a date: YYYY-MM-DD');
  // --run-dir links the ledger to the run directory that keeps its reviews.
  const runDir = sub === 'init' ? takeValue('--run-dir') : undefined;
  if (runDir !== undefined && !runDir.startsWith('/')) die('--run-dir needs an absolute path');
  const pos = positional(args);
  if (sub === 'report') {
    // Read-only survey: --all crosses sessions on purpose, so no session is required.
    const json = hasFlag(args, '--json');
    const render = (runs) => (hasFlag(args, '--verdicts') ? renderVerdicts(runs) : renderReport(runs, { json }));
    if (hasFlag(args, '--all')) {
      const recent = ({ l }) => !since || String(l.updated || l.created || '').slice(0, 10) >= since;
      process.stdout.write(render(allLedgers().filter(recent).map(({ p, l }) => reportLedger(l, p))));
      return;
    }
    const sid = requireSession(envSession(), 'The ledger is keyed to $CLAUDE_CODE_SESSION_ID or $CODEX_SESSION_ID, both empty here.');
    const cwd = pos[0] ?? process.cwd();
    const p = ledgerFor(cwd, sid);
    const l = readLedger(p);
    if (!l) die(`no ledger for this session.\nStart one: handoff.mjs ledger init "${cwd}" "<goal>"\nOr survey every run: handoff.mjs ledger report --all`);
    process.stdout.write(render([reportLedger(l, p)]));
    return;
  }
  const sid = requireSession(envSession(), 'The ledger is keyed to $CLAUDE_CODE_SESSION_ID or $CODEX_SESSION_ID, both empty here.');
  const cwd = pos[0] ?? process.cwd();
  switch (sub) {
    case 'init': process.stdout.write(`${initLedger(cwd, sid, pos[1], runDir)}\n`); break;
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
      process.stderr.write('usage: handoff.mjs ledger {init|path|show|add|set|goal|report} <cwd> ...\n');
      process.exit(2);
  }
}

function end(p) { rmSync(p, { force: true }); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const pos = positional(rest);
  const steal = hasFlag(rest, '--steal');
  switch (cmd) {
    case 'key': process.stdout.write(requireSession(envSession()) + '\n'); break;
    case 'resolve':  resolve(pos[0] ?? process.cwd(), pos[1]); break;
    case 'init':     init(pos[0], pos[1], pos[2]); break;
    case 'path':     path(pos[0], pos[1]); break;
    case 'list':     list(pos[0] ?? process.cwd()); break;
    case 'reattach': reattach(pos[0], pos[1], steal); break;
    case 'status':   setStatus(pos[0], pos[1], steal); break;
    case 'ready':    setStatus(pos[0], 'results-ready', steal); break;
    case 'blocked':  setStatus(pos[0], 'blocked', steal); break;
    case 'coverage': coverage(pos[0]); break;
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
    // A human stop for the whole run in <cwd>; any session or shell may set it.
    case 'halt': {
      if (!pos[0]) die('usage: handoff.mjs halt <repo_root> [reason]');
      process.stdout.write(`halted: ${setHalt(pos[0], pos.slice(1).join(' '))}\n`);
      break;
    }
    case 'unhalt': {
      if (!pos[0]) die('usage: handoff.mjs unhalt <repo_root>');
      clearHalt(pos[0]);
      process.stdout.write('unhalted\n');
      break;
    }
    // Exit 0 and print the reason when halted, exit 1 when not.
    case 'halted': {
      const h = readHalt(pos[0] ?? process.cwd());
      if (!h) process.exit(1);
      process.stdout.write(`${h.reason}\n`);
      break;
    }
    case 'board': {
      const sid = requireSession(envSession(), 'The board is keyed to $CLAUDE_CODE_SESSION_ID or $CODEX_SESSION_ID, both empty here.');
      process.stdout.write(renderBoard(pos[0] ?? process.cwd(), sid, {
        json: hasFlag(rest, '--json'),
        withGit: !hasFlag(rest, '--no-git'),
        withPane: !hasFlag(rest, '--no-pane'),
        record: true,
      }));
      break;
    }
    default:
      process.stderr.write(
        'usage: handoff.mjs {resolve|init|path|list|reattach|status|ready|blocked|coverage|end|prune|section|ledger|board|halt|unhalt|halted} ...\n',
      );
      process.exit(2);
  }
}
