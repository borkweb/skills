import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { start, change, inspect, status } from './engine.mjs';
import { readRun, recoverLock } from './store.mjs';
import { compile, decisionRequirements, validateContract } from './policy.mjs';
import { fingerprint } from './snapshot.mjs';
import { main } from './cli.mjs';

function fixture(kind = 'implement', options = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'bork-do-test-')));
  const repo = join(temp, 'repo'); mkdirSync(repo); writeFileSync(join(repo, 'app.txt'), 'before\n');
  const evidence = join(temp, 'evidence.txt'); writeFileSync(evidence, 'actual fixture observation\n');
  const effects = ['implement', 'prototype', 'plan'].includes(kind) ? ['write'] : kind === 'deliver' ? ['push'] : [];
  const contract = { schemaVersion: 1, request: `Fixture: ${kind}`, repo, rationale: 'Explicit fixture request', outcomes: [{ kind, goal: `Exercise ${kind}`, effects }], risk: 'standard', surfaces: [], authority: { grants: effects.map(effect => ({ effect, source: `Fixture authorizes ${effect}` })), writePaths: effects.includes('write') ? ['app.txt'] : [], protectedPaths: [] }, scope: ['app.txt'], checks: [], ...options };
  let state = start(contract, 'controller-a', join(temp, 'runs'));
  const apply = (command, payload) => state = change(state.runDir, state.owner, state.revision, command, payload);
  const claim = (id = status(state).next[0]?.node, worker = 'worker-1') => {
    apply('claim', { node: id }); const attempt = state.nodes.find(n => n.id === id).attempts.at(-1);
    apply('attach', { node: id, attempt: attempt.id, worker: { runtime: 'host', id: worker, model: 'fixture-model' } });
    return { node: id, attempt: attempt.id, snapshot: attempt.snapshot };
  };
  const result = (assignment, extra = {}) => apply('result', { ...assignment, status: 'pass', summary: 'Fixture completed with recorded evidence', evidence: [evidence], ...extra });
  const finish = (id, worker, extra) => { const a = claim(id, worker); result(a, extra); return a; };
  return { temp, repo, evidence, contract, apply, claim, result, finish, get state() { return state; } };
}
function throughBuild(f) { f.finish(undefined, 'planner'); f.finish(undefined, 'builder'); }

