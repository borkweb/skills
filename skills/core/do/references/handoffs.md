# Handoffs and harness selection

Read this when delegating a node or transferring the controller. `do` supplies scheduling and a run ledger; use the existing [handoff skill](../../handoff/SKILL.md) for the communication document, not a new competing format. Read that skill before preparing the packet. Its eight-section structure, unique temporary `handoff.md`, concise reasoning and artifact pointers remain authoritative.

## Delegated node

1. Claim the node and retain the exact run, node, attempt and assigned snapshot. Prepare one handoff for that assignment using `handoff`'s format. Do not dump the parent transcript or give the worker the entire graph as a new goal.
2. Under **Goal / Next steps**, identify the assigned role and endpoint, result path, and how to return findings. Builders give a brief plan and every genuine disagreement with file evidence before substantive edits; unresolved scope/contract conflicts pause dependent work. No disagreement is valid.
3. Under **Key context**, preserve the absolute checkout and branch, allowed/protected paths, authority and prohibitions, frozen acceptance/gate commands, requested and resolved harness/model, and relevant rulings. Carry the non-obvious parts of [the existing builder brief](../../offload/builder-template.md), but do not copy its `$OFFLOAD_HANDOFF`, `ready`, or session-CLI commands into a native `do` assignment. Reviewers are read-only and independent; only the controller writes the run ledger.
4. Under **Pointers**, link the run directory, node/attempt/snapshot, detailed contract and prior evidence, and private result location. Under **Suggested skills**, name only the assignment's specialists. A worker does not start a second `do` run or adopt controller ownership.
5. Save the packet with `brief`: `{"node":"...","attempt":"...","path":"/absolute/temp/handoff.md"}`. The receipt's `attempt.handoff` identifies the retained copy and digest. Pass that retained copy to the launcher; the host must persist it before launch. A packet is launch context, not proof a worker started. `attach` requires it for native/external workers; ordinary host-executed checks do not require one.
6. Attach the actual worker identity after a verified launch. Require raw command/exit/count evidence, changed paths, actual delivery state, and unresolved disagreements in the returned artifact. The controller judges frozen gates and independent review, records rulings, and submits `result`; a builder's summary is not acceptance. Corrections get a new attempt packet preserving the failed criteria and the controller's ruling.

This reuses the existing handoff document and builder contract. It does not claim compatibility with the guarded `offload` mailbox protocol or supply an automatic cross-harness launcher.

## Existing external harness preferences

When an external builder is requested, use the existing configuration and resolver rather than inventing another harness preference list. Resolve [harness.mjs](../../offload/harness.mjs) from the loaded package and check it exists. `node <absolute-helper> select --rule N` reads the configured chain; `N` is zero-based and defaults to `0`. Select only a rule whose purpose applies to this task/role (the existing default is implementation builder dispatch, not arbitrary research or review). It reports `chosen`, `candidates`, and skip/demotion notes; show the choice and notes. Explicit user harness/model choices take precedence and must not silently fall through to a different profile.

The resolver honors `BORKWEB_SKILLS_CONFIG` or `~/.borkweb-skills/config.json`. Missing config, no applicable rule, an unavailable required model, or a missing observable launcher needs a user decision or a paste-ready handoff—not `init`, a fabricated session identity, or an implicit harness switch. Do not modify the shared config without authorization. A selected permission mode is not authorization to weaken sandbox/approval controls.

Do not call legacy `dispatch.sh` directly from `do`: it couples launch to an owned Claude-session mailbox and can relax runtime permissions. An explicitly requested existing `offload` workflow should use `offload` itself with its real session identity and ownership checks, rather than having two controllers schedule the same worker. Any supplied legacy mailbox is read-only context unless that separate workflow has explicitly assigned ownership. Never hand-edit it or bypass an ownership refusal.

## Controller continuation

Use `handoff`'s same document format. Include the absolute run path, current owner/revision, decision policy and unresolved decision IDs, active attempts with actual runtime IDs and retained packet/result paths, frozen gates, unresolved rulings, budgets, and the next safe action. The receiving controller reads `show` and `status`, verifies actual liveness, and uses `adopt` only after responsibility is transferred. Old worker IDs are not proof of current liveness. A missing run pointer must be recovered or requested; never create a competing run.

Use the existing `session-budget` mailbox only when that workflow is invoked and its handoff-worth gate calls for it. A per-node dispatch packet does not trigger compaction, mailbox staging, or a new session.
