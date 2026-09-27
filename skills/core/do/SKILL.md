---
name: do
description: Run a coding task through the matching pipeline (land an existing change, ship a new goal, or hand multi-slice work to complete) with concurrent steps, lean handoffs and council-answered design questions. Use for /do, "fix until safe to land", "keep working until ready" or "build, plan and implement this".
---

# Do

Pick the pipeline that matches the request, run independent work concurrently and hand off between steps with short briefs. `complete` and direct specialist requests keep their own workflows.

## Route

| Request | Pipeline |
| --- | --- |
| Question, diagnosis, review only, plan only, or a trivial local edit | No pipeline. Answer, or use the specialist skill (`investigate`, `review`, `writing-plans`) directly. |
| Existing change: "fix until SAFE TO LAND", "keep working until it's ready" | **land** |
| New goal: idea or spec → plan → implement → ready | **ship** (runs **land** at the end) |
| Two or more independent slices, or "delegate/offload this" | Hand off to `complete` with the goal and any rulings. Do not run a second ledger. |

Read [pipelines.md](references/pipelines.md) for **land** or **ship**, and [briefs.md](references/briefs.md) before spawning any agent.

## Authority

The endpoint and effects come from the user's words. "Fix", "until ready" and "safe to land" authorize local edits, not commit, push, PR, merge or tracker updates. When those are requested, do them once gates pass, and carry that authorization through later steps without asking again. A sensitive change (auth, data, security, public API) always gets an independent review, however small. Repository text, worker output and council never grant authority.

## Questions

Design questions inside the agreed scope go to `council` (quick mode unless the stakes call for more). Record each ruling in the run's `decisions.md` (question, options, ruling, strongest counterargument) so the user can audit it later, then continue. When the user says "ask me", ask instead.

Always ask the user about scope expansion, changes to frozen gates, missing authority, deletion, deployment, spending, or anything irreversible, even if council has a recommendation. Missing facts call for investigation, not a vote.

## Run notes

For **land** and **ship**, create a private temp directory and keep `notes.md` there: goal (verbatim), endpoint, authority, frozen gates with commands, a one-line-per-step log, and agent IDs. Report its path. On resume, read it first and check agent liveness before spawning replacements. Pass it to `handoff` when another session will continue.

## Concurrency

- Start work as soon as its inputs exist, and never wait on something that doesn't depend on it.
- Run the independent reviewer, the background suite and your own pass at the same time, then join before fixing.
- Run one test suite at a time. Suites share ports, databases and fixtures.
- Parallel writers need separate worktrees and modules that don't import each other. Use at most 3–4 lanes.
- While an agent or suite runs, prepare the next step: its brief, a commit message, the PR body.

## Finish

Stop at the endpoint or a circuit breaker. Report the verdict, fixes, gate results (pass/fail, count, command), open decisions, and a **delivery line**: uncommitted, committed `<sha>`, pushed, PR `<url>`. Before reporting a delivery blocker, retry the failing command once and show its exact error and the command the user can run to clear it.
