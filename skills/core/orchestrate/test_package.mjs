// test_package.mjs — structural checks for the skill, manifests, README and evals
// (spec v2 section 6; criteria A4, A37-A39).
import assert from 'node:assert';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const skill = () => read('skills/core/orchestrate/SKILL.md');

test('runs.mjs and helpers import only node builtins and sibling files; no package.json', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.includes('runs.mjs'));
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('node:') || /^\.\/[\w.-]+$/.test(m[1]), `${f} imports ${m[1]}`);
    }
  }
  assert.ok(!existsSync(join(HERE, 'package.json')));
});

test('all three plugin manifests carry 3.33.0 and the same skill list, including orchestrate', () => {
  const m = ['.claude-plugin', '.codex-plugin', '.grok-plugin'].map((d) => JSON.parse(read(`${d}/plugin.json`)));
  assert.deepEqual(new Set(m.map((x) => x.version)), new Set(['3.33.0']));
  for (const x of m) assert.deepEqual(x.skills, m[0].skills);
  assert.ok(m[0].skills.includes('./skills/core/orchestrate'));
});

test('README has an orchestrate row', () => {
  assert.match(read('README.md'), /^\| \*\*orchestrate\*\* \|/m);
});

test('the SKILL routes do runs, names matt:orchestrator, relays questions verbatim and acks by RUN line revision', () => {
  const s = skill();
  const fm = s.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(fm, /^name: orchestrate$/m);
  const desc = fm.match(/^description:\s*(.*)$/m)[1];
  assert.match(desc, /\bdo\b/);
  for (const w of ['start', 'wait', 'answer']) assert.match(desc, new RegExp(w, 'i'));
  assert.match(s, /matt:orchestrator/);
  for (const w of ['verbatim', 'data', '--by user', '--by orchestrator', 'ack --revision', 'one background', 'claim']) assert.ok(s.includes(w), `SKILL mentions ${w}`);
  assert.match(s, /approval prompts/);
});

test('8: the loop says what to do on exit 124, on several RUN lines, and at a trust dialog', () => {
  const s = skill();
  assert.match(s, /exit 124[^\n]*re-arm[^\n]*(no|without) `?show`? or `?ack/i, 'on 124, re-arm without show or ack');
  assert.match(s, /more than one RUN line[^\n]*`show` and `ack --revision` each one before (you )?re-arm/i);
  assert.match(s, /trust dialog[^\n]*blocked[^\n]*(user )?answer/i);
});

test('6: the SKILL says a Codex architect runs in the workspace-write sandbox and that a live Codex check is pending', () => {
  const s = skill();
  assert.match(s, /Codex architect[^\n]*workspace-write[^\n]*sandbox/i);
  assert.match(s, /repo and the two added roots/i);
  assert.match(s, /live Codex check is still pending/i);
});

test('evals/cases.json gains the three orchestration cases with unique ids and resolvable skills', () => {
  const cases = JSON.parse(read('evals/cases.json'));
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of cases) assert.ok(existsSync(join(ROOT, c.skill, 'SKILL.md')), c.id);
  for (const id of ['do-orchestrated-asks-and-ends-turn', 'orchestrate-relays-needs-me-question', 'offload-one-slice-corrective-passes-verdict']) assert.ok(ids.includes(id), id);
});

test('f2/f6/f8: the SKILL covers self-launched questions, an unnudged answer and orchestrator.json', () => {
  const s = skill();
  assert.match(s, /launched by: self[^\n]*waiting in that run's own session[^\n]*do not answer it from the coordinator unless the user asks/i);
  assert.match(s, /could not nudge[^\n]*architect did not get the answer[^\n]*continue in that tab/i);
  assert.match(s, /orchestrator\.json[^\n]*machine-local[^\n]*ORCHESTRATOR_HOME[^\n]*never commit/i);
  for (const l of s.split('\n').filter((x) => /runs\.mjs answer|^\| `answer/.test(x))) assert.match(l, /--by/, `every answer example carries --by: ${l}`);
});

test('f5: the one-slice corrective eval names a C-numbered criterion and requires --verdict with a provenance tag', () => {
  const c = JSON.parse(read('evals/cases.json')).find((x) => x.id === 'offload-one-slice-corrective-passes-verdict');
  const n = c.prompt.match(/\bC(\d+)\b/);
  assert.ok(n, `the prompt names a C<n> criterion: ${c.prompt}`);
  const crit = c.criteria.join('\n');
  assert.match(crit, /--verdict/);
  assert.match(crit, new RegExp(`named C${n[1]}\\b`), 'the tag cites the same criterion');
  assert.match(crit, /unnamed/);
  assert.ok(c.criteria.length >= 4);
});
