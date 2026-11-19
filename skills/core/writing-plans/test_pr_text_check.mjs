// test_pr_text_check.mjs — drives pr-text-check.mjs only as a child process, against body files in a temp
// dir. The Before and After examples come from pr-comments.md itself, so the rule file's example cannot
// drift away from what the check accepts.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test, { after } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'pr-text-check.mjs');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'prtc-')));
after(() => rmSync(BOX, { recursive: true, force: true }));

let n = 0;
function file(text, ext = 'md') {
  const path = join(BOX, `body-${n++}.${ext}`);
  writeFileSync(path, text);
  return path;
}

function run(...args) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The fenced markdown block that follows a line starting with `lead` in pr-comments.md.
function example(lead) {
  const doc = readFileSync(join(HERE, 'pr-comments.md'), 'utf8');
  const at = doc.indexOf(`\n${lead}`);
  assert.ok(at >= 0, `pr-comments.md has no line starting "${lead}"`);
  const m = /```markdown\n([\s\S]*?)\n```\n/.exec(doc.slice(at));
  assert.ok(m, `no markdown block after "${lead}"`);
  return m[1];
}

const DETAILS = '<details>\n<summary>Details</summary>\n\nDeep detail with `a`, `b`, `c` and `d`. Tests: 22/22. PHPCS is clean.\n</details>\n';

test('the After example in pr-comments.md passes', () => {
  const r = run(file(example('After:')));
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /ok \(1 body\)/);
});

test('the Before example in pr-comments.md fails on code spans and test results', () => {
  const r = run(file(example('Before:')));
  assert.strictEqual(r.code, 1, r.out + r.err);
  assert.match(r.out, /: code-spans: 7 code spans/);
  assert.match(r.out, /: test-results: /);
});

test('a paragraph of four sentences fails', () => {
  const r = run(file('- **Broken accounts.** One. Two. Three! Four?\n'));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /: sentences: 4 sentences, limit 3/);
});

test('deep detail inside a Details block is not visible text', () => {
  const r = run(file(`🤖 Fixed the share check. It now skips broken accounts.\n\n${DETAILS}`));
  assert.strictEqual(r.code, 0, r.out + r.err);
});

test('a harness name fails anywhere, even in Details, and --allow lets it pass', () => {
  const body = `Fixed the share check.\n\n<details>\n<summary>Details</summary>\n\nFound in the Codex pass.\n</details>\n`;
  const r = run(file(body));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /process: remove a harness name \("Codex"\)/);
  assert.match(r.out, /process: remove a process word \("Codex pass"\)|process: remove a harness name/);
  const allowed = run('--allow', 'codex', file('🤖 Codex now starts in the right folder.\n'));
  assert.strictEqual(allowed.code, 0, allowed.out);
});

test('skill names, slash commands, session links and local paths fail', () => {
  const r = run(file('Ran /pr-review via bork:do from /Users/someone/x. See https://claude.ai/code/session_1.\n'));
  assert.strictEqual(r.code, 1);
  for (const what of ['a slash command', 'a skill name', 'a local path', 'a session link']) {
    assert.ok(r.out.includes(`remove ${what}`), `${what} not reported:\n${r.out}`);
  }
});

test('a hidden HTML marker is ignored', () => {
  const r = run(file('<!-- bork:do review-marker with `a` `b` `c` -->\n🤖 Fixed the share check.\n'));
  assert.strictEqual(r.code, 0, r.out + r.err);
});

test('a suggestion block is not visible text', () => {
  const code = Array.from({ length: 60 }, (_, i) => `$a${i} = foo( \`x\`, 'y' ); // 1/2 tests pass. Done. Again. More. Yes.`).join('\n');
  const r = run(file(`🤖 **IMPORTANT — Wrong default**\n\nThe default turns sharing on for every site.\n\n\`\`\`suggestion\n${code}\n\`\`\`\n`));
  assert.strictEqual(r.code, 0, r.out + r.err);
});

test('a Details block without a blank line after </summary> fails', () => {
  const r = run(file('Fixed it.\n\n<details>\n<summary>Details</summary>\nNo blank line.\n</details>\n'));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /details: put a blank line after <\/summary>/);
});

test('an unclosed Details block fails', () => {
  const r = run(file('Fixed it.\n\n<details>\n<summary>Details</summary>\n\nOpen.\n'));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /details: 1 <details> but 0 <\/details>/);
});

