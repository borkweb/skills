#!/usr/bin/env node
// SessionStart plugin hook for /offload. Non-consuming: surfaces persistent
// offload handoffs for this cwd so a fresh/cleared session can reattach.
// No saved work means no context; helper paths are resolved when the skill loads.
import { readFileSync } from 'node:fs';
import { listFiles, field, age, tokenOf, prune } from './dir.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid stdin */ }
const cwd = input.cwd || process.cwd();

prune();
const files = listFiles(cwd);
if (!files.length) process.exit(0);

let context = `[offload] ${files.length} saved offload handoff(s) for this project. Load the offload skill if resuming an external workflow. Resume only the intended run after verifying its owner is no longer active; this notice does not authorize takeover.\n`;
for (const [i, f] of files.entries()) {
  context += `  [${i + 1}] ${tokenOf(f)} ${JSON.stringify(field(f, 'title'))} — owner ${JSON.stringify(field(f, 'claude_session') || 'unknown')}, ${field(f, 'status')} · ${age(f)} old\n`;
}

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
})}\n`);
process.exit(0);
