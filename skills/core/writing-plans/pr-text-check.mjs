#!/usr/bin/env node
// pr-text-check.mjs — check PR text against pr-comments.md before it is posted.
//
//   node pr-text-check.mjs [--kind comment|description] [--allow <word>]... <body.md>
//   node pr-text-check.mjs --payload <review.json> [--allow <word>]...
//
// A payload is a pull request review body as `gh api .../reviews --input` takes it: `body` and
// `comments[].body` are each checked as a comment.
//
// The visible text is the body without HTML comments, fenced code blocks (suggestion blocks included) and
// <details> blocks. In a description, a section whose heading names testing is not visible text either,
// because its steps must stay visible and often hold commands. Rules:
//   process      anywhere outside HTML comments and fences: no skill, model, harness, process word or local path
//   details      every <details> is closed and every </summary> is followed by a blank line
//   length       visible words <= 120 (comment) or 300 (description)
//   sentences    <= 3 sentences in a visible paragraph or list item (a bold lead-in does not count)
//   code-spans   <= 2 code spans in a visible paragraph or list item
//   test-results no test counts or lint results in visible text
// --allow <word> lets a process match that contains <word> pass, for a PR that is about that word.
//
// Exit 0 when every body passes, 1 when a rule fails (one line per failure on stdout), 2 on a usage or
// read error. Node builtins only, no package.json.
import { readFileSync } from 'node:fs';

const WORD_LIMIT = { comment: 120, description: 300 };
const MAX_SENTENCES = 3;
const MAX_CODE_SPANS = 2;

const PROCESS = [
  ['a skill name', /\bbork:[a-z][a-z-]*/gi],
  ['a slash command', /(?:^|[\s(])\/(?:pr-review|review|do|complete|offload|layman|humanize|red-pen|desk|code-review)\b/gm],
  ['a harness name', /\bClaude Code\b/g],
  ['a harness name', /\bCodex\b/g],
  ['a session link', /claude\.ai\/code/gi],
  ['an attribution trailer', /co-authored-by:/gi],
  ['an attribution line', /generated (?:with|by) (?:claude|codex|ai)\b/gi],
  ['a process word', /\b(?:peer|review|fix|second) (?:pass|round)\b/gi],
  ['a process word', /\bboth reviewers\b/gi],
  ['a process word', /\bflagged independently\b/gi],
  ['a process word', /\bautomated review\b/gi],
  ['a process word', /\bthis sweep\b/gi],
  ['a local tool', /\bherdr\b/gi],
  ['a local file', /\bscratchpad\b/gi],
  ['a local checkout', /\bworktrees?\b/gi],
  ['a local path', /(?:\/Users\/|\/private\/tmp\/|~\/\.claude\b|~\/\.codex\b|~\/\.borkweb-skills\b)/g],
];

const TEST_COUNT = /\b\d+\s*\/\s*\d+\b/;
const TEST_WORD = /\b(?:tests?|pass(?:es|ed|ing)?|assertions?|green)\b/i;
const LINT_RESULT = /\b(?:PHPCS|PHPStan|ESLint|Stylelint|tsc|lint|linter)\b[^.\n]*\b(?:clean|pass(?:es|ed)?|green)\b/i;

function usage(msg) {
  process.stderr.write(`pr-text-check: ${msg}\n`);
  process.stderr.write('usage: pr-text-check.mjs [--kind comment|description] [--allow <word>]... <body.md>\n');
  process.stderr.write('       pr-text-check.mjs --payload <review.json> [--allow <word>]...\n');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { kind: 'comment', allow: [], payload: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind' || a === '--allow' || a === '--payload') {
      const v = argv[++i];
      if (v === undefined || v === '') usage(`${a} needs a value`);
      if (a === '--kind') {
        if (!(v in WORD_LIMIT)) usage(`unknown kind '${v}'`);
        opts.kind = v;
      } else if (a === '--allow') opts.allow.push(v.toLowerCase());
      else opts.payload = v;
    } else if (a.startsWith('--')) usage(`unknown option '${a}'`);
    else if (opts.file === null) opts.file = a;
    else usage('give one body file');
  }
  if (opts.payload !== null && opts.file !== null) usage('give a body file or --payload, not both');
  if (opts.payload === null && opts.file === null) usage('give a body file or --payload');
  return opts;
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`pr-text-check: cannot read ${path}: ${err.code || err.message}\n`);
    process.exit(2);
  }
}

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripFences = (s) => s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');

function stripDetails(s) {
  const inner = /<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/gi;
  let prev;
  do {
    prev = s;
    s = s.replace(inner, '');
  } while (s !== prev);
  return s;
}

// Drop each section whose heading names testing, up to the next heading of the same or a higher level.
function stripTestingSections(s) {
  const out = [];
  let skipLevel = 0;
  for (const line of s.split('\n')) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && /\btest/i.test(h[2])) {
        skipLevel = level;
        continue;
      }
    }
    if (!skipLevel) out.push(line);
  }
  return out.join('\n');
}