test('a bold lead-in and abbreviations do not count as sentences', () => {
  const r = run(file('🤖 It shared broken accounts.\n\n- **It shared broken accounts.** It now checks each one, e.g. expired ones. Then it queues the share. Tests cover it.\n'));
  assert.strictEqual(r.code, 0, r.out + r.err);
});

test('a long comment fails on length', () => {
  const para = 'This line has exactly ten plain words in it now. ';
  const body = Array.from({ length: 13 }, () => `${para}\n`).join('\n');
  const r = run(file(body));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /length: 130 visible words, limit 120/);
});

test('a description may keep commands in its testing section and allows more words', () => {
  const what = 'Adds three abilities so an agent can manage social sharing for a site. ';
  const body = [
    '## What', what.repeat(3), '## Why', what.repeat(3), '## How', what.repeat(3),
    '## Notes', what.repeat(3),
    '## Testing instructions',
    '1. Run `composer phpunit` in `projects/packages/publicize` with `--filter` set. 22/22 tests pass.',
    '2. Add `add_filter( \'jetpack_wp_abilities_enabled\', \'__return_true\' );` to a `mu-plugin`.',
    '## Does this change tracking?', 'No.',
  ].join('\n\n');
  const asComment = run(file(body));
  assert.strictEqual(asComment.code, 1, 'the same text as a comment is too long');
  const r = run('--kind', 'description', file(body));
  assert.strictEqual(r.code, 0, r.out + r.err);
});

test('a payload checks the review body and every inline comment, with their locations', () => {
  const payload = {
    commit_id: 'abc',
    event: 'COMMENT',
    body: '🤖 Two problems block landing.',
    comments: [
      { path: 'a.php', line: 3, side: 'RIGHT', body: '🤖 **IMPORTANT — Wrong default**\n\nSharing turns on for every site.' },
      { path: 'b.php', line: 9, side: 'RIGHT', body: '🤖 Uses `a`, `b` and `c` in `d`.' },
    ],
  };
  const r = run('--payload', file(JSON.stringify(payload), 'json'));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /:comments\[1\] \(b\.php:9\): code-spans: 4 code spans/);
  assert.doesNotMatch(r.out, /comments\[0\]|:body:/);
});

test('a comment without the robot prefix fails, and --no-robot turns the rule off', () => {
  const body = file('Fixed the share check.\n');
  const r = run(body);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /: robot: start the comment with 🤖/);
  const off = run('--no-robot', body);
  assert.strictEqual(off.code, 0, off.out + off.err);
});

test('the robot prefix must lead the text, not sit later in it', () => {
  const r = run(file('Fixed the share check. 🤖\n'));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /: robot: /);
});

test('a hidden marker may come before the robot prefix, but a marker alone does not count', () => {
  assert.strictEqual(run(file('<!-- review sha=abc -->\n🤖 One problem blocks landing.\n')).code, 0);
  const r = run(file('<!-- review sha=abc 🤖 -->\nOne problem blocks landing.\n'));
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /: robot: /);
});

test('a description does not need the robot prefix', () => {
  const r = run('--kind', 'description', file('## What\n\nAdds sharing.\n'));
  assert.strictEqual(r.code, 0, r.out + r.err);
});

test('a payload needs the robot prefix on the review body and on every inline comment', () => {
  const payload = {
    body: 'One problem blocks landing.',
    comments: [
      { path: 'a.php', line: 3, body: '🤖 **IMPORTANT — Wrong default**\n\nSharing turns on for every site.' },
      { path: 'b.php', line: 9, body: '**IMPORTANT — Wrong default**\n\nSharing turns on for every site.' },
    ],
  };
  const path = file(JSON.stringify(payload), 'json');
  const r = run('--payload', path);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /:body: robot: /);
  assert.match(r.out, /:comments\[1\] \(b\.php:9\): robot: /);
  assert.doesNotMatch(r.out, /comments\[0\]/);
  assert.strictEqual(run('--payload', path, '--no-robot').code, 0);
});

test('usage and read errors exit 2', () => {
  assert.strictEqual(run().code, 2);
  assert.strictEqual(run('--kind', 'essay', file('x')).code, 2);
  assert.strictEqual(run(join(BOX, 'missing.md')).code, 2);
  assert.strictEqual(run('--payload', file('not json', 'json')).code, 2);
  assert.strictEqual(run('--payload', file('{"comments": [{}]}', 'json')).code, 2);
  assert.strictEqual(run('--payload', file('{}', 'json')).code, 2);
});
