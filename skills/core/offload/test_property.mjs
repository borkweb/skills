// test_property.mjs — SG-07: a seeded, stateful property test over the architect ledger, the
// handoff status machine, dispatch-slice.sh and the wait bridge.
//
// Each seed drives a random sequence of dispatch, ready, corrective, stale, halt, unhalt, returned,
// abandoned and crash events through the REAL CLIs (handoff.mjs and its ledger, dispatch-slice.sh with
// stub herdr/claude on PATH, wait-for-ready.sh). The expected outcome of every event comes from a
// small model built from how the event was GENERATED (a verdict is labelled valid or invalid when it is
// made, never classified by the ledger's own matcher), and after every step the invariants are checked
// against the files on disk:
//   - a rejected entry always carries a verdict, and no verdict the ledger recorded was one it must refuse
//   - a stale or incomplete `ready` never flips the status; a write from a second session never changes a doc
//   - halt blocks dispatch (fresh and corrective) until unhalt
//   - a builder that crashed leaves its slice flagged, never silently running
//   - the wait bridge wakes on results-ready and blocked only, and always ends within its deadline
// A failure prints the seed, the step and the exact command that replays it:
//   SG07_SEED=<n> node --test skills/core/offload/test_property.mjs
// SG07_SEEDS=<n,m,...> runs a different set. No seed depends on timing, pids or paths.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF = join(HERE, 'handoff.mjs');
const SLICE_SH = join(HERE, 'dispatch-slice.sh');
const BRIDGE = join(HERE, '..', 'complete', 'wait-for-ready.sh');
const NODE = process.execPath;
const NODE_DIR = dirname(NODE);
const BOX = mkdtempSync(join(tmpdir(), 'ofl-prop-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const DEFAULT_SEEDS = [11, 23, 37, 41, 59, 73];
const SEEDS = process.env.SG07_SEED ? [Number(process.env.SG07_SEED)]
  : process.env.SG07_SEEDS ? process.env.SG07_SEEDS.split(',').map(Number) : DEFAULT_SEEDS;
const STEPS = 16;
const KINDS = ['dispatch', 'ready', 'corrective', 'stale', 'halt', 'unhalt', 'returned', 'abandoned', 'crash'];
// What the contract says must be generated; kept apart from KINDS so dropping one from the generator fails the run.
const REQUIRED_KINDS = ['dispatch', 'ready', 'corrective', 'stale', 'halt', 'unhalt', 'returned', 'abandoned', 'crash'];
// How often each kind is drawn: correctives and ready attempts carry most of the invariants.
const WEIGHTS = { dispatch: 2, ready: 4, corrective: 8, stale: 2, halt: 1, unhalt: 1, returned: 1, abandoned: 2, crash: 2 };
const STATES = ['specced', 'dispatched', 'blocked', 'results-ready', 'returned', 'accepted', 'rejected', 'merged', 'abandoned'];
const UNWATCHED = STATES.filter((s) => s !== 'results-ready' && s !== 'blocked');

// mulberry32: small, seedable and the same on every machine.
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)] };
}

// --- child processes: always an explicit env, never the ambient one ---------------------------
function exec(cmd, args, { env, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => resolve({ code: -1, out, err: `${err}${e.message}` }));
    const kill = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err }); });
    child.stdin.end(input ?? '');
  });
}

const GIT_IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

