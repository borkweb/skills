// launch_contract.test.mjs — freeze the builder-launch path described by
// /complete. The dispatcher already has behavioral tests; these assertions keep
// the orchestrator from bypassing it with raw herdr agent/pane creation commands.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPLETE = readFileSync(join(HERE, 'SKILL.md'), 'utf8');
const OFFLOAD = readFileSync(join(HERE, '..', 'offload', 'SKILL.md'), 'utf8');
const DISPATCH = readFileSync(join(HERE, '..', 'offload', 'dispatch.sh'), 'utf8');

const section = (body, heading) => {
  const start = body.indexOf(heading);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const tail = body.slice(start + heading.length);
  const next = tail.search(/^#{2,3} /m);
  return next === -1 ? tail : tail.slice(0, next);
};

test('complete requires every builder launch to use offload dispatch', () => {
  const invariant = section(COMPLETE, '### Builder launch invariant — `dispatch.sh` only');
  const contract = invariant.replace(/\s+/g, ' ');

  assert.match(contract, /Every builder launch MUST go through `offload` and its `dispatch\.sh`/);
  assert.match(contract, /Concurrency does not change the launcher/);
  assert.match(contract, /herdr agent start/);
  assert.match(contract, /herdr agent spawn/);
  assert.match(contract, /herdr pane split/);
  assert.match(contract, /new herdr tab <tab_id>/);
  assert.match(contract, /A pane id without a tab id is a failed dispatch/);
  assert.match(contract, /Do not set the slice to `dispatched`/);
});

test('complete command examples never launch a builder with raw herdr creation commands', () => {
  const forbidden = /\bherdr\s+(?:agent\s+(?:start|spawn)|pane\s+split)\b/;
  const blocks = [...COMPLETE.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);

  assert.ok(blocks.length > 0, 'expected executable examples in complete skill');
  for (const block of blocks) assert.doesNotMatch(block, forbidden);
});

test('offload still routes dispatch through the tab-creating implementation', () => {
  assert.match(
    OFFLOAD,
    /bash "<…>\/skills\/core\/offload\/dispatch\.sh" "\$PWD" "\$f\.md" "\$HANDOFF" "\$CLAUDE_CODE_SESSION_ID"/,
  );
  assert.match(DISPATCH, /out=\$\(herdr tab create/);
  assert.match(DISPATCH, /launched \$h in new herdr tab \$tab/);
});