for (const kind of ['answer', 'research', 'diagnose', 'review', 'plan', 'prototype', 'implement', 'deliver', 'operate', 'monitor']) {
  test(`route ${kind} reaches requested report with valid evidence`, () => {
    const f = fixture(kind);
    for (let i = 0; status(f.state).state !== 'complete' && i < 20; i++) {
      const next = status(f.state).next[0]; assert.ok(next, JSON.stringify(status(f.state)));
      f.finish(next.node, next.role === 'reviewer' ? 'independent-reviewer' : `actor-${next.role}`);
    }
    assert.equal(inspect(f.state.runDir).state, 'complete');
  });
}
test('diagnosis and review cannot grant themselves writes', () => {
  for (const kind of ['diagnose', 'review']) { const f = fixture(kind); const c = structuredClone(f.contract); c.outcomes[0].effects = ['write']; c.authority.grants.push({ effect: 'write', source: 'invalid route' }); c.authority.writePaths = ['app.txt']; assert.throws(() => validateContract(c), /not allowed/); }
});
test('all external effects require exact authority and named targets in host contract', () => {
  const f = fixture('deliver'); const c = structuredClone(f.contract); c.outcomes[0].effects.push('merge'); assert.throws(() => validateContract(c), /not authorized/);
});
test('small security change still requires independent review and security checks', () => {
  const f = fixture('implement', { risk: 'light', surfaces: ['security'] });
  assert.equal(f.state.nodes.filter(n => n.role === 'reviewer').length, 2);
});
test('UI adds browser verification and checks fan out after the builder', () => {
  const f = fixture('implement', { surfaces: ['ui'] }); throughBuild(f);
  assert.deepEqual(status(f.state).next.map(n => n.role).sort(), ['browser', 'check', 'reviewer']);
  const assignments = status(f.state).next.map(n => f.claim(n.node, `reader-${n.role}`));
  assert.equal(status(f.state).active.length, 3); assert.equal(status(f.state).next.length, 0);
  for (const a of assignments) f.result(a);
  assert.equal(status(f.state).next[0].role, 'reporter');
});
test('composed diagnosis then implementation retains the no-write diagnosis boundary', () => {
  const f = fixture(); const c = structuredClone(f.contract); c.outcomes.unshift({ kind: 'diagnose', goal: 'Find the cause', effects: [] });
  const nodes = compile(validateContract(c)); const build = nodes.find(n => n.role === 'builder');
  assert.ok(build); assert.ok(nodes.filter(n => n.outcome === 0).every(n => !n.effects.length));
  assert.deepEqual(nodes.find(n => n.outcome === 1).deps, ['g1-o1-report']);
});
test('implementation gates do not prematurely block a preceding diagnosis', () => {
  const f = fixture(); const c = structuredClone(f.contract);
  c.outcomes.unshift({ kind: 'diagnose', goal: 'Reproduce failing regression', effects: [] });
  c.checks = [{ id: 'regression', kind: 'check', instruction: 'Regression passes after fixing' }];
  let nodes = compile(validateContract(c));
  assert.deepEqual(nodes.filter(n => n.id.includes('custom-')).map(n => n.outcome), [1]);
  c.checks[0].outcomes = [0]; nodes = compile(validateContract(c));
  assert.deepEqual(nodes.filter(n => n.id.includes('custom-')).map(n => n.outcome), [0]);
});
test('custom delivery gates are required before the external action', () => {
  const f = fixture('deliver', { checks: [{ id: 'ci', kind: 'check', instruction: 'Required CI is green' }] });
  const action = f.state.nodes.find(n => n.role === 'operator'); assert.ok(action.deps.includes('g1-o1-custom-ci'));
});
test('builder cannot supply its own independent review', () => {
  const f = fixture(); throughBuild(f); const n = status(f.state).next.find(n => n.role === 'reviewer');
  assert.throws(() => f.claim(n.node, 'builder'), /independent reviewer/);
  assert.equal(f.state.nodes.find(x => x.id === n.node).state, 'launching');
});
test('stale source invalidates review and blocks final completion', () => {
  const f = fixture(); throughBuild(f); const a = f.claim(status(f.state).next.find(n => n.role === 'reviewer').node, 'reviewer');
  writeFileSync(join(f.repo, 'app.txt'), 'changed while reviewing');
  assert.throws(() => f.result(a), /stale evidence/); assert.equal(status(f.state).state, 'stale'); assert.equal(status(f.state).next.length, 0);
});
test('captured result must name the assigned snapshot and current attempt', () => {
  const f = fixture('answer'); const a = f.claim();
  assert.throws(() => f.result({ ...a, snapshot: 'invented' }), /assigned snapshot/);
  assert.throws(() => f.result({ ...a, attempt: 'unknown' }), /stale or unknown/);
});
test('evidence bytes are retained privately instead of mutable path references', () => {
  const f = fixture('answer'); const a = f.claim(); f.result(a);
  const e = f.state.nodes[0].attempts[0].result.evidence[0]; writeFileSync(f.evidence, 'later text');
  assert.equal(readFileSync(e.path, 'utf8'), 'actual fixture observation\n');
});
test('an absent reviewer and missing artifacts never produce clean evidence', () => {
  const f = fixture(); throughBuild(f); const a = f.claim(status(f.state).next.find(n => n.role === 'reviewer').node, 'reviewer');
  assert.throws(() => f.result(a, { evidence: [] }), /requires 1..20/);
  f.apply('reconcile', { node: a.node, attempt: a.attempt, presence: 'absent', reason: 'Fixture runtime confirms worker exited without a result', evidence: [f.evidence] });
  assert.equal(status(f.state).state, 'blocked'); assert.ok(!status(f.state).next.some(n => n.role === 'reporter'));
});
test('duplicate result is idempotent and conflicting result is rejected', () => {
  const f = fixture('answer'); const a = f.claim(); f.result(a); f.result(a);
  assert.throws(() => f.result(a, { summary: 'different' }), /conflicting duplicate/);
  assert.equal(f.state.nodes[0].attempts.length, 1);
});
test('crash after launch intent never offers the node for duplicate dispatch', () => {
  const f = fixture('answer'); const id = status(f.state).next[0].node; f.apply('claim', { node: id });
  const restored = readRun(f.state.runDir).state; assert.equal(status(restored).next.length, 0); assert.equal(status(restored).active[0].state, 'launching');
  assert.throws(() => f.apply('claim', { node: id }), /not eligible/);
});
test('unknown liveness preserves ownership and blocks replacement', () => {
  const f = fixture('answer'); const a = f.claim(); f.apply('reconcile', { node: a.node, attempt: a.attempt, presence: 'unknown', reason: 'Host no longer sees the worker', evidence: [f.evidence] });
  assert.equal(status(f.state).active.length, 1); assert.equal(status(f.state).next.length, 0);
});
test('cancellation is a request until absent workers are verified', () => {
  const f = fixture('answer'); const a = f.claim(); f.apply('cancel', { reason: 'User stopped the fixture' });
  assert.equal(status(f.state).state, 'cancelling'); assert.throws(() => f.result(a), /active worker/);
  f.apply('reconcile', { node: a.node, attempt: a.attempt, presence: 'absent', reason: 'Confirmed stopped', evidence: [f.evidence] }); assert.equal(status(f.state).state, 'cancelled');
});
test('revision and owner fencing reject a stale controller', () => {
  const f = fixture('answer'); const { revision, owner, runDir } = f.state; f.apply('adopt', { newOwner: 'controller-b', reason: 'Prior host ended; retain existing attempts' });
  assert.throws(() => change(runDir, owner, revision, 'cancel', { reason: 'old controller' }), /ownership/);
  assert.throws(() => change(runDir, 'controller-b', revision, 'cancel', { reason: 'stale view' }), /stale revision/);
});
test('an existing writer lock is never stolen automatically', () => {
  const f = fixture('answer'); writeFileSync(join(f.state.runDir, 'writer.lock'), JSON.stringify({ host: hostname(), pid: process.pid }));
  assert.throws(() => f.apply('cancel', { reason: 'test' }), /writer lock exists/);
  assert.throws(() => recoverLock(f.state.runDir), /alive/);
});
test('journal replay ignores a stale derived snapshot and rejects a torn tail', () => {
  const f = fixture('answer'); writeFileSync(join(f.state.runDir, 'state.json'), '{invalid derived file');
  assert.equal(readRun(f.state.runDir).state.runId, f.state.runId);
  appendFileSync(join(f.state.runDir, 'events.jsonl'), '{partial'); assert.throws(() => readRun(f.state.runDir), /incomplete journal/);
});
test('authorized writes update the snapshot; protected paths reject acceptance', () => {
  const f = fixture('implement', { scope: ['.'], authority: { grants: [{ effect: 'write', source: 'Fixture allows app only' }], writePaths: ['app.txt'], protectedPaths: ['protected.txt'] } });
  f.finish(undefined, 'planner'); const a = f.claim(undefined, 'builder'); writeFileSync(join(f.repo, 'app.txt'), 'after'); writeFileSync(join(f.repo, 'protected.txt'), 'forbidden');
  assert.throws(() => f.result(a), /unauthorized changes/);
});
test('read-only work cannot change its observed source', () => {
  const f = fixture('review'); const a = f.claim(); writeFileSync(join(f.repo, 'app.txt'), 'unexpected'); assert.throws(() => f.result(a), /stale evidence/);
});
test('corrections join all workers and stop after the configured bound', () => {
  const f = fixture(); throughBuild(f);
  for (let i = 0; i < 3; i++) {
    const check = status(f.state).next.find(n => n.role === 'check'); const a = f.claim(check.node, 'checker'); f.result(a, { status: 'fail', category: 'defect' });
    if (i < 2) { f.apply('correct', { node: a.node, reason: 'Fix demonstrated defect' }); f.finish(undefined, 'builder'); }
    else assert.throws(() => f.apply('correct', { node: a.node, reason: 'Third blind retry' }), /correction budget/);
  }
});
test('environment recovery is bounded separately from corrections', () => {
  const f = fixture('answer'); let id;
  for (let i = 0; i < 3; i++) { const a = f.claim(id); id = a.node; f.result(a, { status: 'blocked', category: 'environment' }); if (i < 2) f.apply('retry', { node: id, reason: 'Fixture environment recovered' }); else assert.throws(() => f.apply('retry', { node: id, reason: 'again' }), /recovery budget/); }
});
test('replanning cannot enlarge authority, reset budgets, or replay external effects', () => {
  const f = fixture(); const c = structuredClone(f.contract); c.authority.grants.push({ effect: 'push', source: 'invented' });
  assert.throws(() => f.apply('replan', { contract: c, reason: 'expand' }), /expand authority/);
  const safe = structuredClone(f.state.contract); f.apply('replan', { contract: safe, reason: 'Reassess cause' }); assert.equal(f.state.usage.replans, 1);
  const d = fixture('deliver'); d.finish(undefined, 'checker'); const action = d.claim(undefined, 'operator'); d.result(action);
  assert.throws(() => d.apply('replan', { contract: d.state.contract, reason: 'redo' }), /external effects/);
});
test('overall attempt budget bounds looping even after replan', () => {
  const f = fixture('answer', { budgets: { corrections: 2, replans: 2, attempts: 1 } }); f.finish();
  assert.equal(status(f.state).budgetExhausted, true); assert.equal(status(f.state).next.length, 0);
  f.apply('replan', { contract: f.state.contract, reason: 'same task' }); assert.equal(status(f.state).next.length, 0);
});
test('monitor observations wait without relaunch or consuming correction budget', () => {
  const f = fixture('monitor'); const a = f.claim(); f.result(a, { status: 'waiting', summary: 'CI still running' }); f.result(a, { status: 'waiting', summary: 'No change' });
  assert.equal(f.state.usage.attempts, 1); assert.deepEqual(f.state.usage.corrections, {}); assert.equal(status(f.state).active[0].state, 'waiting'); f.result(a); assert.equal(status(f.state).next[0].role, 'reporter');
});
test('path validation rejects traversal, globs, symlink parent and git internals', () => {
  const f = fixture(); for (const path of ['../outside', '.git/config', 'src/*.js', '/tmp/absolute']) { const c = structuredClone(f.contract); c.scope = [path]; assert.throws(() => validateContract(c)); }
  symlinkSync(f.temp, join(f.repo, 'escape')); assert.throws(() => fingerprint(f.repo, ['escape/evidence.txt']), /symlink scope parent/);
});
test('private state cannot be created inside the task source', () => {
  const f = fixture(); assert.throws(() => start(f.contract, 'owner', join(f.repo, 'runs')), /outside the task repository/);
  assert.equal(existsSync(join(f.repo, 'runs')), false, 'invalid start must not create files in the task source');
});
test('correction cannot absorb rejected protected writes after worker reconciliation', () => {
  const f = fixture('implement', { scope: ['.'], authority: { grants: [{ effect: 'write', source: 'App only' }], writePaths: ['app.txt'], protectedPaths: ['protected.txt'] } });
  f.finish(undefined, 'planner'); const a = f.claim(undefined, 'builder'); writeFileSync(join(f.repo, 'protected.txt'), 'unauthorized');
  assert.throws(() => f.result(a), /unauthorized changes/);
  f.apply('reconcile', { node: a.node, attempt: a.attempt, presence: 'absent', reason: 'Worker exited', evidence: [f.evidence] });
  assert.throws(() => f.apply('correct', { node: a.node, reason: 'Retry the patch' }), /unauthorized changes/);
  assert.throws(() => f.apply('invalidate', { reason: 'Recheck everything' }), /unauthorized changes/);
  assert.throws(() => f.apply('replan', { contract: f.state.contract, reason: 'Replan' }), /unauthorized changes/);
});
test('stored evidence corruption and removal invalidate completion and dependency release', () => {
  const f = fixture('answer'); f.finish();
  const artifact = f.state.nodes[0].attempts[0].result.evidence[0].path;
  writeFileSync(artifact, 'corrupt'); assert.equal(status(f.state).state, 'evidence-invalid');
  assert.equal(status(f.state).next.length, 0);
  assert.throws(() => f.apply('claim', { node: 'g1-o1-report' }), /evidence/);
  unlinkSync(artifact); assert.equal(status(f.state).state, 'evidence-invalid');
});
test('directory permission changes are covered by snapshots', () => {
  const f = fixture('answer'); const directory = join(f.repo, 'private'); mkdirSync(directory, { mode: 0o700 });
  const before = fingerprint(f.repo, ['private']); chmodSync(directory, 0o777);
  assert.notEqual(fingerprint(f.repo, ['private']).digest, before.digest);
});
test('unknown schema and input fields fail closed', () => {
  const f = fixture(); assert.throws(() => validateContract({ ...f.contract, schemaVersion: 2 }), /schemaVersion/); assert.throws(() => validateContract({ ...f.contract, autoMerge: true }), /unknown field/);
  assert.throws(() => main(['start', '--unknown', 'value']), /invalid option/);
});
test('CLI process runs against a disposable real filesystem', () => {
  const f = fixture('diagnose'); const input = join(f.temp, 'contract.json'); writeFileSync(input, JSON.stringify(f.contract));
  const cli = resolve('scripts/do/cli.mjs'); const plan = spawnSync(process.execPath, [cli, 'plan', '--input', input], { encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr); assert.equal(JSON.parse(plan.stdout).nodes[0].role, 'investigator');
  const inspectRun = spawnSync(process.execPath, [cli, 'status', '--run', f.state.runDir], { encoding: 'utf8' }); assert.equal(inspectRun.status, 0, inspectRun.stderr); assert.equal(JSON.parse(inspectRun.stdout).runId, f.state.runId);
  const claimInput = join(f.temp, 'claim.json'); writeFileSync(claimInput, JSON.stringify({ node: status(f.state).next[0].node }));
  const receipt = main(['claim', '--run', f.state.runDir, '--owner', f.state.owner, '--revision', String(f.state.revision), '--input', claimInput]);
  assert.ok(receipt.attempt.id); assert.equal(receipt.attempt.snapshot, f.state.snapshot.digest);
  assert.equal(receipt.nodes, undefined); assert.equal(receipt.history, undefined); assert.equal(receipt.snapshot.files, undefined);
});
test('an actual authorized edit advances the pinned snapshot used by checks', () => {
  const f = fixture(); f.finish(undefined, 'planner'); const before = f.state.snapshot.digest;
  const a = f.claim(undefined, 'builder'); writeFileSync(join(f.repo, 'app.txt'), 'after\n'); f.result(a);
  assert.notEqual(f.state.snapshot.digest, before);
  for (const next of status(f.state).next) assert.equal(next.snapshot, f.state.snapshot.digest);
});
test('two real CLI processes cannot claim the same revision', async () => {
  const f = fixture('answer'); const payload = join(f.temp, 'claim.json'); writeFileSync(payload, JSON.stringify({ node: status(f.state).next[0].node }));
  const args = [resolve('scripts/do/cli.mjs'), 'claim', '--run', f.state.runDir, '--owner', f.state.owner, '--revision', String(f.state.revision), '--input', payload];
  const run = () => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = '';
    child.stdout.resume(); child.stderr.on('data', chunk => stderr += chunk); child.on('error', reject); child.on('close', code => resolveResult({ code, stderr }));
  });
  const results = await Promise.all([run(), run()]); assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.match(results.find(r => r.code === 1).stderr, /writer lock|stale revision/);
  const restored = readRun(f.state.runDir).state; assert.equal(restored.nodes[0].attempts.length, 1); assert.equal(restored.revision, 1);
});

