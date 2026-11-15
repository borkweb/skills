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
//                                                             and even with --steal; it checks coverage, not freshness.
//                                                             When the doc names a worktree (`cwd:`), all three also
//                                                             need a `Head: <sha>` line under Gate results that matches
//                                                             the worktree's HEAD, and refuse with `stale:` (exit 5). A
//                                                             `Head:` that differs is accepted only after a pure rebase:
//                                                             the frontmatter's `base:` sha and `base_ref:` full ref
//                                                             (written by dispatch-slice.sh), the same `git patch-id
//                                                             --verbatim` for `base..<head>` and `<merge-base>..HEAD`, a
//                                                             non-empty patch and a clean `git merge-tree --write-tree`
//                                                             against the ref's current tip. Anything unknown refuses
//                                                             `stale:` naming the condition. A `Carried:` line is not a
//                                                             `Head:` line. Gate evidence only; see judging.md
//   node handoff.mjs rulings  <decisions.md> <block.md> --slice <id>
//                                                         -> check that every `Changes the bar (slice <id>): <IDs>` marker in
//                                                             decisions.md names only IDs that lead an `Acceptance:` line of the
//                                                             block. Exit 0 when all are backed (or there are no markers), 6 with
//                                                             one `unbacked: <marker line>` per offender on stderr, 2 on usage, 1
//                                                             when a file cannot be read. dispatch-slice.sh runs it on a fresh dispatch.
//   node handoff.mjs base     <path> <sha> [<ref>]        -> record the slice's base commit (`base:`) and the full ref it came
//                                                             from (`base_ref:`, dropped when none) in the frontmatter, ownership-guarded.
//                                                             dispatch-slice.sh calls it on a fresh dispatch.
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
import { execFileSync, spawnSync } from 'node:child_process';
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
      const stale = staleHead(b);
      if (stale) die(`stale: ${stale}`, 5);
    }
    return setField(setField(b, 'status', v), 'updated', nowIso());
  });
}

