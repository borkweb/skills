// testkit.mjs — shared fixtures for the orchestrate tests (not a test file).
//
// Every test builds its environment FROM SCRATCH, never from process.env: the
// builder's own shell carries OFFLOAD_HANDOFF, BORK_RUN_DIR and a live herdr
// pane, and any of them would change what runs.mjs does. PATH holds only the
// stub dir, node's dir and /usr/bin:/bin, so the live herdr is unreachable.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNS = join(HERE, 'runs.mjs');
export const NODE = process.execPath;
export const NODE_DIR = dirname(NODE);

const HERDR_STUB = `#!/usr/bin/env node
// Stub herdr: logs argv as one JSON line; behavior comes from HERDR_STUB_* env.
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_STUB_LOG, JSON.stringify(a) + '\\n');
const mode = process.env.HERDR_STUB_MODE || 'ok';
const key = a.slice(0, 2).join(' ');
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
if (key === 'tab create') {
  if (a.includes('--help')) {
    process.stdout.write('Usage: herdr tab create [OPTIONS]\\n  --workspace <ID>\\n  --cwd <PATH>\\n  --label <TEXT>\\n  --focus\\n' + (process.env.HERDR_STUB_HELP === 'without' ? '' : '  --no-focus\\n'));
  } else if (mode === 'fail-create') fail('herdr: workspace not found');
  else process.stdout.write('{"result":{"root_pane":{"pane_id":"w9:p7","tab_id":"w9:t7","workspace_id":"w9"},"tab":{"tab_id":"w9:t7"},"type":"tab_created"}}\\n');
} else if (key === 'pane run') {
  if (mode === 'fail-run') fail('herdr: pane w9:p7 not found');
} else if (key === 'pane current') {
  if (mode === 'fail-current') fail('herdr: no current pane');
  process.stdout.write('{"result":{"pane":{"pane_id":"wc:p1","tab_id":"wc:t1","workspace_id":"wc"},"type":"pane_current"}}\\n');
} else if (key === 'agent prompt') {
  if (process.env.HERDR_STUB_SNAP_SRC) fs.copyFileSync(process.env.HERDR_STUB_SNAP_SRC, process.env.HERDR_STUB_LOG + '.snap');
  if (mode === 'prompt-fail') fail('herdr: agent not found');
  if (mode === 'prompt-error') process.stdout.write('{"error":{"code":"agent_not_found","message":"no agent"}}\\n');
  else if (mode === 'prompt-blocked') process.stdout.write('{"result":{"status":"agent_blocked"},"type":"agent_prompt"}\\n');
  else process.stdout.write('{"result":{"type":"agent_prompt_accepted"}}\\n');
} else if (key === 'agent get') {
  const have = (process.env.HERDR_STUB_AGENTS || '').split(',');
  if (have.includes(a[2])) process.stdout.write('{"result":{"agent":{"agent":"claude","pane_id":"' + a[2] + '"}}}\\n');
  else { process.stdout.write('{"error":{"code":"agent_not_found"}}\\n'); process.exit(1); }
}
`;

