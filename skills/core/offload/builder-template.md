# Builder brief

Fill this template for the slice. Save the brief and link it; print it in full only for manual handoff.

```text
Execute <slice goal> in <absolute worktree> on <branch>.
Owned files: <paths>. Protected paths: <paths>.
Authorization: <exact commit/push/merge permissions and prohibitions>.
Contracts: <existing frozen contracts; freeze new ones only if this slice requires it>.
Acceptance: <numbered criteria frozen before results exist, including every criterion the spec reviewer returned; the independent reviewer will apply the same list>.
Gates: <commands, expected results, evidence paths, required RED chronology>.
Result file: <path>. Handoff: $OFFLOAD_HANDOFF.

Before substantive edits, give a brief plan and every genuine disagreement with file evidence. No disagreement is a valid outcome. Report unresolved scope or contract conflicts before dependent work; proceed on settled instructions.

Build the smallest change that fully works, in this order: does it need to exist at all (skip and name anything nobody asked for); a helper, component or pattern already in this codebase, used the way the surrounding code uses it; the standard library or platform; an installed dependency; one line a reader gets at a glance; otherwise the minimum code that works. Never add a dependency for a few lines, and never cut validation at trust boundaries, error handling that prevents data loss, security, accessibility or anything the spec asks for. Be lazy about the solution, never about the change: finish every caller, test, fixture, config and export the change touches or breaks. New logic with a branch, loop, parser, money or security leaves one small test that fails when it breaks; trivial changes need none.

While iterating, run the narrowest gate that covers the file you are editing; run the full frozen gate set once after your last edit, and report that run's numbers. A frozen gate you cannot run here (no access, no sandbox, wrong runtime version) is `NOT RUN` with the reason, never a pass. Use only the delegated lanes explicitly assigned by the architect and available runtime capacity. An independent reviewer must remain read-only and cannot be the builder. Before signalling ready, check the work against the same `review` criteria the architect's independent reviewer will apply and fix what you find; this pre-check is not acceptance. Do not grade your own work or change frozen gates.

Preserve the requested prose style; code, commands, errors, commit messages and PR text stay exact or normal as appropriate. Do not enable a persona implicitly.

Complete the authorized delivery steps, then update the handoff via its CLI:
- builder_session: actual session/resume ID.
- Gate results: pass/fail or NOT RUN, exact counts, command, exit code and path to raw evidence. Then criteria evidence, in the same section: one line per acceptance criterion, by its number, naming the test, command or file:line that proves it and the result, or NOT MET or NOT RUN with the reason. A criterion with no line counts as not met. On a corrective, report every criterion again, not only the blockers, and add one line per blocker with its red command's result before your fix and after it. Then a `Loosened tests:` line: every assertion, expected value, fixture value, golden file or test case this slice removed, skipped or loosened, each with the source of truth that justifies it (spec section, API doc, recorded real response), or `None.` Never change an expectation to match the code without one; an unlisted change counts as a defect.
- Work summary: changed paths, branch/commit state, remaining work and blockers, then `Not checked:` one or two lines on what was skipped or not verified and any risk the architect must know.
Use `node "<resolved handoff.mjs>" section append|set "$OFFLOAD_HANDOFF" "<heading>" --file <file>`; never splice Markdown or write the architect's ledger.

At completion, run `node "<resolved handoff.mjs>" ready "$OFFLOAD_HANDOFF"`.
For a mid-slice blocker, record Open disagreements, then run `node "<resolved handoff.mjs>" blocked "$OFFLOAD_HANDOFF"` and report what needs a ruling. Do not silently wait.
Ownership refusal is a blocker: do not use --steal or edit the path to bypass it. The dispatcher supplies the architect's session identity in `$OFFLOAD_SESSION_ID`, which the CLI honors for `$OFFLOAD_HANDOFF` even when your own `$CLAUDE_CODE_SESSION_ID` differs. Use only the status vocabulary documented by the CLI.
```
