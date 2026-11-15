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
3. **Fix.** Fix every confirmed finding in one batch. Fix in this order: conflicts, then unresolved review threads, then CI. Batch every known fix into one push, because each push restarts CI. After you update the branch onto its base, sweep trunk for new callers of code the change moved. Before you retrigger CI, classify a failure in code the diff never touched as a stale base, not a flake: update the branch onto its base and rerun. Merge the base in when the branch is already pushed; rebase only when force-push is authorized. Add a regression test that fails without each behavioral fix. Send design questions that come up to council (see SKILL.md). While fixing, draft the commit message and PR body if delivery was requested.
4. **Re-review.** Run these concurrently:
   - the **same** reviewer agent, if it's still reachable, given only the diff since its last review and the finding IDs you claim are fixed (a delta re-review);
   - only the gates the fixes could affect, rerun on the final files. Earlier passes stand for unchanged files.

   Join.
5. **Loop or stop.** No blockers left: SAFE TO LAND, or LAND WITH CAUTION if nonblocking caveats remain. Otherwise go back to step 3. **Circuit breaker:** after 3 fix rounds, or if the same finding survives two rounds, stop at DO NOT LAND and report the remaining findings with what you tried.
6. **Deliver** only if requested: commit (`writing-commits`), push without force, open or update the PR, update the tracker. Confirm each step against the remote (for example, the PR head SHA) before reporting it done.

A review-only request is step 1 plus step 2, then the verdict. It makes no fixes.

## land batch

For two or more existing PRs or branches that should each reach SAFE TO LAND, with whatever push, approval or comments the user asked for. Each PR runs **land** in its own lane. The host owns every wait and every shared resource, so no lane sits idle waiting, and no model turn is spent waiting on nothing.

