// test_gate_hook.mjs — the Claude Stop hook that runs the frozen local gates (AT-02).
//
// HOOKRUN, as Claude Code runs it: a real dispatch.sh run writes a launch script, a stub
// `claude` records its argv, the Stop command is read out of the --settings JSON and run
// with /bin/sh -c in the worktree, with the env the launch script exports, and the Stop
// input on stdin. Nothing here calls the hook script by path.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert';
import test from 'node:test';
import {
  BOX, HERE, HANDOFF, N, L, cli, docStatus, gitRepo, hostile, mkGateDoc, read, readyFx, scratch, uniq, FORBIDDEN_IN_GATE,
} from './gate-fixture.mjs';

const DISPATCH = join(HERE, 'dispatch.sh');
const BIN = join(BOX, 'bin');
mkdirSync(BIN, { recursive: true });
const TMUX_LOG = join(BOX, 'tmux.log');
const stub = (name, body) => { const p = join(BIN, name); writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`); chmodSync(p, 0o755); };
stub('tmux', `echo "tmux $*" >> "${TMUX_LOG}"`);
stub('claude', 'printf "%s\\n" "$@" > "$ARGV_OUT"; env > "$ENV_OUT"');
stub('quota-axi', 'exit 1');
stub('osascript', 'exit 0');
const CONFIG = join(BOX, 'config.json');
writeFileSync(CONFIG, JSON.stringify({ dispatch: { rules: [{ when: 'x', use: [{ harness: 'claude' }], why: 'test' }] } }));
const PATH = `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin`;
const STOP_INPUT = (extra = {}) => ({ session_id: 'builder', transcript_path: '/dev/null', cwd: '/', permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done', ...extra });

// dispatch.sh against the fixture, then the launch script it wrote, run with a stub claude.
function launch(fx, { handoffsDir } = {}) {
  const block = join(BOX, `block-${uniq()}.md`);
  writeFileSync(block, 'BUILDER BLOCK\n');
  rmSyncLog();
  const env = { PATH, HOME: BOX, TMPDIR: tmpdir(), TMUX: '/tmp/tmux-1,1,0', HERDR_ENV: '', HERDR_WORKSPACE_ID: '', BORKWEB_SKILLS_CONFIG: CONFIG, CODEX_HOME: join(BOX, 'codex'),
    ...(handoffsDir ? { AGENT_HANDOFFS_DIR: handoffsDir } : {}) };
  execFileSync('bash', [DISPATCH, fx.dir, block, fx.doc, 'arch'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const script = /bash (\S+\.sh)/.exec(read(TMUX_LOG))?.[1];
  assert.ok(script, 'dispatch.sh wrote a launch script');
  const argvOut = join(BOX, `argv-${uniq()}`);
  const envOut = join(BOX, `env-${uniq()}`);
  execFileSync('bash', [script], { env: { PATH, HOME: BOX, TMPDIR: tmpdir(), ARGV_OUT: argvOut, ENV_OUT: envOut }, stdio: 'ignore' });
  const argv = read(argvOut).split('\n');
  const i = argv.indexOf('--settings');
  assert.ok(i >= 0, 'the claude launch passes --settings');
  const sid = argv[argv.indexOf('--session-id') + 1];
  const launched = Object.fromEntries(read(envOut).split('\n').filter((l) => /^OFFLOAD_/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { settingsText: argv[i + 1], settings: JSON.parse(argv[i + 1]), sid, launched };
}
function rmSyncLog() { try { writeFileSync(TMUX_LOG, ''); } catch { /* none */ } }

const stopCommand = (lf) => lf.settings.hooks.Stop[0].hooks[0].command;
function hookrun(fx, lf, { input = JSON.stringify(STOP_INPUT()), env: extra = {}, command = stopCommand(lf), handoffsDir } = {}) {
  const env = { PATH, HOME: BOX, TMPDIR: tmpdir(), AGENT_HANDOFFS_DIR: handoffsDir ?? BOX, ...lf.launched, CLAUDE_CODE_SESSION_ID: lf.sid, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync('/bin/sh', ['-c', command], { cwd: fx.dir, env, input, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const withGates = (cmds, extra = {}) => { const fx = readyFx(cmds, extra); return { fx, lf: launch(fx) }; };

test('C6a: --settings is valid JSON', () => {
  const { lf } = withGates(['true']);
  assert.equal(typeof JSON.parse(lf.settingsText), 'object');
});

test('C6b/C6e: one Stop entry runs the gate check and then the touch', () => {
  const { lf } = withGates(['true']);
  assert.equal(lf.settings.hooks.Stop.length, 1, 'one Stop entry: sibling entries run in parallel');
  assert.equal(lf.settings.hooks.Stop[0].hooks.length, 1);
  const c = stopCommand(lf);
  const gate = c.indexOf('stop-gates');
  const touch = c.indexOf('.turn-ended');
  assert.ok(gate >= 0, `the Stop command runs the gate check: ${c}`);
  assert.ok(touch > gate, `the touch comes after the check: ${c}`);
});

test('C6c: the Stop timeout is an integer above the check’s own deadline (C11: 900)', () => {
  const { lf } = withGates(['true']);
  const t = lf.settings.hooks.Stop[0].hooks[0].timeout;
  const deadline = Number(/LOCAL_GATES_DEADLINE_S = (\d+)/.exec(read(HANDOFF))?.[1]);
  assert.ok(Number.isInteger(t), `timeout ${t}`);
  assert.ok(Number.isInteger(deadline) && deadline > 0, 'the runner enforces an overall deadline');
  assert.ok(t > deadline, `hook timeout ${t} must exceed the deadline ${deadline}`);
  assert.equal(t, 900);
});

test('C6d: Notification stays the turn-ended touch and runs no gate', () => {
  const { lf } = withGates(['true']);
  const n = lf.settings.hooks.Notification;
  assert.equal(n.length, 1);
  const c = n[0].hooks[0].command;
  assert.match(c, /^touch /);
  assert.ok(c.includes('.turn-ended'));
  assert.ok(!c.includes('stop-gates'));
});

test('C6f/C6g/C7a: a red gate blocks the stop: exit 2, reason names red:, the gate and the saved path', () => {
  const { fx, lf } = withGates(['echo boom-marker >&2; exit 3']);
  const r = hookrun(fx, lf);
  assert.equal(r.code, 2, `${r.out}${r.err}`);
  const reason = r.err || JSON.parse(r.out).reason;
  assert.ok(reason.startsWith('red:'), reason);
  assert.match(reason, /\bL1\b/);
  const path = /(\/[^\s]+)/.exec(reason.replace(/^red:/, ''))?.[1];
  assert.ok(path && existsSync(path), `saved output: ${path}`);
  assert.match(read(path), /boom-marker/);
  assert.ok(!existsSync(`${fx.doc}.turn-ended`), 'a blocked stop must not wake the architect');
});

test('C6h: a gate whose output says "No such file or directory" still blocks', () => {
  const { fx, lf } = withGates([`cat /nonexistent-${uniq('p')}`]);
  const r = hookrun(fx, lf);
  assert.equal(r.code, 2);
  assert.ok(r.out.trim() !== '' || !/No such file or directory/.test(r.err), `would be a non-blocking error: ${r.err}`);
});

test('C6i: no local gates: exit 0 and empty stdout', () => {
  const { fx, lf } = withGates([]);
  const r = hookrun(fx, lf);
  assert.deepEqual([r.code, r.out], [0, '']);
});

test('C6j: green gates and status dispatched: exit 0, the doc is byte-identical', () => {
  const { fx, lf } = withGates(['true']);
  const before = read(fx.doc);
  const r = hookrun(fx, lf);
  assert.equal(r.code, 0, r.err);
  assert.equal(read(fx.doc), before);
  assert.equal(docStatus(fx.doc), 'dispatched');
});

test('C6k/C14: stop_hook_active true never blocks, even on a red gate', () => {
  const { fx, lf } = withGates(['exit 3']);
  const r = hookrun(fx, lf, { input: JSON.stringify(STOP_INPUT({ stop_hook_active: true })) });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(`${fx.doc}.turn-ended`), 'the stop goes through, so the touch happens');
});

test('C14: the Stop command is the gate check, and it exits 0 on stop_hook_active even with a red gate', () => {
  const { fx, lf } = withGates(['exit 3']);
  assert.match(stopCommand(lf), /stop-gates/, 'the Stop entry runs the gate check');
  assert.equal(hookrun(fx, lf).code, 2, 'without the flag the red gate blocks');
  const r = hookrun(fx, lf, { input: JSON.stringify(STOP_INPUT({ stop_hook_active: true })) });
  assert.equal(r.code, 0, r.err);
});

test('C15: gates run only in dispatched or results-ready; every other status exits 0 and runs nothing', () => {
  for (const status of ['dispatched', 'results-ready', 'blocked', 'accepted', 'rejected', 'returned', 'abandoned', 'merged']) {
    const fx = readyFx((out) => [`touch ${out}/ran; exit 3`], { status });
    const lf = launch(fx);
    const r = hookrun(fx, lf);
    const runs = existsSync(join(fx.out, 'ran'));
    if (status === 'dispatched' || status === 'results-ready') { assert.equal(r.code, 2, status); assert.ok(runs, status); } else { assert.equal(r.code, 0, `${status}: ${r.err}`); assert.ok(!runs, `${status} ran a gate`); }
  }
});

test('C6l: a handoff path with a space and a quote still works end to end', () => {
  const handoffs = join(BOX, `a b"c-${uniq()}`);
  mkdirSync(join(handoffs, 'offload'), { recursive: true });
  const repo = gitRepo();
  const out = scratch();
  const doc = join(handoffs, 'offload', 'doc.md');
  const seed = mkGateDoc({ frozen: [L('L1', `touch ${out}/ran`)], head: repo.head, cwd: repo.dir });
  writeFileSync(doc, read(seed));
  const fx = { dir: repo.dir, doc, out };
  const lf = launch(fx, { handoffsDir: handoffs });
  const r = hookrun(fx, lf, { handoffsDir: handoffs });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(out, 'ran')), 'the gate ran for that doc');
  assert.ok(existsSync(`${doc}.turn-ended`), 'exactly <doc>.turn-ended was touched');
});

