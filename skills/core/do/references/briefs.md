# Briefs

A brief carries a step's inputs to an agent. Handoffs are fast because briefs are short and point to files: no transcript, no pasted diff, no restated history. Every brief fits on one screen.

## Every brief

- **Goal**: one sentence, plus the endpoint.
- **Where**: absolute worktree path, branch, base..head.
- **Owns**: paths the agent may change. Reviewers own nothing.
- **Frozen**: gates with exact commands, and contracts nobody may edit.
- **Inputs**: paths to the spec, prior findings, `decisions.md`.
- **Return**: the output format below, written to an absolute result path under the run directory.

## Reviewer

Independent, read-only, and never writes feature code. Reviews the pinned diff against the spec, gates and repo instructions using the `review` skill. Does not run suites; the parent owns gates and passes their results in as inputs.

Returns:
- a numbered findings list: severity, file:line, the evidence, and the smallest fix;
- a verdict: SAFE TO LAND, LAND WITH CAUTION, or DO NOT LAND.

For a delta re-review, send only: the diff since the last review, the finding IDs claimed fixed, and new gate results. Ask the reviewer to confirm each fix, check the delta for regressions, and keep the same numbering.

## Builder (lane)

1. Before any code, reply with a plan and every disagreement with the brief, citing real files. Silent compliance and silent scope additions both count as failures.
2. Settle a genuinely ambiguous design question with `council`, and record the ruling in the result. If it needs a change to scope or a gate, stop and report it as a blocker.
3. Implement only within **Owns**. Don't edit frozen gates or contracts, and don't grade your own work.

Returns:
- **Gate results**: one line per gate, with pass/fail, the count and the command that reproduces it. No logs.
- **Work summary**: changed paths, commit SHAs, what's done, stubbed or deferred, and blockers.
- **Open disagreements**: one line each, or `None.`

## Compression

Agent-to-agent prose may use `caveman` compression. Keep code, commands, error strings, gate lines, commit messages and user-facing reports in normal prose.
