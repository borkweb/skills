// test_reinit_hook.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'reinit-hook.mjs');
const HANDOFF = join(HERE, 'handoff.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'ofl-h-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));
const REPO = join(BOX, 'repo');
const env = { ...process.env, AGENT_HANDOFFS_DIR: BOX, BORK_REVIEW_CRITERIA: join(BOX, 'no-criteria.md') };
delete env.OFFLOAD_UNATTENDED_TURN; delete env.OFFLOAD_HANDOFF; delete env.BORK_DREAM_REMINDER;

const hoff = (args) => execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env }).trim();
const fireHook = (cwd) =>
  execFileSync(NODE, [HOOK], { encoding: 'utf8', env, input: JSON.stringify({ cwd }) });

test('no handoff -> no startup context', () => {
  assert.strictEqual(fireHook(join(BOX, 'empty-repo')), '');
});

test('saved handoff -> concise owner notice without consumption or takeover command', () => {
  const p = hoff(['init', REPO, 'sess-1', 'Proj']);
  const ctx = JSON.parse(fireHook(REPO)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /owner "sess-1"/);
  assert.match(ctx, /Proj/);
  assert.doesNotMatch(ctx, /handoff\.mjs|Handoff CLI|plugins\/cache/);
  assert.doesNotMatch(ctx, /--steal|resolve "\$PWD"|Current state:/);
  assert.ok(existsSync(p));
});

test('multiple handoffs -> menu, no full documents injected', () => {
  hoff(['init', REPO, 'sess-2', 'Proj2']);
  const ctx = JSON.parse(fireHook(REPO)).hookSpecificOutput.additionalContext;
  assert.match(ctx, /2 saved offload handoff/);
  assert.match(ctx, /\[1\]/);
  assert.match(ctx, /\[2\]/);
  assert.doesNotMatch(ctx, /## Gate results|--steal|Resolve YOUR/);
});

test('Codex handoff notice shows the actual architect owner without impersonation', () => {
  const cwd = join(BOX, 'codex-repo');
  const id = 'codex:01a16a67-f178-70e2-9b40-c0babe791262';
  hoff(['init', cwd, id, 'Codex project']);
  const ctx = JSON.parse(fireHook(cwd)).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(`owner "${id}"`));
  assert.doesNotMatch(ctx, /owner "unknown"/);
});

// The wake after a compaction is the one most likely to narrate slice state from
// memory. When this session owns a ledger, SessionStart hands it the board and
// its own handoff path instead of leaving it to re-derive both.
test('a session that owns a ledger gets its board and handoff path at start', () => {
  const cwd = join(BOX, 'ledger-repo');
  const own = { ...env, CLAUDE_CODE_SESSION_ID: 'arch-9' };
  const h = (args) => execFileSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env: own }).trim();
  const doc = h(['resolve', cwd, 'Ledger project']);
  h(['ledger', 'init', cwd, 'ship it']);
  h(['ledger', 'add', cwd, '--id', '1', '--title', 'first slice', '--state', 'specced']);
  const ctx = JSON.parse(execFileSync(NODE, [HOOK], {
    encoding: 'utf8', env: own, input: JSON.stringify({ cwd, session_id: 'arch-9' }),
  })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /BOARD\s+ship it/);
  assert.match(ctx, /first slice/);
  assert.ok(ctx.includes(doc), 'names the handoff this session owns');
});

test('another session’s ledger is listed as a notice only — no board, no path', () => {
  const cwd = join(BOX, 'ledger-repo');
  const ctx = JSON.parse(execFileSync(NODE, [HOOK], {
    encoding: 'utf8', env, input: JSON.stringify({ cwd, session_id: 'stranger' }),
  })).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /BOARD/);
  assert.match(ctx, /owner "arch-9"/);
});

// EC-12: one reminder line when a dream pass is due.
test('dream reminder: due after five changed runs, once, only on an attended startup', () => {
  const box = mkdtempSync(join(tmpdir(), 'ofl-dream-'));
  try {
    const criteria = join(box, 'review-criteria.md');
    const day = (n) => new Date(Date.now() - n * 86_400_000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const setCutoff = (daysAgo) => writeFileSync(criteria, `# Review criteria\n\nLast dreamed: ${iso(day(daysAgo))}, 19 runs scanned.\n`);
    const run = (name, daysAgo) => { const d = join(box, 'runs', name); mkdirSync(d, { recursive: true }); utimesSync(d, day(daysAgo), day(daysAgo)); };
    const fire = (source, extra = {}) => execFileSync(NODE, [HOOK], {
      encoding: 'utf8', input: JSON.stringify({ cwd: join(box, 'repo'), ...(source ? { source } : {}) }),
      env: { ...env, AGENT_HANDOFFS_DIR: box, BORK_REVIEW_CRITERIA: criteria, ...extra },
    });
    const quiet = () => rmSync(join(box, '.dream-reminder'), { force: true });

    setCutoff(6);
    for (let i = 0; i < 4; i += 1) run(`2026-run-${i}`, 2);
    run('2026-old-run', 30);
    run('2026-11-14-dream-abcd', 1);
    assert.strictEqual(fire('startup'), '', 'four runs since, six days: not due; old runs and dream directories do not count');
    run('2026-run-4', 2);
    assert.strictEqual(fire('compact'), '', 'not on compact');
    assert.strictEqual(fire('resume'), '', 'not on resume');
    assert.strictEqual(fire(null), '', 'not without a source');
    assert.strictEqual(fire('startup', { OFFLOAD_UNATTENDED_TURN: '1' }), '', 'not in an unattended turn');
    assert.strictEqual(fire('startup', { OFFLOAD_HANDOFF: '/x' }), '', 'not in a builder');
    assert.strictEqual(fire('startup', { BORK_DREAM_REMINDER: '0' }), '', 'off switch');
    const ctx = JSON.parse(fire('startup')).hookSpecificOutput.additionalContext;
    assert.match(ctx, /^\[dream\] The last dream pass was 6 day\(s\) ago .* and 5 run\(s\) have changed since\..*Do not run it unless they ask\.\n$/);
    assert.strictEqual(fire('startup'), '', 'throttled after one reminder');

    quiet(); setCutoff(20);
    for (let i = 0; i < 5; i += 1) utimesSync(join(box, 'runs', `2026-run-${i}`), day(25), day(25));
    assert.strictEqual(fire('startup'), '', 'old cutoff with no run since: nothing to learn from');
    utimesSync(join(box, 'runs', '2026-run-0'), day(1), day(1));
    assert.match(fire('startup'), /20 day\(s\) ago/, 'over 14 days and one run since: due');

    quiet(); rmSync(criteria);
    assert.strictEqual(fire('startup'), '', 'no private criteria: the user has never dreamed, no reminder');
  } finally { rmSync(box, { recursive: true, force: true }); }
});