test('C6m: hook failure paths never exit 2', () => {
  const { fx, lf } = withGates(['exit 3']);
  const cases = [
    ['OFFLOAD_HANDOFF unset', { env: { OFFLOAD_HANDOFF: undefined } }],
    ['doc missing', { env: { OFFLOAD_HANDOFF: join(BOX, 'no-such-doc.md') } }],
    ['stdin empty', { input: '' }],
    ['stdin not JSON', { input: 'not json {' }],
    ['helper missing', { command: stopCommand(lf).replace(/\S*stop-gates\S*/, '/nonexistent/stop-gates.mjs') }],
  ];
  for (const [what, o] of cases) {
    const r = hookrun(fx, lf, o);
    assert.notEqual(r.code, 2, `${what}: exit 2 would block the stop`);
  }
});

test('C6n: the touch happens after the check has finished', () => {
  const fx0 = readyFx(['true']);
  const doc = fx0.doc;
  writeFileSync(doc, read(doc).replace(L('L1', 'true'), L('L1', `touch ${fx0.out}/ran; test ! -e "${doc}.turn-ended"`)));
  const lf = launch(fx0);
  const r = hookrun(fx0, lf);
  assert.ok(existsSync(join(fx0.out, 'ran')), 'the gate ran');
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(`${doc}.turn-ended`), 'the marker exists after a passing stop');
});

