#!/usr/bin/env node
// Skill usage log.
//
// As a hook (no arguments, hook JSON on stdin), it appends one line per skill
// invocation to <AGENT_HANDOFFS_DIR>/usage/skills.jsonl:
//   PreToolUse, matcher Skill -> {ts, via:"tool", skill, session, cwd[, agent]}
//   UserPromptSubmit          -> {ts, via:"slash", skill, session, cwd} when the
//                                prompt starts with a slash command
// It records the skill or command name only, never arguments or prompt text.
// It never blocks, never writes to stdout and exits 0 on every error.
// BORK_SKILL_USAGE_LOG=0 turns logging off.
//
// As a report (`node skill-usage.mjs report [--since YYYY-MM-DD] [--json]`),
// it counts invocations per skill and lists this plugin's skills and commands
// that have no invocation in the window.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeSync } from 'node:fs';

const DIR = process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs');
const USAGE_DIR = join(DIR, 'usage');
const LOG = join(USAGE_DIR, 'skills.jsonl');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'bork';
const RELOAD_WINDOW_MS = 120_000;

// A slash command token: /name or /plugin:name, ending at whitespace or the end.
// A path such as /Users/me/x does not match, because the token ends at the second slash.
const SLASH = /^\/([A-Za-z0-9_-]+(?::[A-Za-z0-9_.-]+)?)(?=\s|$)/;
// The expanded form Claude Code writes for a typed slash command.
const COMMAND_TAG = /<command-name>\/?([A-Za-z0-9_-]+(?::[A-Za-z0-9_.-]+)?)<\/command-name>/;
const SAFE = /[^A-Za-z0-9_.:-]/g;

function clean(value, max = 200) {
  return String(value ?? '').replace(SAFE, '_').slice(0, max);
}

function slashName(prompt) {
  if (typeof prompt !== 'string') return null;
  const text = prompt.trimStart();
  const m = SLASH.exec(text) || COMMAND_TAG.exec(text.slice(0, 2000));
  return m ? m[1] : null;
}

