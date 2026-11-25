import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

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

// The hook throttles by session, so some checks build on earlier fires. A step
// runs once and keeps its result or error; a test calls the steps it needs, so
// it also passes when run alone.
const once = (step) => {
  let ran;
  return () => {
    if (!ran) {
      try { ran = { value: step() }; } catch (error) { ran = { error }; }
    }
    if (ran.error) throw ran.error;
    return ran.value;
  };
};

// below threshold -> silent
test('below threshold: no output', () => {
  const small = transcriptOf('small.jsonl', 100_000);
  assert.strictEqual(fire({ session_id: 's1', transcript_path: small }).trim(), '');
});

// above threshold, first fire -> nudge
const big = join(BOX, 'big.jsonl');
const firstNudge = once(() => {
  transcriptOf('big.jsonl', THRESHOLD + 10_000);
  return fire({ session_id: 's2', transcript_path: big });
});
test('above threshold: emits a proactive nudge', () => {
  const out = firstNudge();
  assert.match(out, /PROACTIVE/);
});
test('nudge is UserPromptSubmit additionalContext', () => {
  const j = JSON.parse(firstNudge());
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(j.hookSpecificOutput.additionalContext, /session-budget/);
});

// same band, second fire -> throttled silent
const throttled = once(() => {
  firstNudge();
  assert.strictEqual(fire({ session_id: 's2', transcript_path: big }).trim(), '');
});
test('same band: throttled (no repeat)', throttled);

// higher band -> fires again
test('higher band: nudges again', () => {
  throttled();
  const bigger = transcriptOf('big.jsonl', THRESHOLD + BAND + 10_000); // overwrite, larger
  assert.match(fire({ session_id: 's2', transcript_path: bigger }).trim(), /PROACTIVE/);
});

// Code Mode background output -> silent, and the band stays unused for the next real turn
const pollBig = join(BOX, 'poll.jsonl');
const polled = once(() => {
  transcriptOf('poll.jsonl', THRESHOLD + 10_000);
  assert.strictEqual(fire({ session_id: 's4', transcript_path: pollBig, source: 'poll_event' }).trim(), '');
});
test('poll_event (Code Mode output): no output', polled);
test('poll_event does not use up the band', () => {
  polled();
  assert.match(fire({ session_id: 's4', transcript_path: pollBig, source: 'user' }).trim(), /PROACTIVE/);
});

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
test('large transcript, small last usage (just compacted): no output', () => {
  const compacted = withUsage('compacted.jsonl', THRESHOLD * 2, usageLine(190_000), usageLine(40_000));
  assert.strictEqual(fire({ session_id: 't1', transcript_path: compacted }).trim(), '');
});
const heavy = join(BOX, 'heavy.jsonl');
const heavyNudge = once(() => {
  withUsage('heavy.jsonl', 1000, usageLine(160_000));
  return fire({ session_id: 't2', transcript_path: heavy });
});
test('small transcript, heavy last usage: nudges and reports tokens', () => {
  const heavyOut = heavyNudge();
  assert.match(heavyOut, /PROACTIVE/);
  assert.match(heavyOut, /~160k tokens/);
});
const sameTokenBand = once(() => {
  heavyNudge();
  assert.strictEqual(fire({ session_id: 't2', transcript_path: heavy }).trim(), '');
});
test('same token band: throttled', sameTokenBand);
const higherTokenBand = once(() => {
  sameTokenBand();
  assert.match(fire({ session_id: 't2', transcript_path: withUsage('heavy.jsonl', 1000, usageLine(205_000)) }), /~205k tokens/);
});
test('higher token band: nudges again', higherTokenBand);
test('after a compaction the same band nudges again', () => {
  higherTokenBand();
  assert.strictEqual(fire({ session_id: 't2', transcript_path: withUsage('heavy.jsonl', 1000, usageLine(30_000)) }).trim(), '');
  assert.match(fire({ session_id: 't2', transcript_path: withUsage('heavy.jsonl', 1000, usageLine(160_000)) }), /PROACTIVE/);
});
test('subagent usage is ignored', () => {
  const side = withUsage('side.jsonl', 1000, usageLine(40_000), usageLine(300_000, { isSidechain: true }));
  assert.strictEqual(fire({ session_id: 't3', transcript_path: side }).trim(), '');
});
test('a byte-unit state does not silence a token nudge', () => {
  withUsage('heavy.jsonl', 1000, usageLine(160_000));
  writeFileSync(join(BOX, '.budget-hook-t4.state'), '9');
  assert.match(fire({ session_id: 't4', transcript_path: heavy }), /PROACTIVE/);
});

// missing transcript -> silent
test('missing transcript_path: no output', () =>
  assert.strictEqual(fire({ session_id: 's3' }).trim(), ''));
