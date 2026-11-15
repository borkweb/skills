#!/usr/bin/env node
// Claude Stop hook for a dispatched builder: run the frozen local gates of $OFFLOAD_HANDOFF, the same
// check `handoff.mjs ready` runs (handoff.mjs stopGateCheck), and send the builder back when one is red.
// dispatch.sh wires it as `node stop-gates.mjs; <exit 2 stays 2>; touch <doc>.turn-ended`, so the
// architect's wake-up marker is touched only on a stop that goes through, and only after the gates ran.
//
// Exit 2 with the `red:` message on stderr is the ONE blocking path. Everything else exits 0: no
// handoff, no doc, unreadable or empty stdin, `stop_hook_active` (the builder already got one forced
// continuation for this stop, so a gate the builder cannot fix never loops), a doc that is not at
// `dispatched` or `results-ready`, no local gate, green gates and any crash of the check itself. A
// hook that dies must never block a builder. The message never carries the phrase Claude Code reads
// as a missing hook file (an exit 2 whose stderr says it is a non-blocking error).
import { readFileSync, writeSync } from 'node:fs';
import { stopGateCheck } from './handoff.mjs';

try {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  if (!input || typeof input !== 'object' || input.stop_hook_active) process.exit(0);
  const message = await stopGateCheck(process.env.OFFLOAD_HANDOFF);
  if (message) {
    writeSync(2, `${message.replace(/No such file or directory/gi, 'file not found')}\n`);
    process.exit(2);
  }
} catch { /* a failed check lets the stop through */ }
process.exit(0);