test('later implementations must recheck earlier requirements on their final snapshot', () => {
  const f = fixture('implement', {
    outcomes: [
      { kind: 'implement', goal: 'Enable A', effects: ['write'] },
      { kind: 'implement', goal: 'Enable B and preserve A', effects: ['write'] },
    ],
    checks: [{ id: 'feature-a', kind: 'check', instruction: 'Assert A=on in app.txt', outcomes: [0] }],
  });
  while (status(f.state).next[0]?.node !== 'g1-o2-build') {
    const next = status(f.state).next[0]; assert.ok(next);
    const a = f.claim(next.node, next.role === 'reviewer' ? 'reviewer' : next.role);
    if (next.node === 'g1-o1-build') writeFileSync(join(f.repo, 'app.txt'), 'A=on B=off');
    f.result(a);
  }
  const build = f.claim('g1-o2-build', 'builder');
  writeFileSync(join(f.repo, 'app.txt'), 'A=off B=on'); f.result(build);
  const gate = f.state.nodes.find(n => n.outcome === 1 && n.revalidates === 'g1-o1-custom-feature-a');
  assert.ok(gate, 'earlier acceptance gate must be carried into later writing outcomes');
  const a = f.claim(gate.id, 'checker');
  assert.equal(a.snapshot, f.state.snapshot.digest);
  assert.notEqual(a.snapshot, f.state.nodes.find(n => n.id === gate.revalidates).attempts.at(-1).snapshot);
  f.result(a, { status: 'fail', category: 'defect', summary: 'Actual A check now fails' });
  assert.equal(status(f.state).state, 'blocked');
  assert.ok(!status(f.state).next.some(n => n.node === 'g1-o2-report'));
  f.apply('correct', { node: gate.id, reason: 'Restore A in second implementation' });
  const fix = f.claim(undefined, 'builder'); writeFileSync(join(f.repo, 'app.txt'), 'A=on B=on'); f.result(fix);
  while (status(f.state).next.length) {
    const next = status(f.state).next[0]; f.finish(next.node, next.role === 'reviewer' ? 'reviewer' : next.role);
  }
  assert.equal(status(f.state).state, 'complete');
  assert.equal(f.state.nodes.find(n => n.id === 'g1-o1-build').attempts.length, 1, 'do not replay earlier builders');
});

