// test_k1_env.mjs — K1: what environment a builder and quota-axi get.
//
// The builder is the user's own agent, so it keeps the user's environment (an
// auth key must still reach it), minus two things: session pointers, which are
// always dropped, and run pointers (BORK_RUN_DIR, BORK_RUN_ID), which survive
// only while the run they name is live. quota-axi needs no secrets, so it gets a
// true allowlist. Every case runs the real scripts under a hostile ambient env:
// a unique K1_CANARY_* name, tokens, stale run and session pointers, and the
// auth canary OPENAI_API_KEY that must still reach the builder.
//
// Each stub writes its `env` to an absolute log path embedded in the stub text,
// not passed through the environment; a missing or empty dump fails the case, so
// a stub that never ran cannot pass for a clean env.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(HERE, 'dispatch.sh');
const HARNESS = join(HERE, 'harness.mjs');
const STOP_HOOK = join(HERE, 'stop-hook.mjs');
const HANDOFF_MJS = join(HERE, 'handoff.mjs');
const BOX = mkdtempSync(join(tmpdir(), 'ofl-k1-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const NODE_DIR = dirname(process.execPath);
const CANARY = `K1_CANARY_${randomBytes(6).toString('hex')}`;
const SENTINEL = join(BOX, 'sentinel');
mkdirSync(SENTINEL, { recursive: true });
const AUTH = 'k1-auth-canary';
const SID = 'sess-Z';

// The hostile ambient env the ruling lists. `runDir` is the per-case BORK_RUN_DIR.
const hostile = (runDir) => ({
  [CANARY]: randomBytes(4).toString('hex'),
  GITHUB_TOKEN: 'hostile', AWS_SECRET_ACCESS_KEY: 'hostile', ANTHROPIC_API_KEY: 'hostile',
  CLAUDE_CODE_SESSION_ID: 'hostile-sid', CODEX_SESSION_ID: 'hostile-sid',
  ...(runDir === undefined ? {} : { BORK_RUN_DIR: runDir }), BORK_RUN_ID: 'hostile-run', BORK_RUNS_HOME: SENTINEL,
  OFFLOAD_HANDOFF: '/hostile/handoff.md', OFFLOAD_SESSION_ID: 'hostile-arch',
  OPENAI_API_KEY: AUTH,
});

let caseN = 0;
// A bin dir whose stubs each dump their env to `dump`, plus a Linux `uname` and a
// herdr that creates a tab and logs what it was asked to run.
function stubs() {
  const dir = join(BOX, `bin-${++caseN}`);
  mkdirSync(dir, { recursive: true });
  const dump = join(dir, 'dump.txt');
  const calls = join(dir, 'calls.log');
  const write = (name, body) => { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  for (const h of ['claude', 'codex', 'opencode', 'custom-harness']) write(h, `env > '${dump}'`);
  write('uname', 'echo Linux');
  write('quota-axi', 'exit 1');
  write('herdr', `echo "herdr $*" >> '${calls}'
if [ "$1 $2" = "tab create" ]; then echo '{"result":{"root_pane":{"pane_id":"w9:p7","tab_id":"w9:t7","workspace_id":"w9"},"tab":{"tab_id":"w9:t7"},"type":"tab_created"}}'; fi`);
  return { dir, dump, calls, path: `${dir}:${NODE_DIR}:/usr/bin:/bin` };
}

const parseEnv = (text) => {
  const m = new Map();
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) m.set(line.slice(0, i), line.slice(i + 1)); }
  return m;
};
const readDump = (file) => {
  assert.ok(existsSync(file), `the stub ran and wrote ${file}`);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.trim().length > 0, 'the env dump is not empty');
  return parseEnv(text);
};

const CONFIG = join(BOX, 'config.json');
const BLOCK = join(BOX, 'block.md');
writeFileSync(BLOCK, 'BUILDER BLOCK CONTENTS\n');
let handoffN = 0;
const newHandoff = () => { const p = join(BOX, `handoff-${++handoffN}.md`); writeFileSync(p, '---\nstatus: dispatched\n---\n'); return p; };
const CODEX_HOME = join(BOX, 'codex-home');
mkdirSync(join(CODEX_HOME, 'sessions'), { recursive: true });

