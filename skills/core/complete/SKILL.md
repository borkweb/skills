---
name: complete
description: >
  Drive a goal to a merge-ready endpoint by orchestrating the offload architect
  loop: run contextual plan reviews, dispatch a configured builder harness slice-by-slice, wait
  for each slice via a backgrounded bridge (no Claude-side polling), judge raw gates
  plus an independent `review` pass per slice, and run a final integration `review`.
  STOPS at the edge of merge by default and hands to the human — only merges when
  the goal text explicitly authorizes it. You stay the ARCHITECT and never write
  implementation code. Use when the user says "complete", "drive this to done",
  "take this to merge-ready", "run the whole loop", or invokes /complete.
effort: xhigh
---

You are the **ARCHITECT/ORCHESTRATOR**. `offload` is your single-turn engine;
the **BUILDER** is whichever harness `~/.borkweb-skills/config.json` resolves to
(offload's `harness.mjs` picks it, with quota-aware failover). You never write
implementation code — you spec
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

- **Dispatch:** auto-dispatch each slice to the configured builder without re-asking, or pause for
  an OK each turn?
- **Merge** — ask this *only if* the goal authorized a merge (step 1): once the
  final review is clean, auto-merge, or pause for an OK first? If the goal did not
  authorize a merge, skip this question entirely — the endpoint is merge-ready and
  you will stop there regardless.

State the safety fact plainly: dispatch launches the builder with its permission
gates relaxed — codex `--dangerously-bypass-approvals-and-sandbox` (sandbox fully
off), opencode all-permissions config, grok `--always-approve`, claude
`--permission-mode auto` interactive / full bypass headless — with full local
access, merely launched from the repo dir. Name the flag for the harness actually
chosen. Record the chosen posture; honor it for the rest of the loop.

## 4. The loop — one slice per iteration

```
a. Invoke the `offload` skill for ONE architect turn. It arbitrates, judges any
   ready results, specs the next slice (freezing gates), emits the builder block,
   sets status=dispatched, and dispatches the builder. Honor the dispatch posture from
   step 3 — in pause mode, get the user's OK before offload dispatches.
b. After dispatch, launch the WAIT BRIDGE backgrounded (below). Then stop your
   turn — do NOT poll, do NOT ScheduleWakeup. The harness re-invokes you when the
   bridge exits.
c. On wake, read the background task's final `WAITER:` line and branch:
     WAITER: ready                       → go to (d)
     WAITER: builder-blocked …            → the builder flipped the handoff to `blocked`: it stopped on a
                                            mid-slice blocker and is waiting for a ruling. ARBITRATE NOW —
                                            follow "Arbitrating a stopped builder" below. This is not a
                                            judgment call and not a reason to wait.
     WAITER: builder-awaiting-input …     → the harness's own turn-end hook reported the builder stopped
                                            without flipping the handoff (blocked but didn't say so, hit a
                                            permission prompt, or finished without running `ready`).
                                            Same mandate: "Arbitrating a stopped builder" below.
     WAITER: builder-idle …               → no handoff flip, no turn-end, no session-log activity, no CPU.
                                            The idle detector now counts harness session-log writes as life,
                                            so a quiet verdict means the builder is not thinking, not
                                            streaming, and not writing — do NOT rationalize it as "just
                                            slow" and do NOT relaunch the bridge on a hunch. Treat it
                                            exactly like builder-awaiting-input.
     WAITER: builder-exited-without-ready → surface as a BLOCKER, pause, ask human
     WAITER: timeout …                    → surface, pause, ask human
     WAITER: never-started …              → no builder ever appeared: read the dispatch output for a launch failure, fix the cause, re-dispatch. Surface as a BLOCKER if it repeats
     WAITER: handoff-deleted …            → the handoff vanished mid-wait: STOP. Do not re-dispatch blindly — resolve the handoff path first, then ask the human
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

### Arbitrating a stopped builder (builder-blocked / builder-awaiting-input / builder-idle)

The lesson this procedure encodes: a builder once sat self-reported-blocked in
its pane for ~2 hours because the only wake signal was "results ready" and the
idle signal that DID fire was reasoned away as "probably just slow". The wake is
deterministic now; so is the response. In order, no steps skipped:

1. Read the builder pane (`herdr pane read <pane>` / `tmux capture-pane`) and
   the handoff's `## Open disagreements`.
2. Rule on every open item — accept / reject / modify, with one-line reasons —
   and record the rulings in the handoff (genuine judgment calls go through
   `council` first, per step 5).
3. Resume the builder: send the ruling into its pane. If it finished the slice
   but never ran `handoff.mjs ready`, tell it to report and stop.
4. Relaunch the bridge (same command as after a dispatch) and end your turn.

If after step 1 there is genuinely nothing to rule on — no disagreement, no
question, no prompt, pane mid-stream — relaunch the bridge once and say so in
your status line. If the same signal fires again, surface it as a BLOCKER and
ask the human. Never relaunch more than once without new evidence.

### The wait bridge (push, not poll)

The builder already ends its run with `handoff.mjs ready`, flipping the handoff
to `results-ready`. The bridge turns that file-write into a harness wake-up so the
Claude side never polls. After each dispatch, run:

```
Bash(run_in_background: true):
  HANDOFF=$(node "<…>/offload/handoff.mjs" resolve "$PWD")
  bash "<core>/complete/wait-for-ready.sh" "$HANDOFF" builder
```

Re-resolve `$HANDOFF` with the offload `resolve` subcommand here — shell variables
do not survive the harness wake between dispatch and this bridge, and `resolve`
deterministically returns this session's one canonical handoff (it refuses if
`$CLAUDE_CODE_SESSION_ID` is empty — surface that, don't guess a path). Resolve
`<core>` as the parent of the offload dir from the SessionStart
`[offload]` line (i.e. `wait-for-ready.sh` sits next to the offload dir under
`skills/core/`). The script blocks — via `fswatch` when available, else a cheap
detached sleep-poll — until one of its deterministic signals fires, then exits
with a final `WAITER:` line. All of that runs outside your context: zero tokens
until it wakes you. The signals, strongest first:

- the handoff flips to `results-ready` (builder ran `handoff.mjs ready`) or
  `blocked` (builder ran `handoff.mjs blocked` on a mid-slice blocker);
- `"$HANDOFF.turn-ended"` appears — dispatch wires the harness's own turn-end
  hook (codex `notify`, claude `Stop`/`Notification`) to touch it the moment
  the builder stops and waits for input, so even a builder that never reports
  wakes you in seconds, not hours;
- idle backstop: builder pid alive but no session-log activity (the
  `"$HANDOFF.activity"` sidecar dispatch writes) AND no CPU for the idle
  window;
- liveness/timeout backstops: builder died, never started, handoff deleted,
  or the overall deadline passed.

## 5. Field questions through council

When you hit a genuine judgment call — an arbitration ruling, a scope dispute, a
design fork — field it through `council` before deciding, rather than guessing.
The builder block already instructs the builder to resolve its own ambiguity via
the bork:council skill before coding (see the offload builder block).

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
- Never poll or ScheduleWakeup for the builder — the wait bridge wakes you. A short-poll
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
- Re-resolve `$HANDOFF` via the offload `resolve` subcommand on every wake — never
  carry a stale path or write to a handoff you don't own. An ownership `refusing:`
  error from the CLI is the wrong-document tripwire: STOP and surface it, never
  `--steal` past it.
