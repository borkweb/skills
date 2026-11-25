#!/usr/bin/env node
// pr-state.mjs — the merge-readiness tier of one or more GitHub PRs, as one NDJSON line each.
//
//   node pr-state.mjs <pr-url>...
//
// Each line carries url, head, mergeStateStatus, tier, and checksPending and checksFailing (counts of checks, independent of the tier). Exit code:
// 0 every PR ready, 3 conflict (DIRTY, BEHIND or CONFLICTING: both are fixed by updating onto the base),
// 4 unresolved review threads, 5 failing checks, 6 draft, changes requested, review required or BLOCKED,
// 7 checks pending or state UNKNOWN, 2 usage error, 1 fetch error or a value this script does not know.
// With several PRs the lowest nonzero code wins, so a fetch error is never hidden by a ready PR.
// A PR that fails to fetch prints nothing on stdout (its error goes to stderr), so stdout only ever holds the tiers above.
//
// gh is the command in PR_STATE_GH (split on whitespace, `~/` expanded, no shell), else `gh`. For
// github.a8c.com use PR_STATE_GH='proxychains4 -q -f ~/.proxychains.conf gh'. Every call has a timeout
// (PR_STATE_TIMEOUT_MS, default 30000). The gh child gets an allowlisted environment, never this one. Only github.com
// and github.a8c.com URLs are accepted, and the enterprise tokens reach gh only for github.a8c.com.
//
// Node builtins only, no package.json.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// The only hosts a PR URL may name. Any other host would get a gh request, and gh sends a GitHub Enterprise token to it.
const HOSTS = new Set(['github.com', 'github.a8c.com']);
const URL_RE = /^https:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)$/;
const PAGE = 100;
const MAX_PAGES = 50;

const CONTEXT = 'nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}} pageInfo{hasNextPage endCursor}';
const ARGS = '$owner:String!,$name:String!,$number:Int!';
const PR = (inner) => `repository(owner:$owner,name:$name){pullRequest(number:$number){${inner}}}`;
const THREADS = (after) => `reviewThreads(first:${PAGE}${after}){nodes{isResolved} pageInfo{hasNextPage endCursor}}`;
const CHECKS = (after) => `commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:${PAGE}${after}){${CONTEXT}}}}}}`;
const QUERY = `query(${ARGS}){${PR(`headRefOid isDraft mergeable mergeStateStatus reviewDecision ${THREADS('')} ${CHECKS('')}`)}}`;
const QUERY_THREADS = `query(${ARGS},$after:String!){${PR(THREADS(',after:$after'))}}`;
// headRefOid rides along so a push between two pages of checks is seen (the page then belongs to another head).
const QUERY_CHECKS = `query(${ARGS},$after:String!){${PR(`headRefOid ${CHECKS(',after:$after')}`)}}`;

// What the gh child may see. Everything else in this process's environment stays here.
const ENV_PASS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TZ',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'PROXYCHAINS_CONF_FILE', 'PROXYCHAINS_QUIET_MODE',
]);
// gh sends these to any host that is not github.com, so only the host they belong to gets them.
const ENTERPRISE_TOKENS = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const childEnv = (host) => {
  const env = { GH_PROMPT_DISABLED: '1' };
  for (const [k, v] of Object.entries(process.env)) if (ENV_PASS.has(k) || k.startsWith('LC_') || (host === 'github.a8c.com' && ENTERPRISE_TOKENS.includes(k))) env[k] = v;
  return env;
};

class FetchError extends Error {}

// ---- gh -------------------------------------------------------------------------------------------