function record(input) {
  const event = input.hook_event_name;
  let via;
  let skill;
  if (event === 'PreToolUse') {
    if (input.tool_name !== 'Skill') return;
    via = 'tool';
    skill = input.tool_input?.skill ?? input.tool_input?.command ?? input.tool_input?.name;
  } else if (event === 'UserPromptSubmit') {
    via = 'slash';
    skill = slashName(input.prompt);
  } else {
    return;
  }
  if (!skill) return;

  const line = { ts: new Date().toISOString(), via, skill: clean(skill), session: clean(input.session_id || 'unknown', 80) };
  if (typeof input.cwd === 'string') line.cwd = input.cwd;
  const agent = input.agent_type || input.agent_id;
  if (agent) line.agent = clean(agent, 80);

  if (!existsSync(USAGE_DIR)) {
    mkdirSync(USAGE_DIR, { recursive: true, mode: 0o700 });
    chmodSync(USAGE_DIR, 0o700);
  }
  // One write with O_APPEND per line, so concurrent sessions do not interleave lines.
  appendFileSync(LOG, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

function frontmatterName(file) {
  try {
    const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'));
    const name = m && /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(m[1]);
    return name ? name[1] : null;
  } catch {
    return null;
  }
}

// Every name this plugin exposes, from the Claude manifest and the commands directory.
function pluginNames() {
  const names = new Map(); // name -> kind
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    for (const rel of manifest.skills || []) {
      const name = frontmatterName(join(ROOT, rel, 'SKILL.md'));
      if (name) names.set(name, 'skill');
    }
  } catch {}
  try {
    for (const f of readdirSync(join(ROOT, 'commands'))) {
      if (f.endsWith('.md')) names.set(f.slice(0, -3), 'command');
    }
  } catch {}
  return names;
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function report(argv) {
  const since = arg(argv, '--since');
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    process.stderr.write('--since takes a date as YYYY-MM-DD\n');
    process.exit(2);
  }
  const names = pluginNames();
  const counts = new Map();
  let total = 0;
  let bad = 0;
  let first = null;
  let last = null;
  const text = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const entries = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let e;
    try { e = JSON.parse(raw); } catch { bad++; continue; }
    if (!e.skill || !e.ts || Number.isNaN(Date.parse(e.ts))) { bad++; continue; }
    if (since && e.ts.slice(0, 10) < since) continue;
    entries.push(e);
  }
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const lastSlash = new Map(); // session + skill -> ms of the latest slash invocation
  for (const e of entries) {
    // An unprefixed slash name that this plugin owns counts as the prefixed name.
    const key = !e.skill.includes(':') && e.via === 'slash' && names.has(e.skill) ? `${PLUGIN}:${e.skill}` : e.skill;
    const c = counts.get(key) || { skill: key, tool: 0, slash: 0, reload: 0, sessions: new Set(), last: '' };
    const pair = `${e.session}\u0000${key}`;
    const ms = Date.parse(e.ts);
    if (e.via === 'slash') {
      c.slash++;
      lastSlash.set(pair, ms);
    } else if (lastSlash.has(pair) && ms - lastSlash.get(pair) <= RELOAD_WINDOW_MS) {
      // A typed slash command already loaded this skill or command; the model then
      // called the Skill tool for it again. That is one use plus a redundant reload.
      c.reload++;
      lastSlash.delete(pair);
      counts.set(key, c);
      continue;
    } else {
      c.tool++;
    }
    c.sessions.add(e.session);
    if (e.ts > c.last) c.last = e.ts;
    counts.set(key, c);
    total++;
    if (!first || e.ts < first) first = e.ts;
    if (!last || e.ts > last) last = e.ts;
  }

  const rows = [...counts.values()]
    .map((c) => ({ skill: c.skill, total: c.tool + c.slash, tool: c.tool, slash: c.slash, reload: c.reload, sessions: c.sessions.size, last: c.last }))
    .sort((a, b) => b.total - a.total || a.skill.localeCompare(b.skill));
  const unused = [...names]
    .filter(([name]) => !counts.has(`${PLUGIN}:${name}`))
    .map(([name, kind]) => ({ name: `${PLUGIN}:${name}`, kind }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const result = { log: LOG, since: since || null, first, last, total, unreadable_lines: bad, skills: rows, unused };
  if (argv.includes('--json')) {
    writeSync(1, `${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const out = [];
  out.push(`Skill usage: ${total} invocations${since ? ` since ${since}` : ''} (${first ? `${first.slice(0, 10)} to ${last.slice(0, 10)}` : 'no entries'})`);
  out.push(`Log: ${LOG}${bad ? ` (${bad} unreadable lines skipped)` : ''}`);
  out.push('');
  if (rows.length) {
    const w = Math.max(5, ...rows.map((r) => r.skill.length));
    out.push(`${'skill'.padEnd(w)}  total  tool  slash  reload  sessions  last`);
    for (const r of rows) {
      out.push(`${r.skill.padEnd(w)}  ${String(r.total).padStart(5)}  ${String(r.tool).padStart(4)}  ${String(r.slash).padStart(5)}  ${String(r.reload).padStart(6)}  ${String(r.sessions).padStart(8)}  ${r.last.slice(0, 10)}`);
    }
  } else {
    out.push('No invocations recorded.');
  }
  out.push('');
  out.push(`${PLUGIN} skills and commands with no invocation in this window: ${unused.length ? unused.map((u) => u.name).join(', ') : 'none'}`);
  out.push('"tool" counts Skill tool calls (model or subagent). "slash" counts prompts that start with a slash command.');
  out.push(`"reload" counts Skill tool calls made within ${RELOAD_WINDOW_MS / 1000}s after a slash command already loaded the same name in the same session. They are not in "total".`);
  writeSync(1, `${out.join('\n')}\n`);
}

const argv = process.argv.slice(2);
if (argv[0] === 'report') {
  report(argv.slice(1));
  process.exit(0);
}

if (process.env.BORK_SKILL_USAGE_LOG === '0') process.exit(0);
try {
  record(JSON.parse(readFileSync(0, 'utf8')));
} catch {
  // A usage log must never block or disturb the session.
}
process.exit(0);
