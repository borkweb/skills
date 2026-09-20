// Pure policy: the host interprets intent; this module validates and compiles it.
import { isAbsolute, normalize, sep } from 'node:path';

export const KINDS = ['answer', 'research', 'diagnose', 'review', 'plan', 'prototype', 'implement', 'deliver', 'operate', 'monitor'];
export const EFFECTS = ['write', 'commit', 'push', 'pr', 'merge', 'deploy', 'operate', 'delete'];
export const SURFACES = ['ui', 'data', 'security', 'api'];
export const DECISION_TOPICS = ['routine', 'approach', 'scope', 'acceptance', 'delivery', 'authority', 'blocker'];
export const DEFAULT_DECISION_POLICY = { mode: 'checkpointed', checkpoints: ['approach', 'delivery'], council: 'auto' };
export function validateDecisionPolicy(policy) {
  fields(policy, ['mode', 'checkpoints', 'council'], 'decisionPolicy');
  requireThat(['collaborative', 'checkpointed', 'autonomous'].includes(policy.mode), 'invalid decision mode');
  strings(policy.checkpoints, 'decisionPolicy.checkpoints', DECISION_TOPICS);
  requireThat(['auto', 'requested', 'off'].includes(policy.council), 'invalid council policy');
  return policy;
}
export function decisionRequirements(policy, decision) {
  const hardStop = ['scope', 'acceptance', 'authority', 'blocker'].includes(decision.topic);
  return {
    requiresUser: hardStop || (decision.stakes === 'consequential' && (policy.mode === 'collaborative' || (policy.mode === 'checkpointed' && policy.checkpoints.includes(decision.topic)))),
    requiresCouncil: !!decision.councilRequested || (policy.council === 'auto' && decision.stakes === 'consequential' && decision.uncertain && !['authority', 'blocker'].includes(decision.topic)),
  };
}
export function requireThat(condition, message) { if (!condition) throw new Error(message); }
export function text(value, name) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 20000, `${name}: expected nonempty text (max 20000 chars)`);
  return value;
}
function fields(value, allowed, name) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), `${name}: expected object`);
  for (const key of Object.keys(value)) requireThat(allowed.includes(key), `${name}: unknown field ${key}`);
}
function strings(value, name, options) {
  requireThat(Array.isArray(value) && value.length <= 100, `${name}: expected array (max 100)`);
  for (const item of value) { text(item, name); if (options) requireThat(options.includes(item), `${name}: unsupported value ${item}`); }
  requireThat(new Set(value).size === value.length, `${name}: duplicate values`);
}
export function relativePath(value) {
  text(value, 'path');
  requireThat(!isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && !/[\r\n*?]/.test(value), 'paths must be literal repository-relative paths');
  const parts = value.split('/');
  requireThat(!parts.includes('..') && !parts.some(p => p.toLowerCase() === '.git'), 'parent traversal and .git paths are forbidden');
  requireThat(normalize(value).split(sep).join('/') === value && (value === '.' || !parts.includes('.')), 'paths must be normalized');
  return value;
}
export function covers(parent, child) { return parent === '.' || parent === child || child.startsWith(`${parent}/`); }
export function validateContract(input) {
  const c = structuredClone(input);
  fields(c, ['schemaVersion', 'request', 'repo', 'rationale', 'outcomes', 'risk', 'surfaces', 'authority', 'scope', 'checks', 'budgets', 'decisionPolicy'], 'contract');
  requireThat(c.schemaVersion === 1, 'unsupported contract schemaVersion');
  for (const key of ['request', 'repo', 'rationale']) text(c[key], key);
  requireThat(isAbsolute(c.repo), 'repo must be absolute');
  requireThat(['light', 'standard', 'sensitive'].includes(c.risk), 'invalid risk');
  c.decisionPolicy ??= structuredClone(DEFAULT_DECISION_POLICY);
  validateDecisionPolicy(c.decisionPolicy);
  strings(c.surfaces, 'surfaces', SURFACES);
  strings(c.scope, 'scope'); c.scope.forEach(relativePath);
  fields(c.authority, ['grants', 'writePaths', 'protectedPaths'], 'authority');
  strings(c.authority.writePaths, 'writePaths'); c.authority.writePaths.forEach(relativePath);
  strings(c.authority.protectedPaths, 'protectedPaths'); c.authority.protectedPaths.forEach(relativePath);
  requireThat(Array.isArray(c.authority.grants), 'authority.grants must be an array');
  const grants = new Set();
  for (const g of c.authority.grants) {
    fields(g, ['effect', 'source'], 'grant');
    requireThat(EFFECTS.includes(g.effect) && !grants.has(g.effect), 'invalid or duplicate effect grant');
    text(g.source, 'grant.source'); grants.add(g.effect);
  }
  if (grants.has('write')) requireThat(c.authority.writePaths.length > 0, 'write grant requires writePaths');
  for (const p of c.authority.writePaths) {
    requireThat(c.scope.some(s => covers(s, p)), `scope must cover write path ${p}`);
    requireThat(!c.authority.protectedPaths.some(s => covers(s, p)), `write path ${p} is protected`);
  }
  requireThat(Array.isArray(c.outcomes) && c.outcomes.length > 0 && c.outcomes.length <= 20, 'outcomes must contain 1..20 entries');
  for (const o of c.outcomes) {
    fields(o, ['kind', 'goal', 'effects'], 'outcome');
    requireThat(KINDS.includes(o.kind), 'unsupported outcome kind'); text(o.goal, 'outcome.goal'); strings(o.effects, 'outcome.effects', EFFECTS);
    const permitted = ['implement', 'prototype', 'plan'].includes(o.kind) ? ['write'] : ['deliver', 'operate'].includes(o.kind) ? EFFECTS : [];
    requireThat(o.effects.every(e => permitted.includes(e) && grants.has(e)), `${o.kind}: effect is not allowed or not authorized`);
    if (['implement', 'prototype'].includes(o.kind)) requireThat(o.effects.includes('write'), `${o.kind} requires an explicit write grant`);
    if (o.kind === 'deliver') requireThat(o.effects.length > 0, 'deliver requires named effects; use review for a delivery assessment');
  }
  requireThat(Array.isArray(c.checks) && c.checks.length <= 50, 'checks must be an array (max 50)');
  const ids = new Set();
  for (const check of c.checks) {
    fields(check, ['id', 'kind', 'instruction', 'outcomes'], 'check');
    requireThat(typeof check.id === 'string' && /^[a-z][a-z0-9-]{0,49}$/.test(check.id) && !ids.has(check.id), 'invalid or duplicate check id');
    ids.add(check.id); requireThat(['check', 'review', 'browser'].includes(check.kind), 'invalid check kind'); text(check.instruction, 'check.instruction');
    if (check.outcomes !== undefined) requireThat(Array.isArray(check.outcomes) && check.outcomes.length > 0 && new Set(check.outcomes).size === check.outcomes.length && check.outcomes.every(i => Number.isSafeInteger(i) && i >= 0 && i < c.outcomes.length), 'check.outcomes must name valid zero-based outcome indexes');
  }
  c.budgets ??= { corrections: 2, replans: 2, attempts: 64 };
  fields(c.budgets, ['corrections', 'replans', 'attempts'], 'budgets');
  for (const key of ['corrections', 'replans', 'attempts']) requireThat(Number.isSafeInteger(c.budgets[key]) && c.budgets[key] >= 0 && c.budgets[key] <= 1000, `invalid ${key} budget`);
  requireThat(c.budgets.attempts > 0, 'attempt budget must be positive');
  if (c.outcomes.some(o => ['implement', 'review'].includes(o.kind))) requireThat(c.scope.length > 0, 'implementation/review requires snapshot scope');
  return c;
}