// Everything one seed needs: its own box, ledger dir, repo, stub bin dir and architect session.
async function setup(seed, tag = 'events') {
  const box = join(BOX, `seed-${seed}-${tag}`);
  mkdirSync(box, { recursive: true });
  const bin = join(box, 'bin');
  const log = join(box, 'calls.log');
  mkdirSync(bin, { recursive: true });
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  for (const n of ['tmux', 'claude', 'codex', 'osascript']) stub(n, `echo "${n} $*" >> "${log}"`);
  stub('quota-axi', 'exit 1');
  stub('herdr', `echo "herdr $*" >> "${log}"
case "$1 $2" in
  "tab create") echo '{"result":{"root_pane":{"pane_id":"w9:p7","tab_id":"w9:t7","workspace_id":"w9"},"tab":{"tab_id":"w9:t7"},"type":"tab_created"}}' ;;
  "pane run") exit 0 ;;
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"w9:t7"}},"type":"pane_info"}\\n' "$3" ;;
  "tab get") printf '{"result":{"tab":{"tab_id":"%s","label":"builder","pane_count":1}},"type":"tab_info"}\\n' "$3" ;;
esac`);
  const config = join(box, 'config.json');
  writeFileSync(config, JSON.stringify({ dispatch: { rules: [{ when: 'test', use: [{ harness: 'claude' }], why: 'test' }] } }));
  const block = join(box, 'block.md');
  writeFileSync(block, 'Execute the slice.\nAcceptance:\nC1: first criterion\nC2: second criterion\nGates: G1 `true`\n');
  const fix = join(box, 'fix.md');
  writeFileSync(fix, 'Corrective: fix the listed blocker.\n');
  const S = {
    seed, box, log, block, fix, arch: `arch-${seed}`, builder: `builder-${seed}`,
    repo: join(box, 'repo'), path: `${bin}:${NODE_DIR}:/usr/bin:/bin`, config,
    slices: [], halted: false, kinds: new Set(), verdictsOk: new Set(['SAFE TO LAND']), verdictKinds: new Set(), steps: 0, history: [],
  };
  const base = { PATH: S.path, HOME: box, TMPDIR: tmpdir(), AGENT_HANDOFFS_DIR: box };
  S.archEnv = { ...base, CLAUDE_CODE_SESSION_ID: S.arch, BORKWEB_SKILLS_CONFIG: config, HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', TMUX: '' };
  S.builderEnv = (slice) => ({ ...base, CLAUDE_CODE_SESSION_ID: S.builder, OFFLOAD_HANDOFF: slice.doc, OFFLOAD_SESSION_ID: S.arch });
  S.intruderEnv = { ...base, CLAUDE_CODE_SESSION_ID: `intruder-${seed}` };
  S.gitEnv = { ...base, ...GIT_IDENT };
  mkdirSync(S.repo, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: S.repo, env: S.gitEnv });
  writeFileSync(join(S.repo, 'README.md'), 'hi\n');
  await exec('git', ['add', 'README.md'], { cwd: S.repo, env: S.gitEnv });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: S.repo, env: S.gitEnv });
  const init = await hoff(S, S.archEnv, ['ledger', 'init', S.repo, 'property run']);
  S.ledger = init.out.trim();
  return S;
}

const hoff = (S, env, args) => exec(NODE, [HANDOFF, ...args], { env });
const sliceSh = (S, args) => exec('bash', [SLICE_SH, ...args], { env: S.archEnv });
const read = (p) => readFileSync(p, 'utf8');
const docStatus = (p) => /^status:\s*(.*)$/m.exec(read(p))[1].trim();
const docOwner = (p) => /^architect_session:\s*(.*)$/m.exec(read(p))?.[1]?.trim() ?? '';
const callsLog = (S) => (existsSync(S.log) ? read(S.log) : '');

// --- verdicts: labelled by how they are made --------------------------------------------------
// valid: the ledger must take it. invalid: it must refuse, with the reason that makes it invalid.
const VERDICTS = [
  { kind: 'review-tagged', valid: true, text: 'gates green; review = DO NOT LAND: token leak (named C1) checkable: lint' },
  { kind: 'review-tagged-no', valid: true, text: 'review = DO NOT LAND: guard fails open (unnamed) checkable: no' },
  { kind: 'gate-failed', valid: true, text: 'gate notes-G4 failed: 3 tests red' },
  { kind: 'review-untagged', valid: false, text: 'review = DO NOT LAND: token leak (unnamed)' },
  { kind: 'review-no-provenance', valid: false, text: 'review = DO NOT LAND: token leak checkable: lint' },
  { kind: 'review-near-miss', valid: false, text: 'review = DO NOT LAND: token leak (named C2) uncheckable: no' },
  { kind: 'empty', valid: false, text: '' },
];

// --- the model and its invariants ----------------------------------------------------------------
const fail = (S, step, msg) => {
  const replay = `SG07_SEED=${S.seed} node --test skills/core/offload/test_property.mjs`;
  assert.fail(`seed ${S.seed}, step ${step} (${S.history.at(-1) ?? 'start'}): ${msg}\n  events so far: ${S.history.join(' | ')}\n  replay: ${replay}`);
};
const expect = (S, step, cond, msg) => { if (!cond) fail(S, step, msg); };

const ledgerNow = (S) => JSON.parse(read(S.ledger));
const rowOf = (S, id) => ledgerNow(S).slices.find((s) => s.id === id);

