import { copyFileSync, lstatSync, readFileSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authorityDoesNotExpand, compile, covers, DECISION_TOPICS, DEFAULT_DECISION_POLICY, decisionRequirements, requireThat, text, validateContract } from './policy.mjs';
import { createRun, defaultRoot, hash, readRun, transact } from './store.mjs';
import { fingerprint } from './snapshot.mjs';

const LIVE = new Set(['launching', 'running', 'waiting', 'cancel-requested']);
const external = node => node.effects.some(e => e !== 'write');
const active = state => state.nodes.filter(n => LIVE.has(n.state));
const attemptOf = node => node.attempts.at(-1);
const now = () => new Date().toISOString();
const pendingDecisions = state => (state.decisions ?? []).filter(d => !d.resolution);
function find(state, id) { const n = state.nodes.find(n => n.id === id); requireThat(n, `unknown node ${id}`); return n; }
function event(state, type, detail) { state.history.push({ type, at: now(), ...detail }); }
function allAccepted(state, deps) { return deps.every(id => find(state, id).state === 'accepted'); }
const capture = contract => fingerprint(contract.repo, [...new Set([...contract.scope, ...contract.authority.protectedPaths])]);
function stale(state) { return capture(state.contract).digest !== state.snapshot.digest; }
function assertAuthorizedDrift(state, nextSnapshot) {
  const paths = [...new Set([...Object.keys(state.snapshot.files), ...Object.keys(nextSnapshot.files)])];
  const changed = paths.filter(p => state.snapshot.files[p] !== nextSnapshot.files[p]);
  const outside = changed.filter(p => {
    const necessaryParent = (state.snapshot.files[p] === undefined || state.snapshot.files[p] === 'missing')
      && nextSnapshot.files[p]?.startsWith('directory:')
      && state.contract.authority.writePaths.some(w => covers(p, w));
    return (!necessaryParent && !state.contract.authority.writePaths.some(w => covers(w, p)))
      || state.contract.authority.protectedPaths.some(w => covers(w, p));
  });
  requireThat(outside.length === 0, `snapshot contains unauthorized changes: ${outside.join(', ')}`);
}
function recoverySnapshot(state) {
  const next = capture(state.contract);
  // Pure read-only reviews may explicitly re-pin a changed target. A writing run
  // must never adopt an out-of-scope edit as its new authorized baseline.
  if (state.contract.authority.grants.some(g => g.effect === 'write')) assertAuthorizedDrift(state, next);
  return next;
}
function invalidEvidence(state) {
  const invalid = [];
  const records = state.nodes.filter(n => n.state === 'accepted').map(n => ({ node: n.id, evidence: attemptOf(n)?.result?.evidence ?? [] }));
  records.push(...(state.decisions ?? []).filter(d => d.resolution).map(d => ({ decision: d.id, evidence: [...d.resolution.evidence, ...d.resolution.councilEvidence] })));
  for (const record of records) {
    for (const artifact of record.evidence) {
      try {
        const info = lstatSync(artifact.path);
        requireThat(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024, 'invalid artifact');
        requireThat(hash(readFileSync(artifact.path)) === artifact.digest, 'artifact digest changed');
      } catch { invalid.push({ ...(record.node ? { node: record.node } : { decision: record.decision }), path: artifact.path }); }
    }
  }
  return invalid;
}
function staleVerification(state) {
  return state.nodes.filter(n => n.snapshot && !n.revalidates && n.state === 'accepted' && state.contract.outcomes[n.outcome].kind === 'implement')
    .filter(gate => !state.nodes.some(n => (n.id === gate.id || n.revalidates === gate.id) && n.state === 'accepted' && attemptOf(n)?.snapshot === state.snapshot.digest))
    .map(n => n.id);
}
function canStart(state, node) {
  if (state.stop || pendingDecisions(state).length || node.state !== 'pending' || !allAccepted(state, node.deps)) return false;
  const live = active(state);
  // One writer/action globally, read-only fan-out only within a frozen checkpoint.
  if (node.effects.length && live.length) return false;
  if (live.some(n => n.effects.length)) return false;
  if (external(node) && staleVerification(state).length) return false;
  return true;
}
function attachWorker(state, node, attempt, worker) {
  assertPayload(worker, ['runtime', 'id', 'model']);
  for (const key of ['runtime', 'id', 'model']) text(worker[key], `worker.${key}`);
  requireThat(['host', 'codex-native', 'claude-native', 'external'].includes(worker.runtime), 'unsupported runtime');
  if (worker.runtime !== 'host') {
    requireThat(attempt.handoff, 'delegated worker requires a saved handoff brief before launch');
    const info = lstatSync(attempt.handoff.path);
    requireThat(info.isFile() && !info.isSymbolicLink() && hash(readFileSync(attempt.handoff.path)) === attempt.handoff.digest, 'handoff evidence changed');
  }
  if (node.role === 'reviewer') {
    const builders = [...state.nodes, ...state.archived.flatMap(g => g.nodes)].filter(n => n.effects.includes('write')).flatMap(n => n.attempts).map(a => a.worker).filter(Boolean);
    requireThat(!builders.some(w => w.runtime === worker.runtime && w.id === worker.id), 'builder cannot act as independent reviewer');
  }
  attempt.worker = worker; attempt.state = node.state = 'running';
  event(state, 'attached', { node: node.id, attempt: attempt.id, worker });
}
export function status(state) {
  const live = active(state);
  const changed = live.some(n => n.effects.includes('write')) ? false : stale(state);
  const failures = state.nodes.filter(n => ['failed', 'blocked'].includes(n.state));
  const finished = state.nodes.every(n => n.state === 'accepted');
  const evidenceInvalid = invalidEvidence(state);
  const verificationStale = staleVerification(state);
  const decisions = pendingDecisions(state);
  return {
    runId: state.runId, runDir: state.runDir, revision: state.revision, owner: state.owner,
    state: state.stop ? (live.length ? 'cancelling' : 'cancelled') : changed ? 'stale' : evidenceInvalid.length ? 'evidence-invalid' : decisions.length ? 'waiting-decision' : finished ? (verificationStale.length ? 'verification-stale' : 'complete') : failures.length ? 'blocked' : 'active',
    snapshot: { digest: state.snapshot.digest, entries: state.snapshot.entries }, changed, budgets: state.contract.budgets, usage: state.usage,
    active: live.map(n => ({ node: n.id, state: n.state, attempt: attemptOf(n) })),
    blocked: failures.map(n => ({ node: n.id, result: attemptOf(n)?.result })),
    evidenceInvalid, verificationStale, decisions,
    next: changed || evidenceInvalid.length || state.usage.attempts >= state.contract.budgets.attempts ? [] : state.nodes.filter(n => canStart(state, n)).map(n => ({ node: n.id, role: n.role, instruction: n.instruction, effects: n.effects, snapshot: n.snapshot ? state.snapshot.digest : null,
      ...(n.consolidates?.length ? { inputs: n.consolidates.map(id => { const source = find(state, id); const a = attemptOf(source); return { node: id, snapshot: a?.snapshot, result: a?.result }; }) } : {}),
    })),
    budgetExhausted: state.usage.attempts >= state.contract.budgets.attempts && !finished,
  };
}
export function start(input, owner, root = defaultRoot()) {
  text(owner, 'owner'); const contract = validateContract(input);
  contract.repo = realpathSync(contract.repo);
  const snapshot = capture(contract);
  const at = now();
  return createRun(root, contract.repo, { owner, contract, generation: 1, nodes: compile(contract), snapshot, decisions: [], usage: { attempts: 0, replans: 0, corrections: {} }, history: [{ type: 'start', at, rationale: contract.rationale }], archived: [], created: at, updated: at, stop: false });
}
function resetFrom(state, rootIds) {
  const ids = new Set(rootIds); let changed = true;
  while (changed) { changed = false; for (const n of state.nodes) if (!ids.has(n.id) && n.deps.some(d => ids.has(d))) { ids.add(n.id); changed = true; } }
  requireThat(!state.nodes.some(n => ids.has(n.id) && LIVE.has(n.state)), 'affected work is still live; reconcile or cancel it before invalidating');
  requireThat(!state.nodes.some(n => ids.has(n.id) && external(n) && n.attempts.length), 'external action may have occurred; inspect its actual outcome instead of replaying');
  for (const n of state.nodes) if (ids.has(n.id)) n.state = 'pending';
}
function evidenceFiles(state, paths) {
  requireThat(Array.isArray(paths) && paths.length > 0 && paths.length <= 20, 'result requires 1..20 evidence file paths');
  return paths.map(path => {
    text(path, 'evidence path'); requireThat(path.startsWith('/'), 'evidence path must be absolute');
    const info = lstatSync(path); requireThat(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024, 'evidence must be a regular file, at most 8 MiB');
    const bytes = readFileSync(path); const destination = join(state.runDir, `evidence-${randomUUID()}`);
    copyFileSync(path, destination); chmodSync(destination, 0o600);
    requireThat(hash(readFileSync(destination)) === hash(bytes), 'evidence changed during capture');
    return { path: destination, original: path, digest: hash(bytes) };
  });
}
function assertPayload(payload, keys) {
  requireThat(payload && typeof payload === 'object' && !Array.isArray(payload), 'payload must be an object');
  for (const key of Object.keys(payload)) requireThat(keys.includes(key), `unknown payload field ${key}`);
}
function nodeAttempt(state, payload) {
  const node = find(state, payload.node); const attempt = attemptOf(node);
  requireThat(attempt && attempt.id === payload.attempt, 'stale or unknown attempt'); return { node, attempt };
}
export function change(dir, owner, revision, command, payload = {}) {
  return transact(dir, owner, revision, state => {
    if (pendingDecisions(state).length) requireThat(['decide', 'adopt', 'cancel'].includes(command), 'resolve the pending decision before changing work');
    if (command === 'question') {
      assertPayload(payload, ['topic', 'stakes', 'uncertain', 'question', 'options', 'recommendation', 'councilRequested', 'node']);
      requireThat(!state.stop && active(state).length === 0, 'settle or reconcile workers before opening a decision');
      requireThat(pendingDecisions(state).length === 0, 'resolve the pending decision first');
      requireThat(DECISION_TOPICS.includes(payload.topic), 'invalid decision topic');
      requireThat(['routine', 'consequential'].includes(payload.stakes) && typeof payload.uncertain === 'boolean', 'decision needs stakes and uncertainty');
      text(payload.question, 'question'); text(payload.recommendation, 'recommendation');
      requireThat(Array.isArray(payload.options) && payload.options.length >= 2 && payload.options.length <= 5, 'decision requires 2..5 options');
      payload.options.forEach(option => text(option, 'option'));
      requireThat(new Set(payload.options).size === payload.options.length && payload.options.includes(payload.recommendation), 'options must be unique and include recommendation');
      if (payload.councilRequested !== undefined) text(payload.councilRequested, 'councilRequested user instruction');
      let blockedAttempt;
      if (payload.node !== undefined) {
        const node = find(state, payload.node);
        requireThat(node.state === 'blocked' && attemptOf(node)?.result?.category === 'decision' && !external(node), 'linked question requires a decision-paused non-external node');
        requireThat(!['scope', 'acceptance', 'authority'].includes(payload.topic), 'contract changes cannot resume an unchanged assignment');
        blockedAttempt = attemptOf(node).id;
      }
      const decision = { ...structuredClone(payload), id: randomUUID(), snapshot: state.snapshot.digest, created: now(),
        ...decisionRequirements(state.contract.decisionPolicy ?? DEFAULT_DECISION_POLICY, payload), blockedAttempt, resolution: null };
      (state.decisions ??= []).push(decision);
      event(state, 'question', { decision: decision.id });
    } else if (command === 'reopen-decision') {
      assertPayload(payload, ['decision', 'reason']); text(payload.reason, 'reason');
      const decision = (state.decisions ?? []).find(d => d.id === payload.decision);
      requireThat(decision?.resolution && !state.stop && active(state).length === 0, 'reopening requires a resolved decision and settled uncancelled work');
      (decision.previousResolutions ??= []).push(decision.resolution);
      decision.resolution = null;
      event(state, 'decision-reopened', { decision: decision.id, reason: payload.reason });
    } else if (command === 'decide') {
      assertPayload(payload, ['decision', 'choice', 'by', 'source', 'rationale', 'evidence', 'councilEvidence']);
      const decision = (state.decisions ?? []).find(d => d.id === payload.decision);
      requireThat(decision && !decision.resolution && !state.stop, 'decision is not awaiting a ruling');
      requireThat(['user', 'controller'].includes(payload.by) && (!decision.requiresUser || payload.by === 'user'), 'decision requires a user ruling');
      text(payload.choice, 'choice');
      requireThat(payload.by === 'user' || decision.options.includes(payload.choice), 'controller choice must match a recorded option');
      text(payload.source, 'ruling source'); text(payload.rationale, 'rationale');
      const councilEvidence = payload.councilEvidence ? evidenceFiles(state, payload.councilEvidence) : [];
      requireThat(!decision.requiresCouncil || councilEvidence.length > 0 || payload.by === 'user', 'controller decision requires council evidence');
      decision.resolution = { choice: payload.choice, by: payload.by, source: payload.source, rationale: payload.rationale,
        evidence: evidenceFiles(state, payload.evidence), councilEvidence, councilSkipped: decision.requiresCouncil && !councilEvidence.length ? 'direct user ruling' : null, at: now() };
      if (decision.node) {
        const node = state.nodes.find(n => n.id === decision.node);
        // Reopening a historical ruling must not reset already completed work.
        if (node?.state === 'blocked' && attemptOf(node)?.id === decision.blockedAttempt && attemptOf(node).result?.category === 'decision') node.state = 'pending';
      }
      event(state, 'decision', { decision: decision.id, by: payload.by, choice: payload.choice });
    } else if (command === 'claim' || command === 'claim-host') {
      assertPayload(payload, command === 'claim-host' ? ['node', 'worker'] : ['node']); const node = find(state, payload.node);
      if (command === 'claim-host') requireThat(payload.worker?.runtime === 'host', 'claim-host requires the actual host actor; delegate through claim, brief and attach');
      requireThat(canStart(state, node), 'node is not eligible; inspect status and dependencies');
      requireThat(state.usage.attempts < state.contract.budgets.attempts, 'run attempt budget exhausted');
      requireThat(!stale(state), 'snapshot changed; invalidate and reconcile before new work');
      requireThat(invalidEvidence(state).length === 0, 'required evidence is missing or changed; invalidate and reverify');
      const attempt = { id: randomUUID(), state: 'launching', snapshot: state.snapshot.digest, created: now(), worker: null };
      node.attempts.push(attempt); node.state = 'launching'; state.usage.attempts++;
      event(state, 'launch-intent', { node: node.id, attempt: attempt.id });
      if (command === 'claim-host') attachWorker(state, node, attempt, payload.worker);
    } else if (command === 'brief') {
      assertPayload(payload, ['node', 'attempt', 'path']); const { node, attempt } = nodeAttempt(state, payload);
      requireThat(node.state === 'launching' && !state.stop && !attempt.handoff, 'brief requires an unbriefed launch intent');
      attempt.handoff = evidenceFiles(state, [payload.path])[0];
      event(state, 'briefed', { node: node.id, attempt: attempt.id, handoff: attempt.handoff });
    } else if (command === 'attach') {
      assertPayload(payload, ['node', 'attempt', 'worker']); const { node, attempt } = nodeAttempt(state, payload);
      requireThat(node.state === 'launching' && !state.stop, 'attempt is not awaiting attachment');
      attachWorker(state, node, attempt, payload.worker);
    } else if (command === 'result' || command === 'recover-result') {
      assertPayload(payload, ['node', 'attempt', 'status', 'summary', 'category', 'evidence', 'snapshot']);
      const { node, attempt } = nodeAttempt(state, payload);
      const digest = hash(JSON.stringify(payload));
      const recovering = command === 'recover-result';
      if (attempt.result && !(recovering && attempt.result.reconciledAbsent)) { requireThat(attempt.result.inputDigest === digest, 'conflicting duplicate result'); return; }
      if (recovering) {
        requireThat(external(node) && node.state === 'blocked' && attempt.result?.reconciledAbsent && !state.stop && active(state).length === 0,
          'recovery requires an absent external attempt, no live workers and an uncancelled run');
        requireThat(payload.status === 'pass', 'recovery requires verified target completion; unresolved outcomes remain blocked');
      } else requireThat(['running', 'waiting'].includes(node.state) && !state.stop, 'result requires an attached active worker');
      requireThat(['pass', 'fail', 'blocked', 'waiting'].includes(payload.status), 'invalid result status');
      text(payload.summary, 'result.summary');
      requireThat(payload.snapshot === attempt.snapshot, 'result must name its assigned snapshot');
      requireThat(invalidEvidence(state).length === 0, 'required evidence is missing or changed; invalidate and reverify');
      if (!node.effects.includes('write')) requireThat(!stale(state), 'stale evidence: repository snapshot changed');
      if (payload.status === 'waiting') {
        requireThat(node.role === 'observer', 'only monitor nodes may wait');
        node.state = attempt.state = 'waiting'; event(state, 'observation', { node: node.id, summary: payload.summary, evidence: evidenceFiles(state, payload.evidence) }); return;
      }
      if (payload.status !== 'pass') requireThat(['defect', 'evidence', 'environment', 'contract', 'authority', 'decision'].includes(payload.category), 'failure needs a category');
      if (payload.category === 'decision') requireThat(payload.status === 'blocked' && !external(node), 'decision pause requires blocked non-external work; external actions need reconciliation');
      const evidence = evidenceFiles(state, payload.evidence);
      attempt.result = { status: payload.status, summary: payload.summary, category: payload.category ?? null, evidence, inputDigest: digest, at: now() };
      attempt.state = node.state = payload.status === 'pass' ? 'accepted' : payload.status === 'fail' ? 'failed' : 'blocked';
      if (node.effects.includes('write')) {
        const nextSnapshot = capture(state.contract);
        assertAuthorizedDrift(state, nextSnapshot);
        state.snapshot = nextSnapshot;
        attempt.result.outputSnapshot = state.snapshot.digest;
      }
      event(state, recovering ? 'recovered-result' : 'result', { node: node.id, attempt: attempt.id, status: node.state });
    } else if (command === 'retry') {
      assertPayload(payload, ['node', 'reason']); text(payload.reason, 'reason'); const node = find(state, payload.node);
      requireThat(['failed', 'blocked'].includes(node.state), 'retry needs a failed or blocked node');
      requireThat(!node.effects.length, 'retry cannot replay a mutating action; use correction or explicit reconciliation');
      requireThat(['evidence', 'environment'].includes(attemptOf(node).result?.category), 'defects and contract failures require correction or replanning');
      requireThat(node.attempts.length < 3, 'node recovery budget exhausted; replan');
      requireThat(!stale(state), 'snapshot changed; use invalidate'); resetFrom(state, [node.id]);
      event(state, 'retry', { node: node.id, reason: payload.reason });
    } else if (command === 'correct') {
      assertPayload(payload, ['node', 'reason']); text(payload.reason, 'reason'); const failed = find(state, payload.node);
      requireThat(['failed', 'blocked'].includes(failed.state), 'correction requires a failed or blocked result');
      const build = state.nodes.find(n => n.outcome === failed.outcome && n.role === 'builder');
      requireThat(build, 'no builder in this outcome; replan instead');
      const key = String(failed.outcome); const count = state.usage.corrections[key] ?? 0;
      requireThat(count < state.contract.budgets.corrections, 'correction budget exhausted; diagnose/replan');
      requireThat(active(state).length === 0, 'join all results or reconcile workers before correction');
      resetFrom(state, [build.id]); state.usage.corrections[key] = count + 1;
      state.snapshot = recoverySnapshot(state);
      event(state, 'correction', { outcome: failed.outcome, reason: payload.reason, count: count + 1 });
    } else if (command === 'invalidate') {
      assertPayload(payload, ['reason']); text(payload.reason, 'reason');
      requireThat(active(state).length === 0, 'reconcile active workers before invalidating');
      requireThat(!state.nodes.some(n => external(n) && n.attempts.length), 'external effects may have occurred; inspect before starting a new run');
      requireThat(state.usage.replans < state.contract.budgets.replans, 'replan budget exhausted');
      // Conservative invalidation: replay the scoped work, never accept old evidence.
      resetFrom(state, state.nodes.filter(n => !n.deps.length).map(n => n.id));
      state.snapshot = recoverySnapshot(state); state.usage.replans++;
      event(state, 'invalidate', { reason: payload.reason });
    } else if (command === 'replan') {
      assertPayload(payload, ['reason', 'contract']); text(payload.reason, 'reason');
      requireThat(!state.stop && active(state).length === 0, 'cannot replan cancelled or live work');
      requireThat(pendingDecisions(state).length === 0, 'resolve pending decisions before replanning');
      requireThat(!state.nodes.some(n => external(n) && n.attempts.length), 'external effects may have occurred; inspect before starting a new run');
      requireThat(state.usage.replans < state.contract.budgets.replans, 'replan budget exhausted');
      const contract = validateContract(payload.contract); contract.repo = realpathSync(contract.repo);
      requireThat(authorityDoesNotExpand(state.contract, contract), 'replan cannot expand authority; obtain a new user instruction and start a linked, scoped run');
      requireThat(JSON.stringify(contract.budgets) === JSON.stringify(state.contract.budgets), 'replan cannot reset or enlarge budgets');
      const beforePolicy = state.contract.decisionPolicy ?? DEFAULT_DECISION_POLICY;
      requireThat(contract.decisionPolicy.mode === beforePolicy.mode && contract.decisionPolicy.council === beforePolicy.council
        && contract.decisionPolicy.checkpoints.length === beforePolicy.checkpoints.length
        && contract.decisionPolicy.checkpoints.every(topic => beforePolicy.checkpoints.includes(topic)), 'decision policy changes need a new user instruction and linked run');
      recoverySnapshot(state); // Validate against the old contract before changing scope.
      state.archived.push({ generation: state.generation, contract: state.contract, nodes: state.nodes });
      state.generation++; state.usage.replans++; state.contract = contract; state.nodes = compile(contract, state.generation);
      state.snapshot = capture(contract); event(state, 'replan', { reason: payload.reason, generation: state.generation });
    } else if (command === 'cancel') {
      assertPayload(payload, ['reason']); text(payload.reason, 'reason'); state.stop = true;
      for (const node of state.nodes) {
        if (LIVE.has(node.state)) node.state = attemptOf(node).state = 'cancel-requested';
        else if (node.state === 'pending') node.state = 'cancelled';
      }
      event(state, 'cancel-requested', { reason: payload.reason });
    } else if (command === 'reconcile') {
      assertPayload(payload, ['node', 'attempt', 'presence', 'reason', 'evidence']);
      const { node, attempt } = nodeAttempt(state, payload); requireThat(LIVE.has(node.state), 'attempt is not live'); text(payload.reason, 'reason');
      requireThat(['alive', 'absent', 'unknown'].includes(payload.presence), 'invalid presence');
      const evidence = evidenceFiles(state, payload.evidence);
      if (payload.presence === 'absent') {
        node.state = attempt.state = state.stop ? 'cancelled' : 'blocked';
        attempt.result = { status: 'blocked', category: 'environment', summary: payload.reason, evidence, reconciledAbsent: true, at: now() };
      }
      event(state, 'reconciled', { node: node.id, attempt: attempt.id, presence: payload.presence, reason: payload.reason, evidence });
    } else if (command === 'adopt') {
      assertPayload(payload, ['newOwner', 'reason']); text(payload.newOwner, 'newOwner'); text(payload.reason, 'reason');
      requireThat(payload.newOwner !== owner, 'new owner must differ'); state.owner = payload.newOwner;
      event(state, 'adopted', { from: owner, to: payload.newOwner, reason: payload.reason });
    } else throw new Error(`unknown command ${command}`);
  });
}
export function inspect(dir) { return status(readRun(dir).state); }
