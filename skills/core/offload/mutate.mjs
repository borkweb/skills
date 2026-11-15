#!/usr/bin/env node
// Runs an architect's mutation checks in a pool of throwaway worktrees: apply one edit, run its cmd, restore, repeat.
// Usage and the full contract: `node mutate.mjs --help`, and offload SKILL.md step 3.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { isAbsolute, join, posix, resolve } from 'node:path';

const USAGE = `Usage: node mutate.mjs <mutations.json> --head <rev> [options]

Runs each mutation (one edit and the narrowest command that should go red) in a pool of throwaway worktrees
at <rev>. The mutations file is a JSON array of {id, file, find+replace | patch, cmd, tests?}.

Options:
  --repo <path>       repository (default: the current directory's repo root)
  --head <rev>        revision every worktree is created at, resolved once (required)
  --jobs <n>          pool size (default: min(8, cpus - 1), at most the mutations left to run)
  --serial            same as --jobs 1
  --timeout <s>       limit per command in seconds (default 300)
  --log-dir <dir>     new or empty directory for logs and results.json (default: a new temp directory)
  --setup <cmd>       run once in each new worktree before any command there
  --pass-env <NAME>   pass one more variable to every command (repeatable)
  --since <file>      a previous results.json; carry its unchanged killed mutations
  --help              print this text

Exit: 0 all killed or carried; 1 a mutation survived or errored; 2 usage or input error; 3 the runner could
not run; 130, 143 or 129 after SIGINT, SIGTERM or SIGHUP.
`;

class Usage extends Error {}
class Fatal extends Error {}
const usage = (m) => { throw new Usage(m); };

// ---- environment ------------------------------------------------------------------------------------------------

const ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TERM|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|http_proxy|https_proxy|no_proxy|all_proxy|LC_.*)$/;
const DENY = /^(BORK_RUN_DIR|BORK_RUN_ID|OFFLOAD_.*|CLAUDE_.*|CODEX_.*|HERDR_.*|GIT_.*)$/;
const STATE_DIRS = ['AGENT_HANDOFFS_DIR', 'BORK_RUNS_HOME', 'ORCHESTRATOR_HOME', 'BORK_REPO_RULES_DIR'];

function allowlistedEnv(passNames) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (ALLOW.test(k)) env[k] = v;
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  for (const n of passNames) {
    if (process.env[n] === undefined) console.error(`mutate: --pass-env ${n} is not set in the runner's environment`);
    else env[n] = process.env[n];
  }
  return env;
}

// ---- arguments --------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { input: null, repo: null, head: null, jobs: null, serial: false, timeout: 300, logDir: null, setup: null, passEnv: [], since: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--help': o.help = true; break;
      case '--serial': o.serial = true; break;
      case '--repo': o.repo = val(); break;
      case '--head': o.head = val(); break;
      case '--log-dir': o.logDir = val(); break;
      case '--setup': o.setup = val(); break;
      case '--since': o.since = val(); break;
      case '--jobs': {
        const v = val();
        if (!/^\d+$/.test(v) || Number(v) < 1) usage(`--jobs must be a whole number of at least 1, got "${v}"`);
        o.jobs = Number(v);
        break;
      }
      case '--timeout': {
        const v = val();
        if (!(Number(v) > 0)) usage(`--timeout must be a number of seconds above 0, got "${v}"`);
        o.timeout = Number(v);
        break;
      }
      case '--pass-env': {
        const name = val();
        if (DENY.test(name)) usage(`--pass-env ${name} is never passed to a command`);
        o.passEnv.push(name);
        break;
      }
      default:
        if (a.startsWith('--')) usage(`unknown option: ${a}`);
        if (o.input !== null) usage(`unexpected argument: ${a}`);
        o.input = a;
    }
  }
  if (o.help) return o;
  if (o.input === null) usage('missing the mutations file');
  if (o.head === null) usage('missing --head <rev>');
  if (o.head.startsWith('-')) usage(`--head must be a revision, got "${o.head}"`);
  if (o.serial && o.jobs !== null && o.jobs > 1) usage('--serial and --jobs above 1 conflict');
  return o;
}

// ---- git --------------------------------------------------------------------------------------------------------

const GITP = ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false'];
const GITENV = allowlistedEnv([]);

