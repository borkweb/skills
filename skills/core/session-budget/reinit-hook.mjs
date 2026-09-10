#!/usr/bin/env node
// SessionStart plugin hook. Zero-config: ships with the plugin and runs on every
// session start (startup|resume|clear|compact). If a handoff is pending for this cwd
// it injects it: single -> load + consume,
// multiple -> a pick menu. Reuses mailbox.mjs helpers (no duplicated logic).
import { readFileSync } from 'node:fs';
import { listFiles, field, age, tokenOf, consumeFile, prune } from './mailbox.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid stdin */ }
const cwd = input.cwd || process.cwd();

prune();
const files = listFiles(cwd);
if (!files.length) process.exit(0);

let context = '[session-budget]';

let toConsume = null; // consume AFTER emitting the injection, so a crash can't lose the handoff
if (files.length === 1) {
  const f = files[0];
  const body = readFileSync(f, 'utf8').replace(/\n*$/, '');
  toConsume = f; // consume-once
  context +=
    `\n\nA handoff from your previous session for this project was found and auto-loaded ` +
    `(now consumed). Treat it as your briefing:\n\n${body}`;
} else if (files.length > 1) {
  context +=
    `\n\n${files.length} handoffs are pending for this project. Ask the user which to load, then ` +
    `load the session-budget skill to locate the current mailbox helper. Use \`show <token>\` ` +
    `to read the selected handoff and \`consume <token>\` to clear it after reading:\n`;
  for (const [i, f] of files.entries()) {
    context += `  [${i + 1}] ${tokenOf(f)} "${field(f, 'title')}" — ${field(f, 'goal')} · ${field(f, 'branch')} · ${age(f)} old\n`;
  }
}

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
})}\n`);
if (toConsume) consumeFile(toConsume);
process.exit(0);