// Stub claude/codex: log argv and cwd; STUB_ACTION scripts what the architect does.
const ARCH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify({ bin: require('node:path').basename(process.argv[1]), argv: process.argv.slice(2), cwd: process.cwd(), runId: process.env.BORK_RUN_ID || null }) + '\\n');
const cli = (args) => cp.spawnSync(process.execPath, [process.env.BORK_RUNS_CLI, ...args], { encoding: 'utf8' });
const act = process.env.STUB_ACTION || '';
if (act === 'ask') {
  const r = cli(['ask', process.env.BORK_RUN_ID, '--question', 'which?', '--options', '[{"label":"A","description":"a"},{"label":"B","description":"b"}]', '--recommendation', 'A']);
  process.exit(r.status);
}
if (act === 'done') cli(['set', process.env.BORK_RUN_ID, '--state', 'done', '--delivery', 'shipped']);
if (act === 'exit3') process.exit(3);
`;

export function newBox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-')));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  const b = {
    root, bin: join(root, 'bin'), home: join(root, 'home'), handoffs: join(root, 'handoffs'),
    log: join(root, 'herdr.log'), argv: join(root, 'argv.log'),
  };
  b.runs = join(b.handoffs, 'runs');
  b.orch = join(b.home, '.borkweb-skills', 'orchestrator');
  for (const d of [b.bin, b.home, b.handoffs, b.runs, b.orch]) mkdirSync(d, { recursive: true });
  for (const [name, body] of [['herdr', HERDR_STUB], ['claude', ARCH_STUB], ['codex', ARCH_STUB]]) {
    writeFileSync(join(b.bin, name), body);
    chmodSync(join(b.bin, name), 0o755);
  }
  return b;
}

export const stubPath = (b) => `${b.bin}:${NODE_DIR}:/usr/bin:/bin`;
export const barePath = () => `${NODE_DIR}:/usr/bin:/bin`;

// An undefined value in `extra` removes the variable.
export function env(b, extra = {}) {
  const e = {
    PATH: stubPath(b), HOME: b.home, AGENT_HANDOFFS_DIR: b.handoffs, BORK_RUNS_HOME: b.runs,
    ORCHESTRATOR_HOME: b.orch, HERDR_ENV: '1', HERDR_PANE_ID: 'tw:p1', HERDR_WORKSPACE_ID: 'tw',
    HERDR_STUB_LOG: b.log, STUB_ARGV_LOG: b.argv, ...extra,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

export function run(b, args, extra = {}, opts = {}) {
  const r = spawnSync(NODE, [RUNS, ...args], { env: env(b, extra), encoding: 'utf8', timeout: 40000, cwd: opts.cwd ?? b.root });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export function runAsync(b, args, extra = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(NODE, [RUNS, ...args], { env: env(b, extra), cwd: b.root });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  });
}

// A running child we can still kill: returns {done: Promise, kill()}.
export function spawnChild(b, args, extra = {}) {
  const p = spawn(NODE, [RUNS, ...args], { env: env(b, extra), cwd: b.root });
  let out = ''; let err = '';
  const t0 = Date.now();
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => p.on('close', (code, sig) => resolve({ code, sig, out, err, ms: Date.now() - t0 })));
  return { done, kill: () => p.kill('SIGKILL') };
}

export const QOPTS = JSON.stringify([{ label: 'A', description: 'da' }, { label: 'B', description: 'db' }]);

export function mkRun(b, { goal = 'goal', slug = 'job', extra = [], env: x = {} } = {}) {
  const r = run(b, ['init', '--goal', goal, '--slug', slug, ...extra], x);
  if (r.code !== 0) throw new Error(`init failed: ${r.err}`);
  const dir = r.out.split('\n')[0];
  return { dir, id: dir.split('/').pop() };
}

export const recPath = (dir) => join(dir, 'run.json');
export const readRec = (dir) => JSON.parse(readFileSync(recPath(dir), 'utf8'));
export const writeRec = (dir, patch) => {
  const rec = { ...readRec(dir), ...patch };
  writeFileSync(recPath(dir), JSON.stringify(rec, null, 2) + '\n');
  return rec;
};
export const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export const ask = (b, id, q = 'which?', extra = {}) => run(b, ['ask', id, '--question', q, '--options', QOPTS, '--recommendation', 'A'], extra);

// No lock, stale-lock or tmp file left in a run dir.
export const debris = (dir) => readdirSync(dir).filter((f) => /^run\.json\.(lock|tmp-)/.test(f));

export const calls = (b) => {
  try { return readFileSync(b.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
export const rawLog = (b) => { try { return readFileSync(b.log, 'utf8'); } catch { return ''; } };
export const nudges = (b) => calls(b).filter((c) => c[0] === 'agent' && c[1] === 'prompt');
export const resetLog = (b) => rmSync(b.log, { force: true });

export function mkRepo(b, name = 'repo') {
  const r = join(b.root, name);
  mkdirSync(r, { recursive: true });
  const g = (...a) => spawnSync('git', a, { cwd: r, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: b.home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(r, 'f.txt'), 'x\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  return realpathSync(r);
}

export const claim = (b, pane = 'tw:p9') => run(b, ['claim', '--pane', pane]);
export const orchestratorRun = (b, opts) => {
  const r = mkRun(b, opts);
  writeRec(r.dir, { launched_by: 'orchestrator' });
  return r;
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { existsSync };