// Run dispatch.sh headless (TMUX='', no herdr, uname = Linux) with `harness` as the
// override profile, or the custom-command profile when harness is 'custom'.
function dispatchHeadless(harness, runDir, { cwd } = {}) {
  const s = stubs();
  const handoff = newHandoff();
  let spec = harness;
  if (harness === 'custom') {
    writeFileSync(CONFIG, JSON.stringify({ dispatch: { rules: [{ when: 'x', why: 'x', use: [{ harness: 'mytool', command: `${join(s.dir, 'custom-harness')} __PROMPT_FILE__` }] }] } }));
    spec = undefined;
  }
  const env = { PATH: s.path, HOME: BOX, TMPDIR: tmpdir(), TMUX: '', BORKWEB_SKILLS_CONFIG: CONFIG, CODEX_HOME, ...hostile(runDir) };
  const r = spawnSync('bash', [DISPATCH, BOX, BLOCK, handoff, SID, ...(spec ? [spec] : [])], { encoding: 'utf8', env, cwd });
  assert.equal(r.status, 0, `dispatch exited ${r.status}: ${r.stderr}`);
  return { env: readDump(s.dump), parentPath: s.path, handoff };
}

// --- the truth table (council-k1-ruling.md condition 3) -----------------------------
const ROWS = [
  ['running', true, (d) => writeFileSync(join(d, 'run.json'), JSON.stringify({ schema: 1, state: 'running' }))],
  ['needs-me', true, (d) => writeFileSync(join(d, 'run.json'), JSON.stringify({ schema: 1, state: 'needs-me' }))],
  ['blocked', true, (d) => writeFileSync(join(d, 'run.json'), JSON.stringify({ schema: 1, state: 'blocked' }))],
  ['done', false, (d) => writeFileSync(join(d, 'run.json'), JSON.stringify({ schema: 1, state: 'done' }))],
  ['failed', false, (d) => writeFileSync(join(d, 'run.json'), JSON.stringify({ schema: 1, state: 'failed' }))],
  ['missing directory', false, null],
  ['directory with no run.json', true, () => {}],
  ['unreadable run.json', true, (d) => writeFileSync(join(d, 'run.json'), '{ not json')],
  // K6: `[ -d ]` is false for a regular file, so the hook must call it dead too
  ['run dir is a regular file', false, null, true],
];
let rowN = 0;
const rowDir = ([, , make, asFile]) => {
  const d = join(BOX, `run-${++rowN}`);
  if (asFile) writeFileSync(d, 'a file, not a run directory\n');
  else if (make) { mkdirSync(d, { recursive: true }); make(d); }
  return d;
};

const rowNamed = (name) => ROWS.find((r) => r[0] === name);

// One headless dispatch of `harness` with the row's run pointer, and every env assert on it.
function checkHeadlessRow(harness, row) {
  const [name, live] = row;
  const dir = rowDir(row);
  const { env, parentPath, handoff } = dispatchHeadless(harness, dir);
  const label = `${harness} / ${name}`;
  if (live) {
    assert.equal(env.get('BORK_RUN_DIR'), dir, `${label}: BORK_RUN_DIR kept`);
    assert.equal(env.get('BORK_RUN_ID'), 'hostile-run', `${label}: BORK_RUN_ID travels with it`);
  } else {
    assert.equal(env.has('BORK_RUN_DIR'), false, `${label}: BORK_RUN_DIR dropped`);
    assert.equal(env.has('BORK_RUN_ID'), false, `${label}: BORK_RUN_ID dropped`);
  }
  assert.equal(env.has('CLAUDE_CODE_SESSION_ID'), false, `${label}: no Claude session id`);
  assert.equal(env.has('CODEX_SESSION_ID'), false, `${label}: no Codex session id`);
  assert.equal(env.get('OFFLOAD_SESSION_ID'), SID, label);
  assert.equal(env.get('OFFLOAD_HANDOFF'), handoff, label);
  assert.equal(env.get('OPENAI_API_KEY'), AUTH, `${label}: the builder exception keeps the user's auth`);
  assert.equal(env.get('PATH'), parentPath, `${label}: PATH unchanged`);
}

// The liveness predicate is shared (run-env.sh), so one harness runs the whole table.
test(`C12/C14: headless claude builder env follows the liveness table and keeps the user's auth`, () => {
  for (const row of ROWS) checkHeadlessRow('claude', row);
});

// Every other run_headless branch carries its own unset, scrub call and OFFLOAD_* assignments.
for (const harness of ['codex', 'opencode', 'custom']) {
  test(`C12/C14: headless ${harness} builder env keeps a live run pointer, drops a dead one, drops session ids and keeps the user's auth`, () => {
    for (const name of ['running', 'done']) checkHeadlessRow(harness, rowNamed(name));
  });
}

