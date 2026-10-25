#!/usr/bin/env node
// Stop plugin hook for the architect loop. The prose used to say "write terminal
// states in the same turn you decide them" and "resolve every NO OWNER row
// before your turn ends"; both were skipped often enough that finished slices
// read as running for an hour. This hook makes the harness enforce them: if the
// ledger this session owns holds a slice the architect must act on right now,
// the stop is refused once and the board is handed back as the reason.
//
// Silent (exit 0, no output) when: the session owns no ledger here (builders,
// unrelated work), nothing is owed, the hook already fired for this stop
// (stop_hook_active), or stdin is unreadable. A hook crash must never block a
// user, so every path that is not a deliberate block exits quietly.
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { ledgerFor, renderBoard } from './ledger.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (input.stop_hook_active) process.exit(0);

const cwd = input.cwd || process.cwd();
const session = String(input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '').trim();
if (!session) process.exit(0);

const p = ledgerFor(cwd, session);
if (!existsSync(p)) process.exit(0);

let out;
try {
  out = JSON.parse(renderBoard(cwd, session, { json: true, withGit: false, withPane: false }));
} catch { process.exit(0); }
if (!out || !Array.isArray(out.slices)) process.exit(0);

// Only the flags the architect can clear by itself, this turn: judge reported
// gates, arbitrate a blocked builder, or own a slice nobody is working. A specced
// slice waiting on the user, a vanished doc or an unmanaged pane are reported by
// the board but are not grounds to refuse the stop.
const OWED = /^(NEEDS ARCHITECT|NO OWNER|MISMATCH — ledger says \S+, doc says (results-ready|blocked))/;
const owed = out.slices.filter((s) => !s.terminal && s.flags.some((f) => OWED.test(f)));
if (!owed.length) process.exit(0);

let board = '';
try { board = renderBoard(cwd, session, { withGit: false, withPane: false }); } catch { /* reason without board */ }
const rows = owed.map((s) => `  slice ${s.id} (${s.state}${s.doc?.status ? `, doc ${s.doc.status}` : ''}): ${s.flags.filter((f) => OWED.test(f)).join('; ')}`).join('\n');
const reason =
  `[offload] This session's ledger still owes work on ${owed.length} slice${owed.length === 1 ? '' : 's'}:\n${rows}\n\n` +
  'Before ending the turn: judge reported gates and write the terminal state (ledger set … --state accepted|rejected), ' +
  'arbitrate a blocked builder and resume it, or dispatch a corrective onto a slice with no owner. ' +
  'If a human ruling is genuinely required, say so explicitly and end the turn; this check fires once.\n\n' +
  board;

// writeSync, not process.stdout.write: a pipe write is async on macOS and the process.exit below would drop a payload over the pipe buffer.
writeSync(1, `${JSON.stringify({ decision: 'block', reason })}\n`);
process.exit(0);