function gitRun(dir, args, { input, buffer } = {}) {
  return new Promise((res) => {
    const c = spawn('git', [...GITP, '-C', dir, ...args], { env: GITENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    c.stdout.on('data', (d) => out.push(d));
    c.stderr.on('data', (d) => err.push(d));
    c.stdin.on('error', () => {});
    c.on('error', (e) => res({ status: -1, stdout: '', stderr: e.message }));
    c.on('close', (status) => res({ status, stdout: buffer ? Buffer.concat(out) : Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    c.stdin.end(input ?? '');
  });
}
async function gitOk(dir, args, what) {
  const r = await gitRun(dir, args);
  if (r.status !== 0) throw new Fatal(`${what || `git ${args[0]}`} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

// ---- mutation file ----------------------------------------------------------------------------------------------

const KEYS = new Set(['id', 'file', 'find', 'replace', 'patch', 'cmd', 'tests']);
const badPath = (p) => typeof p !== 'string' || p === '' || isAbsolute(p) || p.split(/[\\/]/).includes('..');

function validateShape(raw) {
  if (!Array.isArray(raw)) usage('the mutations file must hold a JSON array');
  if (raw.length === 0) usage('the mutations array is empty');
  const seen = new Set();
  raw.forEach((e, i) => {
    const who = e && typeof e === 'object' && typeof e.id === 'string' ? `entry ${i} ("${e.id}")` : `entry ${i}`;
    const bad = (m) => usage(`${who}: ${m}`);
    if (e === null || typeof e !== 'object' || Array.isArray(e)) bad('must be an object');
    for (const k of Object.keys(e)) if (!KEYS.has(k)) bad(`unknown key "${k}"`);
    if (typeof e.id !== 'string') bad('id must be a string');
    if (!/^[A-Za-z0-9._-]+$/.test(e.id)) bad('id must match ^[A-Za-z0-9._-]+$');
    if (/^(baseline|setup)-\d+$/.test(e.id)) bad('id collides with a runner log name');
    if (seen.has(e.id)) bad(`duplicate id "${e.id}"`);
    seen.add(e.id);
    if (typeof e.file !== 'string') bad('file must be a string');
    if (badPath(e.file)) bad('file must be a relative path inside the repo');
    if (typeof e.cmd !== 'string' || e.cmd.trim() === '') bad('cmd must be a non-empty string');
    const hasFind = 'find' in e;
    const hasPatch = 'patch' in e;
    if (hasFind && hasPatch) bad('give find+replace or patch, not both');
    if (!hasFind && !hasPatch) bad('needs find+replace or patch');
    if (hasFind) {
      if (typeof e.find !== 'string' || e.find === '') bad('find must be a non-empty string');
      if (typeof e.replace !== 'string') bad('find needs a replace string');
      if (e.replace === e.find) bad('replace equals find');
    } else if ('replace' in e) bad('replace needs find');
    if (hasPatch && (typeof e.patch !== 'string' || e.patch === '')) bad('patch must be a non-empty string');
    if ('tests' in e && (!Array.isArray(e.tests) || e.tests.some(badPath))) bad('tests must be an array of relative paths');
  });
  return raw;
}

// Edits work on bytes, so a file that is not valid UTF-8 changes only where the edit lands.
const occurrences = (buf, find) => {
  let n = 0;
  for (let i = buf.indexOf(find); i >= 0; i = buf.indexOf(find, i + find.length)) n++;
  return n;
};

const IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

// The files a test file imports by a static relative import, one level, that `has` says are tracked.
function importsOf(text, testPath, has) {
  const found = [];
  for (const [, spec] of text.matchAll(IMPORT_RE)) {
    const p = posix.normalize(posix.join(posix.dirname(testPath), spec));
    const hit = [p, `${p}.mjs`, `${p}.js`, `${p}.cjs`, `${p}.json`, `${p}/index.js`].find((c) => has(c));
    if (hit) found.push(hit);
  }
  return found;
}

// Everything that needs the head's tree: file modes, edit validation, and each mutation's test and dependency set.
async function bindToHead(repo, sha, muts) {
  const tree = new Map();
  for (const rec of (await gitOk(repo, ['ls-tree', '-r', '-z', sha], 'git ls-tree')).split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    tree.set(rec.slice(tab + 1), rec.slice(0, rec.indexOf(' ')));
  }
  const blobs = new Map();
  const blob = async (p) => {
    if (!blobs.has(p)) blobs.set(p, (await gitRun(repo, ['cat-file', 'blob', `${sha}:${p}`], { buffer: true })).stdout);
    return blobs.get(p);
  };
  for (const m of muts) {
    const who = `entry "${m.id}"`;
    const mode = tree.get(m.file);
    if (mode === undefined) usage(`${who}: ${m.file} is not a file at the head`);
    if (mode !== '100644' && mode !== '100755') usage(`${who}: ${m.file} is not a regular file (mode ${mode})`);
    if (m.patch !== undefined) {
      const r = await gitRun(repo, ['apply', '--numstat'], { input: m.patch });
      const touched = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[2]);
      if (r.status !== 0) usage(`${who}: patch is not a valid unified diff`);
      if (touched.length !== 1 || touched[0] !== m.file) usage(`${who}: patch must touch exactly ${m.file}`);
    } else {
      const n = occurrences(await blob(m.file), Buffer.from(m.find));
      if (n !== 1) m.preError = n === 0 ? 'edit-not-found' : 'edit-ambiguous';
    }
    m.cmdTokens = m.cmd.split(/\s+/).map((t) => t.replace(/^(['"])(.*)\1$/, '$2'));
    m.tests = m.testsGiven ?? [...new Set(m.cmdTokens.filter((t) => tree.has(t)))];
    const deps = new Set(m.tests);
    for (const t of m.tests) {
      if (!tree.has(t)) continue;
      for (const d of importsOf((await blob(t)).toString('utf8'), t, (c) => tree.has(c))) deps.add(d);
    }
    m.deps = [...deps];
  }
}

// ---- --since ----------------------------------------------------------------------------------------------------

async function loadSince(repo, file) {
  let prev;
  try { prev = JSON.parse(readFileSync(resolve(file), 'utf8')); } catch (e) { usage(`--since ${file}: ${e.message}`); }
  if (!prev || typeof prev !== 'object' || !Array.isArray(prev.mutations) || typeof prev.head !== 'string') usage(`--since ${file}: not a results.json (needs head and mutations)`);
  if ((await gitRun(repo, ['cat-file', '-e', `${prev.head}^{commit}`])).status !== 0) usage(`--since ${file}: head ${prev.head} is not in this repo`);
  return prev;
}

async function decideCarries(repo, sha, muts, prev) {
  const trees = new Map();
  const diffs = new Map();
  const treeAt = async (h) => {
    if (!trees.has(h)) trees.set(h, new Set((await gitRun(repo, ['ls-tree', '-r', '--name-only', '-z', h])).stdout.split('\0')));
    return trees.get(h);
  };
  const changedSince = async (h) => {
    if (!diffs.has(h)) diffs.set(h, new Set((await gitRun(repo, ['diff', '--no-renames', '--name-only', '-z', `${h}..${sha}`])).stdout.split('\0')));
    return diffs.get(h);
  };
  for (const m of muts) {
    const p = prev.mutations.find((x) => x && x.id === m.id);
    if (m.preError || !p || (p.status !== 'killed' && p.status !== 'carried')) continue;
    if (['file', 'find', 'replace', 'patch', 'cmd'].some((k) => p[k] !== m[k])) continue;
    if (!/^[0-9a-f]{40}$/.test(p.head ?? '')) continue;
    if ((await gitRun(repo, ['merge-base', '--is-ancestor', p.head, sha])).status !== 0) continue;
    const old = await treeAt(p.head);
    const mine = m.testsGiven ?? m.cmdTokens.filter((t) => old.has(t));
    if (mine.length === 0) continue;
    const tests = [...new Set([...(p.tests ?? []), ...m.tests])];
    const deps = [...new Set([...(p.deps ?? []), ...m.deps])];
    const mineDeps = new Set(mine);
    for (const t of mine) {
      if (!old.has(t)) continue;
      const text = (await gitRun(repo, ['cat-file', 'blob', `${p.head}:${t}`], { buffer: true })).stdout.toString('utf8');
      for (const d of importsOf(text, t, (c) => old.has(c))) mineDeps.add(d);
    }
    const paths = [m.file, ...deps, ...mineDeps];
    if (!paths.every((x) => old.has(x))) continue;
    const changed = await changedSince(p.head);
    if (paths.some((x) => changed.has(x))) continue;
    if ((await gitRun(repo, ['rev-list', '--merges', `${p.head}..${sha}`])).stdout.trim() !== '') continue;
    m.carried = { head: p.head, exit: p.exit ?? null, log: p.log ?? null, tests, deps };
  }
}

// ---- running commands -------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A read-only directory a command left behind makes rmSync throw. Make the directories writable and try again.
// Unlinking a file needs write permission on its parent only, and a directory has no hard links, so no file outside
// the run changes mode. Returns whether the path is gone.
function makeWritable(p) {
  try {
    const st = lstatSync(p);
    if (!st.isDirectory()) return;
    chmodSync(p, st.mode | 0o700);
    for (const e of readdirSync(p)) makeWritable(join(p, e));
  } catch { /* gone or not ours */ }
}
function forceRm(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { rmSync(path, { recursive: true, force: true }); return true; } catch { makeWritable(path); }
  }
  return !existsSync(path);
}
const live = new Set();
const created = [];
let poolRoot = null;
let runSeq = 0;
let baseEnv = null;

async function groupGone(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { process.kill(-pid, 0); } catch { return true; }
    await sleep(20);
  }
  return false;
}
async function endGroup(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch { return; }
  if (await groupGone(pid, 2000)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
}

// Runs `sh -c cmd` in its own process group with a private TMPDIR. Resolves with how it ended; never rejects on a
// command failure.
function runCommand(cmd, cwd, logFile, limitSec) {
  const tmp = join(poolRoot, 'run', String(++runSeq));
  const env = { ...baseEnv, TMPDIR: tmp, PYTHONDONTWRITEBYTECODE: '1' };
  mkdirSync(tmp, { recursive: true });
  for (const d of STATE_DIRS) { env[d] = join(tmp, d.toLowerCase().replace(/_/g, '-')); mkdirSync(env[d]); }
  const fd = openSync(logFile, 'w');
  const started = Date.now();
  return new Promise((res) => {
    let child;
    let timedOut = false;
    let escalate = null;
    let timer = null;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(escalate);
      if (child && child.pid) live.delete(child.pid);
      forceRm(tmp);
      res({ ms: Date.now() - started, timedOut, ...r });
    };
    try {
      child = spawn('sh', ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    } catch (e) { closeSync(fd); finish({ spawnFailed: e.message }); return; }
    closeSync(fd);
    child.on('error', (e) => finish({ spawnFailed: e.message }));
    if (!child.pid) return;
    live.add(child.pid);
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
    timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      escalate = setTimeout(() => killGroup('SIGKILL'), 2000);
    }, limitSec * 1000);
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      if (timedOut) await groupGone(child.pid, 2500); else await endGroup(child.pid);
      finish({ code, signal });
    });
  });
}

// "green" is exit 0 with no signal; everything else is classified by the caller.
const green = (r) => !r.spawnFailed && !r.timedOut && !r.signal && r.code === 0;

function selectedNoTests(text, cmd) {
  const last = (re) => [...text.matchAll(re)].at(-1);
  const node = last(/^(?:#|ℹ) tests (\d+)\s*$/gm);
  if (node && node[1] === '0') return true;
  const py = last(/^Ran (\d+) tests? in /gm);
  if (py && py[1] === '0') return true;
  if (/No tests executed/.test(text.split('\n').slice(-12).join('\n'))) return true;
  const tops = [...text.matchAll(/^(?:ok \d+ - |✔ )(.+?)(?: \([0-9.]+ms\))?\s*$/gm)].map((m) => m[1]);
  const tokens = cmd.split(/\s+/).map((t) => t.replace(/^\.\//, ''));
  if (tops.length === 1 && tokens.some((t) => tops[0] === t || tops[0].endsWith(`/${t}`))) return true;
  return false;
}

// ---- cleanup ----------------------------------------------------------------------------------------------------

let cleaned = false;
function cleanup(repoRoot) {
  if (cleaned) return;
  cleaned = true;
  for (const pid of live) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  const left = [];
  for (const w of created) {
    try {
      const r = spawnSync('git', [...GITP, '-C', repoRoot, 'worktree', 'remove', '--force', w.path], { env: GITENV, stdio: 'ignore' });
      if (r.status !== 0) {
        forceRm(w.path);
        if (w.admin) forceRm(w.admin);
      }
    } catch { /* report below */ }
    for (const p of [w.path, w.admin]) if (p && existsSync(p)) left.push(p);
  }
  if (poolRoot) forceRm(poolRoot);
  if (poolRoot && existsSync(poolRoot)) left.push(poolRoot);
  for (const p of left) console.error(`mutate: left behind: ${p}`);
}

// ---- main -------------------------------------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) { process.stdout.write(USAGE); return 0; }
  baseEnv = allowlistedEnv(opt.passEnv);

  let raw;
  try { raw = JSON.parse(readFileSync(resolve(opt.input), 'utf8')); } catch (e) { usage(`${opt.input}: ${e.message}`); }
  const muts = validateShape(raw).map((e) => ({ ...e, testsGiven: e.tests }));
  const top = await gitRun(resolve(opt.repo ?? '.'), ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) usage(`not a git repository: ${resolve(opt.repo ?? '.')}`);
  const repo = realpathSync(top.stdout.trim());
  repoForCleanup = repo;
  const r = await gitRun(repo, ['rev-parse', '--verify', '--quiet', `${opt.head}^{commit}`]);
  if (r.status !== 0) usage(`cannot resolve --head ${opt.head}`);
  const sha = r.stdout.trim();
  await bindToHead(repo, sha, muts);
  const prev = opt.since ? await loadSince(repo, opt.since) : null;
  if (prev) await decideCarries(repo, sha, muts, prev);

  let logs;
  if (opt.logDir === null) {
    try { logs = mkdtempSync(join(realpathSync(tmpdir()), 'mutate-logs-')); } catch (e) { throw new Fatal(`cannot create a log directory: ${e.message}`); }
  } else {
    logs = resolve(opt.logDir);
    if (existsSync(logs)) {
      if (!statSync(logs).isDirectory() || readdirSync(logs).length > 0) usage(`--log-dir ${logs} must be new or empty`);
    }
    try {
      mkdirSync(logs, { recursive: true });
      const probe = join(logs, '.writable');
      writeFileSync(probe, '');
      unlinkSync(probe);
    } catch (e) { throw new Fatal(`cannot write to --log-dir ${logs}: ${e.message}`); }
  }

  const results = new Map();
  const note = (m, text) => { const f = join(logs, `${m.id}.log`); writeFileSync(f, `${text}\n`); return f; };
  const setResult = (m, status, extra = {}) => {
    results.set(m.id, { status, exit: null, log: null, ...extra });
    console.error(`mutate: ${status} ${m.id}${extra.token ? ` ${extra.token}` : ''}`);
  };
  const runnable = [];
  for (const m of muts) {
    if (m.preError) setResult(m, 'error', { token: m.preError, log: note(m, `${m.preError}: find matched ${m.preError === 'edit-not-found' ? 'nothing' : 'more than once'} in ${m.file} at ${sha}`) });
    else if (m.carried) results.set(m.id, { status: 'carried', ...m.carried });
    else runnable.push(m);
  }

  const jobs = opt.serial ? 1 : opt.jobs ?? Math.max(1, Math.min(8, availableParallelism() - 1));
  const poolSize = Math.min(jobs, runnable.length);
  const workers = [];
  const errorAll = (list, token, info) => { for (const m of list) setResult(m, 'error', { token, ...info }); };

  if (poolSize > 0) {
    poolRoot = mkdtempSync(join(realpathSync(tmpdir()), 'mutate-pool-'));
    for (let n = 1; n <= poolSize; n++) {
      const path = join(poolRoot, `mutate-${process.pid}-${n}`);
      const w = { n, path, admin: null, snapshot: null, retired: false };
      created.push(w);
      await gitOk(repo, ['worktree', 'add', '--detach', '--quiet', path, sha], 'git worktree add');
      w.admin = (await gitOk(path, ['rev-parse', '--absolute-git-dir'])).trim();
      workers.push(w);
    }
    console.error('mutate: pool ready');
  }
  process.stdout.write(`Head: ${sha}\nLogs: ${logs}\nPool: ${poolSize}\n${prev ? `Since: ${prev.head}\n` : ''}`);

  const limit = opt.timeout;
  const snapshotOf = async (w) => await gitOk(w.path, ['status', '--porcelain', '--ignored', '--untracked-files=normal', '-z']);
  const runSetup = (w, suffix = '') => runCommand(opt.setup, w.path, join(logs, `setup-${w.n}${suffix}.log`), limit);

  if (poolSize > 0 && opt.setup) {
    const out = await Promise.all(workers.map(async (w) => [w, await runSetup(w)]));
    const bad = out.find(([, s]) => !green(s));
    if (bad) {
      const [w, s] = bad;
      const token = s.timedOut ? 'timeout' : 'setup-failed';
      errorAll(runnable, token, { exit: s.code ?? null, log: join(logs, `setup-${w.n}.log`) });
      runnable.length = 0;
    }
  }
  for (const w of workers) w.snapshot = runnable.length ? await snapshotOf(w) : '';

  // Baselines run once per distinct cmd; a mutation waits for its cmd's baseline to be green.
  const baselines = new Map();
  const baselineQ = [];
  for (const m of runnable) {
    if (!baselines.has(m.cmd)) {
      const n = baselines.size + 1;
      baselines.set(m.cmd, { n, state: 'pending', log: join(logs, `baseline-${n}.log`), sec: 0 });
      baselineQ.push(m.cmd);
    }
  }
  const mutQ = [...runnable];
  let runningBaselines = 0;
  let waiters = [];
  const wake = () => { const ws = waiters; waiters = []; for (const f of ws) f(); };

  const take = () => {
    if (baselineQ.length) return { cmd: baselineQ.shift() };
    const i = mutQ.findIndex((m) => baselines.get(m.cmd).state === 'green');
    if (i >= 0) return { m: mutQ.splice(i, 1)[0] };
    return mutQ.length > 0 && runningBaselines > 0 ? 'wait' : null;
  };

  const restoreWorktree = async (w) => {
    const step = async (args) => (await gitRun(w.path, args)).status === 0;
    if (!(await step(['reset', '--hard', '--quiet', sha]))) return false;
    if (!(await step(['clean', '-ffdq']))) {
      makeWritable(w.path);
      if (!(await step(['clean', '-ffdq']))) return false;
    }
    const keep = new Set(w.snapshot.split('\0'));
    for (const rec of (await snapshotOf(w)).split('\0')) {
      if (rec.startsWith('!! ') && !keep.has(rec)) forceRm(join(w.path, rec.slice(3)));
    }
    if ((await snapshotOf(w)) === w.snapshot) return true;
    if (!opt.setup) return false;
    if (!green(await runSetup(w, '-rerun'))) return false;
    return (await snapshotOf(w)) === w.snapshot;
  };
  // Any failure while restoring, a throw included, retires the worktree and makes its mutation error restore-failed.
  const restore = async (w) => {
    try { return await restoreWorktree(w); } catch { return false; }
  };

  const classifyBaseline = (b, r, cmd) => {
    b.sec = r.ms / 1000;
    if (r.spawnFailed) return ['spawn-failed', null];
    if (r.timedOut) return ['timeout', null];
    if (r.signal) return ['signal', null];
    if (r.code !== 0) return ['baseline-red', r.code];
    if (selectedNoTests(readFileSync(b.log, 'utf8'), cmd)) return ['no-tests', 0];
    return [null, 0];
  };

  const runMutation = async (w, m) => {
    const b = baselines.get(m.cmd);
    const logFile = join(logs, `${m.id}.log`);
    let edit = null;
    if (m.patch !== undefined) {
      const r = await gitRun(w.path, ['apply', '--whitespace=nowarn'], { input: m.patch });
      if (r.status !== 0) edit = ['patch-failed', r.stderr];
    } else {
      const p = join(w.path, m.file);
      const buf = readFileSync(p);
      const find = Buffer.from(m.find);
      const i = buf.indexOf(find);
      if (i < 0) edit = ['edit-not-found', `${m.find} not found in ${m.file}`];
      else writeFileSync(p, Buffer.concat([buf.subarray(0, i), Buffer.from(m.replace), buf.subarray(i + find.length)]));
    }
    let outcome;
    if (edit) {
      writeFileSync(logFile, `${edit[0]}: ${edit[1]}\n`);
      outcome = ['error', { token: edit[0], log: logFile }];
    } else {
      const r = await runCommand(m.cmd, w.path, logFile, Math.min(limit, Math.max(10, 10 * b.sec)));
      if (r.spawnFailed) outcome = ['error', { token: 'spawn-failed', log: logFile }];
      else if (r.timedOut) outcome = ['killed', { timeout: true, log: logFile }];
      else if (r.signal) outcome = ['error', { token: 'signal', log: logFile }];
      else outcome = [r.code === 0 ? 'survived' : 'killed', { exit: r.code, log: logFile }];
    }
    if (await restore(w)) setResult(m, ...outcome);
    else { setResult(m, 'error', { token: 'restore-failed', exit: null, log: outcome[1].log }); w.retired = true; }
  };

  const worker = async (w) => {
    while (!w.retired) {
      const t = take();
      if (t === null) return;
      if (t === 'wait') { await new Promise((f) => waiters.push(f)); continue; }
      if (t.m) { await runMutation(w, t.m); wake(); continue; }
      const b = baselines.get(t.cmd);
      b.state = 'running'; runningBaselines++;
      const r = await runCommand(t.cmd, w.path, b.log, limit);
      const [token, code] = classifyBaseline(b, r, t.cmd);
      runningBaselines--;
      b.state = token ? 'bad' : 'green';
      if (token) {
        const mine = mutQ.filter((m) => m.cmd === t.cmd);
        for (const m of mine) mutQ.splice(mutQ.indexOf(m), 1);
        errorAll(mine, token, { exit: code, log: b.log });
      }
      if (!(await restore(w))) w.retired = true;
      wake();
    }
    wake();
  };

  if (runnable.length) await Promise.all(workers.map(worker));
  for (const m of mutQ.splice(0)) setResult(m, 'error', { token: 'restore-failed', log: note(m, 'every worktree was retired before this mutation ran') });
  for (const b of baselines.values()) if (b.state === 'pending') b.state = 'bad';

  cleanup(repo);

  const rows = muts.map((m) => {
    const x = results.get(m.id);
    const row = { id: m.id, file: m.file };
    if (m.patch !== undefined) row.patch = m.patch; else { row.find = m.find; row.replace = m.replace; }
    row.cmd = m.cmd;
    row.tests = x.tests ?? m.tests;
    row.deps = x.deps ?? m.deps;
    row.status = x.status;
    if (x.token) row.token = x.token;
    if (x.timeout) row.timeout = true;
    row.exit = x.exit ?? null;
    row.log = x.log ?? null;
    row.head = x.status === 'carried' ? x.head : sha;
    return row;
  });
  const file = join(logs, 'results.json');
  try {
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ schema: 1, head: sha, ...(prev ? { since: prev.head } : {}), mutations: rows }, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    rmSync(`${file}.tmp`, { force: true });
    throw new Fatal(`cannot write ${file}: ${e.message}`);
  }

  const count = { killed: 0, survived: 0, error: 0, carried: 0 };
  const out = [];
  for (const m of muts) {
    const x = results.get(m.id);
    count[x.status]++;
    if (x.status === 'killed') out.push(`killed   ${m.id}  log: ${x.log}${x.timeout ? ' timeout' : ''}`);
    else if (x.status === 'survived') out.push(`survived ${m.id}  log: ${x.log}`);
    else if (x.status === 'error') out.push(`error    ${m.id}  ${x.token}  exit ${x.exit ?? '-'}  log: ${x.log}`);
    else out.push(`carried  ${m.id}  @${x.head}`);
  }
  out.push(`killed=${count.killed} survived=${count.survived} error=${count.error} carried=${count.carried} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.stdout.write(`${out.join('\n')}\n`);
  return count.survived + count.error === 0 ? 0 : 1;
}

let repoForCleanup = null;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => { cleanup(repoForCleanup); process.exit(code); });
const crash = (e) => {
  cleanup(repoForCleanup);
  console.error(e instanceof Usage ? `mutate: ${e.message}\nRun with --help for usage.` : e instanceof Fatal ? `mutate: ${e.message}` : `mutate: ${e && e.stack ? e.stack : e}`);
  process.exit(e instanceof Usage ? 2 : 3);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
process.on('exit', () => cleanup(repoForCleanup));

main().then((code) => process.stdout.write('', () => process.exit(code)), crash);
