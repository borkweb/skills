# Builder brief

Fill this template for the slice. Save the brief and link it; print it in full only for manual handoff. The labelled blocks are short on purpose: a builder drops rules it has to dig out of long paragraphs. The bar (`Acceptance:` and `Gates:`) comes last, so it is the freshest text when the builder starts and the text it re-reads before ready. RETURNS is a form to fill in, not a description. TRANSPORT applies only to builders that have `$OFFLOAD_HANDOFF`; a Local-tier subagent follows the rest and writes RETURNS to the result file. Never start a line of a block other than `Acceptance:` with a criterion ID (`C5:`) or a local gate (`L1: local:`): the dispatcher freezes every such line.

```text
Execute <slice goal> in <absolute worktree> on <branch>.
Owned files: <paths>. Protected paths: <paths>.
Authorization: <exact commit/push/merge permissions and prohibitions>.
Contracts: <existing frozen contracts; freeze new ones only if this slice requires it>.
Result file: <path>.

RULES
- Frozen criteria outrank spec prose. When the two differ, build to the criterion and report the difference.
- Implement only within the owned files. Do not edit frozen gates or contracts.
- Before substantive edits, give a brief plan and every genuine disagreement with file evidence. No disagreement is a valid outcome. Report a scope or contract conflict before the work that depends on it.
- Settle a genuinely ambiguous design question with `council` and record the ruling in the result. A question whose answer changes scope or a gate is a blocker: stop and report it.
- Repo rules reach you only through criteria that cite `rule: <path>`. Read that file in the run directory's frozen `repo-rules-<slice>/` copy, never the live rule store.
- Use only the lanes the architect assigned. Any reviewer you start stays read-only and is never the builder.
- Keep the requested prose style. Code, commands, errors and commit messages stay exact. Do not enable a persona.

BUILD
- Build the smallest change that fully works, in this order: does it need to exist at all (skip and name anything nobody asked for); a helper or pattern already in this codebase, used the way the code around it uses it; the standard library or platform; an installed dependency; otherwise the minimum code that works. Never add a dependency for a few lines.
- Be lazy about the solution, never about the change: finish every caller, test, fixture, config and export the change touches or breaks, and never cut validation at trust boundaries, error handling that prevents data loss, security, accessibility or anything the spec asks for.
- Fix the root cause or raise a blocker. Never add a comment that explains why a workaround is acceptable.

TEST BAR
- A new or changed test must fail when the behavior it names breaks, and keep passing when only the implementation changes.
- It fails that bar when its expected value comes from the code under test, when a mock or fixture supplies the result the code should produce, or when it asserts calls between internal parts instead of what the code returns, stores or sends.
- New logic with a branch, loop, parser, money or security gets one such test. A trivial change needs none.
- Add no production export, flag, wrapper or hook that only tests use when the real entry point can drive the behavior.

BEFORE READY
- (a) Name what each new early return or abort, and each widened fallback or recovery path, now skips or swallows.
- (b) Read the callbacks, middleware, observers and hooks up to two levels out from the change, plus any other interface that exposes the changed behavior. Run the tests that cover them.
- (c) Never narrow requested behavior to fit a safeguard by delaying, gating, capping or skipping part of it. An open conflict is a blocker.
- (d) After two failed fixes for the same failing check, name the assumption both relied on and check it before a third try.
- (e) Re-read every `Acceptance:` line at the end of this brief and check each one against the code, the way the independent `review` will. Fix what you find. This pre-check is not acceptance. Do not grade your own work or change frozen gates.
- While iterating, run the narrowest gate that covers the file you are editing. On a fresh dispatch, run the full frozen gate set once after your last edit and report that run.
- A frozen gate you cannot run here (no access, no sandbox, wrong runtime version) is `NOT RUN` with the reason, never a pass.
- Complete the authorized delivery steps before you report: commit as the `Authorization:` line allows, and nothing it prohibits. Then fill RETURNS.

ON A CORRECTIVE
- Rerun the gates your diff can reach and every criterion's check at HEAD. A gate your diff can reach is a test that imports, executes or reads a changed file, or a validator that reads a changed doc. A change to dependency, build or test configuration reaches every gate. When unsure, rerun it.
- Measure reach over `git diff <Carried sha>..HEAD`; the `Carried:` sha must be an ancestor of HEAD. A corrective that rebases onto or merges its base carries nothing. A local gate (a frozen `L<n>: local: <command>` line) is never carried: it reruns at HEAD on every `ready`, whatever the `Carried:` line says.
- Report every criterion again, not only the blockers. The architect runs the full set once on the head it accepts.

RETURNS (fill every line in this order; a criterion with no line counts as not met)
Gate results:
Head: <sha of the commit the final gate run used; after any later commit, even a comment or a description string, rerun and update it>
Carried: <earlier head sha> — <gate names your diff cannot reach> (corrective only; omit on a fresh dispatch)
<gate name>: PASS | FAIL | NOT RUN <reason> — <exact counts> — `<command>` exit <code> — <raw evidence path>
Safety fact: <the one fact the change is safe because of> — rung <1 cited line | 2 walked failure | 3 real code with hostile input | 4 reproduced live; go as far as is cheap> — <evidence path>
<ID>: MET — <test, command or file:line that proves it> — <result> — <the break this check would catch>
<ID>: NOT MET | NOT RUN — <reason>
<ID> blocker: before the fix <red command result> — after <result> (corrective only, one line per blocker)
One criterion line per ID, by its ID exactly as frozen (C5, C5a).
Loosened tests: <each assertion, expected value, fixture value, golden file or test case removed, skipped or loosened, with the source of truth that justifies it (spec section, API doc, recorded real response)>, or None. Never change an expectation to match the code without one; an unlisted change counts as a defect.
Work summary: <changed paths, branch and commit state, remaining work and blockers>
Not checked: <one or two lines on what was skipped or not verified, and any risk the architect must know>
Open disagreements: <one line each>, or None.
Without `$OFFLOAD_HANDOFF` (a Local-tier subagent), write the same Returns to the result file.

TRANSPORT (only when `$OFFLOAD_HANDOFF` is set). Handoff: $OFFLOAD_HANDOFF.
Report through the handoff CLI: set builder_session to your actual session or resume ID, and write Gate results, Work summary and Open disagreements with `node "<resolved handoff.mjs>" section append|set "$OFFLOAD_HANDOFF" "<heading>" --file <file>`. Never splice Markdown or write the architect's ledger.
Before the final gate run, also re-read `## Frozen gates` with `node "<resolved handoff.mjs>" section get "$OFFLOAD_HANDOFF" "Frozen gates"` and report against that copy.
At completion, run `node "<resolved handoff.mjs>" ready "$OFFLOAD_HANDOFF"`. It is a coverage check plus a run of the frozen local gates, not a check of the evidence: it refuses unless Gate results has one line for every frozen criterion ID, and lines from an earlier round satisfy it. It also refuses with `stale:` when the `Head:` line is missing or does not match your worktree's HEAD. Once those pass, `ready` runs every frozen local gate (`L<n>: local: <command>` lines in Frozen gates) in your worktree at HEAD and refuses with `red:` and exit 7, naming each red gate and the file that holds its output; the status does not change. When the slice has local gates, it also refuses, with `red:`, when tracked files have uncommitted changes. A Claude builder's Stop hook runs the same gates and sends you back once.
On an `incomplete:` refusal, add the missing lines and run `ready` again. Do not run `blocked`, use `--steal` or run `status`. On a `stale:` refusal, rerun at HEAD every gate and check you list under `Head:` (on a corrective, the gates your diff can reach and every criterion's check; keep the `Carried:` line), update the evidence and the `Head:` line, then run `ready` again. Do not run `blocked`, use `--steal` or run `status`.
On a `red:` refusal, read the saved output at the path it names, fix the cause within your owned files, commit it and run `ready` again. Do not edit Frozen gates, use `--steal` or run `status`.
If the red gate is one you cannot fix within your owned files (red at the base, or failing because of the environment), record it under Open disagreements, then run `blocked`.
For a mid-slice blocker, record Open disagreements, then run `node "<resolved handoff.mjs>" blocked "$OFFLOAD_HANDOFF"` and report what needs a ruling. Do not silently wait.
Ownership refusal is a blocker: do not use --steal or edit the path to bypass it. The dispatcher supplies the architect's session identity in `$OFFLOAD_SESSION_ID`, which the CLI honors for `$OFFLOAD_HANDOFF` even when your own `$CLAUDE_CODE_SESSION_ID` differs. Use only the status vocabulary documented by the CLI.

THE BAR (the independent reviewer applies this same list)
Acceptance: <copy every criterion verbatim from the spec review, one per line below this label, each line starting with its ID as `<ID>: <condition>`>
Gates: <commands, expected results, evidence paths, required RED chronology>.
```
