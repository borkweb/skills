// gate-fixture.mjs — shared fixtures for the local-gate tests (test_local_gates.mjs and
// test_gate_hook.mjs). Not a test file: it holds the temp box, an allowlisted child env,
// real git repos and the handoff docs those tests run `ready` and the Stop hook against.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const HANDOFF = join(HERE, 'handoff.mjs');
export const NODE = process.execPath;
export const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'ofl-lg-')));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

// The exit code of the new `ready` refusal (`red:`). 0 ok, 1 error, 2 usage, 4 incomplete,
// 5 stale and 6 unbacked ruling are taken.
export const N = 7;

export const baseEnv = () => ({ PATH: process.env.PATH, HOME: BOX, TMPDIR: tmpdir(), AGENT_HANDOFFS_DIR: BOX });
export const GIT_ENV = { PATH: process.env.PATH, HOME: BOX, TMPDIR: tmpdir(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
export const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();

let n = 0;
export const uniq = (name = 'x') => `${name}-${++n}`;

// A git repo with one commit and a committer identity in its own config, so a gate that
// commits (the HEAD-moves case) can. `file.txt` is tracked.
export function gitRepo(name = 'repo') {
  const dir = join(BOX, uniq(name));
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'file.txt'), 'one\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

// A scratch directory outside every repo, for gate markers and dumps.
export const scratch = (name = 'out') => { const d = join(BOX, uniq(name)); mkdirSync(d, { recursive: true }); return d; };

export const cli = (args, { session, env: extra = {}, input, cwd, timeout = 60000 } = {}) => {
  const env = baseEnv();
  if (session !== undefined) env.CLAUDE_CODE_SESSION_ID = session;
  Object.assign(env, extra);
  const r = spawnSync(NODE, [HANDOFF, ...args], { encoding: 'utf8', env, input, cwd, timeout });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// `L1: local: <command>`: the local-gate line the architect writes.
export const L = (id, command) => `${id}: local: ${command}`;

// A handoff doc under <box>/offload (so prune sees it) with Frozen gates and Gate results.
// `results` defaults to a line for C1 and a Head line for `head`.
export function mkGateDoc({ frozen = [], results, head, cwd, status = 'dispatched', owner = 's', fm = [], eol = '\n', name = 'doc' } = {}) {
  mkdirSync(join(BOX, 'offload'), { recursive: true });
  const p = join(BOX, 'offload', `${uniq(name)}.md`);
  const res = results ?? `${head ? `Head: ${head}\n` : ''}C1: MET\n`;
  const front = ['---', ...(cwd ? [`cwd: ${cwd}`] : []), ...fm, `claude_session: ${owner}`, `status: ${status}`, 'updated: x', '---', ''];
  const body = [...front, '## Frozen gates', ['C1: x', ...frozen].join('\n'), '', '## Gate results', res, '', '## Work summary', 'wip', ''];
  writeFileSync(p, body.join('\n').replace(/\n/g, eol));
  return p;
}

export const docStatus = (p) => /^status: (.*)$/m.exec(readFileSync(p, 'utf8'))[1];
export const read = (p) => readFileSync(p, 'utf8');

// One ready-to-run fixture: a repo, a doc with these local gate commands (L1, L2, ...), and
// a scratch dir for markers.
export function readyFx(commands, extra = {}) {
  const repo = gitRepo('fx');
  const out = scratch('fxout');
  const cmds = typeof commands === 'function' ? commands(out, repo) : commands;
  const doc = mkGateDoc({ frozen: cmds.map((c, i) => L(`L${i + 1}`, c)), head: repo.head, cwd: repo.dir, ...extra });
  return { ...repo, out, doc };
}

// The hostile ambient env: the K1 canary, tokens, session and run pointers (a done run),
// git redirection, shell startup scripts and NODE_OPTIONS.
export function hostile(out) {
  const done = join(out, 'done-run');
  mkdirSync(done, { recursive: true });
  writeFileSync(join(done, 'run.json'), JSON.stringify({ state: 'done' }));
  const other = gitRepo('other');
  const startup = join(out, 'startup.sh');
  writeFileSync(startup, `touch ${join(out, 'env-sourced')}\n`);
  return {
    K1_CANARY_abc123: 'canary', GITHUB_TOKEN: 'hostile', AWS_SECRET_ACCESS_KEY: 'hostile', ANTHROPIC_API_KEY: 'hostile', OPENAI_API_KEY: 'hostile',
    CODEX_SESSION_ID: 'hostile-codex', BORK_RUN_ID: 'hostile-run', BORK_RUN_DIR: done,
    GIT_DIR: join(other.dir, '.git'), GIT_WORK_TREE: other.dir, GIT_INDEX_FILE: join(other.dir, '.git', 'index'),
    BASH_ENV: startup, ENV: startup, NODE_OPTIONS: '--no-warnings',
  };
}
export const FORBIDDEN_IN_GATE = ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'OFFLOAD_HANDOFF', 'OFFLOAD_SESSION_ID', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'NODE_OPTIONS', 'BASH_ENV', 'ENV',
  'K1_CANARY_abc123', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BORK_RUN_DIR', 'BORK_RUN_ID'];
