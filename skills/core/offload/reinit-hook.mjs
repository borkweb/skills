#!/usr/bin/env node
// SessionStart plugin hook for /offload. Non-consuming: surfaces persistent
// offload handoffs for this cwd so a fresh/cleared session can reattach. Always
// advertises the handoff CLI path so the skill can drive it with zero install.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, field, age, tokenOf, prune } from './dir.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'handoff.mjs').replace(/\\/g, '/');

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid stdin */ }
const cwd = input.cwd || process.cwd();

prune();
const files = listFiles(cwd);

let context =
  `[offload] Handoff CLI is \`node "${CLI}"\` — subcommands: ` +
  `init|path|list|reattach|status|ready|end. The offload handoff is session-scoped, ` +
  `persistent for the life of the session, and never committed.`;

if (files.length === 1) {
  const f = files[0];
  const body = readFileSync(f, 'utf8').replace(/\n*$/, '');
  context +=
    `\n\nAn offload handoff from a prior session exists for this project. It is NOT ` +
    `consumed — reattach with \`node "${CLI}" reattach "${f}" "$CLAUDE_CODE_SESSION_ID"\` ` +
    `and continue judging/spec'ing. Current state:\n\n${body}`;
} else if (files.length > 1) {
  context +=
    `\n\n${files.length} offload handoffs exist for this project. Ask the user which to ` +
    `reattach, then \`node "${CLI}" reattach <path> "$CLAUDE_CODE_SESSION_ID"\`:\n`;
  for (const [i, f] of files.entries()) {
    context += `  [${i + 1}] ${tokenOf(f)} "${field(f, 'title')}" — ${field(f, 'status')} · ${field(f, 'branch')} · ${age(f)} old\n`;
  }
}

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
})}\n`);
process.exit(0);