1. **Pin.** Do **review batch** step 1. Then record in `notes.md`, per PR: head SHA, base, frozen gates with commands, and for each gate whether it uses a shared resource ([test-resources.md](test-resources.md)), such as a sandbox, database or CI. Record the authority the user granted (push, approve, comment) verbatim under **Authority**.
2. **Dispatch.** One subagent per PR, at most 4 at a time. A stacked pair is one lane, base first. Start the next queued PR as each lane returns. Each lane runs **land** steps 2–5 as host for its PR, in its own worktree under `<run>/pr-<number>/`. Its fixes are land fixes on an existing change, not build work. The brief ([briefs.md](briefs.md)) names the gates the lane may run itself (only those with no shared resource) and the ones it must request, and repeats its **Waits** rule.
3. **Lane wait.** When a lane needs CI on a pushed head, or a gate that uses a shared resource, it writes `<run>/pr-<number>/waiting.md` with the head SHA and one line per need (`ci <n>`, or the exact gate command), then ends its turn. `ci <n>` asks for the nth CI run on that head: `ci 1` after a push (a bare `ci` means `ci 1`), and when the lane reruns CI on the same head it writes a new `waiting.md` with `ci <n+1>`, after it has triggered the rerun. It starts no background waiter, takes no lock and does not poll. A message from the host is the only thing that wakes it.
4. **Host watcher.** While any lane is in flight, keep exactly one background shell task armed (`run_in_background`). It sleeps between checks, so it costs no tokens. It reads PR state with `node skills/core/do/pr-state.mjs <pr-url>...` (resolve the path from the loaded `do` skill), never with hand-written polling. The script prints one NDJSON line per PR (`url`, `head`, `mergeStateStatus`, `tier`, `checksPending`, `checksFailing`; the last two count the head's pending and failing checks; a head with no reported checks counts as pending, so a repo with no CI ends at the deadline, recorded as blocked) and exits 0 when every PR is ready, 3 on a conflict, 4 on unresolved threads, 5 on failing CI, 6 on a draft or requested changes and 7 while CI is pending. With several PRs the lowest nonzero code wins; 2 is a usage error and 1 a fetch error. On a host that plain `gh` cannot reach (github.a8c.com through proxychains), set `PR_STATE_GH` to the command, for example `PR_STATE_GH='proxychains4 -q -f ~/.proxychains.conf gh'`. The watcher exits on the first of:
   - a lane wrote or changed `result.md` or `waiting.md`;
   - CI finished: a `waiting.md` lists a `ci <n>` line for a head, the host has not relayed that head and attempt yet (the lane directory has no `ci relayed <sha> <n>` line; an old `ci relayed <sha>` line counts as attempt 1), and the PR's line has `head` equal to that SHA and `checksPending` 0. For `n` above 1 the PR's line still shows the earlier run's result until GitHub reports the rerun, so the watcher first needs a `ci pending <sha> <n>` line in `relayed.md`, which it writes the first time it sees that head with `checksPending` above 0 while `waiting.md` lists `ci <n>`; the wake is that line plus `checksPending` 0 again. A rerun that starts and ends between two checks leaves no such line and falls to the deadline, so nothing is relayed on the earlier result. Skip a lane that wrote `result.md`. Never key this on `tier`: a PR that still waits for review or is behind its base has a higher-ranked tier while its checks run. The condition is a state, so the relayed line is what stops it firing again;
   - the deadline: 90 minutes since the last event, unless `notes.md` records another.

   It prints which one fired. On each wake, act, then re-arm:
   - **CI finished:** send the lane the line's `tier`, `checksPending` and `checksFailing`, with `SendMessage`. Then append `ci relayed <sha> <n>` to `relayed.md` in the lane's directory, before you re-arm. A new head from a later push, or a rerun on the same head, needs a new `ci` line in `waiting.md` and fires once.
   - **Shared-resource gate requested:** run it yourself on the lane's pushed head, one run at a time per resource, save the output under the lane directory, then send the lane the gate line and the path.
   - **`result.md` written:** read it, update the plan, start the next queued PR.
   - **Deadline:** treat it as a stall. A lane that is idle with neither file written gets a message to continue from its notes. CI still pending re-arms once more; at the second deadline, record that PR as blocked with the check name. A `ci <n>` line never seen pending, with `checksPending` 0, re-arms once; at the second deadline, record that PR as blocked (rerun never seen pending). Never relay the current result in that case: it is the result from before the rerun. Never stop a resource you did not start; reclaim a stale lock only as [test-resources.md](test-resources.md) says.

   Never end a host turn while lanes are in flight and no watcher is armed.
5. **Deliver.** At its endpoint each lane performs only the recorded authority: push without force, then an APPROVE review at SAFE TO LAND with CI green, or at the circuit breaker a COMMENT review with one inline comment per open item. A lane never approves a PR the user authored. When the request did not authorize posting, the lane drafts the review into its directory, and the host shows every draft together and confirms them as **review batch** step 5 does. The lane writes `result.md`: verdict, review URL or `not posted`, commits pushed, gate lines, open items.
6. **Report.** One table with a row per PR: verdict, pushed SHAs, review URL or `not posted`, open items. Set the run state.

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
   - each slice's worktree, pre-warmed: create it, then run the dependency install and the baseline gate suite in it as a background task, so the builder's first gate run is warm;
   - a gate preflight: run each frozen gate's command once, including remote, sandbox and CI gates, to prove it can execute here (credentials, SSH agent, sandbox access, runtime version). A gate nobody can run stops the dispatch until access is fixed, the gate is replaced, or the user rules.

   Join. Run each criterion's command once in the slice's pre-warmed worktree, still at the base, and record `base: red`, `green` or `n/a`; rewrite or return any new-behavior criterion that is already green ([offload](../../offload/SKILL.md) step 4). Freeze each slice's acceptance gates as exact commands with expected results, with the spec reviewer's criteria folded in, before any code exists. From here on, nobody edits the gates. The builder and the later reviewer now hold the same bar. For each blocker of a rejection after green gates, record in `decisions.md` whether a frozen criterion named it (the builder missed it) or none did (the spec review missed it). A review-only rejection also records which kind of check could have caught it (`checkable: <tool>` or `checkable: no`; [offload](../../offload/SKILL.md) step 3 names the tags).
4. **Implement.** Pick the tier from Build work in SKILL.md: one slice goes to `offload`, two or more to `complete`, which dispatches slices with disjoint files in the first turn, except that slices sharing a brief shape go one first (see `complete`). Hand over the frozen plan, gates and council rulings. Keep running your own reviews and gates concurrently while it works, then merge its result and run the integration gates once (fleet tier only).
5. **Land.** Pass along the gates already frozen; don't re-derive them. One-slice tier: `offload`'s accepted slice review is the independent review, so skip **land** step 2's reviewer and rerun only the final gates on the delivered head. Fleet tier: run **land** from step 2 on the integrated result. Either way, findings on built code go back to the builder as an `offload` corrective (`dispatch-slice.sh … --corrective`, which reuses the warm builder), not as local fixes.

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
7. **Clean up and report.** Remove each comment-only worktree as `pr-review`'s Step 7 cleanup says, and never with `--force`. Keep AUTO-FIX worktrees until the run ends: setting the run `done` or `failed` removes every clean worktree in the run directory, so the AUTO-FIX patch must be a file in `<run>/pr-<number>/`. Report one table with a row per PR: verdict, critical and informational counts, review URL or `not posted`, patch path, leads. For each DO NOT LAND, name **land** as the next step. Don't start it.

## Council during a pipeline

Give council one narrow question, the live evidence (file:line, gate output), the constraints and the options. Log the ruling in `decisions.md` and apply it. A ruling that changes what the work must say or do follows offload's [judging.md](../../offload/judging.md): the text it dictates is checked against the code path, and it becomes a numbered criterion. If the ruling changes a frozen gate or the scope, it's a user question, not a council question.
