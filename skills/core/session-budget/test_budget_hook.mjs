import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'budget-hook.mjs');
const NODE = process.execPath;
const BOX = mkdtempSync(join(tmpdir(), 'bh-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

const THRESHOLD = 1_500_000;
const BAND = 750_000;

const transcriptOf = (name, bytes) => {
  const p = join(BOX, name);
  writeFileSync(p, Buffer.alloc(bytes, 'x'));
  return p;
};

const fire = (payload) =>
  execFileSync(NODE, [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, AGENT_HANDOFFS_DIR: BOX },
    encoding: 'utf8',
  });

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (e) { failed = 1; console.log(`FAIL - ${name}\n       ${e.message}`); }
};

// below threshold -> silent
const small = transcriptOf('small.jsonl', 100_000);
check('below threshold: no output', () =>
  assert.strictEqual(fire({ session_id: 's1', transcript_path: small }).trim(), ''));

// above threshold, first fire -> nudge
const big = transcriptOf('big.jsonl', THRESHOLD + 10_000);
const out = fire({ session_id: 's2', transcript_path: big });
check('above threshold: emits a proactive nudge', () => assert.match(out, /PROACTIVE/));
check('nudge is UserPromptSubmit additionalContext', () => {
  const j = JSON.parse(out);
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(j.hookSpecificOutput.additionalContext, /session-budget/);
});

// same band, second fire -> throttled silent
check('same band: throttled (no repeat)', () =>
  assert.strictEqual(fire({ session_id: 's2', transcript_path: big }).trim(), ''));

// higher band -> fires again
const bigger = transcriptOf('big.jsonl', THRESHOLD + BAND + 10_000); // overwrite, larger
check('higher band: nudges again', () =>
  assert.match(fire({ session_id: 's2', transcript_path: bigger }).trim(), /PROACTIVE/));

// Code Mode background output -> silent, and the band stays unused for the next real turn
const pollBig = transcriptOf('poll.jsonl', THRESHOLD + 10_000);
check('poll_event (Code Mode output): no output', () =>
  assert.strictEqual(fire({ session_id: 's4', transcript_path: pollBig, source: 'poll_event' }).trim(), ''));
check('poll_event does not use up the band', () =>
  assert.match(fire({ session_id: 's4', transcript_path: pollBig, source: 'user' }).trim(), /PROACTIVE/));

// A transcript with usage records is measured in context tokens, not bytes.
const usageLine = (tokens, extra = {}) => JSON.stringify({
  type: 'assistant', ...extra,
  message: { usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2 - 1000, cache_creation_input_tokens: 1000, output_tokens: 50 } },
});
const withUsage = (name, padBytes, ...lines) => {
  const p = join(BOX, name);
  writeFileSync(p, `${'x'.repeat(padBytes)}\n${lines.join('\n')}\n`);
  return p;
};
// A huge file whose last turn is small is a session that was just compacted.
const compacted = withUsage('compacted.jsonl', THRESHOLD * 2, usageLine(190_000), usageLine(40_000));
check('large transcript, small last usage (just compacted): no output', () =>
  assert.strictEqual(fire({ session_id: 't1', transcript_path: compacted }).trim(), ''));
const heavy = withUsage('heavy.jsonl', 1000, usageLine(160_000));
const heavyOut = fire({ session_id: 't2', transcript_path: heavy });
check('small transcript, heavy last usage: nudges and reports tokens', () => {
  assert.match(heavyOut, /PROACTIVE/);
  assert.match(heavyOut, /~160k tokens/);
});
check('same token band: throttled', () =>
  assert.strictEqual(fire({ session_id: 't2', transcript_path: heavy }).trim(), ''));
check('higher token band: nudges again', () =>
  assert.match(fire({ session_id: 't2', transcript_path: withUsage('heavy.jsonl', 1000, usageLine(205_000)) }), /~205k tokens/));
check('after a compaction the same band nudges again', () => {
  assert.strictEqual(fire({ session_id: 't2', transcript_path: withUsage('heavy.jsonl', 1000, usageLine(30_000)) }).trim(), '');
  assert.match(fire({ session_id: 't2', transcript_path: withUsage('heavy.jsonl', 1000, usageLine(160_000)) }), /PROACTIVE/);
});
check('subagent usage is ignored', () => {
  const side = withUsage('side.jsonl', 1000, usageLine(40_000), usageLine(300_000, { isSidechain: true }));
  assert.strictEqual(fire({ session_id: 't3', transcript_path: side }).trim(), '');
});
check('a byte-unit state does not silence a token nudge', () => {
  writeFileSync(join(BOX, '.budget-hook-t4.state'), '9');
  assert.match(fire({ session_id: 't4', transcript_path: heavy }), /PROACTIVE/);
});

// missing transcript -> silent
check('missing transcript_path: no output', () =>
  assert.strictEqual(fire({ session_id: 's3' }).trim(), ''));

process.exit(failed);
