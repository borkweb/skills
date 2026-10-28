# Briefs

A brief carries a step's inputs to an agent. Handoffs are fast because briefs are short and point to files: no transcript, no pasted diff, no restated history. Every brief fits on one screen.

## Every brief

- **Goal**: one sentence, plus the endpoint.
- **Where**: absolute worktree path, branch, base..head.
- **Owns**: paths the agent may change. Reviewers may write only their explicitly designated report outside the reviewed checkouts; they own no feature files.
- **Frozen**: gates with exact commands, and contracts nobody may edit.
- **Resources**: relevant gate resources, isolation evidence and owner, recorded here or in the linked run notes ([test-resources.md](test-resources.md)). Shared or unknown resources serialize affected gates.
- **Inputs**: paths to the spec, prior findings, `decisions.md`.
- **Return**: the output format below, written to an absolute result path under the run directory.

## Reviewer

Independent, read-only, and never writes feature code. Reviews the pinned diff against the spec, gates and repo instructions using the `review` skill. Does not run suites; the parent owns gates and passes their results in as inputs. Use `review`'s **Independent pass** artifact contract: the assigned absolute result path is the sole report write, the completion returns only that path and scope, and the parent reads and validates the full report before the verdict. Missing shared storage or missing, unreadable or incomplete reports remain missing evidence.

Returns:
- a numbered findings list: severity, file:line, the evidence, and the smallest fix;
- a verdict: SAFE TO LAND, LAND WITH CAUTION, or DO NOT LAND.

For a delta re-review, send only: the diff since the last review, the finding IDs claimed fixed, and new gate results. Ask the reviewer to confirm each fix, check the delta for regressions, and keep the same numbering.

## Spec reviewer

Independent, read-only, runs before gates are frozen and concurrently with worktree setup. Reads the slice spec, the plan and the repo instructions with the `review` skill's checklist and [review-criteria.md](review-criteria.md) (the classes past reviewers rejected on after green gates) in hand, and answers one question: what would make me return DO NOT LAND on a correct implementation of this spec? For every class in review-criteria.md the slice can exhibit, it writes one criterion. Does not review code and does not propose designs. Not run for a corrective: its criteria are the confirmed blockers.

Returns:
- a numbered list of acceptance criteria, each testable, each tied to a checklist item or repo rule, with the smallest check that proves it (a command, a test name, or a file:line condition);
- gaps in the spec that no criterion can cover, one line each, or `None.`

The architect folds the criteria into the frozen gates and the builder brief, so the builder works to the same bar the later reviewer applies.

## Builder (lane)

1. Before any code, reply with a plan and every disagreement with the brief, citing real files. Silent compliance and silent scope additions both count as failures.
2. Settle a genuinely ambiguous design question with `council`, and record the ruling in the result. If it needs a change to scope or a gate, stop and report it as a blocker.
3. Build the smallest change that fully works, in this order: does it need to exist at all (skip and name anything nobody asked for); a helper, component or pattern already in this codebase, used the way the surrounding code uses it; the standard library or platform; an installed dependency; one line a reader gets at a glance; otherwise the minimum code that works. Never add a dependency for a few lines, and never cut validation at trust boundaries, error handling that prevents data loss, security, accessibility or anything the spec asks for. Be lazy about the solution, never about the change: finish every caller, test, fixture, config and export the change touches or breaks.
4. Implement only within **Owns**. Don't edit frozen gates or contracts, and don't grade your own work.
5. While iterating, run the narrowest gate that covers the file being edited (one test file, one linter target). Run the full frozen gate set once, after the last edit and before reporting; that run is the one whose numbers go in the result. New logic with a branch, loop, parser, money or security leaves one small test that fails when it breaks; trivial changes need none.

Returns:
- **Gate results**: one line per gate, with pass/fail, the count and the command that reproduces it. No logs.
- **Work summary**: changed paths, commit SHAs, what's done, stubbed or deferred, and blockers.
- **Not checked**: one or two lines on what was skipped or not verified and any risk the architect must know, or `None.`
- **Open disagreements**: one line each, or `None.`

## Compression

Agent-to-agent prose may use `caveman` compression. Keep code, commands, error strings, gate lines, commit messages and user-facing reports in normal prose.
