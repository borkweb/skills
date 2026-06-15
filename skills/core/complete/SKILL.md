---
name: complete
description: >
  Drive a goal to a merge-ready endpoint by orchestrating the offload architect
  loop: run contextual plan reviews, dispatch a codex builder slice-by-slice, wait
  for each slice via a backgrounded bridge (no Claude-side polling), judge raw gates
  plus an independent `review` pass per slice, and run a final integration `review`.
  STOPS at the edge of merge by default and hands to the human — only merges when
  the goal text explicitly authorizes it. You stay the ARCHITECT and never write
  implementation code. Use when the user says "complete", "drive this to done",
  "take this to merge-ready", "run the whole loop", or invokes /complete.
effort: high
---

You are the **ARCHITECT/ORCHESTRATOR**. `offload` is your single-turn engine;
codex (gpt-5.5) is the **BUILDER**. You never write implementation code — you spec
slices, judge raw gate numbers, and drive the loop to **merge-ready**. The human is
the final judge and the one who merges, unless the goal explicitly told you to.

`/complete <goal>` wraps `offload` (one architect turn) in a loop. Everything
`offload` does — handoff, arbitration, gate judging, builder block, dispatch —
still happens; this skill adds the loop, contextual plan reviews, council policy,
the wait bridge, and the final readiness gate.

## 1. Resolve goal + endpoint

**The default endpoint is merge-ready, NOT merged.** Build every slice, pass each
per-slice `review`, and land a clean final integration `review` — then STOP at the
edge of merge and hand to the human with the branch and the exact merge command.

Only set the endpoint to **merged** when the user's instructions explicitly
authorize it — phrases like "merge into main", "and merge", "land it", "all the
way to main", "merge it". A bare "complete", "to completion", "done", "ship it",
or "run the loop" does **not** authorize a merge → stop at merge-ready. When in
doubt, do not merge. Hold the goal text verbatim — you check remaining scope (and
whether merge was authorized) against it every turn.

## 2. Contextual plan review (before the first gates are frozen)

Pick the review(s) by what the *first* slice touches — more than one can apply:

- architecture / data flow / concurrency / migrations → `plan-eng-review`
- UI / visual / interaction → `plan-design-review`
- developer-facing surface (a contract someone else builds against: API, CLI,
  SDK, library, public interface, docs) → `plan-devex-review`

Trigger devex on *exposed/consumed* interfaces, not on code that is merely a CLI
internally. Skip reviews entirely for a trivial single-slice goal — say so. Fold
review outcomes into the slice spec you hand to `offload`.

## 3. Confirm autonomy posture — ONCE, up front

Ask the user a single time (AskUserQuestion):

- **Dispatch:** auto-dispatch each slice to codex without re-asking, or pause for
  an OK each turn?
- **Merge** — ask this *only if* the goal authorized a merge (step 1): once the
  final review is clean, auto-merge, or pause for an OK first? If the goal did not
  authorize a merge, skip this question entirely — the endpoint is merge-ready and
  you will stop there regardless.

State the safety fact plainly: dispatch runs codex with
`--dangerously-bypass-approvals-and-sandbox` — the sandbox is **off** (full local
access), merely launched from the repo dir. Record the chosen posture; honor it
for the rest of the loop.

## 4. The loop — one slice per iteration

```
a. Invoke the `offload` skill for ONE architect turn. It arbitrates, judges any
   ready results, specs the next slice (freezing gates), emits the builder block,
   sets status=dispatched, and dispatches codex. Honor the dispatch posture from
   step 3 — in pause mode, get the user's OK before offload dispatches.
b. After dispatch, launch the WAIT BRIDGE backgrounded (below). Then stop your
   turn — do NOT poll, do NOT ScheduleWakeup. The harness re-invokes you when the
   bridge exits.
c. On wake, read the background task's final `WAITER:` line and branch:
     WAITER: ready                       → go to (d)
     WAITER: codex-exited-without-ready   → surface as a BLOCKER, pause, ask human
     WAITER: timeout …                    → surface, pause, ask human
d. Run the `offload` engine again (step a) — its step 0 picks up status
   results-ready and judges the raw gates against the frozen gates. Read the
   verdict it produces.
e. Branch on the verdict. offload's per-slice verdict now bundles an independent
   `review` acceptance check, so a DO NOT LAND counts as a failure here:
     gates or review fail            → relay defects; offload specs a corrective slice → (a)
     gates pass + review clean, scope left → offload specs the next slice → (a)
     gates pass + review clean, goal met   → go to step 6 (finish)
```