// --- slice base -----------------------------------------------------------
// dispatch-slice.sh records the commit a slice was cut from (`base: <sha>`) and,
// when it came from a branch, the full ref (`base_ref: refs/heads/...`) in the
// frontmatter. `staleHead` uses both to accept gate evidence across a pure rebase.
// Frontmatter only: setField would also rewrite a body line that starts `base:`.
function setFrontmatter(body, key, value) {
  const m = /^---\n([\s\S]*?)\n---(?=\n|$)/.exec(body);
  if (!m) die('refusing: the handoff has no frontmatter to record the base in');
  const lines = m[1].split('\n').filter((l) => !l.startsWith(`${key}:`));
  if (value !== null) lines.push(`${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---${body.slice(m[0].length)}`;
}

const BASE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BASE_REF = /^refs\/(?:heads|remotes)\/[^\s]+$/;

function setBase(p, sha, ref, steal) {
  requireDoc(p);
  if (!BASE_SHA.test(String(sha ?? ''))) die('usage: handoff.mjs base <path> <full-commit-sha> [<refs/heads/...|refs/remotes/...>]', 2);
  if (ref !== undefined && !BASE_REF.test(ref)) die('refusing: base_ref must be a full refs/heads/... or refs/remotes/... name', 2);
  const expected = requireSession(
    writerSession(p),
    'A base write must verify ownership against $CLAUDE_CODE_SESSION_ID or $CODEX_SESSION_ID, both empty here.',
  );
  assertOwner(p, expected, steal, 'record the base on');
  updateDoc(p, (b) => setField(setFrontmatter(setFrontmatter(b, 'base', sha), 'base_ref', ref ?? null), 'updated', nowIso()));
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
  const doc = readFileSync(p, 'utf8');
  const missing = missingCriteria(doc);
  if (missing.length) {
    process.stdout.write(`${missing.join('\n')}\n`);
    die(incompleteMessage(missing), 4);
  }
  const stale = staleHead(doc);
  if (stale) die(`stale: ${stale}`, 5);
}

// --- bar-changing rulings -------------------------------------------------
// A ruling in a run's decisions.md that changes what the work must say or do
// carries one marker line, `Changes the bar (slice <id>): <IDs>` (a list marker
// and `**` decoration are allowed). `rulings` checks that every marker for the
// slice names only criterion IDs that lead a line of the block's Acceptance
// lines: from a column-0 `Acceptance:` line to the next column-0 `<Label>:` that
// is not a criterion ID, or a ``` fence, or the end. A parent ID (`C2`) is backed
// by any of its sub-IDs (`C2a`). A marker with no IDs, a token that is not an ID,
// or a line that contains `Changes the bar` but does not parse, is unbacked.
const MARKER = /^\s*(?:[-*]\s+)?Changes the bar \(slice ([A-Za-z0-9._-]+)\):\s*(.*?)\s*$/;
const ID_ONLY = /^C\d+[a-z]?$/;

function acceptanceIds(block) {
  const plain = block.replace(COMMENT, (m) => m.replace(/[^\n]/g, ''));
  const kept = [];
  let inside = false;
  for (const line of plain.split('\n')) {
    if (/^Acceptance:/.test(line)) { inside = true; continue; }
    if (!inside) continue;
    const label = /^([A-Za-z][A-Za-z0-9 _/-]*):/.exec(line)?.[1];
    if (/^\s*```/.test(line) || (label && !ID_ONLY.test(label))) { inside = false; continue; }
    kept.push(line);
  }
  return new Set(leadingIds(kept.join('\n')));
}

function unbackedMarkers(decisions, block, slice) {
  const acceptance = acceptanceIds(block.replace(/\r\n?/g, '\n'));
  const backed = (id) => acceptance.has(id) || (!/[a-z]$/.test(id) && [...acceptance].some((a) => a.length === id.length + 1 && a.startsWith(id)));
  const bad = [];
  for (const line of decisions.replace(/\r\n?/g, '\n').split('\n')) {
    const flat = line.replace(/\*\*/g, '');
    if (!flat.includes('Changes the bar')) continue;
    const m = MARKER.exec(flat);
    if (!m) { bad.push(line); continue; }
    if (m[1] !== slice) continue;
    const ids = m[2].split(',').map((t) => t.trim());
    if (!m[2] || !ids.every((t) => ID_ONLY.test(t) && backed(t))) bad.push(line);
  }
  return bad;
}

const RULINGS_USAGE = 'usage: handoff.mjs rulings <decisions.md> <block.md> --slice <id>';

function rulingsCmd(rest) {
  const i = rest.indexOf('--slice');
  const slice = i === -1 ? '' : String(rest[i + 1] ?? '');
  const [decisions, block] = positional(i === -1 ? rest : rest.filter((_, j) => j !== i && j !== i + 1));
  if (!decisions || !block || !slice || slice.startsWith('--')) die(RULINGS_USAGE, 2);
  const read = (p, what) => {
    try { return readFileSync(p, 'utf8'); } catch (e) { return die(`rulings: cannot read the ${what} file ${p} (${e.code || e.message})`, 1); }
  };
  const bad = unbackedMarkers(read(decisions, 'decisions'), read(block, 'block'), slice);
  if (bad.length) die(bad.map((l) => `unbacked: ${l}`).join('\n'), 6);
}

// --- gate head ------------------------------------------------------------
// Gate results name the commit the final full gate run used, as a `Head: <sha>`
// line. A doc whose frontmatter names a worktree (`cwd:`, set by every dispatch)
// must carry at least one, and every one must be a prefix of that worktree's
// HEAD: evidence from before a late edit then cannot pass as evidence for the
// head. A `Carried: <sha> — <gates>` line (gates a corrective's diff cannot reach)
// is not a `Head:` line and is never compared. A doc with no `cwd:`, or whose
// `cwd:` is not inside a git work tree (a hand-made doc, a test fixture), has no
// head to compare and is not checked. A work tree whose HEAD git cannot read (no
// commit yet) refuses, never passes.
//
// One exception: a pure rebase. A recorded head that is not HEAD is accepted when
// the slice was cut from a recorded base (`base:` sha and `base_ref:` full ref,
// written by dispatch-slice.sh) and all four hold:
//   1. both frontmatter lines are present and well formed, and the recorded head
//      is a commit in this repository on top of `base:`;
//   2. the patch `base..<recorded head>` and the patch `<merge-base of HEAD and
//      the current tip of base_ref>..HEAD` have the same `git patch-id --verbatim`
//      (verbatim: --stable also ignores whitespace, which changes meaning in a
//      string or a Python indent). Each diff is whole-range, binary and mode aware;
//   3. that patch is not empty (two empty patches would compare equal);
//   4. `git merge-tree --write-tree <tip> HEAD` is clean, so the rebased work
//      still lands on the base as it is now.
// Any unknown fails closed with a `stale:` message that names the condition: a
// missing line, an unknown head, an empty patch, a patch-id mismatch, a merge
// conflict or a git error (including a git too old for --verbatim/--write-tree).
// This covers gate evidence only; a review verdict never carries over a rebase.
// Every git child runs with a scrubbed environment, so an ambient GIT_DIR,
// GIT_WORK_TREE or GIT_INDEX_FILE cannot point it at another repository.
const HEAD_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?Head:(?:\*\*)?\s+`?([0-9a-fA-F]{7,40})`?\s*$/;
const GIT_ENV_PASS = ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'XDG_CONFIG_HOME'];

function frontmatterField(text, key) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return '';
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(m[1]);
  return line ? line[1].trim() : '';
}

function gitIn(cwd, args, input) {
  const env = {};
  for (const k of GIT_ENV_PASS) if (process.env[k] !== undefined) env[k] = process.env[k];
  const r = spawnSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] });
  return { status: r.status ?? -1, out: (r.stdout ?? '').trim(), raw: r.stdout ?? '' };
}