test('integration checks follow later non-implementation writers without replaying diagnosis', () => {
  for (const kind of ['plan', 'prototype', 'operate']) {
    const f = fixture('implement'); const c = structuredClone(f.contract);
    c.outcomes.unshift({ kind: 'diagnose', goal: 'Historical cause', effects: [] });
    c.outcomes.push({ kind, goal: 'Later authorized write', effects: ['write'] });
    c.outcomes.push({ kind: 'implement', goal: 'Third write', effects: ['write'] });
    const nodes = compile(validateContract(c));
    assert.ok(nodes.some(n => n.outcome === 2 && n.revalidates === 'g1-o2-verify'));
    assert.equal(nodes.filter(n => n.outcome === 3 && n.revalidates === 'g1-o2-verify').length, 1);
    assert.ok(!nodes.some(n => n.revalidates?.startsWith('g1-o1-')));
  }
});

test('literal dynamic route filenames snapshot through direct and parent scopes', () => {
  const f = fixture(); mkdirSync(join(f.repo, 'app', '[id]'), { recursive: true });
  writeFileSync(join(f.repo, 'app', '[id]', 'page.tsx'), 'before');
  const path = 'app/[id]/page.tsx';
  const c = structuredClone(f.contract); c.scope = ['app']; c.authority.writePaths = [path];
  validateContract(c);
  const before = fingerprint(f.repo, ['app']); assert.ok(before.files[path]);
  assert.ok(fingerprint(f.repo, [path]).files[path]);
  writeFileSync(join(f.repo, path), 'after');
  assert.notEqual(fingerprint(f.repo, ['app']).digest, before.digest);
});

