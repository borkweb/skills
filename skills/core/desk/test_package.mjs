// test_package.mjs — structural checks for the skill, manifests, README and evals
// (spec v2 section 6; criteria A4, A37-A39).
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const skill = () => read('skills/core/desk/SKILL.md');

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

test('all three plugin manifests carry 3.35.1 and the same skill list, including desk', () => {
  const m = ['.claude-plugin', '.codex-plugin', '.grok-plugin'].map((d) => JSON.parse(read(`${d}/plugin.json`)));
  assert.deepEqual(new Set(m.map((x) => x.version)), new Set(['3.35.1']));
  for (const x of m) assert.deepEqual(x.skills, m[0].skills);
  assert.ok(m[0].skills.includes('./skills/core/desk'));
  assert.ok(!m.some((x) => x.skills.includes('./skills/core/orchestrate')), 'the old orchestrate entry is gone');
});

// The desk board (slice 2): an optional Claude Code plugin shipped beside the desk skill.
const BOARD = 'skills/core/desk/board';
const boardManifest = () => JSON.parse(read(`${BOARD}/.claude-plugin/plugin.json`));

test('marketplace lists desk-board at the board folder and leaves the bork entry alone', () => {
  const plugins = JSON.parse(read('.claude-plugin/marketplace.json')).plugins;
  assert.deepEqual(plugins.find((p) => p.name === 'bork'), { name: 'bork', source: './' });
  assert.equal(plugins.find((p) => p.name === 'desk-board')?.source, `./${BOARD}`);
  assert.ok(existsSync(join(ROOT, BOARD, '.claude-plugin', 'plugin.json')));
});

test('the board version equals the bork version, so the two installs cannot drift', () => {
  assert.equal(boardManifest().version, JSON.parse(read('.claude-plugin/plugin.json')).version);
});

test('the board manifest names the plugin, its contract, bork as author and an empty terminalApp default', () => {
  const m = boardManifest();
  assert.equal(m.name, 'desk-board');
  assert.equal(m.types, './types/index.d.ts');
  assert.deepEqual(m.author, JSON.parse(read('.claude-plugin/plugin.json')).author);
  assert.equal(m.userConfig.terminalApp.type, 'string');
  assert.equal(m.userConfig.terminalApp.default, '');
  assert.deepEqual(JSON.parse(read(`${BOARD}/hooks/hooks.json`)), { modules: ['./register.tsx'] });
  // A session that hot-reloads the folder lays a tsconfig.json beside the manifest; it must never be committed.
  const tracked = spawnSync('git', ['ls-files', `${BOARD}/tsconfig.json`], { cwd: ROOT, encoding: 'utf8' });
  if (tracked.status === 0) assert.equal(tracked.stdout.trim(), '', 'the mod ships no tsconfig');
});

test('the SKILL has a Board section: command, keyboard, install, development and terminalApp', () => {
  const s = skill();
  const board = s.slice(s.indexOf('## Board (optional, Claude only)'));
  assert.ok(board.startsWith('## Board'), 'the section exists');
  for (const w of ['/desk-board', 'ctrl+x tab', '/plugin marketplace update skills', '/plugin install desk-board@skills', 'CLAUDE_CODE_PLUGIN_DIRS',
    '--plugin-dir', 'com.mitchellh.ghostty', `osascript -e 'id of app "Ghostty"'`, 'BORK_RUNS_HOME', 'only when absolute']) assert.ok(board.includes(w), `Board section mentions ${w}`);
});

test('README has a desk row', () => {
  assert.match(read('README.md'), /^\| \*\*desk\*\* \|/m);
  assert.ok(!/^\| \*\*orchestrate\*\* \|/m.test(read('README.md')), 'the old orchestrate row is gone');
  const row = read('README.md').split('\n').filter((l) => /^\| \*\*desk\*\* \|/.test(l));
  assert.equal(row.length, 1, 'the desk row is one table line');
  assert.match(row[0], /desk-board/i);
});

test('the SKILL routes do runs, names matt:orchestrator, relays questions verbatim and acks by RUN line revision', () => {
  const s = skill();
  const fm = s.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(fm, /^name: desk$/m);
  const desc = fm.match(/^description:\s*(.*)$/m)[1];
  assert.match(desc, /\bdo\b/);
  for (const w of ['start', 'wait', 'answer']) assert.match(desc, new RegExp(w, 'i'));
  assert.match(s, /matt:orchestrator/);
  for (const w of ['verbatim', 'data', '--by user', '--by orchestrator', 'ack --revision', 'one background', 'claim']) assert.ok(s.includes(w), `SKILL mentions ${w}`);
});