const timeoutMs = () => {
  const n = Number(process.env.PR_STATE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
};

function ghCommand() {
  const parts = (process.env.PR_STATE_GH ?? '').split(/\s+/).filter(Boolean).map((t) => (t === '~' ? homedir() : t.startsWith('~/') ? homedir() + t.slice(1) : t));
  return parts.length ? parts : ['gh'];
}

function graphql(host, query, vars) {
  const [cmd, ...pre] = ghCommand();
  const args = [...pre, 'api', 'graphql', ...(host === 'github.com' ? [] : ['--hostname', host]), '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(k === 'number' ? '-F' : '-f', `${k}=${v}`);
  const ms = timeoutMs();
  const r = spawnSync(cmd, args, { env: childEnv(host), encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') throw new FetchError(`gh timed out after ${ms} ms (PR_STATE_TIMEOUT_MS)`);
    if (r.error.code === 'ENOENT') throw new FetchError(`cannot run ${cmd === 'gh' ? 'gh' : `gh via PR_STATE_GH (${cmd})`}: not found on PATH`);
    throw new FetchError(`cannot run gh: ${r.error.code ?? r.error.message}`);
  }
  if (r.status !== 0) throw new FetchError(`gh exited ${r.status}: ${(r.stderr || r.stdout).trim().split('\n')[0].slice(0, 200)}`);
  let body;
  try { body = JSON.parse(r.stdout); } catch { throw new FetchError('gh printed output that is not JSON'); }
  if (body === null || typeof body !== 'object') throw new FetchError('gh printed JSON that is not an object');
  if (Array.isArray(body.errors) && body.errors.length) throw new FetchError(`GraphQL error: ${String(body.errors[0]?.message ?? 'unknown').slice(0, 200)}`);
  const pr = body.data?.repository?.pullRequest;
  if (!pr || typeof pr !== 'object') throw new FetchError('no such pull request in the response');
  return pr;
}

// Every page of a connection: first is the connection from the main query, more(cursor) fetches the next.
function allNodes(first, more) {
  const nodes = [];
  let conn = first;
  for (let i = 0; ; i++) {
    if (!conn || !Array.isArray(conn.nodes)) throw new FetchError('a connection in the response has no nodes');
    nodes.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) return nodes;
    if (!conn.pageInfo.endCursor || i >= MAX_PAGES) throw new FetchError('a connection has more pages than can be followed');
    conn = more(conn.pageInfo.endCursor);
  }
}

// ---- classification ---------------------------------------------------------------------------------

class Unknown extends Error {}
const want = (table, field, value) => {
  if (!Object.hasOwn(table, value)) throw new Unknown(`unrecognized ${field} ${JSON.stringify(value)}`);
  return table[value];
};

// Each value maps to one signal: 'ok', or the tier-forming problem it means.
const MERGE_STATE = { CLEAN: 'ok', HAS_HOOKS: 'ok', UNSTABLE: 'ok', DIRTY: 'conflict', BEHIND: 'conflict', DRAFT: 'draft', BLOCKED: 'blocked', UNKNOWN: 'pending' };
const MERGEABLE = { MERGEABLE: 'ok', CONFLICTING: 'conflict', UNKNOWN: 'pending' };
const REVIEW = { APPROVED: 'ok', CHANGES_REQUESTED: 'draft', REVIEW_REQUIRED: 'draft' };
const CONCLUSION = { SUCCESS: 'pass', NEUTRAL: 'pass', SKIPPED: 'pass', FAILURE: 'fail', CANCELLED: 'fail', TIMED_OUT: 'fail', ACTION_REQUIRED: 'fail', STARTUP_FAILURE: 'fail', STALE: 'fail' };
const RUN_STATUS = { QUEUED: 'pending', IN_PROGRESS: 'pending', WAITING: 'pending', PENDING: 'pending', REQUESTED: 'pending' };
const STATUS_STATE = { SUCCESS: 'pass', FAILURE: 'fail', ERROR: 'fail', PENDING: 'pending', EXPECTED: 'pending' };

function checkSignal(node) {
  if (node?.__typename === 'CheckRun') {
    if (node.status === 'COMPLETED') return want(CONCLUSION, 'check conclusion', node.conclusion);
    return want(RUN_STATUS, 'check status', node.status);
  }
  if (node?.__typename === 'StatusContext') return want(STATUS_STATE, 'status state', node.state);
  throw new Unknown(`unrecognized check node ${JSON.stringify(node?.__typename)}`);
}

const TIERS = [['conflict', 3], ['threads', 4], ['ci-failing', 5], ['draft-or-changes-requested', 6], ['ci-pending', 7]];
const EXIT = Object.fromEntries([['ready', 0], ...TIERS]);

function classify(pr, threads, rollup, checks) {
  const merge = want(MERGE_STATE, 'mergeStateStatus', pr.mergeStateStatus);
  const mergeable = want(MERGEABLE, 'mergeable', pr.mergeable);
  const review = pr.reviewDecision == null ? 'ok' : want(REVIEW, 'reviewDecision', pr.reviewDecision);
  const signals = checks.map(checkSignal);
  // The counts are of checks, whatever the tier. A head with no reported checks yet (a null rollup or zero
  // contexts) counts as one pending check, so a watcher that waits for checksPending 0 does not wake early.
  const none = !rollup || checks.length === 0;
  const failing = signals.filter((s) => s === 'fail').length;
  const pending = signals.filter((s) => s === 'pending').length + (none ? 1 : 0);
  const rollupSignal = rollup?.state == null ? null : want(STATUS_STATE, 'rollup state', rollup.state);
  const unresolved = threads.filter((t) => t?.isResolved === false).length;
  const is = {
    conflict: merge === 'conflict' || mergeable === 'conflict',
    threads: unresolved > 0,
    'ci-failing': failing > 0 || rollupSignal === 'fail',
    'draft-or-changes-requested': pr.isDraft === true || merge === 'draft' || review === 'draft',
    'ci-pending': pending > 0 || rollupSignal === 'pending' || none || merge === 'pending' || mergeable === 'pending',
  };
  let tier = TIERS.map(([t]) => t).find((t) => is[t]);
  // BLOCKED with nothing else wrong still has an unmet rule (a required review or check), so it is not ready.
  if (!tier && merge === 'blocked') tier = 'draft-or-changes-requested';
  return { tier: tier ?? 'ready', signals: { mergeable: pr.mergeable, isDraft: pr.isDraft === true, reviewDecision: pr.reviewDecision ?? null, unresolvedThreads: unresolved, checksFailing: failing, checksPending: pending } };
}

// ---- main ---------------------------------------------------------------------------------------------

function inspect(url) {
  const [, rawHost, owner, name, number] = URL_RE.exec(url);
  const host = rawHost.toLowerCase();
  const vars = { owner, name, number };
  const pr = graphql(host, QUERY, vars);
  const threads = allNodes(pr.reviewThreads, (after) => graphql(host, QUERY_THREADS, { ...vars, after }).reviewThreads);
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const checks = rollup ? allNodes(rollup.contexts, (after) => {
    const next = graphql(host, QUERY_CHECKS, { ...vars, after });
    if (next.headRefOid !== pr.headRefOid) throw new FetchError(`head changed while paging checks (${pr.headRefOid} then ${next.headRefOid}); run again`);
    return next.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  }) : [];
  const { tier, signals } = classify(pr, threads, rollup, checks);
  return { url, head: pr.headRefOid, mergeStateStatus: pr.mergeStateStatus, tier, ...signals };
}

function main(urls) {
  if (!urls.length) { process.stderr.write('usage: pr-state.mjs <pr-url>...\n'); return 2; }
  const bad = urls.find((u) => !URL_RE.test(u));
  if (bad !== undefined) { process.stderr.write(`pr-state: not a pull request URL: ${JSON.stringify(bad)}\nusage: pr-state.mjs https://github.com|github.a8c.com/<owner>/<repo>/pull/<n>...\n`); return 2; }
  const stranger = urls.find((u) => !HOSTS.has(URL_RE.exec(u)[1].toLowerCase()));
  if (stranger !== undefined) { process.stderr.write(`pr-state: host not allowed in ${JSON.stringify(stranger)}; only github.com and github.a8c.com\n`); return 2; }
  const codes = [];
  for (const url of urls) {
    try {
      const line = inspect(url);
      process.stdout.write(`${JSON.stringify(line)}\n`);
      codes.push(EXIT[line.tier]);
    } catch (e) {
      // Any failure, including an unexpected response shape, is a stderr line and exit 1, never a stack trace. stdout keeps only the X3 tiers.
      const message = e instanceof FetchError || e instanceof Unknown ? e.message : `unexpected response: ${e.message}`;
      process.stderr.write(`pr-state: ${url}: ${message}\n`);
      codes.push(1);
    }
  }
  const failed = codes.filter((c) => c !== 0);
  return failed.length ? Math.min(...failed) : 0;
}

export { classify, checkSignal };

// Run the CLI only when node was started with this file, not when it is imported. Both paths are realpath'd: through a
// symlink, with or without --preserve-symlinks-main, a skipped main would exit 0, which a watcher reads as every PR ready.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
