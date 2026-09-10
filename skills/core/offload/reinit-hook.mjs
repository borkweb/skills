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

let context = `[offload] Handoff CLI is \`node "${CLI}"\`. Available for an explicitly active external offload workflow; do not resolve a handoff during unrelated tasks. Load the offload skill for runtime and ownership rules.`;
if (files.length) {
  context += `\n${files.length} saved offload handoff(s) for this project. Resume only the intended run after verifying its owner is no longer active; this notice does not authorize takeover.\n`;
  for (const [i, f] of files.entries()) {
    context += `  [${i + 1}] ${tokenOf(f)} ${JSON.stringify(field(f, 'title'))} — owner ${JSON.stringify(field(f, 'claude_session') || 'unknown')}, ${field(f, 'status')} · ${age(f)} old\n`;
  }
}

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
})}\n`);
process.exit(0);