test('8: the loop says what to do on exit 124, on several RUN lines, and at a trust dialog', () => {
  const s = skill();
  assert.match(s, /exit 124[^\n]*re-arm[^\n]*(no|without) `?show`? or `?ack/i, 'on 124, re-arm without show or ack');
  assert.match(s, /more than one RUN line[^\n]*`show` and `ack --revision` each one before (you )?re-arm/i);
  assert.match(s, /trust dialog[^\n]*blocked[^\n]*(user )?answer/i);
});

test('6: the SKILL says Codex architects cannot be launched yet', () => {
  const s = skill();
  assert.match(s, /Codex architects cannot be launched yet \(herdr is blocked in Codex's sandbox\)\./);
  assert.ok(!/workspace-write|live Codex check|--harness claude\|codex|approval prompts|a Codex session can still coordinate/.test(s), 'no stale Codex text');
});

// Decisions 16 and 17: herdr fails with PermissionDenied inside Codex's sandbox, so the texts
// must not imply a Codex session can coordinate fully.
const CODEX_CAN = /Codex session inside its sandbox can `?wait`?, `?show`? and `?ack`?, and can `?answer`? only where it can write the runs home/;
const CODEX_CANNOT = /cannot `?start`? runs, and its `?answer`? cannot send the architect its pane line, so (it must )?tell the user to continue in the architect's tab/;
test('f10: the SKILL and the README row say exactly what a Claude session and a Codex session can do', () => {
  const s = skill();
  assert.match(s, /Claude session \(in a herdr tab or over Remote Control\) can do the whole loop/);
  assert.match(s, CODEX_CAN);
  assert.match(s, CODEX_CANNOT);
  const frontmatter = s.split('---')[1];
  assert.ok(!/Claude or Codex/.test(frontmatter), 'the description no longer says Claude or Codex coordinate alike');
  const row = read('README.md').split('\n').find((l) => /^\| \*\*desk\*\* \|/.test(l));
  assert.match(row, /Claude session[^|]*(start|whole loop)/i);
  assert.match(row, CODEX_CAN);
  assert.match(row, CODEX_CANNOT);
  assert.match(row, /Codex architects cannot be launched yet/);
  assert.ok(!/Claude, Codex or Remote Control session can start runs/.test(row), 'the old overclaim is gone');
});

test('evals/cases.json gains the three orchestration cases with unique ids and resolvable skills', () => {
  const cases = JSON.parse(read('evals/cases.json'));
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of cases) assert.ok(existsSync(join(ROOT, c.skill, 'SKILL.md')), c.id);
  for (const id of ['do-orchestrated-asks-and-ends-turn', 'desk-relays-needs-me-question', 'offload-one-slice-corrective-passes-verdict']) assert.ok(ids.includes(id), id);
});

test('f2/f6/f8: the SKILL covers self-launched questions, an unnudged answer and orchestrator.json', () => {
  const s = skill();
  assert.match(s, /launched by: self[^\n]*waiting in that run's own session[^\n]*do not answer it from the coordinator unless the user asks/i);
  assert.match(s, /could not nudge[^\n]*architect did not get the answer[^\n]*continue in that tab/i);
  assert.match(s, /orchestrator\.json[^\n]*machine-local[^\n]*ORCHESTRATOR_HOME[^\n]*never commit/i);
  for (const l of s.split('\n').filter((x) => /runs\.mjs answer|^\| `answer/.test(x))) assert.match(l, /--by/, `every answer example carries --by: ${l}`);
});

test('scope: the coordinator starts runs only on request, passes the goal unchanged and does no research', () => {
  const s = skill();
  const scope = s.slice(s.indexOf('## Scope'), s.indexOf('## The loop'));
  assert.ok(s.indexOf('## Scope') !== -1 && s.indexOf('## Scope') < s.indexOf('## The loop'), 'a Scope section precedes the loop');
  assert.match(scope, /only when the user asks/i);
  assert.match(scope, /goal[^\n]*unchanged/i);
  assert.match(scope, /do not research, read code or plan/i);
  assert.match(scope, /ask the user which repo/i);
  assert.match(s, /\*\*`start`\.\*\*[^\n]*only when the user asks/i, 'the start step repeats the request-only rule');
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