function invariants(S, step) {
  const l = ledgerNow(S);
  // The model and the ledger agree on every row, and the rows hold no state the model did not cause.
  expect(S, step, l.slices.length === S.slices.length, `ledger holds ${l.slices.length} rows, model ${S.slices.length}`);
  for (const m of S.slices) {
    const row = l.slices.find((s) => s.id === m.id);
    expect(S, step, !!row, `row ${m.id} missing`);
    expect(S, step, row.state === m.state, `row ${m.id} is ${row.state}, expected ${m.state}`);
    // A rejected entry always carries a verdict, and only one the model made valid.
    for (const h of row.history || []) {
      if (h.state !== 'rejected') continue;
      expect(S, step, !!(h.verdict && h.verdict.trim()), `row ${m.id}: a rejected entry has no verdict`);
      expect(S, step, S.verdictsOk.has(h.verdict), `row ${m.id}: the ledger recorded a verdict it must refuse: "${h.verdict}"`);
    }
    if (row.state === 'rejected') expect(S, step, !!(row.verdict || '').trim(), `row ${m.id} is rejected with no verdict`);
    // The doc: one owner, and the status only ever what the model made it.
    expect(S, step, docOwner(m.doc) === S.arch, `doc ${m.id} owner is "${docOwner(m.doc)}", expected ${S.arch}`);
    expect(S, step, docStatus(m.doc) === m.docStatus, `doc ${m.id} status is ${docStatus(m.doc)}, expected ${m.docStatus}`);
  }
}

const live = (S) => S.slices.filter((m) => !['rejected', 'abandoned', 'accepted', 'merged'].includes(m.state));

async function writeEvidence(S, m, { head, complete }) {
  const text = `Head: ${head}\nC1: PASS 1/1\n${complete ? 'C2: PASS 1/1\n' : ''}`;
  const r = await hoff(S, S.builderEnv(m), ['section', 'set', m.doc, 'Gate results', '--text', text]);
  return r;
}
const headOf = async (S, m) => (await exec('git', ['rev-parse', 'HEAD'], { cwd: m.wt, env: S.gitEnv })).out.trim();

// --- events ----------------------------------------------------------------------------------------
async function evDispatch(S, step) {
  const id = String(S.slices.length + 1);
  const wt = join(S.box, `wt-${id}`);
  const ledgerBefore = read(S.ledger);
  const callsBefore = callsLog(S);
  const r = await sliceSh(S, [S.repo, wt, `feat/s${id}`, S.block, '--id', id, '--title', `slice ${id}`]);
  S.history.push(`dispatch ${id}${S.halted ? ' (halted)' : ''}`);
  if (S.halted) {
    expect(S, step, r.code !== 0, 'halt did not block a dispatch');
    expect(S, step, read(S.ledger) === ledgerBefore, 'a refused dispatch changed the ledger');
    expect(S, step, callsLog(S) === callsBefore, 'a halted dispatch still called a frontend');
    return;
  }
  expect(S, step, r.code === 0, `dispatch exited ${r.code}: ${r.err}`);
  const doc = (await hoff(S, S.archEnv, ['path', wt, S.arch])).out.trim();
  S.slices.push({ id, wt, doc, state: 'dispatched', docStatus: 'dispatched', correctives: 0 });
}

async function evReady(S, step) {
  const m = S.rng.pick(live(S));
  const variant = S.rng.pick(['complete', 'incomplete', 'intruder']);
  S.history.push(`ready ${m.id} ${variant}`);
  if (variant === 'intruder') {
    // A write from a second session without --steal changes nothing: not the status, not the owner.
    const before = read(m.doc);
    for (const args of [['status', m.doc, 'blocked'], ['section', 'append', m.doc, 'Open disagreements', '--text', 'intruder was here']]) {
      const r = await hoff(S, S.intruderEnv, args);
      expect(S, step, r.code !== 0, `a second session's ${args[0]} was accepted`);
      expect(S, step, read(m.doc) === before, `a second session's ${args[0]} changed the doc`);
    }
    return;
  }
  const head = await headOf(S, m);
  const wrote = await writeEvidence(S, m, { head, complete: variant === 'complete' });
  expect(S, step, wrote.code === 0, `${variant} evidence write failed: ${wrote.err}`);
  const r = await hoff(S, S.builderEnv(m), ['ready', m.doc]);
  if (variant === 'complete') {
    expect(S, step, r.code === 0, `a complete, fresh ready was refused (${r.code}): ${r.err}`);
    m.docStatus = 'results-ready';
  } else {
    expect(S, step, r.code === 4, `an incomplete ready exited ${r.code}, expected 4: ${r.err}`);
    expect(S, step, /^incomplete:/.test(r.err), 'an incomplete ready must say incomplete:');
  }
}