test('exact file authority permits only necessary new parent directories', () => {
  const options = { scope: ['app'], authority: { grants: [{ effect: 'write', source: 'Only new route file' }], writePaths: ['app/[id]/page.tsx'], protectedPaths: [] } };
  const f = fixture('implement', options); f.finish(); const a = f.claim(undefined, 'builder');
  mkdirSync(join(f.repo, 'app', '[id]'), { recursive: true });
  writeFileSync(join(f.repo, 'app', '[id]', 'page.tsx'), 'new route');
  f.result(a); assert.equal(f.state.nodes.find(n => n.id === a.node).state, 'accepted');
  const g = fixture('implement', options); g.finish(); const b = g.claim(undefined, 'builder');
  mkdirSync(join(g.repo, 'app', '[id]'), { recursive: true });
  writeFileSync(join(g.repo, 'app', '[id]', 'page.tsx'), 'new route');
  writeFileSync(join(g.repo, 'app', '[id]', 'unowned.tsx'), 'not authorized');
  assert.throws(() => g.result(b), /unauthorized changes: app\/\[id\]\/unowned.tsx/);
});

test('exact file authority does not grant permission changes to existing parent directories', () => {
  const f = fixture(); mkdirSync(join(f.repo, 'app', '[id]'), { recursive: true, mode: 0o700 });
  const c = { ...f.contract, scope: ['app'], authority: { ...f.contract.authority, writePaths: ['app/[id]/page.tsx'] } };
  // Start a separate fixture contract against the pre-existing directory modes.
  let s = start(c, 'controller', join(f.temp, 'mode-runs'));
  const apply = (command, payload) => s = change(s.runDir, s.owner, s.revision, command, payload);
  for (const id of ['g1-o1-scope', 'g1-o1-build']) {
    apply('claim', { node: id }); const attempt = s.nodes.find(n => n.id === id).attempts.at(-1);
    apply('attach', { node: id, attempt: attempt.id, worker: { runtime: 'host', id: 'fixture', model: 'fixture' } });
    if (id.endsWith('build')) {
      writeFileSync(join(f.repo, 'app', '[id]', 'page.tsx'), 'new route'); chmodSync(join(f.repo, 'app', '[id]'), 0o777);
      assert.throws(() => apply('result', { node: id, attempt: attempt.id, snapshot: attempt.snapshot, status: 'pass', summary: 'Not allowed', evidence: [f.evidence] }), /unauthorized changes/);
    } else apply('result', { node: id, attempt: attempt.id, snapshot: attempt.snapshot, status: 'pass', summary: 'Scoped', evidence: [f.evidence] });
  }
});

