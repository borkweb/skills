# Codex orchestration

Codex is the architect and orchestrator. Delegate implementation and independent
reviews to the worker and reviewer models resolved from `roles.json` beside this file (explicit user choices override that configuration). The parent scopes work, freezes gates,
resolves disagreements, verifies evidence, and maintains progress; it does not
write implementation code. A later explicit user instruction can override the
worker model or execution route.

## Start and preserve state

Keep the user's goal verbatim. The default endpoint is **merge-ready**. Only
merge when the user's instructions explicitly authorize it; "complete", "done",
and "ship it" alone do not authorize merging. Carry existing authorization
forward without asking again. Delegation uses the current runtime's permissions.

Read any supplied handoff and inspect the current checkout before resuming.
Create a temporary directory for this run's state outside tracked files; report
its absolute path. Keep an architect-owned ledger there containing the goal,
endpoint, authorization, orchestrator `Codex`, resolved worker and reviewer models, and
one row per slice: ID, scope, dependencies, worktree/branch, handoff path, native
agent ID, state, commits, gate evidence, and review verdict. On resume, use the
ledger path from the handoff rather than creating a competing record. If the
user is resuming work but the ledger pointer is missing or unreadable, inspect
any supplied artifacts for that pointer and ask for the missing path if it
cannot be recovered. Do not create a second run or dispatch replacement workers
until the existing run's ownership is resolved.

States: `specced`, `dispatched`, `blocked`, `results-ready`, `accepted`,
`rejected`, `merged`, `abandoned`. Only the architect changes the ledger.
Workers write their own result files. Record state changes in the turn they
happen, including reversals when a previously accepted slice fails verification.
Never record a native agent ID as a pane or use `handoff.mjs board` to infer native
worker state: that helper observes external processes and bridges.

## Scope and dispatch

1. Split the goal into bounded slices. Use relevant plan reviews before freezing
   the first gates: `plan-eng-review` for architecture/data flow/concurrency,
   `plan-design-review` for UI, and `plan-devex-review` for consumed interfaces.
   Skip unnecessary reviews for trivial work. If delegated, these reviews also
   use the resolved reviewer model.
2. Write each slice's handoff before dispatch: exact goal, owned files, protected
   paths, dependencies, acceptance criteria, reproducible gate commands, worktree
   and branch, result path, and authorized commit/push behavior. Preserve any
   required RED-before-GREEN chronology. Freeze gates before results exist.
3. Use the available native spawn tool with **`model: <resolved worker or reviewer model>`**. With
   `collaboration.spawn_agent`, use `fork_turns: "none"` so the model override is
   accepted; provide the handoff path and enough context to work independently.
   Do not use `fork_turns: "all"` with a model override. Inspect the exposed tool
   schema if another native spawn API is available; do not invent arguments.
4. Record the returned agent ID before marking the slice `dispatched`. Never
   assume that a spawn succeeded or that a requested worktree was created.
   Agents may share the filesystem: create and verify separate worktrees when
   concurrent branches are needed, and tell workers their exact working path.
   Dispatch only slices whose files and dependencies permit concurrent work,
   within the runtime's available slots.

Each worker must report changed files, commit/branch state, raw gate output and
exit codes, unresolved disagreements, and remaining work to its result file and
final response. A blocker report identifies what needs a ruling. Workers must
not change frozen criteria, claim independent acceptance of their own work, or
delegate again without the architect assigning that work.

## Supervise and judge

Use native messages and completion notifications to supervise workers. With
the collaboration tools, use `send_message` for a running worker,
`followup_task` to resume an idle worker, and `wait_agent` when there is no other
useful work. Keep waits within the runtime's communication limits. Do not launch
`dispatch.sh`, shell wait bridges, or a second external builder for a native slice.

At every wake or resume, read the ledger and reconcile it with live agent status
and result files. Report only verified state. After a fresh session, an old agent
ID may no longer be reachable: inspect its checkout and evidence, mark it
`blocked` with an unreachable-owner reason, and resume with a new worker when safe. Do not duplicate a worker
that is still running or claim an unreachable worker is active.

Resolve a blocked worker's disagreements, record the ruling, and send it back.
Use `council` for substantive judgment calls when it adds value; any delegated
participants use the resolved reviewer model. If the requested model or native tools are unavailable,
report the precise blocker and seek a user choice instead of selecting a fallback.

When results arrive, compare raw gate evidence with the frozen acceptance
criteria and inspect the actual diff. Run a separate reviewer using the resolved reviewer model with the
`review` skill against that slice's exact commit and base. Instruct the reviewer
to stay read-only and return findings plus its verdict; review-skill fix behavior
does not authorize that reviewer to edit. The builder cannot review itself.
The reviewer returns its findings, reviewed base and commit, and verdict to the
architect, who saves that response in the run directory and records its path in
the ledger. This preserves review evidence without giving the reviewer write
access to either the source or the ledger.

Accept only when gates pass and the independent review has no blocking findings.
Otherwise record rejection and dispatch the corrective work with the findings.
Re-review after corrections. A worker's successful exit or prose summary alone
is not acceptance. Verify that reviewed files/HEAD stayed stable during review.

## Finish and hand off

Confirm that every part of the goal is delivered and every ledger row is terminal;
an abandoned or rejected row does not fulfill missing scope. Integrate accepted
slices on the target branch through a delegated worker, then run relevant
integration gates and a fresh independent `review` using the resolved reviewer model over the full diff
against the intended base. Check the repository's required CI as well as local
gates. Missing evidence or blocking findings means corrective work remains.

Report the branch, commits, raw gate totals, review verdict, and any caveats.
Complete authorized commit/push/PR steps; explicitly report any delivery step
that remains unapproved or blocked. Stop at merge-ready unless merging was
authorized. If authorized, perform the merge and verify its result before
recording `merged`.

When producing a continuation handoff, use `handoff` and preserve the ledger and
result-file paths, authorization, frozen criteria, and the role split: Codex
orchestrator, configured workers. Keep these session artifacts out of commits.
