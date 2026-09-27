# Pipelines

Each step lists what runs concurrently. "Join" means wait for every listed branch before moving on. Log each step to `notes.md` as it finishes, one line with its result and evidence path.

## land

For an existing change (branch, PR or working tree) that should reach SAFE TO LAND.

1. **Pin.** Record base, head, uncommitted files and the gates: the project's test and static-analysis commands, plus any check that the repo instructions or the user named. Freeze them in `notes.md`.
2. **Review round 1.** Run these concurrently:
   - an independent reviewer agent with a reviewer brief ([briefs.md](briefs.md)) on the pinned diff;
   - the full suite and static analysis in the background;
   - your own pass using the `review` skill's checklist.

   Join. Merge the findings into one numbered list and drop duplicates. Check each of the reviewer's claims against the code before acting on it.
3. **Fix.** Fix every confirmed finding in one batch. Add a regression test that fails without each behavioral fix. Send design questions that come up to council (see SKILL.md). While fixing, draft the commit message and PR body if delivery was requested.
4. **Re-review.** Run these concurrently:
   - the **same** reviewer agent, if it's still reachable, given only the diff since its last review and the finding IDs you claim are fixed (a delta re-review);
   - only the gates the fixes could affect, rerun on the final files. Earlier passes stand for unchanged files.

   Join.
5. **Loop or stop.** No blockers left: SAFE TO LAND, or LAND WITH CAUTION if nonblocking caveats remain. Otherwise go back to step 3. **Circuit breaker:** after 3 fix rounds, or if the same finding survives two rounds, stop at DO NOT LAND and report the remaining findings with what you tried.
6. **Deliver** only if requested: commit (`writing-commits`), push without force, open or update the PR, update the tracker. Confirm each step against the remote (for example, the PR head SHA) before reporting it done.

A review-only request is step 1 plus step 2, then the verdict. It makes no fixes.

## ship

For a new goal that should end merge-ready.

1. **Frame.** Restate the goal and endpoint. If the brief is ambiguous in a way that changes the design, run `brainstorming` or ask one focused question. Otherwise continue.
2. **Spec and review.** Write the spec (`writing-plan-documents` style). Then run these concurrently:
   - the relevant plan reviews as parallel read-only agents: `plan-eng-review` for architecture and data flow, `plan-design-review` for UI, `plan-devex-review` for consumed interfaces. Use `plan-deep-review` when the user asks for it.
   - dependency installation, fixture setup and baseline suite runs, so later gates start warm.

   Join. Send each open question the reviews raise to council, log the rulings, and fold them into the spec.
3. **Plan and freeze.** Write the plan with `writing-plans`. Freeze the acceptance gates as exact commands with expected results before any code exists. From here on, nobody edits the gates.
4. **Implement.**
   - For one lane, implement in the host, test-first where there's behavior to prove.
   - For independent modules, use up to 3–4 lane agents with builder briefs, each in its own worktree. Commit any contracts the lanes share before dispatching them.
   - For work too large for one session's lanes, hand the plan to `complete` and stop running this pipeline yourself.

   Lanes return gate results and changed files. Merge the lanes and run the integration gates once.
5. **Land.** Run **land** from step 2 on the result. Pass along the gates already frozen; don't re-derive them.

## Council during a pipeline

Give council one narrow question, the live evidence (file:line, gate output), the constraints and the options. Log the ruling in `decisions.md` and apply it. If the ruling changes a frozen gate or the scope, it's a user question, not a council question.
