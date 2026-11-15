// test_local_gates_docs.mjs — the docs that tell people how local gates work stay true to the code.
// Prose checks are greps for the facts a builder or architect needs, not for exact sentences.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { N, HANDOFF, cli, gitRepo, mkGateDoc, scratch } from './gate-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const doc = (name) => readFileSync(join(HERE, name), 'utf8');
const template = doc('builder-template.md');
const correctives = doc('correctives.md');
const skill = doc('SKILL.md');
const judging = doc('judging.md');
const waitSignals = readFileSync(join(HERE, '..', 'complete', 'wait-signals.md'), 'utf8');
const header = (file) => readFileSync(join(HERE, file), 'utf8').split(/\n(?=set -|import )/)[0];

test('C9a: builder-template says ready runs the frozen local gates at HEAD and refuses with red: and the exit code', () => {
  assert.match(template, /`ready`[^\n]*local gates?[^\n]*HEAD|local gates?[^\n]*`ready`[^\n]*HEAD/i);
  assert.ok(template.includes('red:'));
  assert.match(template, new RegExp(`exit ${N}\\b`));
});

test('C9b: the builder reads the saved output, fixes within the owned files, reruns ready, and never edits gates, steals or runs status', () => {
  const para = template.split('\n\n').find((p) => p.includes('red:') && /saved output/i.test(p)) ?? '';
  assert.ok(para, 'a paragraph on handling a red: refusal');
  assert.match(para, /read/i);
  assert.match(para, /owned files/i);
  assert.match(para, /rerun `ready`|run `ready` again/i);
  assert.match(para, /Frozen gates/);
  assert.match(para, /--steal/);
  assert.match(para, /`status`/);
});

test('C9c: a red gate the builder cannot fix goes to Open disagreements, then blocked', () => {
  const para = template.split('\n\n').find((p) => p.includes('red:') && /Open disagreements/.test(p)) ?? '';
  assert.ok(para, 'the escape for a red gate that cannot be fixed within the owned files');
  assert.match(para, /`blocked`/);
});

test('C9d: ready is no longer described as only a coverage check without saying it runs local gates', () => {
  const line = template.split('\n').find((l) => l.includes('a check of the evidence')) ?? '';
  assert.ok(/local gates?/i.test(line), `line: ${line}`);
  assert.ok(template.includes('it refuses unless Gate results has one line for every frozen criterion ID'), 'frozen phrase kept');
});

test('C9e: the corrective reach rule says local gates rerun at HEAD on every ready, whatever Carried: says', () => {
  const para = template.split('\n\n').find((p) => p.includes('Carried:') && /local gates?/i.test(p)) ?? '';
  assert.ok(para, 'a Carried: paragraph naming local gates');
  assert.match(para, /every `?ready`?|each `?ready`?/i);
});

test('C9f: the freeze step says which gates to mark local, the syntax and the timeout', () => {
  const where = [correctives, skill].find((t) => /L\d+: local: <command>/.test(t)) ?? '';
  assert.ok(where, 'a doc gives the exact syntax');
  assert.match(where, /test-resources/);
  assert.match(where, /620/);
  assert.match(where, /not local/i);
  const code = readFileSync(HANDOFF, 'utf8').match(/LOCAL_GATE_TIMEOUT_S = (\d+)/)?.[1];
  assert.ok(code, 'the default timeout constant');
  assert.ok(where.includes(`${code} s`) || where.includes(`${code}s`), `the docs give the timeout ${code}`);
});

test('C9f: the doc’s syntax example is a gate the parser runs', () => {
  const where = [correctives, skill].find((t) => /L\d+: local: <command>/.test(t)) ?? '';
  const example = /(L\d+: local: <command>)/.exec(where)?.[1];
  assert.ok(example, 'a syntax example in the docs');
  const repo = gitRepo();
  const out = scratch();
  const line = example.replace('<command>', `touch ${out}/ran`);
  const d = mkGateDoc({ frozen: [line], head: repo.head, cwd: repo.dir });
  assert.equal(cli(['ready', d], { session: 's' }).code, 0);
  assert.ok(existsSync(join(out, 'ran')), 'the documented syntax did not run');
});

test('C9g: a red: refusal is the builder’s to fix: no verdict, no rejection, no round; the full gate run still happens', () => {
  const para = judging.split('\n\n').find((p) => p.includes('red:')) ?? '';
  assert.ok(para, 'judging.md covers a red: refusal');
  assert.match(para, /not a verdict/i);
  assert.match(para, /rejection/i);
  assert.match(para, /round/i);
  assert.match(para, /full gate run/i);
});

test('C13: judging.md says the builder can edit Frozen gates, so the architect reruns local gates from the dispatched block', () => {
  const para = judging.split('\n\n').find((p) => /local gates?/i.test(p) && /dispatched block|block you dispatched/i.test(p)) ?? '';
  assert.ok(para, 'a paragraph on rerunning local gates from the block');
  assert.match(para, /Frozen gates/);
  assert.match(para, /send-back|send back|sends? it back/i);
});

test('C17: wait-signals.md says coverage runs no gate, so a stopped builder’s output is read or the check rerun', () => {
  const para = waitSignals.split('\n\n').find((p) => p.includes('`coverage`') && /gate/i.test(p) && /saved/i.test(p)) ?? '';
  assert.ok(para, 'wait-signals.md names coverage and the saved local-gate output');
  assert.match(para, /does not run|never runs|runs no gate/i);
});

test('C9h: the handoff.mjs header documents the syntax, the exit code, the order, the timeout, the allowlist and the hook', () => {
  const h = header('handoff.mjs');
  assert.match(h, /L<n>: local: <command>/);
  assert.match(h, new RegExp(`exit ${N}\\b`));
  assert.ok(h.includes('red:'));
  assert.match(h, /coverage[^\n]*stale[^\n]*gates|coverage, then stale, then/i);
  assert.match(h, /OFFLOAD_LOCAL_GATE_TIMEOUT_S/);
  assert.match(h, /Gate env allowlist:/);
  assert.match(h, /stop-gates/);
});

test('C9h: the comment above claude_hook_settings describes the Stop gate check and the touch order', () => {
  const src = readFileSync(join(HERE, 'dispatch.sh'), 'utf8');
  const at = src.indexOf('claude_hook_settings() {');
  const comment = src.slice(src.lastIndexOf('\n\n', at), at);
  assert.match(comment, /gate/i);
  assert.match(comment, /touch/);
  assert.match(comment, /after|then/i);
});

test('C9i: the exit code is the same everywhere it is named', () => {
  assert.match(header('handoff.mjs'), new RegExp(`exit ${N}\\b`));
  assert.match(template, new RegExp(`exit ${N}\\b`));
  assert.match(judging, new RegExp(`\\b${N}\\b`));
});

test('C9j: SKILL.md stays within the size the allowlist held before this slice', () => {
  assert.ok(statSync(join(HERE, 'SKILL.md')).size <= 24094);
  const rb = readFileSync(join(HERE, '..', '..', '..', 'scripts', 'validate-skills.rb'), 'utf8');
  const entry = Number(/'skills\/core\/offload\/SKILL\.md' => ([\d_]+)/.exec(rb)?.[1].replace(/_/g, ''));
  assert.ok(entry <= 24094, `allowlist entry ${entry} was raised`);
});