test('verified external completion can recover an absent attempt without replay', () => {
  const f = fixture('deliver'); f.finish(); const a = f.claim(undefined, 'operator');
  f.apply('reconcile', { node: a.node, attempt: a.attempt, presence: 'absent', reason: 'Runtime confirms exited', evidence: [f.evidence] });
  const payload = { ...a, status: 'pass', summary: 'Actual target verifies original operation completed', evidence: [f.evidence] };
  assert.throws(() => f.result(a), /conflicting duplicate/);
  f.apply('recover-result', payload); f.apply('recover-result', payload);
  assert.equal(f.state.usage.attempts, 2);
  assert.equal(status(f.state).next[0].node, 'g1-o1-postflight');
  f.finish(); f.finish(); assert.equal(status(f.state).state, 'complete');
  assert.equal(f.state.nodes.find(n => n.id === a.node).attempts.length, 1);
  assert.throws(() => f.apply('recover-result', { ...payload, summary: 'Different evidence' }), /conflicting duplicate/);
});

test('recovered completion requires absent external attempt, evidence, unchanged scope and no cancellation', () => {
  const f = fixture('deliver'); f.finish(); const a = f.claim(undefined, 'operator');
  const payload = { ...a, status: 'pass', summary: 'Actual target evidence', evidence: [f.evidence] };
  assert.throws(() => f.apply('recover-result', payload), /absent external/);
  f.apply('reconcile', { node: a.node, attempt: a.attempt, presence: 'absent', reason: 'Verified exit', evidence: [f.evidence] });
  assert.throws(() => f.apply('recover-result', { ...payload, evidence: [] }), /requires 1..20/);
  assert.throws(() => f.apply('recover-result', { ...payload, attempt: 'stale' }), /stale or unknown/);
  writeFileSync(join(f.repo, 'app.txt'), 'drift');
  assert.throws(() => f.apply('recover-result', payload), /stale evidence/);
  writeFileSync(join(f.repo, 'app.txt'), 'before\n');
  f.apply('cancel', { reason: 'User stopped work' });
  assert.throws(() => f.apply('recover-result', payload), /absent external/);
  const r = fixture('review'); const review = r.claim();
  r.apply('reconcile', { node: review.node, attempt: review.attempt, presence: 'absent', reason: 'Reviewer exited', evidence: [r.evidence] });
  assert.throws(() => r.apply('recover-result', { ...review, status: 'pass', summary: 'Not a review', evidence: [r.evidence] }), /absent external/);
});

test('older graphs cannot claim completion using stale implementation verification', () => {
  const f = fixture();
  while (status(f.state).next.length) { const n = status(f.state).next[0]; f.finish(n.node, n.role); }
  const historical = structuredClone(f.state);
  writeFileSync(join(f.repo, 'app.txt'), 'later authorized writer');
  historical.snapshot = fingerprint(f.repo, f.contract.scope);
  assert.equal(status(historical).state, 'verification-stale');
  assert.deepEqual(status(historical).verificationStale.sort(), ['g1-o1-review', 'g1-o1-verify']);
});

test('native and external workers retain an immutable handoff packet before attachment', () => {
  for (const runtime of ['codex-native', 'claude-native', 'external']) {
    const f = fixture('answer'); const node = status(f.state).next[0].node;
    f.apply('claim', { node }); const attempt = f.state.nodes[0].attempts[0].id;
    const worker = { runtime, id: `fixture-${runtime}`, model: 'fixture-model' };
    assert.throws(() => f.apply('attach', { node, attempt, worker }), /saved handoff brief/);
    const path = join(f.temp, 'handoff.md'); writeFileSync(path, '# Handoff: fixture\n');
    const input = join(f.temp, 'brief.json'); writeFileSync(input, JSON.stringify({ node, attempt, path }));
    main(['brief', '--run', f.state.runDir, '--owner', f.state.owner, '--revision', String(f.state.revision), '--input', input]);
    const state = readRun(f.state.runDir).state;
    assert.equal(readFileSync(state.nodes[0].attempts[0].handoff.path, 'utf8'), '# Handoff: fixture\n');
    writeFileSync(path, 'caller edited the temporary copy');
    const attached = change(state.runDir, state.owner, state.revision, 'attach', { node, attempt, worker });
    assert.equal(attached.nodes[0].state, 'running');
    assert.throws(() => change(attached.runDir, attached.owner, attached.revision, 'brief', { node, attempt, path }), /unbriefed launch intent/);
  }
});

