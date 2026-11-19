#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: when the session's context grows past a
// (tunable) threshold, inject a one-shot instruction asking the agent to run the
// session-budget skill in proactive mode. Throttled to once per growth band so it
// doesn't nag. Silent (no output) below threshold or when already nudged this band.
//
// The measure is the context the last main-thread turn was billed for (input +
// cache read + cache creation tokens in the transcript's last usage record). The
// transcript file keeps growing after a compaction, so its size says nothing about
// a session that was just compacted; bytes are the fallback only when the tail of
// the transcript holds no usage record.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';

const DIR = process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs');
const THRESHOLD = Number(process.env.BUDGET_HOOK_THRESHOLD_BYTES) || 1_500_000;
const BAND = Number(process.env.BUDGET_HOOK_BAND_BYTES) || 750_000;
const TOKEN_THRESHOLD = Number(process.env.BUDGET_HOOK_THRESHOLD_TOKENS) || 150_000;
const TOKEN_BAND = Number(process.env.BUDGET_HOOK_BAND_TOKENS) || 50_000;
const TAIL_BYTES = 512_000;

function silent() { process.exit(0); }

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { silent(); }
// Code Mode runs this hook on background code output too (source "poll_event").
// Nudge only on a real turn, so code output never uses up a band.
if (input.source === 'poll_event') silent();

const transcript = input.transcript_path;
if (!transcript || !existsSync(transcript)) silent();

let size = 0;
try { size = statSync(transcript).size; } catch { silent(); }

// Context tokens of the last main-thread assistant turn, or null when the tail has
// none. Subagent turns (isSidechain) are billed against their own context.
function lastContextTokens(path, fileSize) {
  let text = '';
  try {
    const len = Math.min(fileSize, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, fileSize - len); } finally { closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"usage"')) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; } // the first tail line is usually cut
    const u = row?.message?.usage;
    if (!u || row.isSidechain) continue;
    const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (n > 0) return n;
  }
  return null;
}

const tokens = lastContextTokens(transcript, size);
const byTokens = tokens !== null;
const measure = byTokens ? tokens : size;
const sessionId = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
const stateFile = join(DIR, `.budget-hook-${sessionId}.state`);
if (measure < (byTokens ? TOKEN_THRESHOLD : THRESHOLD)) {
  // Context fell back under the threshold (a compaction): forget the bands already
  // nudged, so the session is told again when it refills.
  if (byTokens && existsSync(stateFile)) { try { writeFileSync(stateFile, 't:0'); } catch { /* best effort */ } }
  silent();
}

const band = Math.floor(measure / (byTokens ? TOKEN_BAND : BAND));

// State is "<unit>:<band>". A state in the other unit (or the old bare number) does not count.
const unit = byTokens ? 't' : 'b';
let lastBand = -1;
if (existsSync(stateFile)) {
  const [u, v] = readFileSync(stateFile, 'utf8').trim().split(':');
  if (u === unit && Number.isFinite(Number(v))) lastBand = Number(v);
}
if (band <= lastBand) silent(); // already nudged for this band

mkdirSync(DIR, { recursive: true });
writeFileSync(stateFile, `${unit}:${band}`);

const amount = byTokens
  ? `context is ~${Math.round(tokens / 1000)}k tokens`
  : `transcript is ~${(size / 1_000_000).toFixed(1)} MB`;
const context =
  `[session-budget] This session's ${amount} and context may be getting heavy. ` +
  `Run the session-budget skill in PROACTIVE mode now: assess context composition and act ONLY if the ` +
  `verdict is COMPACT or CLEAR. If the verdict is NOT YET, do nothing and do not mention this check. ` +
  `If action is warranted, apply the skill's handoff-worth gate: pre-stage the reinit-ready handoff only ` +
  `if it would carry state the next session cannot recover from disk/git; otherwise just tell the user ` +
  `the verdict and that no handoff is needed. Either way, the user runs /clear or /compact themselves.`;

// writeSync, not process.stdout.write: a pipe write is async on macOS and the process.exit below would drop a payload over the pipe buffer.
writeSync(1, `${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
})}\n`);
process.exit(0);