async function evStale(S, step) {
  const m = S.rng.pick(live(S));
  S.history.push(`stale ${m.id}`);
  const old = await headOf(S, m);
  writeFileSync(join(m.wt, `late-${S.steps}.txt`), `late edit ${S.steps}\n`);
  await exec('git', ['add', `late-${S.steps}.txt`], { cwd: m.wt, env: S.gitEnv });
  await exec('git', ['commit', '-q', '-m', 'late edit'], { cwd: m.wt, env: S.gitEnv });
  const before = m.docStatus;
  const wrote = await writeEvidence(S, m, { head: old, complete: true });
  expect(S, step, wrote.code === 0, `stale evidence write failed: ${wrote.err}`);
  const r = await hoff(S, S.builderEnv(m), ['ready', m.doc]);
  expect(S, step, r.code === 5 && /^stale:/.test(r.err), `a stale ready exited ${r.code}: ${r.err}`);
  expect(S, step, docStatus(m.doc) === before, 'a stale ready changed the status');
}

async function evCorrective(S, step) {
  const m = S.rng.pick(live(S).filter((x) => x.state === 'dispatched' || x.state === 'returned'));
  if (m.state === 'returned') return evFollowUp(S, step, m);
  const viaLedger = S.rng.next() < 0.25;
  const verdict = S.rng.pick(VERDICTS);
  S.verdictKinds.add(verdict.kind);
  S.history.push(`corrective ${m.id} via ${viaLedger ? 'ledger' : 'dispatch-slice'} (${verdict.kind})${S.halted ? ' (halted)' : ''}`);
  const docBefore = read(m.doc);
  const ledgerBefore = read(S.ledger);

  if (viaLedger) {
    // The architect records the rejection itself (halt does not stop a ledger write).
    const r = await hoff(S, S.archEnv, ['ledger', 'set', S.repo, m.id, '--state', 'rejected', '--verdict', verdict.text]);
    if (verdict.valid) {
      expect(S, step, r.code === 0, `ledger refused a valid verdict (${verdict.kind}): ${r.err}`);
      S.verdictsOk.add(verdict.text);
      m.state = 'rejected';
    } else {
      expect(S, step, r.code !== 0, `ledger accepted a verdict it must refuse (${verdict.kind})`);
      expect(S, step, read(S.ledger) === ledgerBefore, 'a refused verdict changed the ledger');
    }
    return;
  }

  if (m.correctives >= 2) { S.history.pop(); return; }
  const r = await sliceSh(S, [S.repo, m.wt, `feat/s${m.id}`, S.fix, '--id', m.id, '--corrective', '--verdict', verdict.text]);
  if (S.halted) {
    expect(S, step, r.code !== 0, 'halt did not block a corrective');
    expect(S, step, read(S.ledger) === ledgerBefore && read(m.doc) === docBefore, 'a halted corrective changed the ledger or the doc');
    return;
  }
  if (!verdict.valid) {
    expect(S, step, r.code !== 0, `a corrective with an invalid verdict (${verdict.kind}) was sent`);
    expect(S, step, read(m.doc) === docBefore, 'a refused corrective changed the builder brief');
    expect(S, step, read(S.ledger) === ledgerBefore, 'a refused corrective changed the ledger');
    return;
  }
  expect(S, step, r.code === 0, `a valid corrective was refused (${r.code}): ${r.err}`);
  S.verdictsOk.add(verdict.text);
  m.state = 'dispatched';
  m.docStatus = 'dispatched';
  m.correctives += 1;
}

// A returned slice (a ruling, no verdict against the work) goes back to the builder with no verdict.
async function evFollowUp(S, step, m) {
  S.history.push(`corrective ${m.id} follow-up of a returned slice${S.halted ? ' (halted)' : ''}`);
  const docBefore = read(m.doc);
  const r = await sliceSh(S, [S.repo, m.wt, `feat/s${m.id}`, S.fix, '--id', m.id, '--corrective']);
  if (S.halted) {
    expect(S, step, r.code !== 0, 'halt did not block a follow-up corrective');
    expect(S, step, read(m.doc) === docBefore, 'a halted follow-up changed the doc');
    return;
  }
  expect(S, step, r.code === 0, `a follow-up on a returned slice was refused (${r.code}): ${r.err}`);
  m.state = 'dispatched';
  m.docStatus = 'dispatched';
}

