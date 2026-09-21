# Handoffs and harness selection

Read only for delegation or controller continuation. Use the existing [handoff skill](../../handoff/SKILL.md) and its eight-section format; read it once when first preparing a handoff in this session. The runner can draft recorded facts, but the controller owns the reasoning and reviews the packet before launch. Do not copy the parent transcript or assign the whole graph to a worker.

## Delegated node

1. Use `claim`, retaining run/node/attempt/snapshot. Create a unique private temporary directory outside source scope with the platform’s secure temp helper.
2. Prepare a context JSON file. `branch` and absolute `resultPath` are required; the result's parent directory must already exist, be canonical and outside the repository. Optional fields are `context` (non-obvious reasoning, disagreements and prior partial work), `nextSteps` (strings), `skills` (only assignment specialists), `requestedHarness`, `resolvedHarness`, `requestedModel`, `resolvedModel`. Supply actual resolved runtime/model information; the helper cannot discover it. Never invent identities or silently substitute a required harness.
3. Generate a new draft with `packet`. It copies the recorded authority, scope, assigned snapshot, frozen gates, rulings and relevant prior evidence into the handoff format. It creates only the requested private file, never overwrites a file, and does not mutate the ledger or launch anything.

```sh
node CLI packet --run DIR --node NODE --attempt ATTEMPT --input /private/context.json --out /private/unique/handoff.md
```

4. Read the draft, add missing task-specific reasoning and verify its branch, boundaries, gates, result path and resolved harness/model. Preserve the eight headings and facts; remove unrelated detail if needed without dropping constraints. For builders, require a brief plan and every genuine disagreement before substantive edits. No disagreement is valid. Reviewers stay read-only and independent. Only the controller writes the ledger; workers do not start another `do` run or adopt ownership.
5. Retain the reviewed packet through `brief`: `{"node":"...","attempt":"...","path":"/absolute/temp/handoff.md"}`. Pass the receipt’s retained `attempt.handoff.path` to the launcher, then `attach` the actual returned identity. A packet or launch intent is not proof a worker started. Host-executed nodes need no packet. A manually prepared handoff remains supported.
6. Require raw command/exit/count evidence, changed paths, actual delivery state and unresolved disagreements in the returned artifact. The controller judges frozen gates; the builder’s summary is not acceptance. Corrections use a new attempt packet preserving failed criteria, rulings and prior partial work.

When an external builder is requested, read [external-harness.md](external-harness.md) before selection or launch. Never invoke legacy `dispatch.sh` or mutate its mailbox/config from `do`.

## Controller continuation

Use `handoff`'s same document format. Include the absolute run path, current owner/revision, decision policy and unresolved decision IDs, active attempts with actual runtime IDs and retained packet/result paths, frozen gates, unresolved rulings, budgets, and the next safe action. The receiving controller reads `show` and `status`, verifies actual liveness, and uses `adopt` only after responsibility is transferred. Old worker IDs are not proof of current liveness. A missing run pointer must be recovered or requested; never create a competing run.

Use the existing `session-budget` mailbox only when that workflow is invoked and its handoff-worth gate calls for it. A per-node dispatch packet does not trigger compaction, mailbox staging, or a new session.