test('C3y: ready and the hook give the same verdict and name the same gate', () => {
  const red = readyFx(['exit 3']);
  const green = readyFx(['true']);
  const rr = cli(['ready', red.doc], { session: 's' });
  const hr = hookrun(red, launch(red));
  assert.equal(rr.code, N);
  assert.equal(hr.code, 2);
  assert.match(rr.err, /\bL1\b/);
  assert.match(hr.err || hr.out, /\bL1\b/);
  assert.equal(cli(['ready', green.doc], { session: 's' }).code, 0);
  assert.equal(hookrun(green, launch(green)).code, 0);
});

test('C5f: the allowlist holds when the gate runs through the hook under a hostile env', () => {
  const fx = readyFx((out) => [`env > ${out}/dump`]);
  const lf = launch(fx);
  const r = hookrun(fx, lf, { env: hostile(fx.out) });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(fx.out, 'dump')), 'the gate ran and wrote its env dump');
  const names = read(join(fx.out, 'dump')).split('\n').filter(Boolean).map((l) => l.split('=')[0]);
  assert.ok(names.length > 0 && names.includes('PATH') && names.includes('HOME'));
  for (const v of FORBIDDEN_IN_GATE) assert.ok(!names.includes(v), `${v} reached the gate`);
  assert.ok(!existsSync(join(fx.out, 'env-sourced')), 'a startup script ran');
});