async function evHalt(S, step) {
  S.history.push('halt');
  const r = await hoff(S, S.archEnv, ['halt', S.repo, 'property halt']);
  expect(S, step, r.code === 0, `halt failed: ${r.err}`);
  S.halted = true;
}
async function evUnhalt(S, step) {
  S.history.push('unhalt');
  const r = await hoff(S, S.archEnv, ['unhalt', S.repo]);
  expect(S, step, r.code === 0, `unhalt failed: ${r.err}`);
  S.halted = false;
}

async function evReturned(S, step) {
  const m = S.rng.pick(live(S));
  S.history.push(`returned ${m.id}`);
  const r = await hoff(S, S.archEnv, ['ledger', 'set', S.repo, m.id, '--state', 'returned', '--verdict', 'ruling sent back, no verdict against the work']);
  expect(S, step, r.code === 0, `returned was refused: ${r.err}`);
  m.state = 'returned';
}
async function evAbandoned(S, step) {
  const m = S.rng.pick(live(S));
  S.history.push(`abandoned ${m.id}`);
  const r = await hoff(S, S.archEnv, ['ledger', 'set', S.repo, m.id, '--state', 'abandoned']);
  expect(S, step, r.code === 0, `abandoned was refused: ${r.err}`);
  m.state = 'abandoned';
}

// A builder that dies leaves a marker naming a dead pid. The board must say nobody is working the slice.
async function evCrash(S, step) {
  const m = S.rng.pick(live(S).filter((x) => x.state === 'dispatched'));
  if (!m) { S.history.push('crash (none to crash)'); return; }
  S.history.push(`crash ${m.id}`);
  const gone = spawn('true', [], { stdio: 'ignore', env: { PATH: S.path } });
  await new Promise((res) => gone.on('close', res));
  writeFileSync(`${m.doc}.builder`, `${gone.pid}\n`);
  const r = await hoff(S, S.archEnv, ['board', S.repo, '--json', '--no-git', '--no-pane']);
  expect(S, step, r.code === 0, `board failed: ${r.err}`);
  const row = JSON.parse(r.out).slices.find((s) => s.id === m.id);
  expect(S, step, row.flags.some((f) => /NO OWNER|BUILDER EXITED|MISMATCH/.test(f)), `a crashed builder left slice ${m.id} unflagged: ${JSON.stringify(row.flags)}`);
}

const EVENTS = { dispatch: evDispatch, ready: evReady, corrective: evCorrective, stale: evStale, halt: evHalt, unhalt: evUnhalt, returned: evReturned, abandoned: evAbandoned, crash: evCrash };

function applicable(S, kind) {
  const hasLive = live(S).length > 0;
  switch (kind) {
    case 'dispatch': return S.slices.length < 3;
    case 'halt': return !S.halted;
    case 'unhalt': return S.halted;
    case 'corrective': return live(S).some((m) => m.state === 'dispatched' || m.state === 'returned');
    case 'crash': return live(S).some((m) => m.state === 'dispatched');
    case 'abandoned': return live(S).length >= 2;
    default: return hasLive;
  }
}

async function runSeed(seed) {
  const S = await setup(seed);
  S.rng = prng(seed);
  // Every seed opens with one dispatch so the rest has a slice to act on.
  S.history.push('dispatch 1 (opening)');
  await evDispatch(S, 0);
  S.history.pop();
  S.kinds.add('dispatch');
  invariants(S, 0);
  for (let step = 1; step <= STEPS; step++) {
    S.steps = step;
    let kind = S.rng.pick(KINDS.flatMap((k) => Array(WEIGHTS[k]).fill(k)));
    for (let tries = 0; !applicable(S, kind) && tries < KINDS.length; tries++) kind = KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length];
    if (!applicable(S, kind)) continue;
    S.kinds.add(kind);
    await EVENTS[kind](S, step);
    invariants(S, step);
  }
  return S;
}

// --- the wait bridge ---------------------------------------------------------------------------------
// For a doc in a random status, with a live builder marker, the bridge must exit with the WAITER line
// the status calls for within its deadline: `ready` for results-ready, `builder-blocked` for blocked,
// and a timeout for every status it does not watch, even when the status changes mid-wait.
const BRIDGE_TIMEOUT = 3;
const KILL_AFTER_MS = (BRIDGE_TIMEOUT + 7) * 1000;