const SHA_ONLY = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// null when the recorded head `h` is a pure rebase of what HEAD holds, else the reason it is not.
function rebaseCarryOver(cwd, text, h, head) {
  const git = (...args) => gitIn(cwd, args);
  const failed = (what, r) => `git error: \`git ${what}\` exited ${r.status}.`;
  const base = frontmatterField(text, 'base');
  if (!base) return 'the handoff has no `base:` line, so the slice\'s base is unknown (dispatch-slice.sh records it on a fresh dispatch; pass --base <ref> on the first dispatch).';
  if (!SHA_ONLY.test(base)) return `\`base: ${base}\` is not a full commit sha.`;
  const baseRef = frontmatterField(text, 'base_ref');
  if (!baseRef) return 'the handoff has no `base_ref:` line, so the base\'s current tip is unknown (dispatch-slice.sh records it when --base names a branch).';
  if (!/^refs\/(?:heads|remotes)\/[^\s-][^\s]*$/.test(baseRef)) return `\`base_ref: ${baseRef}\` is not a full refs/heads/... or refs/remotes/... name.`;

  const baseCommit = git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
  if (baseCommit.status !== 0 || !baseCommit.out) return `git error: \`base: ${base}\` no longer resolves to a commit in this repository (unknown or unreachable).`;
  const recorded = git('rev-parse', '--verify', '--quiet', `${h}^{commit}`);
  if (recorded.status !== 0 || !SHA_ONLY.test(recorded.out)) return `the recorded head ${h} is unknown or unreachable in this repository.`;
  const tip = git('rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`);
  if (tip.status !== 0 || !SHA_ONLY.test(tip.out)) return `git error: \`base_ref: ${baseRef}\` no longer resolves to a commit in this repository.`;
  const onTop = git('merge-base', '--is-ancestor', baseCommit.out, recorded.out);
  if (onTop.status === 1) return `the recorded head ${h} is not on top of \`base: ${base.slice(0, 12)}\`.`;
  if (onTop.status !== 0) return failed('merge-base --is-ancestor', onTop);
  const mb = git('merge-base', head, tip.out);
  if (mb.status === 1) return `HEAD and ${baseRef} share no merge base.`;
  if (mb.status !== 0 || !SHA_ONLY.test(mb.out)) return failed('merge-base', mb);

  // `-U0`: the patch is its changed lines, so a neighbouring edit in the base does
  // not change it; merge-tree below is what judges the neighbourhood.
  const patchId = (from, to) => {
    const diff = git('diff', '-U0', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', from, to);
    if (diff.status !== 0) return { err: failed('diff', diff) };
    if (!diff.raw.trim()) return { empty: true };
    const id = gitIn(cwd, ['patch-id', '--verbatim'], diff.raw);
    if (id.status !== 0) return { err: failed('patch-id --verbatim', id) };
    const first = id.out.split('\n')[0].split(/\s+/)[0];
    return first ? { id: first } : { empty: true };
  };
  const was = patchId(baseCommit.out, recorded.out);
  if (was.err) return was.err;
  const now = patchId(mb.out, head);
  if (now.err) return now.err;
  if (was.empty || now.empty) return `the patch is empty (an empty patch proves nothing about the rebase): ${was.empty ? `base..${h}` : `${mb.out.slice(0, 12)}..HEAD`} changes nothing.`;
  if (was.id !== now.id) return `patch-id mismatch: the patch of base..${h} is not the patch of ${mb.out.slice(0, 12)}..HEAD, so the work changed after the recorded head.`;

  const merged = git('merge-tree', '--write-tree', tip.out, head);
  if (merged.status === 0) return null;
  if (merged.status === 1 && SHA_ONLY.test(merged.out.split('\n')[0])) {
    return `merge conflict: HEAD does not merge cleanly onto ${baseRef} (${tip.out.slice(0, 12)}); rebase onto the current base.`;
  }
  return failed('merge-tree --write-tree', merged);
}

function staleHead(doc) {
  const text = doc.replace(/\r\n?/g, '\n');
  const cwd = frontmatterField(text, 'cwd');
  if (!cwd) return null;
  if (gitIn(cwd, ['rev-parse', '--is-inside-work-tree']).out !== 'true') return null;
  const headRead = gitIn(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (headRead.status !== 0 || !headRead.out) return `cannot read HEAD in ${cwd}, so the gate head cannot be verified.`;
  const head = headRead.out.toLowerCase();
  const plain = sectionText(text, 'Gate results').replace(COMMENT, (m) => m.replace(/[^\n]/g, ''));
  const heads = plain.split('\n').map((l) => HEAD_LINE.exec(l)?.[1]?.toLowerCase()).filter(Boolean);
  const short = head.slice(0, 12);
  if (!heads.length) {
    return `Gate results has no \`Head: <sha>\` line. Add the commit the final full gate run used; the worktree HEAD is ${short}.`;
  }
  const off = [...new Set(heads.filter((h) => !head.startsWith(h)))];
  if (!off.length) return null;
  const reasons = off.map((h) => ({ h, why: rebaseCarryOver(cwd, text, h, head) })).filter((r) => r.why);
  if (!reasons.length) return null;
  return `Gate results names ${off.join(', ')}, but the worktree HEAD is ${short}. ` +
    `A rebase carries gate evidence over only when the patch is unchanged, and it does not here: ${reasons.map((r) => `${r.h}: ${r.why}`).join(' ')} ` +
    'Rerun every gate and mutation at HEAD, then update the Head line.';
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
    case 'rulings':  rulingsCmd(rest); break;
    case 'base':     setBase(pos[0], pos[1], pos[2], steal); break;
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
        'usage: handoff.mjs {resolve|init|path|list|reattach|status|ready|blocked|coverage|rulings|base|end|prune|section|ledger|board|halt|unhalt|halted} ...\n',
      );
      process.exit(2);
  }
}
