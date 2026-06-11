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

// missing transcript -> silent
check('missing transcript_path: no output', () =>
  assert.strictEqual(fire({ session_id: 's3' }).trim(), ''));

process.exit(failed);