test('damaged handoff packet is not attachable', () => {
  const f = fixture('answer'); const node = status(f.state).next[0].node;
  f.apply('claim', { node }); const attempt = f.state.nodes[0].attempts[0].id;
  f.apply('brief', { node, attempt, path: f.evidence });
  writeFileSync(f.state.nodes[0].attempts[0].handoff.path, 'tampered');
  assert.throws(() => f.apply('attach', { node, attempt, worker: { runtime: 'external', id: 'fixture-grok', model: 'fixture' } }), /handoff evidence changed/);
});

const tradeoff = { topic: 'approach', stakes: 'consequential', uncertain: true, question: 'Which compatible retry design?', options: ['fixed delay', 'exponential backoff'], recommendation: 'exponential backoff' };
function rule(f, by = 'controller', extra = {}) {
  return { decision: f.state.decisions.at(-1).id, choice: 'exponential backoff', by, source: by === 'user' ? 'Fixture user: use exponential backoff' : 'Delegated within-scope decision', rationale: 'Bounded load under failures', evidence: [f.evidence], ...extra };
}

test('default decision policy is checkpointed with advisory council for uncertain tradeoffs', () => {
  const f = fixture('answer');
  assert.deepEqual(f.state.contract.decisionPolicy, { mode: 'checkpointed', checkpoints: ['approach', 'delivery'], council: 'auto' });
  assert.deepEqual(decisionRequirements(f.state.contract.decisionPolicy, tradeoff), { requiresUser: true, requiresCouncil: true });
  assert.deepEqual(decisionRequirements(f.state.contract.decisionPolicy, { ...tradeoff, stakes: 'routine' }), { requiresUser: false, requiresCouncil: false });
});

test('decision modes distinguish consequential choices while hard boundaries always need the user', () => {
  for (const mode of ['collaborative', 'checkpointed', 'autonomous']) {
    const policy = { mode, checkpoints: ['delivery'], council: 'auto' };
    assert.equal(decisionRequirements(policy, tradeoff).requiresUser, mode === 'collaborative');
    assert.equal(decisionRequirements(policy, { ...tradeoff, topic: 'delivery' }).requiresUser, mode !== 'autonomous');
    for (const topic of ['scope', 'acceptance', 'authority', 'blocker']) assert.equal(decisionRequirements(policy, { ...tradeoff, topic, stakes: 'routine' }).requiresUser, true);
  }
});

test('pending user decision fences scheduling and survives controller handoff', () => {
  const f = fixture('answer'); f.apply('question', tradeoff);
  assert.equal(status(f.state).state, 'waiting-decision'); assert.equal(status(f.state).next.length, 0);
  assert.throws(() => f.apply('claim', { node: 'g1-o1-work' }), /pending decision/);
  assert.throws(() => f.apply('replan', { contract: f.state.contract, reason: 'Skip question' }), /pending decision/);
  assert.throws(() => f.apply('decide', rule(f, 'controller', { councilEvidence: [f.evidence] })), /user ruling/);
  f.apply('adopt', { newOwner: 'next-controller', reason: 'Explicit ownership transfer' });
  assert.equal(readRun(f.state.runDir).state.decisions[0].resolution, null);
  f.apply('decide', rule(f, 'user', { choice: 'Use the existing retry library instead' }));
  assert.equal(f.state.decisions[0].resolution.councilSkipped, 'direct user ruling');
  assert.ok(status(f.state).next.length);
});

test('autonomous consequential uncertain choice requires actual council evidence', () => {
  const f = fixture('answer', { decisionPolicy: { mode: 'autonomous', checkpoints: [], council: 'auto' } });
  f.apply('question', tradeoff);
  assert.equal(f.state.decisions[0].requiresUser, false);
  assert.throws(() => f.apply('decide', rule(f)), /council evidence/);
  assert.throws(() => f.apply('decide', rule(f, 'controller', { choice: 'invented', councilEvidence: [f.evidence] })), /recorded option/);
  f.apply('decide', rule(f, 'controller', { councilEvidence: [f.evidence] }));
  assert.ok(status(f.state).next.length);
  const artifact = f.state.decisions[0].resolution.councilEvidence[0]; writeFileSync(artifact.path, 'changed');
  assert.equal(status(f.state).state, 'evidence-invalid'); assert.equal(status(f.state).next.length, 0);
  f.apply('reopen-decision', { decision: f.state.decisions[0].id, reason: 'Regather corrupted assessment evidence' });
  assert.equal(status(f.state).state, 'waiting-decision');
  assert.equal(f.state.decisions[0].previousResolutions.length, 1);
  f.apply('decide', rule(f, 'controller', { councilEvidence: [f.evidence] }));
  assert.equal(status(f.state).state, 'active');
});

