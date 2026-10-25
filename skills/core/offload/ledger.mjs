#!/usr/bin/env node
// ledger.mjs — the ARCHITECT's slice ledger, and the `board` roll-up built on it.
//
// WHY THIS EXISTS
// The offload handoff doc is a per-builder mailbox: one doc per (cwd, session),
// carrying one scalar `status`. That shape works for one builder. It cannot
// answer "what is the state of all six slices right now", and it has no terminal
// states — so a slice whose builder finished and exited keeps reading as
// in-flight forever, and the architect reports it as "running" from memory.
//
// The ledger is the missing half: ONE file per session that the architect owns
// exclusively and builders never touch. It records every slice, its terminal
// state, its verdict, and where its work lives. `board` then reconciles the
// ledger against reality — each slice's handoff doc, its builder pid, its wait
// bridge, its git worktree — and prints the disagreements loudly. Progress is
// READ FROM `board`, never reconstructed from context.
//
//   node handoff.mjs ledger init  <cwd> [goal]        -> create/print the ledger path
//   node handoff.mjs ledger path  <cwd>               -> print path (no create)
//   node handoff.mjs ledger show  <cwd>               -> raw JSON
//   node handoff.mjs ledger add   <cwd> --id 3 --title "..." [--branch b] [--slice-cwd d]
//                                       [--handoff p] [--pane w:p1] [--state s] [--note n]
//   node handoff.mjs ledger set   <cwd> <id> --state accepted [--verdict "..."] [--pr url]
//                                       [--note n] [--pane w:p1] [--handoff p] [--branch b]
//   node handoff.mjs ledger goal  <cwd> "<goal text>"
//   node handoff.mjs ledger report [<cwd>] [--all] [--json|--verdicts]   -> build/judge minutes per slice, rejections, concurrency
//   node handoff.mjs board        <cwd> [--json] [--no-git] [--no-pane]
//
// Ownership: the ledger filename is keyed on $CLAUDE_CODE_SESSION_ID, and every
// write asserts the in-file `session` matches. There is no --steal: a ledger
// belongs to exactly one architect.
//
// Provenance: `--pane` is checked against dispatch.sh's signature (see pane.mjs).
// A pane that was not created by dispatch.sh is refused on write and flagged on
// every board; OFFLOAD_ALLOW_UNVERIFIED_PANE=1 records it anyway.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DIR, hash, field } from './dir.mjs';
import { UNMANAGED_PANE_CONSEQUENCE, verifyPane } from './pane.mjs';

// Slice lifecycle. The four terminal states are the point of the whole file:
// without them a finished slice has nowhere to land and keeps reading as live.
export const SLICE_STATES = [
  'specced',        // spec written, no builder launched yet
  'dispatched',     // a builder is running this slice
  'blocked',        // builder stopped for an architect ruling
  'results-ready',  // builder reported gates; awaiting architect judgment
  'accepted',       // gates passed + review clean — TERMINAL
  'rejected',       // failed judgment; a corrective slice supersedes it — TERMINAL
  'merged',         // landed on the base branch — TERMINAL
  'abandoned',      // dropped on purpose — TERMINAL
];
export const TERMINAL_STATES = new Set(['accepted', 'rejected', 'merged', 'abandoned']);
// States where a live builder process is expected to exist.
const NEEDS_BUILDER = new Set(['dispatched']);
// States where the ARCHITECT owes the next action, not the builder.
const NEEDS_ARCHITECT = new Set(['blocked', 'results-ready']);

const nowIso = () => new Date().toISOString();

export const ledgerFor = (cwd, sessionId) => join(DIR, `${hash(cwd)}--${sessionId}.ledger.json`);

function die(msg) { process.stderr.write(msg.replace(/\n*$/, '\n')); process.exit(1); }

// Atomic write: a half-written ledger is worse than no ledger, because the
// architect would read it and believe it.
function writeAtomic(p, obj) {
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, p);
}

export function readLedger(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    die(`ledger at ${p} is not valid JSON (${e.message}).\nInspect it by hand; refusing to overwrite a corrupt ledger.`);
  }
  return null;
}

