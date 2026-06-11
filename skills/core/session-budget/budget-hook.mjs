#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: when the session transcript grows past a
// (tunable) threshold, inject a one-shot instruction asking the agent to run the
// session-budget skill in proactive mode. Throttled to once per growth band so it
// doesn't nag. Silent (no output) below threshold or when already nudged this band.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const DIR = process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs');
const THRESHOLD = Number(process.env.BUDGET_HOOK_THRESHOLD_BYTES) || 1_500_000;
const BAND = Number(process.env.BUDGET_HOOK_BAND_BYTES) || 750_000;

function silent() { process.exit(0); }

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { silent(); }

const transcript = input.transcript_path;
if (!transcript || !existsSync(transcript)) silent();

let size = 0;
try { size = statSync(transcript).size; } catch { silent(); }
if (size < THRESHOLD) silent();

const band = Math.floor(size / BAND);
const sessionId = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
const stateFile = join(DIR, `.budget-hook-${sessionId}.state`);

let lastBand = -1;
if (existsSync(stateFile)) {
  const v = Number(readFileSync(stateFile, 'utf8').trim());
  if (Number.isFinite(v)) lastBand = v;
}
if (band <= lastBand) silent(); // already nudged for this band

mkdirSync(DIR, { recursive: true });
writeFileSync(stateFile, String(band));

const mb = (size / 1_000_000).toFixed(1);
const context =
  `[session-budget] This session's transcript is ~${mb} MB and context may be getting heavy. ` +
  `Run the session-budget skill in PROACTIVE mode now: assess context composition and act ONLY if the ` +
  `verdict is COMPACT or CLEAR. If the verdict is NOT YET, do nothing and do not mention this check. ` +
  `If action is warranted, apply the skill's handoff-worth gate: pre-stage the reinit-ready handoff only ` +
  `if it would carry state the next session cannot recover from disk/git; otherwise just tell the user ` +
  `the verdict and that no handoff is needed. Either way, the user runs /clear or /compact themselves.`;

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
})}\n`);
process.exit(0);
