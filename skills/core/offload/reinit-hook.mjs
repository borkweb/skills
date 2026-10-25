#!/usr/bin/env node
// SessionStart plugin hook for /offload. Non-consuming: surfaces persistent
// offload handoffs for this cwd so a fresh/cleared session can reattach.
// No saved work means no context; helper paths are resolved when the skill loads.
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { listFiles, field, age, tokenOf, prune, fileFor } from './dir.mjs';
import { ledgerFor, renderBoard } from './ledger.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid stdin */ }
const cwd = input.cwd || process.cwd();
const session = String(input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '').trim();

prune();
const files = listFiles(cwd);
const ledger = session ? ledgerFor(cwd, session) : '';
const owned = session ? fileFor(cwd, session) : '';
const ownsLedger = ledger && existsSync(ledger);
if (!files.length && !ownsLedger) process.exit(0);

let context = '';
// The session that owns a ledger here is mid-run (this fires on compact and
// resume too). Hand it the board and its own handoff path so the first thing in
// context is reality, not a recollection of which slices were dispatched.
if (ownsLedger) {
  context += '[offload] You own an architect ledger for this project. Progress is read from this board, never from memory.\n';
  if (owned && existsSync(owned)) context += `Your handoff: ${owned}\n`;
  try { context += renderBoard(cwd, session, { withGit: false, withPane: false }); } catch { /* list below still helps */ }
  context += '\n';
}
const others = files.filter((f) => f !== owned);
if (others.length) {
  context += `[offload] ${others.length} saved offload handoff(s) for this project. Load the offload skill if resuming an external workflow. Resume only the intended run after verifying its owner is no longer active; this notice does not authorize takeover.\n`;
  for (const [i, f] of others.entries()) {
    context += `  [${i + 1}] ${tokenOf(f)} ${JSON.stringify(field(f, 'title'))} — owner ${JSON.stringify(field(f, 'architect_session') || field(f, 'claude_session') || 'unknown')}, ${field(f, 'status')} · ${age(f)} old\n`;
  }
}

// writeSync, not process.stdout.write: a pipe write is async on macOS and the process.exit below would drop a payload over the pipe buffer.
writeSync(1, `${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
})}\n`);
process.exit(0);