export function initLedger(cwd, sessionId, goal) {
  mkdirSync(DIR, { recursive: true });
  const p = ledgerFor(cwd, sessionId);
  const existing = readLedger(p);
  if (existing) {
    if (goal && !existing.goal) { existing.goal = goal; existing.updated = nowIso(); writeAtomic(p, existing); }
    return p;
  }
  const t = nowIso();
  writeAtomic(p, { session: sessionId, cwd, goal: goal || '', created: t, updated: t, slices: [] });
  return p;
}

// Load a ledger for writing. Refuses when it does not exist (init is explicit)
// or when its recorded session disagrees with the caller.
function loadOwned(cwd, sessionId) {
  const p = ledgerFor(cwd, sessionId);
  const l = readLedger(p);
  if (!l) {
    die(
      `no ledger for this session at ${p}\n` +
      `Create it first: node handoff.mjs ledger init "${cwd}" "<goal>"`,
    );
  }
  if (l.session && l.session !== sessionId) {
    die(
      `refusing to write ledger ${p}\n` +
      `  it records session ${l.session} but this caller is session ${sessionId}.\n` +
      'A ledger belongs to one architect. Resolve your own with: node handoff.mjs ledger init "<cwd>"',
    );
  }
  return { p, l };
}

function assertState(state) {
  if (state === undefined) return;
  if (!SLICE_STATES.includes(state)) {
    die(`invalid slice state "${state}".\nvalid: ${SLICE_STATES.join(' | ')}`);
  }
}

// Recording a pane is the architect's claim that a builder was dispatched there.
// Refuse the claim when the pane's provenance says otherwise: the alternative is
// a ledger row that reads `dispatched` forever while nothing can ever report back.
// `verifyPane` returning `skipped` means unverifiable (outside herdr, no CLI, no
// pane) — accept those, they are not evidence of anything.
function assertPane(pane) {
  if (pane === undefined || pane === '') return;
  if (process.env.OFFLOAD_ALLOW_UNVERIFIED_PANE === '1') return;
  const v = verifyPane(pane);
  if (v.skipped || v.verified) return;
  die(
    `refusing to record pane "${pane}" — it did not come from offload's dispatch.sh\n` +
    `  ${v.reason}\n` +
    `Every builder launch goes through the offload skill and its dispatch.sh, which\n` +
    'creates a tab labeled "builder" and runs the harness in that tab\'s only pane.\n' +
    `Recording a hand-started builder is worse than not recording it: ${UNMANAGED_PANE_CONSEQUENCE}.\n` +
    'Re-dispatch through offload, or set OFFLOAD_ALLOW_UNVERIFIED_PANE=1 to record it anyway.',
  );
}

// Apply only the keys actually supplied, so `set --state accepted` never blanks
// the branch or the pane recorded three turns ago.
// Every state change also lands in `history`, so a run can be timed afterwards:
// dispatched → results_at is builder time, results_at → terminal is architect
// time. One `updated` stamp could not tell those apart. A verdict supplied with
// the change is kept on that entry, because the slice's own verdict is
// overwritten by the next round and a report must still classify the earlier
// rejection.
function applyFields(slice, f) {
  const before = slice.state;
  for (const k of ['title', 'branch', 'cwd', 'handoff', 'pane', 'state', 'verdict', 'pr', 'note']) {
    if (f[k] !== undefined) slice[k] = f[k];
  }
  const t = nowIso();
  slice.history = Array.isArray(slice.history) ? slice.history : [];
  if (slice.state && (slice.state !== before || !slice.history.length)) {
    slice.history.push(f.verdict ? { state: slice.state, at: t, verdict: f.verdict } : { state: slice.state, at: t });
  }
  slice.updated = t;
  return slice;
}

export function addSlice(cwd, sessionId, fields) {
  const { p, l } = loadOwned(cwd, sessionId);
  if (!fields.id) die('ledger add needs --id');
  assertState(fields.state);
  assertPane(fields.pane);
  if (l.slices.some((s) => s.id === fields.id)) {
    die(`slice "${fields.id}" already exists in the ledger. Use: ledger set "${cwd}" ${fields.id} --state ...`);
  }
  const slice = applyFields(
    { id: fields.id, title: '', branch: '', cwd: '', handoff: '', pane: '', state: 'specced', verdict: '', pr: '', note: '', history: [] },
    fields,
  );
  l.slices.push(slice);
  l.updated = nowIso();
  writeAtomic(p, l);
  return slice;
}