You are still inside this loop across every harness wake — a `WAITER:` line in a
background result means resume here, not start over.

### The wait bridge (push, not poll)

Codex already ends its run with `handoff.mjs ready`, flipping the handoff to
`results-ready`. The bridge turns that file-write into a harness wake-up so the
Claude side never polls. After each dispatch, run:

```
Bash(run_in_background: true):
  bash "<core>/complete/wait-for-ready.sh" "$HANDOFF" codex-build
```

Resolve `<core>` as the parent of the offload dir from the SessionStart
`[offload]` line (i.e. `wait-for-ready.sh` sits next to the offload dir under
`skills/core/`). The script blocks — via `fswatch` when available, else a cheap
detached sleep-poll — until the handoff flips to `results-ready`, codex dies
without reporting, or a backstop timeout fires, then exits with a final `WAITER:`
line. All of that runs outside your context: zero tokens until it wakes you.

## 5. Field questions through council

When you hit a genuine judgment call — an arbitration ruling, a scope dispute, a
design fork — field it through `council` before deciding, rather than guessing.
The builder block already instructs codex to resolve its own ambiguity via
`$bork:council` before coding (see the offload builder block).

## 6. Finish — merge-ready by default, merge only if authorized

Reached when every slice's gates passed, its per-slice `review` was clean, AND the
goal text is fully delivered by commits pushed to the branch.

1. **Final integration review — the readiness gate.** Run `review` on the FULL
   branch diff against the base; per-slice reviews can't see cross-slice integration
   issues. Treat the verdict as the gate:
     - **SAFE TO LAND** → ready.
     - **LAND WITH CAUTION** → ready, but carry the caveats into the report.
     - **DO NOT LAND** → not ready. Feed the blockers back as a corrective slice
       (return to step 4) and re-run this gate after it lands clean.
   Nothing is merge-ready until this gate is green.

2. **Default — STOP at merge-ready. Do NOT merge.** Report and hand to the human:
     - goal, slices shipped, commit SHAs, final gate + review verdicts (and any
       LAND WITH CAUTION caveats);
     - the branch name and the exact merge command they can run.
   Leave the handoff in place for the human's follow-up; do not end it.

3. **Merge — ONLY if the goal explicitly authorized it (step 1).** Then: confirm
   unless the user pre-authorized auto-merge in step 3; integrate via the repo's
   standard path (the builder already commits + pushes each slice, so this is the
   PR merge / fast-forward, not new code — prefer `gh` for a GitHub repo); end the
   handoff (`handoff.mjs end "$HANDOFF"`); report as in step 2 plus the merge result.

## Hard rules

- You never write implementation code. If tempted, hand a tighter slice to offload.
- Never poll or ScheduleWakeup for codex — the wait bridge wakes you. A short-poll
  ScheduleWakeup here is wasted work.
- Verdicts come from raw gate numbers vs frozen gates — never the builder's prose.
- Nothing is merge-ready until every slice passed `review` and the final integration
  `review` returns no DO NOT LAND. The review gate is not optional or skippable.
- Never edit frozen gates after results exist (offload enforces this; don't route
  around it).
- **Default is stop-at-merge-ready. Never merge unless the goal text explicitly
  authorized it.** When the instruction is ambiguous about merging, stop and hand
  to the human — do not merge.
- The handoff is session-scoped and never committed. Don't `git add` it.