async function bridgeScenario(S, n) {
  const rng = prng(S.seed * 1000 + n);
  const dir = join(S.box, `bridge-${n}`);
  mkdirSync(dir, { recursive: true });
  const doc = (await hoff(S, S.archEnv, ['init', dir, S.arch, `bridge ${n}`])).out.trim();
  const setStatus = (status) => hoff(S, S.archEnv, ['status', doc, status]);
  const start = rng.pick(STATES);
  const flip = rng.next() < 0.5 ? rng.pick(STATES) : null;
  await setStatus(start);
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore', env: { PATH: S.path } });
  writeFileSync(`${doc}.builder`, `${sleeper.pid}\n`);
  const env = { PATH: S.path, HOME: S.box, TMPDIR: tmpdir(), WFR_NO_UPGRADE: '1', WFR_POLL: '1', WFR_GRACE: '2' };
  const child = spawn('bash', [BRIDGE, doc, 'builder', String(BRIDGE_TIMEOUT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const t0 = Date.now();
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  let killed = false;
  const deadline = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, KILL_AFTER_MS);
  if (flip) { await new Promise((r) => setTimeout(r, 700)); await setStatus(flip); }
  const code = await exited;
  clearTimeout(deadline);
  sleeper.kill('SIGKILL');
  const final = flip ?? start;
  const want = final === 'results-ready' ? { code: 0, line: /^WAITER: ready$/m }
    : final === 'blocked' ? { code: 6, line: /^WAITER: builder-blocked/m }
      : { code: 4, line: /^WAITER: timeout after \d+s/m };
  // A flip mid-wait to a watched status wakes the bridge; one that happens after an unwatched start
  // and lands on an unwatched status must still time out.
  const label = `bridge ${n} (status ${start}${flip ? ` -> ${flip}` : ''})`;
  if (killed) fail(S, 'bridge', `${label}: the bridge did not exit within its deadline (${KILL_AFTER_MS / 1000}s), so it never reached a wake or timeout line`);
  // The starting status can wake it before a flip lands: only an unwatched start leaves the flip a chance.
  const startWakes = start === 'results-ready' || start === 'blocked';
  const expected = startWakes ? (start === 'results-ready' ? { code: 0, line: /^WAITER: ready$/m } : { code: 6, line: /^WAITER: builder-blocked/m }) : want;
  if (code !== expected.code || !expected.line.test(out)) fail(S, 'bridge', `${label}: exit ${code}, output ${JSON.stringify(out.trim())}, wanted exit ${expected.code} ${expected.line}`);
  const took = (Date.now() - t0) / 1000;
  if (took > BRIDGE_TIMEOUT + 6) fail(S, 'bridge', `${label}: took ${took}s, past its ${BRIDGE_TIMEOUT}s timeout`);
}

// --- the tests -----------------------------------------------------------------------------------------
test('SG-07: random ledger, handoff and dispatch event sequences keep every invariant', async (t) => {
  const seeds = await Promise.all(SEEDS.map((seed) => runSeed(seed).then((S) => ({ S })).catch((error) => ({ error }))));
  const failed = seeds.find((s) => s.error);
  if (failed) throw failed.error;
  for (const { S } of seeds) t.diagnostic(`seed ${S.seed}: ${S.history.join(' | ')}`);
  if (!process.env.SG07_SEED) {
    const seen = new Set(seeds.flatMap(({ S }) => [...S.kinds]));
    for (const kind of REQUIRED_KINDS) assert.ok(seen.has(kind), `no seed generated a ${kind} event (the generator lost a kind)`);
    const verdicts = new Set(seeds.flatMap(({ S }) => [...S.verdictKinds]));
    for (const v of VERDICTS) assert.ok(verdicts.has(v.kind), `no seed tried a ${v.kind} verdict (the generator lost a verdict kind)`);
  }
});

test('SG-07: the wait bridge wakes on results-ready and blocked only, and always ends within its deadline', async () => {
  const seeds = await Promise.all(SEEDS.map(async (seed) => {
    const S = await setup(seed, 'bridge');
    try {
      await Promise.all([0, 1, 2].map((n) => bridgeScenario(S, n)));
      return {};
    } catch (error) { return { error }; }
  }));
  const failed = seeds.find((s) => s.error);
  if (failed) throw failed.error;
});