export function setSlice(cwd, sessionId, id, fields) {
  const { p, l } = loadOwned(cwd, sessionId);
  assertState(fields.state);
  assertPane(fields.pane);
  const slice = l.slices.find((s) => s.id === id);
  if (!slice) {
    die(`no slice "${id}" in the ledger. Known: ${l.slices.map((s) => s.id).join(', ') || '(none)'}`);
  }
  applyFields(slice, fields);
  l.updated = nowIso();
  writeAtomic(p, l);
  return slice;
}

export function setGoal(cwd, sessionId, goal) {
  const { p, l } = loadOwned(cwd, sessionId);
  l.goal = goal;
  l.updated = nowIso();
  writeAtomic(p, l);
}

// ---------------------------------------------------------------------------
// Reconciliation — the part that catches what memory misses.
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  if (!pid || !/^\d+$/.test(String(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The builder's own pid, written by dispatch.sh and removed by its EXIT trap.
// An ABSENT marker is ambiguous on its own — never launched, or launched and
// exited — so the caller disambiguates with the ledger state. That distinction
// is the whole slice-1 case: `dispatched` + no marker means the builder finished
// and left, which nothing used to record anywhere.
function builderState(handoffPath) {
  if (!handoffPath) return { marker: false, alive: false, pid: '' };
  const marker = `${handoffPath}.builder`;
  if (!existsSync(marker)) return { marker: false, alive: false, pid: '' };
  const pid = (() => { try { return readFileSync(marker, 'utf8').trim(); } catch { return ''; } })();
  return { marker: true, alive: pidAlive(pid), pid };
}

// Is a wait-for-ready.sh bridge currently watching this handoff? A slice with no
// builder AND no bridge has nobody coming back to it.
function armedBridges() {
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }); } catch { return null; }
  const watched = new Set();
  for (const line of out.split('\n')) {
    if (!line.includes('wait-for-ready.sh')) continue;
    const parts = line.trim().split(/\s+/);
    const i = parts.findIndex((a) => a.endsWith('wait-for-ready.sh'));
    const target = parts[i + 1];
    if (target && !target.startsWith('--')) watched.add(target);
  }
  return watched;
}

function gitProbe(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  const git = (args) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  };
  const head = git(['log', '-1', '--format=%h %cr']);
  const dirty = git(['status', '--porcelain']);
  return { head, dirty: dirty ? dirty.split('\n').length : 0 };
}

function docAge(p) {
  try {
    const secs = (Date.now() - statSync(p).mtimeMs) / 1000;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
  } catch { return '?'; }
}

// One slice's reconciled view: ledger state vs doc status vs process reality.
// `flags` are the things that must never be silently absorbed into a summary.
export function reconcile(slice, { bridges, withGit = true, withPane = true } = {}) {
  const flags = [];
  const doc = slice.handoff && existsSync(slice.handoff)
    ? { exists: true, status: field(slice.handoff, 'status'), age: docAge(slice.handoff) }
    : { exists: false, status: '', age: '' };
  const builder = builderState(slice.handoff);
  const bridged = bridges ? bridges.has(slice.handoff) : null;
  const terminal = TERMINAL_STATES.has(slice.state);

  // Doc-level flags only matter while a slice is live. Once it is terminal the
  // ledger is authoritative, and re-flagging a dead doc on every wake is exactly
  // the every-turn noise that trains an architect to ignore the board.
  if (!terminal) {
    if (slice.handoff && !doc.exists) flags.push('DOC MISSING — the handoff this slice points at is gone');
    else if (doc.exists && !SLICE_STATES.includes(doc.status)) {
      flags.push(`CORRUPT DOC STATUS ("${doc.status || 'empty'}") — the bridge can never match it; rewrite with: handoff.mjs status <path> <state>`);
    } else if (doc.exists && doc.status && doc.status !== slice.state) {
      flags.push(`MISMATCH — ledger says ${slice.state}, doc says ${doc.status}; the doc is the builder's word, act on it`);
    }
  }

  if (!terminal && NEEDS_BUILDER.has(slice.state) && !builder.alive) {
    flags.push(
      bridged === false || bridged === null
        ? 'NO OWNER — builder exited and no bridge is armed; nothing is working this slice'
        : 'BUILDER EXITED — bridge still armed, it will report on the next check',
    );
  }
  if (!terminal && NEEDS_ARCHITECT.has(slice.state)) {
    flags.push(slice.state === 'blocked' ? 'NEEDS ARCHITECT — arbitrate now' : 'NEEDS ARCHITECT — judge the gates');
  }
  if (slice.state === 'specced') flags.push('NOT DISPATCHED');

  // A pane recorded before this check existed — or recorded past it with
  // OFFLOAD_ALLOW_UNVERIFIED_PANE — still has to surface every wake. This is the
  // row where the architect believes a builder is working and no signal can ever
  // arrive, which is precisely what memory cannot see.
  const pane = !terminal && withPane ? verifyPane(slice.pane) : null;
  if (pane && !pane.skipped && !pane.verified) {
    flags.push(`UNMANAGED PANE — ${pane.reason}; ${UNMANAGED_PANE_CONSEQUENCE}`);
  }

  return {
    ...slice,
    terminal,
    doc,
    builder,
    bridged,
    paneCheck: pane,
    git: withGit ? gitProbe(slice.cwd) : null,
    flags,
  };
}

