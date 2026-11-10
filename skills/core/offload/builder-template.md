# Builder brief

Fill this template for the slice. Save the brief and link it; print it in full only for manual handoff. The brief has a shared part (instructions and Returns) and a last Transport paragraph for builders that have `$OFFLOAD_HANDOFF`. Local-tier subagents have no handoff: they follow the shared part and write the Returns to the result file.

```text
Execute <slice goal> in <absolute worktree> on <branch>.
Owned files: <paths>. Protected paths: <paths>.
Authorization: <exact commit/push/merge permissions and prohibitions>.
Contracts: <existing frozen contracts; freeze new ones only if this slice requires it>.
Acceptance: <copy every criterion verbatim from the spec review, one per line below this label, each line starting with its ID as `<ID>: <condition>`; the independent reviewer applies the same list>
Gates: <commands, expected results, evidence paths, required RED chronology>.
Result file: <path>.

Frozen criteria outrank spec prose. When the two differ, build to the criterion and report the difference. Before substantive edits, give a brief plan and every genuine disagreement with file evidence. No disagreement is a valid outcome. Report unresolved scope or contract conflicts before dependent work; proceed on settled instructions. Settle a genuinely ambiguous design question with `council` and record the ruling in the result; when the answer needs a change to scope or a gate, stop and report it as a blocker. Implement only within the owned files. Do not edit frozen gates or contracts.

Build the smallest change that fully works, in this order: does it need to exist at all (skip and name anything nobody asked for); a helper, component or pattern already in this codebase, used the way the surrounding code uses it; the standard library or platform; an installed dependency; one line a reader gets at a glance; otherwise the minimum code that works. Never add a dependency for a few lines, and never cut validation at trust boundaries, error handling that prevents data loss, security, accessibility or anything the spec asks for. Be lazy about the solution, never about the change: finish every caller, test, fixture, config and export the change touches or breaks. New logic with a branch, loop, parser, money or security leaves one small test that fails when it breaks; trivial changes need none.

Test bar. A new or changed test must fail when the behavior it names breaks, and must keep passing when only the implementation changes. It fails that bar when its expected value comes from the code under test, when a mock or fixture supplies the result the code should produce, or when it asserts calls between internal parts instead of what the code returns, stores or sends. Add no production export, flag, wrapper or hook that only tests use when the real entry point can drive the behavior.

Self-checks before you signal ready. (a) Name what each new early return or abort, and each widened fallback or recovery path, now skips or swallows. (b) Read the callbacks, middleware, observers and hooks up to two levels out from the change, plus any other interface that exposes the changed behavior, then run the tests that cover them. (c) Never narrow requested behavior to fit a safeguard by delaying, gating, capping or skipping part of it; an open conflict is a blocker. (d) After two failed fixes for the same failing check, name the assumption both relied on and check it before a third try.

While iterating, run the narrowest gate that covers the file you are editing. Before the final full gate run, re-read the brief's `Acceptance:` lines and report against that copy. Run the full frozen gate set once after your last edit, and report that run's numbers. A frozen gate you cannot run here (no access, no sandbox, wrong runtime version) is `NOT RUN` with the reason, never a pass. Use only the delegated lanes explicitly assigned by the architect and available runtime capacity. An independent reviewer must remain read-only and cannot be the builder. Before signaling ready, check the work against the same `review` criteria the architect's independent reviewer will apply and fix what you find; this pre-check is not acceptance. Do not grade your own work or change frozen gates.

Preserve the requested prose style; code, commands, errors, commit messages and PR text stay exact or normal as appropriate. Do not enable a persona implicitly.

Complete the authorized delivery steps before you report: commit as the `Authorization:` line allows, and nothing it prohibits. Then update the handoff or the result file.

Returns, in this order:
- Gate results: pass/fail or NOT RUN, exact counts, command, exit code and path to raw evidence. Then criteria evidence, in the same section: one line per acceptance criterion, by its ID exactly as frozen (C5, C5a), naming the test, command or file:line that proves it and the result, and the break that check would catch, or NOT MET or NOT RUN with the reason. A criterion with no line counts as not met. On a corrective, report every criterion again, not only the blockers, and add one line per blocker with its red command's result before your fix and after it. Then a `Loosened tests:` line: every assertion, expected value, fixture value, golden file or test case this slice removed, skipped or loosened, each with the source of truth that justifies it (spec section, API doc, recorded real response), or `None.` Never change an expectation to match the code without one; an unlisted change counts as a defect.
- Work summary: changed paths, branch/commit state, remaining work and blockers, then `Not checked:` one or two lines on what was skipped or not verified and any risk the architect must know.
- Open disagreements: one line each, or `None.`
Without `$OFFLOAD_HANDOFF` (a Local-tier subagent), write the same Returns to the result file.

Transport, only when `$OFFLOAD_HANDOFF` is set. Handoff: $OFFLOAD_HANDOFF.
Report through the handoff CLI: set builder_session to your actual session or resume ID, and write Gate results, Work summary and Open disagreements with `node "<resolved handoff.mjs>" section append|set "$OFFLOAD_HANDOFF" "<heading>" --file <file>`. Never splice Markdown or write the architect's ledger.
Before the final full gate run, re-read `## Frozen gates` with `node "<resolved handoff.mjs>" section get "$OFFLOAD_HANDOFF" "Frozen gates"` and report against that copy.
At completion, run `node "<resolved handoff.mjs>" ready "$OFFLOAD_HANDOFF"`. It is a coverage check, not a freshness check: it refuses unless Gate results has one line for every frozen criterion ID, and lines from an earlier round satisfy it.
On an `incomplete:` refusal, add the missing lines and run `ready` again. Do not run `blocked`, use `--steal` or run `status`.
For a mid-slice blocker, record Open disagreements, then run `node "<resolved handoff.mjs>" blocked "$OFFLOAD_HANDOFF"` and report what needs a ruling. Do not silently wait.
Ownership refusal is a blocker: do not use --steal or edit the path to bypass it. The dispatcher supplies the architect's session identity in `$OFFLOAD_SESSION_ID`, which the CLI honors for `$OFFLOAD_HANDOFF` even when your own `$CLAUDE_CODE_SESSION_ID` differs. Use only the status vocabulary documented by the CLI.
```