test('council preference does not turn missing authority into a council vote', () => {
  const policy = { mode: 'autonomous', checkpoints: [], council: 'auto' };
  assert.deepEqual(decisionRequirements(policy, { ...tradeoff, topic: 'authority' }), { requiresUser: true, requiresCouncil: false });
  for (const council of ['requested', 'off']) {
    assert.equal(decisionRequirements({ ...policy, council }, tradeoff).requiresCouncil, false);
    assert.equal(decisionRequirements({ ...policy, council }, { ...tradeoff, councilRequested: 'User explicitly requests council' }).requiresCouncil, true);
  }
});

test('rulings do not expand effect authority or silently change the interaction policy', () => {
  const f = fixture('answer', { decisionPolicy: { mode: 'autonomous', checkpoints: [], council: 'auto' } });
  f.apply('question', { ...tradeoff, topic: 'authority' });
  f.apply('decide', rule(f, 'user', { choice: 'Allow a deployment' }));
  assert.deepEqual(f.state.contract.authority.grants, []);
  const c = structuredClone(f.state.contract); c.authority.grants.push({ effect: 'deploy', source: 'New ruling' });
  assert.throws(() => f.apply('replan', { reason: 'expand', contract: c }), /expand authority/);
  c.authority.grants = []; c.decisionPolicy.council = 'off';
  assert.throws(() => f.apply('replan', { reason: 'skip council', contract: c }), /decision policy/);
});

test('questions settle workers first, survive cancellation, and validate their policy schema', () => {
  const f = fixture('answer'); const a = f.claim();
  assert.throws(() => f.apply('question', tradeoff), /settle or reconcile/);
  f.result(a); f.apply('question', tradeoff); f.apply('cancel', { reason: 'User stopped' });
  assert.equal(status(f.state).state, 'cancelled');
  assert.throws(() => f.apply('decide', rule(f, 'user')), /awaiting a ruling/);
  assert.throws(() => validateContract({ ...f.contract, decisionPolicy: { mode: 'yolo', checkpoints: [], council: 'auto' } }), /decision mode/);
  assert.throws(() => validateContract({ ...f.contract, decisionPolicy: { mode: 'autonomous', checkpoints: ['made-up'], council: 'auto' } }), /unsupported/);
});

test('ordinary mid-assignment decisions resume without defect or replan budget charges', () => {
  const f = fixture('plan'); const a = f.claim(undefined, 'planner');
  f.result(a, { status: 'blocked', category: 'decision', summary: 'Need a within-contract tradeoff ruling' });
  f.apply('question', { ...tradeoff, node: a.node });
  f.apply('decide', rule(f, 'user'));
  assert.deepEqual(f.state.usage.corrections, {}); assert.equal(f.state.usage.replans, 0);
  assert.equal(status(f.state).next[0].node, a.node);
  f.finish(a.node, 'planner');
  assert.equal(f.state.nodes[0].attempts.length, 2); assert.equal(f.state.usage.attempts, 2);
  assert.equal(f.state.nodes[0].attempts[0].result.category, 'decision');
  f.apply('reopen-decision', { decision: f.state.decisions[0].id, reason: 'Reconsider after additional evidence' });
  f.apply('decide', rule(f, 'user'));
  assert.equal(f.state.nodes[0].state, 'accepted', 'historical ruling cannot replay completed work');
  f.apply('replan', { contract: f.state.contract, reason: 'New generation after learning' });
  f.apply('reopen-decision', { decision: f.state.decisions[0].id, reason: 'Regather historical ruling evidence' });
  f.apply('decide', rule(f, 'user'));
  assert.equal(status(f.state).state, 'active');
  assert.equal(f.state.nodes[0].id, 'g2-o1-work');
  assert.equal(f.state.nodes[0].attempts.length, 0, 'archived linkage cannot launch a new-generation worker');
});

test('decision linkage cannot replay external actions or skip contract changes', () => {
  const f = fixture('deliver'); f.finish(); const a = f.claim();
  assert.throws(() => f.result(a, { status: 'blocked', category: 'decision' }), /external actions need reconciliation/);
  f.result(a, { status: 'blocked', category: 'authority' });
  assert.throws(() => f.apply('question', { ...tradeoff, node: a.node }), /non-external/);
  const p = fixture('plan'); const paused = p.claim(); p.result(paused, { status: 'blocked', category: 'decision' });
  for (const topic of ['scope', 'acceptance', 'authority']) assert.throws(() => p.apply('question', { ...tradeoff, topic, node: paused.node }), /contract changes/);
});

test('equivalent decision policies replan regardless of key or checkpoint ordering', () => {
  const f = fixture('plan'); const c = structuredClone(f.state.contract);
  c.decisionPolicy = { council: 'auto', checkpoints: ['delivery', 'approach'], mode: 'checkpointed' };
  f.apply('replan', { contract: c, reason: 'Same policy, revised task plan' });
  assert.equal(f.state.usage.replans, 1);
  c.decisionPolicy.checkpoints = ['approach'];
  assert.throws(() => f.apply('replan', { contract: c, reason: 'Remove delivery checkpoint' }), /decision policy/);
});