const pad = (s, n) => {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v.padEnd(n);
};

// The moment a builder reported is the boundary between builder time and
// architect time. The ledger only learns it when the board reads the doc, so the
// board records it once, from the doc's own `updated` stamp — the architect
// usually goes straight from `dispatched` to a terminal state and never sets
// `results-ready` itself. Only the owning session writes; a mismatched session
// just reads.
function recordReportStamps(p, l, sessionId, rows) {
  if (!l.session || l.session !== sessionId) return;
  let changed = false;
  for (const r of rows) {
    if (r.terminal || !r.doc.exists) continue;
    const key = r.doc.status === 'results-ready' ? 'results_at' : r.doc.status === 'blocked' ? 'blocked_at' : null;
    if (!key) continue;
    const slice = l.slices.find((s) => s.id === r.id);
    if (!slice || slice[key]) continue;
    const stamp = field(r.handoff, 'updated');
    slice[key] = stamp && !Number.isNaN(Date.parse(stamp)) ? new Date(stamp).toISOString() : nowIso();
    r[key] = slice[key];
    changed = true;
  }
  if (changed) { l.updated = nowIso(); writeAtomic(p, l); }
}

export function renderBoard(cwd, sessionId, { json = false, withGit = true, withPane = true, record = false } = {}) {
  const p = ledgerFor(cwd, sessionId);
  const l = readLedger(p);
  if (!l) {
    return `BOARD: no ledger for this session.\nStart one: node handoff.mjs ledger init "${cwd}" "<goal>"\n`;
  }
  const bridges = armedBridges();
  const rows = l.slices.map((s) => reconcile(s, { bridges, withGit, withPane }));
  if (record) recordReportStamps(p, l, sessionId, rows);

  if (json) return `${JSON.stringify({ ...l, ledger: p, slices: rows }, null, 2)}\n`;

  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  const attention = rows.filter((r) => r.flags.length).length;

  let out = `BOARD  ${l.goal || '(no goal recorded)'}\n`;
  out += `       session ${l.session} · root ${l.cwd}\n`;
  out += `       ledger ${p}\n`;
  out += `       ${rows.length} slice${rows.length === 1 ? '' : 's'} · `;
  out += Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none';
  out += ` · ${attention} needing attention\n`;
  if (bridges === null) out += '       (could not read the process table — bridge-armed column unavailable)\n';
  out += '\n';
  out += `${pad('ID', 5)}${pad('STATE', 15)}${pad('SLICE', 30)}${pad('BRANCH', 30)}${pad('BUILDER', 12)}${pad('DOC', 15)}AGE\n`;
  out += `${'-'.repeat(111)}\n`;

  for (const r of rows) {
    const mark = r.flags.length ? '!' : ' ';
    const builderCol = r.builder.alive ? `pid ${r.builder.pid}`
      : r.builder.marker ? 'stale pid'
        : (r.state === 'specced' || r.terminal) ? '—'
          : 'exited';
    out += `${mark}${pad(r.id, 4)}${pad(r.state, 15)}${pad(r.title, 30)}${pad(r.branch, 30)}${pad(builderCol, 12)}${pad(r.doc.status || '—', 15)}${r.doc.age || '—'}\n`;
    for (const f of r.flags) out += `     ↳ ${f}\n`;
    if (r.git && (r.git.head || r.git.dirty)) {
      out += `     ↳ git: ${r.git.head || 'no commits'}${r.git.dirty ? ` · ${r.git.dirty} uncommitted file(s)` : ''}\n`;
    }
    if (r.verdict) out += `     ↳ verdict: ${r.verdict}\n`;
    if (r.pr) out += `     ↳ pr: ${r.pr}\n`;
    if (r.note) out += `     ↳ note: ${r.note}\n`;
    if (r.pane) out += `     ↳ pane: ${r.pane}\n`;
  }

  if (!rows.length) out += '(no slices recorded yet — add one with: handoff.mjs ledger add …)\n';
  return out;
}