export function compile(c, generation = 1) {
  const nodes = []; const acceptance = []; let prior = [];
  function add(index, suffix, role, deps, instruction, effects = [], snapshot = false) {
    const node = { id: `g${generation}-o${index + 1}-${suffix}`, outcome: index, role, deps: [...deps], instruction, effects: [...effects], snapshot, state: 'pending', attempts: [] };
    nodes.push(node); return node.id;
  }
  c.outcomes.forEach((o, i) => {
    const checks = c.checks.filter(check => check.outcomes ? check.outcomes.includes(i) : c.outcomes.some(outcome => outcome.kind === 'implement') ? o.kind === 'implement' : true);
    const first = (suffix, role, instruction, effects = []) => add(i, suffix, role, prior, instruction, effects);
    let ends;
    if (o.kind === 'implement') {
      const scope = first('scope', 'planner', `Confirm scope and frozen acceptance for: ${o.goal}`);
      const build = add(i, 'build', 'builder', [scope], o.goal, o.effects);
      ends = [add(i, 'verify', 'check', [build], 'Verify requested behavior, meaningful regression coverage and applicable project gates. Return raw results; missing required evidence is blocked.', [], true)];
      if (c.risk !== 'light' || c.surfaces.includes('security') || c.surfaces.includes('data')) ends.push(add(i, 'review', 'reviewer', [build], 'Independently review the pinned final scope for defects, scope and required evidence.', [], true));
      if (c.surfaces.includes('ui')) ends.push(add(i, 'browser', 'browser', [build], 'Verify applicable rendered interactions against the pinned snapshot using isolated resources.', [], true));
      for (const surface of c.surfaces.filter(s => s !== 'ui')) ends.push(add(i, surface, surface === 'security' ? 'reviewer' : 'check', [build], `Verify the ${surface} contracts and failure paths implicated by this change.`, [], true));
      for (const check of checks) ends.push(add(i, `custom-${check.id}`, check.kind === 'review' ? 'reviewer' : check.kind, [build], check.instruction, [], true));
    } else if (['deliver', 'operate'].includes(o.kind)) {
      const pre = first('preflight', 'check', `Verify exact targets, authority and prerequisites: ${o.goal}`);
      const prerequisites = [pre];
      for (const check of checks) prerequisites.push(add(i, `custom-${check.id}`, check.kind === 'review' ? 'reviewer' : check.kind, [pre], check.instruction));
      const act = add(i, 'action', 'operator', prerequisites, o.goal, o.effects);
      ends = [add(i, 'postflight', 'check', [act], 'Read actual target state and verify the requested outcome; do not infer success from an action request.')];
    } else {
      const roles = { answer: 'analyst', research: 'analyst', diagnose: 'investigator', review: 'reviewer', plan: 'planner', prototype: 'builder', monitor: 'observer' };
      const work = first('work', roles[o.kind], o.goal, o.effects);
      if (o.kind === 'review') nodes.at(-1).snapshot = true;
      ends = ['plan', 'prototype'].includes(o.kind) ? [add(i, 'evaluate', 'check', [work], 'Verify the requested artifact or learning question and explicitly record its limitations.')] : [work];
      for (const check of checks) ends.push(add(i, `custom-${check.id}`, check.kind === 'review' ? 'reviewer' : check.kind, [work], check.instruction, [], o.kind === 'review'));
    }
    // Earlier implementation gates are historical evidence, not proof of later
    // writes. Recheck each original requirement at every subsequent writer;
    // do not replay historical diagnosis/planning or earlier builders.
    if (o.effects.includes('write')) {
      const writer = nodes.find(n => n.outcome === i && n.effects.includes('write'));
      for (const gate of acceptance) {
        const id = add(i, `integration-${gate.id}`, gate.role, [writer.id],
          `Revalidate earlier outcome on the current snapshot: ${c.outcomes[gate.outcome].goal}\n${gate.instruction}`, [], true);
        nodes.at(-1).revalidates = gate.id;
        ends.push(id);
      }
    }
    if (o.kind === 'implement') acceptance.push(...nodes.filter(n => n.outcome === i && n.snapshot && !n.revalidates));
    prior = [add(i, 'report', 'reporter', ends, `Report the requested outcome, evidence, unresolved limits and actual delivery state: ${o.goal}`)];
  });
  return nodes;
}

export function authorityDoesNotExpand(before, after) {
  const oldEffects = before.authority.grants.map(g => g.effect);
  return after.repo === before.repo &&
    after.authority.grants.every(g => oldEffects.includes(g.effect)) &&
    after.authority.writePaths.every(p => before.authority.writePaths.some(old => covers(old, p))) &&
    before.authority.protectedPaths.every(p => after.authority.protectedPaths.some(next => covers(next, p)));
}