// Paragraphs and list items; headings are skipped.
function blocks(s) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) out.push(cur.join(' ').trim());
    cur = [];
  };
  for (const line of s.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) flush();
    cur.push(line.trim());
  }
  flush();
  return out.filter(Boolean);
}

const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])+?\1/g;

function sentenceCount(block) {
  const text = block
    .replace(CODE_SPAN, 'X')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/\b(?:e\.g|i\.e|etc|vs|cf)\./gi, 'abbr')
    .replace(/\.{2,}/g, ' ')
    // A bold lead-in such as "**Broken accounts.**" is a title, not a sentence.
    .replace(/^(?:[-*+]|\d+[.)])?\s*\*\*[^*]+\*\*/, '');
  return (text.match(/[.!?](?=["')\]*_]*(?:\s|$))/g) || []).length;
}

const snippet = (block) => {
  const one = block.replace(/\s+/g, ' ');
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
};

function check(body, kind, allow) {
  const problems = [];
  const noComments = stripComments(body);
  const outsideFences = stripFences(noComments);

  for (const [what, re] of PROCESS) {
    for (const m of outsideFences.matchAll(re)) {
      const hit = m[0].trim();
      if (allow.some((w) => hit.toLowerCase().includes(w))) continue;
      problems.push(['process', `remove ${what} ("${hit}"); talk about the work only`]);
    }
  }

  const opens = (outsideFences.match(/<details\b[^>]*>/gi) || []).length;
  const closes = (outsideFences.match(/<\/details>/gi) || []).length;
  if (opens !== closes) problems.push(['details', `${opens} <details> but ${closes} </details>; close every block`]);
  if (/<\/summary>[ \t]*\n(?![ \t]*\n)/i.test(outsideFences) || /<\/summary>[ \t]*\S/i.test(outsideFences)) {
    problems.push(['details', 'put a blank line after </summary>, or GitHub does not render the Markdown inside']);
  }

  let visible = stripDetails(outsideFences);
  if (kind === 'description') visible = stripTestingSections(visible);

  const words = (visible.replace(/<[^>]+>/g, ' ').match(/\S+/g) || []).filter((t) => /[A-Za-z0-9]/.test(t)).length;
  if (words > WORD_LIMIT[kind]) {
    problems.push(['length', `${words} visible words, limit ${WORD_LIMIT[kind]}; move depth into a Details block`]);
  }

  for (const block of blocks(visible)) {
    const n = sentenceCount(block);
    if (n > MAX_SENTENCES) {
      problems.push(['sentences', `${n} sentences, limit ${MAX_SENTENCES}: "${snippet(block)}"`]);
    }
    const spans = (block.match(CODE_SPAN) || []).length;
    if (spans > MAX_CODE_SPANS) {
      problems.push(['code-spans', `${spans} code spans, limit ${MAX_CODE_SPANS}; say what a person notices and move identifiers to Details: "${snippet(block)}"`]);
    }
    const plain = block.replace(CODE_SPAN, 'X');
    if ((TEST_COUNT.test(plain) && TEST_WORD.test(plain)) || LINT_RESULT.test(plain)) {
      problems.push(['test-results', `move test counts and lint results to Details: "${snippet(block)}"`]);
    }
  }
  return problems;
}

const opts = parseArgs(process.argv.slice(2));
const targets = [];
if (opts.payload !== null) {
  let data;
  try {
    data = JSON.parse(read(opts.payload));
  } catch (err) {
    usage(`${opts.payload} is not JSON: ${err.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) usage(`${opts.payload} is not a review payload object`);
  if (typeof data.body === 'string' && data.body.trim()) targets.push([`${opts.payload}:body`, data.body, 'comment']);
  if (data.comments !== undefined && !Array.isArray(data.comments)) usage(`${opts.payload}: comments must be an array`);
  (data.comments || []).forEach((c, i) => {
    if (!c || typeof c.body !== 'string') usage(`${opts.payload}: comments[${i}] has no string body`);
    const where = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : '';
    targets.push([`${opts.payload}:comments[${i}]${where}`, c.body, 'comment']);
  });
  if (!targets.length) usage(`${opts.payload} has no body and no comments`);
} else {
  targets.push([opts.file, read(opts.file), opts.kind]);
}

let failed = 0;
for (const [label, body, kind] of targets) {
  for (const [rule, msg] of check(body.replace(/\r\n?/g, '\n'), kind, opts.allow)) {
    process.stdout.write(`${label}: ${rule}: ${msg}\n`);
    failed++;
  }
}
if (failed) process.exit(1);
process.stdout.write(`pr-text-check: ok (${targets.length} ${targets.length === 1 ? 'body' : 'bodies'})\n`);