// ---------------------------------------------------------------------------
// Report — where the wall-clock went.
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;
const parseAt = (v) => { const t = Date.parse(v || ''); return Number.isNaN(t) ? null : t; };
const minutes = (a, b) => (a == null || b == null || b < a) ? null : Math.round((b - a) / MIN);
const fmtMin = (m) => (m == null ? '—' : `${m}m`);
const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};

const CORRECTIVE = /\b(correct(ive|ion)?|fix(es|ing)?|redo|retry|follow-?up)\b/i;
// A rejection whose verdict names the independent review and no failed gate:
// the frozen gates said done and the reviewer disagreed. The ratio of these to
// all rejections is the single number the spec-review step exists to lower.
const REVIEW_ONLY = (v) => /do not land|review/i.test(v) && !/\b(fail|failed|failing|red|inconclusive|429)\b/i.test(v);

const sum = (xs) => (xs.some((x) => x != null) ? xs.reduce((a, x) => a + (x ?? 0), 0) : null);

// Every dispatch opens a round. Correctives go back into the warm builder on
// the same slice, so the final state and the last dispatch hide the rework:
// each round is read from `history`. A round is live from its dispatch until
// the next state change (or the results stamp, when that lands first); judging
// runs from a results report to the next state change.
export function sliceTiming(s) {
  const history = (Array.isArray(s.history) ? s.history : [])
    .map((h) => ({ ...h, t: parseAt(h.at) })).filter((h) => h.t != null);
  const resultsStamp = parseAt(s.results_at);
  const rounds = [];
  history.forEach((h, i) => {
    if (h.state !== 'dispatched') return;
    const next = history.slice(i + 1).find((x) => x.state !== 'dispatched');
    const nextDispatch = history.slice(i + 1).find((x) => x.state === 'dispatched');
    const end = next && (!nextDispatch || next.t <= nextDispatch.t) ? next : null;
    let resultsAt = end?.state === 'results-ready' ? end.t : null;
    if (resultsStamp != null && resultsStamp >= h.t && (!nextDispatch || resultsStamp <= nextDispatch.t)
      && (end == null || resultsStamp < end.t)) {
      resultsAt = resultsStamp;
    }
    const liveUntil = resultsAt ?? end?.t ?? null;
    const afterResults = resultsAt == null ? null
      : history.slice(i + 1).find((x) => x.t >= resultsAt && x.state !== 'results-ready');
    rounds.push({ start: h.t, live_until: liveUntil, build: minutes(h.t, liveUntil), judge: afterResults ? minutes(resultsAt, afterResults.t) : null });
  });
  // Results sent straight back (results-ready → dispatched, no rejected entry)
  // are a rejection too; older runs recorded most correctives that way.
  const rejectedEntries = history.filter((h, i) => h.state === 'rejected'
    || (h.state === 'results-ready' && history[i + 1]?.state === 'dispatched'))
    .map((h) => (h.state === 'rejected' ? h : { ...h, verdict: h.verdict ?? '' }));
  // Old ledgers lack history: fall back to the final state.
  const rejections = rejectedEntries.length || (s.state === 'rejected' ? 1 : 0);
  // An entry without its own verdict predates verdicts in history; only the
  // last one can borrow the slice's verdict, and only while still rejected.
  const verdicts = rejectedEntries.length
    ? rejectedEntries.map((h, i) => h.verdict
      ?? (i === rejectedEntries.length - 1 && s.state === 'rejected' ? s.verdict || '' : ''))
    : (s.state === 'rejected' ? [s.verdict || ''] : []);
  const reviewOnlyVerdicts = verdicts.filter((v) => REVIEW_ONLY(v));
  const terminalEntry = [...history].reverse().find((h) => TERMINAL_STATES.has(h.state));
  const terminal = terminalEntry ? terminalEntry.t : (TERMINAL_STATES.has(s.state) ? parseAt(s.updated) : null);
  // A slice reopened after acceptance (a follow-up sent to the warm builder)
  // was still judged; a corrective-titled slice is rework, never a first pass.
  const LANDED = new Set(['accepted', 'merged']);
  const landed = LANDED.has(s.state) || history.some((h) => LANDED.has(h.state));
  const corrective = CORRECTIVE.test(s.title || '');
  return {
    id: s.id, title: s.title || '', state: s.state, verdict: s.verdict || '',
    corrective,
    rounds: rounds.length,
    redispatches: Math.max(0, rounds.length - 1),
    rejections,
    review_only_rejections: reviewOnlyVerdicts.length,
    review_only_verdicts: reviewOnlyVerdicts,
    judged: landed || rejections > 0,
    first_pass: landed && !corrective && rounds.length <= 1 && rejections === 0,
    dispatched_at: rounds.length ? rounds[rounds.length - 1].start : null,
    results_at: resultsStamp ?? [...history].reverse().find((h) => h.state === 'results-ready')?.t ?? null,
    terminal_at: terminal,
    live: rounds.map((r) => [r.start, r.live_until]),
    build_min: sum(rounds.map((r) => r.build)),
    judge_min: sum(rounds.map((r) => r.judge)),
  };
}

