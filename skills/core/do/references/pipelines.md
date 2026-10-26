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
3. **Plan and freeze.** Write the plan with `writing-plans` in `writing-plan-documents` style, split into slices by the sizing rule in SKILL.md (one coherent feature each). Then run these concurrently:
   - a **spec reviewer** agent ([briefs.md](briefs.md)) over each slice's spec, returning the acceptance criteria the `review` checklist would reject on;
   - the plan reviews from step 2 that the plan changed, if any;
   - each slice's worktree, pre-warmed: create it, then run the dependency install and the baseline gate suite in it as a background task, so the builder's first gate run is warm.

   Join. Freeze each slice's acceptance gates as exact commands with expected results, with the spec reviewer's criteria folded in, before any code exists. From here on, nobody edits the gates. The builder and the later reviewer now hold the same bar; a rejection after green gates means the spec review missed something, so record it in `decisions.md`.
4. **Implement.** Pick the tier from Build work in SKILL.md: one slice goes to `offload`, two or more to `complete`, which dispatches every slice with disjoint files in the same turn. Hand over the frozen plan, gates and council rulings. Keep running your own reviews and gates concurrently while it works, then merge its result and run the integration gates once (fleet tier only).
5. **Land.** Run **land** from step 2 on the result. Pass along the gates already frozen; don't re-derive them.

## review batch

For a review request that names two or more PRs. Each PR runs `pr-review` in its own lane, which prepares the review and stops. You show every planned review together, and post only what the user confirms. Neither the request nor a lane authorizes a post. Only the step 5 answer does.

1. **Pin.** Fetch every PR at the same time with `pr-review`'s Step 0 `gh pr view` call, scoped to each URL's host and repo. Note fork PRs, and find a local checkout for each repo. For a repo that isn't the current checkout, follow `pr-review`'s [edge-cases.md](../../pr-review/references/edge-cases.md) now, so that every lane starts with a matching checkout. Then run one `git fetch` per repo for every PR's base and head (`pull/<number>/head` for a fork). Lanes skip their own fetch, so they don't race on the same refs.
2. **Ask once.** One `AskUserQuestion` call: fix mode (comment only, recommended, or auto-fix the mechanical ones), plus the fork question when any PR is a fork, plus any checkout question from step 1. Skip what the user's words already answer. With several PRs every lane runs in a worktree, so auto-fix returns one patch per PR. Say so in the question.
3. **Dispatch.** One subagent per PR, at most 4 at a time. Start the next PR as each lane returns. Brief each lane to invoke `pr-review` through the `Skill` tool with `<PR URL> --prepare-only <run>/pr-<number> --worktree`, the fix-mode flag and `--run-fork` when allowed. The brief also names the host (this harness) and the peer (the other one), and the checkout path. Lanes are reviewers: they own only their `<run>/pr-<number>` directory.
4. **Deferred checks.** Lanes start no local checks. As each lane returns, run its **Checks pending** following [test-resources.md](test-resources.md) and `pr-review`'s [checks.md](../../pr-review/references/checks.md): verified isolated gates may overlap; shared or unknown resources serialize affected gates. Run `pre-fix` checks on the PR head: the lane's worktree in COMMENT-ONLY mode, or a clean detached worktree at `<headRefOid>` for an AUTO-FIX lane, because the verdict describes the PR as it stands. Run `post-fix` checks in the AUTO-FIX lane's worktree. Triage each regression with `pr-review`'s Step 5a into that PR's `payload.json` and `preview.md`, and update its verdict. If a fork PR has no `--run-fork`, record its pending checks as `NOT RUN (fork)`.
5. **Show and confirm.** Print each PR's `preview.md` in full. Then ask one `AskUserQuestion` question per PR, 4 per call. List PRs with nothing to post, but don't ask about them.
   - Critical and informational: *Post criticals + recommended (#1, #4)*, *Criticals only*, *Cancel*.
   - Critical only: *Post*, *Cancel*.
   - Informational only: *Post recommended (#1, #4)*, *All <n>*, *None*.

   Free text edits a comment or picks other informational numbers. Don't re-litigate an answer.
6. **Post.** For each confirmed PR, add the chosen findings from `informational.json` to `payload.json` and post it as `pr-review`'s Step 5c says, including its 422 handling. Post the PRs concurrently and print each review URL.
7. **Clean up and report.** Remove each comment-only worktree as `pr-review`'s Step 7 cleanup says, and never with `--force`. Keep AUTO-FIX worktrees. Report one table with a row per PR: verdict, critical and informational counts, review URL or `not posted`, patch path, leads. For each DO NOT LAND, name **land** as the next step. Don't start it.

## Council during a pipeline

Give council one narrow question, the live evidence (file:line, gate output), the constraints and the options. Log the ruling in `decisions.md` and apply it. If the ruling changes a frozen gate or the scope, it's a user question, not a council question.