// K5: a run dir whose name starts with `-` must never be read as a node option.
test('K5: a done run dir named -v is dead and node is never asked for its version', () => {
  const rel = '-v';
  mkdirSync(join(BOX, rel), { recursive: true });
  writeFileSync(join(BOX, rel, 'run.json'), JSON.stringify({ schema: 1, state: 'done' }));
  const { env } = dispatchHeadless('claude', rel, { cwd: BOX });
  // `node -e '...' -v` prints the version and exits 0, which reads as live
  assert.equal(env.has('BORK_RUN_DIR'), false, 'the dead run dir was kept: node read its name as an option');
  const live = join(BOX, '-live');
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, 'run.json'), JSON.stringify({ schema: 1, state: 'running' }));
  assert.equal(dispatchHeadless('claude', '-live', { cwd: BOX }).env.get('BORK_RUN_DIR'), '-live', 'a live dash-named run dir is kept');
});

// --- T1b: the interactive launch script runs in the tab shell -------------------------
// Under herdr the harness runs in the new tab's shell, whose env came from the herdr
// server (stale pointers included), so the launch script itself must decide.
function dispatchHerdr(runDir) {
  const s = stubs();
  const handoff = newHandoff();
  const env = {
    PATH: s.path, HOME: BOX, TMPDIR: tmpdir(), HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w3', BORKWEB_SKILLS_CONFIG: CONFIG, CODEX_HOME,
    ...hostile(runDir),
  };
  const r = spawnSync('bash', [DISPATCH, BOX, BLOCK, handoff, SID, 'claude'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `dispatch exited ${r.status}: ${r.stderr}`);
  const m = readFileSync(s.calls, 'utf8').match(/bash (\S+\.sh)/);
  assert.ok(m, 'herdr was asked to run a launch script');
  return { ...s, launch: m[1], handoff };
}
// What the harness sees when the tab shell (with its own stale pointers) runs the launch script.
function runLaunch(d, tabRunDir) {
  rmSync(d.dump, { force: true });
  const env = { PATH: d.path, HOME: BOX, TMPDIR: tmpdir(), ...hostile(tabRunDir), BORK_RUN_ID: 'tab-stale-run' };
  const r = spawnSync('bash', [d.launch], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `launch script exited ${r.status}: ${r.stderr}`);
  return { env: readDump(d.dump), parentPath: d.path };
}
const staleDir = () => { const d = join(BOX, `tab-stale-${++rowN}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'run.json'), JSON.stringify({ schema: 1, state: 'done' })); return d; };

test('C13a/C13c: a live dispatch run pointer reaches the builder in place of the tab shell’s stale one', () => {
  const live = rowDir(ROWS[0]);
  const d = dispatchHerdr(live);
  const { env, parentPath } = runLaunch(d, staleDir());
  assert.equal(env.get('BORK_RUN_DIR'), live);
  assert.equal(env.get('BORK_RUN_ID'), 'hostile-run', 'dispatch’s id, not the tab shell’s');
  assert.equal(env.has('CLAUDE_CODE_SESSION_ID'), false);
  assert.equal(env.has('CODEX_SESSION_ID'), false);
  assert.equal(env.get('OFFLOAD_SESSION_ID'), SID);
  assert.equal(env.get('OFFLOAD_HANDOFF'), d.handoff);
  assert.equal(env.get('OPENAI_API_KEY'), AUTH);
  assert.equal(env.get('PATH'), parentPath);
});

test('C13b: a dead or absent dispatch run pointer leaves the builder with neither variable', () => {
  const dead = rowDir(ROWS[3]);
  for (const [label, d] of [['dead', dispatchHerdr(dead)], ['none', dispatchHerdr(undefined)]]) {
    const tabLive = rowDir(ROWS[0]);
    const { env } = runLaunch(d, tabLive);
    assert.equal(env.has('BORK_RUN_DIR'), false, `${label}: the tab shell’s live pointer is dropped too`);
    assert.equal(env.has('BORK_RUN_ID'), false, label);
    assert.equal(env.get('OFFLOAD_SESSION_ID'), SID);
  }
});

test('C13d: a live run dir with a space, a quote and a command substitution arrives exactly and runs nothing', () => {
  const inj = join(BOX, 'inj');
  const awkward = join(BOX, `rd q'uote space $(touch ${inj})`);
  mkdirSync(awkward, { recursive: true });
  writeFileSync(join(awkward, 'run.json'), JSON.stringify({ schema: 1, state: 'running' }));
  const d = dispatchHerdr(awkward);
  const { env } = runLaunch(d, staleDir());
  assert.equal(env.get('BORK_RUN_DIR'), awkward);
  assert.ok(!existsSync(inj), 'nothing was executed');
});

// --- C14a/C14b: one liveness predicate, agreeing with the Stop hook ----------------------
test('C14a: dispatch.sh and dispatch-slice.sh share one env_run_dir_live definition', () => {
  const shells = readdirSync(HERE).filter((f) => f.endsWith('.sh'));
  const defs = shells.filter((f) => /^env_run_dir_live\(\)/m.test(readFileSync(join(HERE, f), 'utf8')));
  assert.equal(defs.length, 1, `defined once, found in ${defs.join(', ')}`);
  assert.match(readFileSync(DISPATCH, 'utf8'), /env_run_dir_live/);
  assert.match(readFileSync(join(HERE, 'dispatch-slice.sh'), 'utf8'), /env_run_dir_live/);
});

const RUN_FIELDS = (state) => ({
  schema: 1, id: 'run-1', run_dir: '/x', repo: null, goal: 'g', task: null, state, summary: '', delivery: null,
  questions: [], architect: { harness: 'claude', session_id: null, frontend: null, tab: null, pane: null },
  launched_by: 'self', revision: 1, signal_revision: 0, orchestrator_ack: 0,
  created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:00:00Z', history: [],
});
const validRun = (name, state) => { const d = join(BOX, `valid-${name}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'run.json'), JSON.stringify(RUN_FIELDS(state))); return d; };

// The Stop hook uses envRunDir() only to pick the run it checks for needs-me. Two
// ledgers tell its answer apart: one linked to a needs-me run (silent unless the
// env dir is chosen and is not needs-me), one linked to a running run (silent only
// if the env dir is chosen and is needs-me). The env dir was chosen when either
// the first blocks or the second stays silent.
function stopHookChoosesEnvDir(envDir) {
  const box = join(BOX, `stop-${++rowN}`);
  mkdirSync(box, { recursive: true });
  const base = { PATH: process.env.PATH, HOME: BOX, TMPDIR: tmpdir(), AGENT_HANDOFFS_DIR: box };
  const fire = (ledgerRun) => {
    const REPO = join(box, `repo-${ledgerRun.split('/').pop()}`);
    const hoff = (args) => execFileSync(process.execPath, [HANDOFF_MJS, ...args], { encoding: 'utf8', env: { ...base, CLAUDE_CODE_SESSION_ID: 'arch' } });
    hoff(['ledger', 'init', REPO, 'g', '--run-dir', ledgerRun]);
    hoff(['ledger', 'add', REPO, '--id', '1', '--title', 't', '--state', 'dispatched']);
    return execFileSync(process.execPath, [STOP_HOOK], {
      encoding: 'utf8', input: JSON.stringify({ session_id: 'arch', cwd: REPO }),
      env: { ...base, CLAUDE_CODE_SESSION_ID: 'arch', BORK_RUN_DIR: envDir },
    });
  };
  const needsMeLedger = fire(validRun(`nm-${rowN}`, 'needs-me'));
  const runningLedger = fire(validRun(`rn-${rowN}`, 'running'));
  return needsMeLedger !== '' || runningLedger === '';
}

// test_stop_hook.mjs covers the done, failed, missing, regular-file and needs-me rows of envRunDir.
test('C14b: on the rows test_stop_hook lacks, the builder env agrees with the Stop hook envRunDir', () => {
  for (const row of ['running', 'blocked', 'directory with no run.json', 'unreadable run.json'].map(rowNamed)) {
    const [name, , make, asFile] = row;
    // the Stop hook only counts a complete schema-1 record as needs-me, so each row writes one
    const full = (d) => { if (make) { make(d); const f = join(d, 'run.json'); try { const j = JSON.parse(readFileSync(f, 'utf8')); writeFileSync(f, JSON.stringify({ ...RUN_FIELDS(j.state), ...j })); } catch { /* missing or unreadable stays so */ } } };
    const dir = rowDir([name, false, make ? (d) => full(d) : null, asFile]);
    const { env } = dispatchHeadless('claude', dir);
    const hook = stopHookChoosesEnvDir(dir);
    assert.equal(env.has('BORK_RUN_DIR'), hook, `${name}: builder env ${env.has('BORK_RUN_DIR')} vs Stop hook ${hook}`);
  }
});

// --- T2: harness.mjs hands quota-axi an env built only from QUOTA_ENV_PASS ------------------
const QUOTA_REQUIRED = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_*', 'TZ', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME',
  'GROK_HOME', 'GROK_AUTH', 'GROK_AUTH_PATH', 'GROK_AUTH_JSON', 'CURSOR_STATE_DB', 'GITHUB_COPILOT_APPS_JSON',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];

test('C15a: harness.mjs exports QUOTA_ENV_PASS with the names quota-axi needs, and importing it runs no CLI', async () => {
  const before = readdirSync(BOX).length;
  const mod = await import(pathToFileURL(HARNESS).href);
  assert.ok(Array.isArray(mod.QUOTA_ENV_PASS), 'QUOTA_ENV_PASS is exported');
  for (const name of QUOTA_REQUIRED) assert.ok(mod.QUOTA_ENV_PASS.includes(name), name);
  assert.equal(readdirSync(BOX).length, before, 'importing wrote nothing');
});

const runQuotaSelect = () => {
  const s = stubs();
  writeFileSync(join(s.dir, 'quota-axi'), `#!/usr/bin/env bash\nenv > '${s.dump}'\necho '{"providers":[]}'\n`);
  chmodSync(join(s.dir, 'quota-axi'), 0o755);
  writeFileSync(CONFIG, JSON.stringify({ dispatch: { rules: [{ when: 'x', why: 'x', use: [{ harness: 'claude' }] }] } }));
  const parent = {
    PATH: s.path, HOME: join(BOX, 'home-quota'), TMPDIR: tmpdir(), BORKWEB_SKILLS_CONFIG: CONFIG,
    CODEX_HOME: join(BOX, 'codex-quota'), XDG_CONFIG_HOME: join(BOX, 'xdg-quota'), HTTPS_PROXY: 'http://proxy.test:3128',
    https_proxy: 'http://proxy.test:3128', LC_ALL: 'en_US.UTF-8',
    ...hostile(join(BOX, 'quota-run')),
  };
  const r = spawnSync(process.execPath, [HARNESS, 'select'], { encoding: 'utf8', env: parent });
  assert.equal(r.status, 0, r.stderr);
  return { parent, child: readDump(s.dump), out: JSON.parse(r.stdout), stderr: r.stderr };
};
// C15b-e read one `select` run. Lazy, so each of them also passes when run alone.
let quota;
const quotaRun = () => (quota ??= runQuotaSelect());

test('C15b: the quota-axi stub runs under the allowlist and no "unavailable" note appears', () => {
  const { out, stderr } = quotaRun();
  const text = `${JSON.stringify(out)}\n${stderr}`;
  assert.doesNotMatch(text, /quota-axi unavailable/);
  assert.doesNotMatch(text, /quota-axi output unparseable/);
});

test('C15c: the quota-axi child holds only QUOTA_ENV_PASS names (plus what bash adds)', async () => {
  const { QUOTA_ENV_PASS = [] } = await import(pathToFileURL(HARNESS).href);
  const { child } = quotaRun();
  const allowed = (k) => QUOTA_ENV_PASS.includes(k) || (QUOTA_ENV_PASS.includes('LC_*') && k.startsWith('LC_')) || ['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k);
  assert.deepEqual([...child.keys()].filter((k) => !allowed(k)), []);
});

test('C15d: no secret, run pointer or session id reaches quota-axi, by name', () => {
  const { child } = quotaRun();
  for (const name of [CANARY, 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'BORK_RUN_DIR', 'BORK_RUN_ID',
    'BORK_RUNS_HOME', 'OFFLOAD_HANDOFF', 'OFFLOAD_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) {
    assert.equal(child.has(name), false, name);
  }
});

test('C15e: every QUOTA_ENV_PASS name set in the parent arrives with an identical value', async () => {
  const { QUOTA_ENV_PASS = [] } = await import(pathToFileURL(HARNESS).href);
  const { parent, child } = quotaRun();
  for (const name of ['HOME', 'PATH', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'HTTPS_PROXY', 'https_proxy', 'LC_ALL']) {
    assert.ok(name in parent, `the test sets ${name}`);
    assert.equal(child.get(name), parent[name], name);
  }
  for (const name of QUOTA_ENV_PASS.filter((n) => !n.endsWith('*') && n in parent)) assert.equal(child.get(name), parent[name], name);
});