function maxConcurrent(timings) {
  const events = [];
  for (const t of timings) {
    for (const [start, until] of t.live) {
      events.push([start, 1]);
      if (until != null) events.push([until, -1]);
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0; let max = 0;
  for (const [, d] of events) { cur += d; if (cur > max) max = cur; }
  return max;
}

export function reportLedger(l, p) {
  const slices = (l.slices || []).map(sliceTiming);
  const counts = {};
  for (const s of slices) counts[s.state] = (counts[s.state] || 0) + 1;
  const created = parseAt(l.created);
  const last = Math.max(...slices.map((s) => s.terminal_at ?? s.results_at ?? s.dispatched_at ?? 0), parseAt(l.updated) ?? 0);
  const total = (k) => slices.reduce((a, s) => a + s[k], 0);
  return {
    ledger: p, session: l.session, cwd: l.cwd, goal: l.goal || '', created: l.created,
    span_min: minutes(created, last || null),
    slices,
    counts,
    correctives: slices.filter((s) => s.corrective).length,
    redispatches: total('redispatches'),
    rejections: total('rejections'),
    review_only_rejections: total('review_only_rejections'),
    judged: slices.filter((s) => s.judged).length,
    first_pass: slices.filter((s) => s.first_pass).length,
    median_build_min: median(slices.map((s) => s.build_min)),
    median_judge_min: median(slices.map((s) => s.judge_min)),
    max_concurrent: maxConcurrent(slices),
  };
}

// The review-only rejection verdicts, one per line: the raw material for
// do/references/review-criteria.md.
export function renderVerdicts(runs) {
  let out = '';
  for (const r of runs) {
    for (const s of r.slices) {
      for (const v of s.review_only_verdicts) {
        out += `${(r.created || '').slice(0, 10)} ${pad(s.id, 4)} ${v.replace(/\s+/g, ' ')}\n`;
      }
    }
  }
  return out || '(no review-only rejections recorded)\n';
}

export function renderReport(runs, { json = false } = {}) {
  const totals = { runs: runs.length, slices: 0, accepted: 0, rejected: 0, merged: 0, abandoned: 0 };
  const SUMMED = ['correctives', 'redispatches', 'rejections', 'review_only_rejections', 'judged', 'first_pass'];
  for (const k of SUMMED) totals[k] = 0;
  const builds = []; const judges = [];
  for (const r of runs) {
    totals.slices += r.slices.length;
    for (const k of ['accepted', 'rejected', 'merged', 'abandoned']) totals[k] += r.counts[k] || 0;
    for (const k of SUMMED) totals[k] += r[k];
    for (const s of r.slices) { builds.push(s.build_min); judges.push(s.judge_min); }
  }
  const rework = (x) => `rework: ${x.redispatches} re-dispatch${x.redispatches === 1 ? '' : 'es'}`
    + ` · ${x.rejections} rejection${x.rejections === 1 ? '' : 's'} · first pass ${x.first_pass} of ${x.judged}`;
  totals.median_build_min = median(builds);
  totals.median_judge_min = median(judges);
  if (json) return `${JSON.stringify({ runs, totals }, null, 2)}\n`;

  let out = '';
  for (const r of runs) {
    out += `RUN    ${r.goal || '(no goal recorded)'}\n`;
    out += `       ${(r.created || '').slice(0, 10)} · session ${r.session} · ${r.cwd}\n`;
    out += `       ${r.slices.length} slice${r.slices.length === 1 ? '' : 's'} · `;
    out += Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none';
    out += ` · ${r.correctives} corrective${r.correctives === 1 ? '' : 's'}\n`;
    out += `       ${rework(r)}\n`;
    out += `       review-only rejections: ${r.review_only_rejections} of ${r.rejections}`;
    out += ` · median build ${fmtMin(r.median_build_min)} · median judge ${fmtMin(r.median_judge_min)}`;
    out += ` · max concurrent builders: ${r.max_concurrent} · span ${fmtMin(r.span_min)}\n\n`;
    out += `${pad('ID', 5)}${pad('STATE', 11)}${pad('SLICE', 32)}${pad('BUILD', 7)}${pad('JUDGE', 7)}${pad('RNDS', 5)}VERDICT\n`;
    out += `${'-'.repeat(105)}\n`;
    for (const s of r.slices) {
      out += `${pad(s.id, 5)}${pad(s.state, 11)}${pad(s.title, 32)}${pad(fmtMin(s.build_min), 7)}${pad(fmtMin(s.judge_min), 7)}${pad(s.rounds, 5)}${pad(s.verdict, 38)}\n`;
    }
    out += '\n';
  }
  if (runs.length !== 1) {
    out += `TOTALS ${totals.runs} runs · ${totals.slices} slices · ${totals.accepted} accepted · ${totals.rejected} rejected`;
    out += ` · ${totals.merged} merged · ${totals.abandoned} abandoned · ${totals.correctives} correctives\n`;
    out += `       ${rework(totals)}\n`;
    out += `       review-only rejections: ${totals.review_only_rejections} of ${totals.rejections}`;
    out += ` · median build ${fmtMin(totals.median_build_min)} · median judge ${fmtMin(totals.median_judge_min)}\n`;
  }
  return out;
}

// Every ledger on disk, any session, read-only. Corrupt files are skipped, not
// fatal: a report is a survey, not a write.
export function allLedgers() {
  if (!existsSync(DIR)) return [];
  const out = [];
  for (const f of (() => { try { return readdirSync(DIR); } catch { return []; } })()) {
    if (!f.endsWith('.ledger.json')) continue;
    const p = join(DIR, f);
    try { out.push({ p, l: JSON.parse(readFileSync(p, 'utf8')) }); } catch { /* skip */ }
  }
  out.sort((a, b) => String(a.l.created || '').localeCompare(String(b.l.created || '')));
  return out;
}

// TTL reaping for ledgers, which prune() skips (it only knows .md/.state).
export function pruneLedgers(ttlMs) {
  if (!existsSync(DIR)) return [];
  const now = Date.now();
  const gone = [];
  for (const f of (() => { try { return readdirSync(DIR); } catch { return []; } })()) {
    if (!f.endsWith('.ledger.json')) continue;
    const p = join(DIR, f);
    try { if (now - statSync(p).mtimeMs > ttlMs) { rmSync(p, { force: true }); gone.push(basename(p)); } } catch { /* raced */ }
  }
  return gone;
}
