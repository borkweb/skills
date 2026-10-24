## External-session workflow

You are the **ARCHITECT/ORCHESTRATOR**. `offload` is your single-turn engine;
the **BUILDER** is whichever harness `~/.borkweb-skills/config.json` resolves to
(offload's `harness.mjs` picks it, with quota-aware failover). You never write
implementation code: you spec slices, judge raw gate numbers, and drive the loop
to **merge-ready**. The human is the final judge and the one who merges, unless
the goal explicitly told you to.

`/complete <goal>` wraps `offload` (one architect turn) in a loop over a fleet of
slices. Everything `offload` does (handoff, arbitration, gate judging, spec review,
builder block, dispatch) still happens; this skill adds the loop, the **slice
ledger**, the wait bridges, council policy and the final readiness gate.

**Progress is read from `board`, never from memory.** A handoff doc is one
builder's mailbox; it cannot tell you the state of the other slices, and it has no
way to say "this slice is finished." The ledger can. Three hooks put the board in
front of you so you never have to remember it: SessionStart (including the wake
after a compaction) prints it with your handoff path; every bridge prints it under
its `WAITER:` line; and the Stop hook refuses a turn end once while the ledger
still owes a judgment, a ruling or an owner. Every claim you make to the human
about what is running, done or stuck comes from the board of that same turn.

## 1. Resolve goal + endpoint

**The default endpoint is merge-ready, NOT merged.** Build every slice, pass each
per-slice `review`, land a clean final integration `review`, then STOP at the edge
of merge and hand to the human with the branch and the exact merge command.

Only set the endpoint to **merged** when the user's instructions explicitly
authorize it: "merge into main", "and merge", "land it", "all the way to main",
"merge it". A bare "complete", "to completion", "done", "ship it" or "run the loop"
does **not** authorize a merge. When in doubt, do not merge. Hold the goal text
verbatim; you check remaining scope (and whether merge was authorized) against it
every turn.

## 2. Open the ledger first, before any slice exists

Resolve `SID` with `node "<…>/handoff.mjs" key`. This supports native Claude and
namespaced Codex identities. Never export a Codex id as a Claude session id.

```
node "<…>/handoff.mjs" ledger init "$PWD" "<the goal, verbatim>"
```

This is the architect's own file, one per session, and **builders never write
it**. It is the only place a slice's terminal state lives. Each slice also gets
its own handoff doc (`handoff.mjs init "<worktree>" "$SID"`), the builder's
mailbox: spec in, gates out. Two different records; do not conflate them.

Register a slice the moment you spec it, and update it the moment its state
changes:

```
node "<…>/handoff.mjs" ledger add "$PWD" --id 3 --title "inline axis widths" \
  --branch fix/inline-axis-widths --slice-cwd "<worktree>" --handoff "<doc>" --state specced
node "<…>/handoff.mjs" ledger set "$PWD" 3 --state dispatched --pane wY:p22
node "<…>/handoff.mjs" ledger set "$PWD" 3 --state accepted \
  --verdict "SAFE TO LAND · unit 2312/0/0 · integration 10/0/0" --pr <url>
```

States: `specced → dispatched → blocked | results-ready → accepted | rejected`,
plus `merged` and `abandoned`. The four terminal states are the point: a slice you
have accepted, rejected, merged or dropped is written terminal in the same turn you
decide it, or it reads as in-flight forever. The ledger stamps every state change
(`history`) and the board records when a doc first reported (`results_at`), so
`handoff.mjs ledger report "$PWD"` can show where the hours went afterwards; keep
the verdict text precise (gate numbers; "review = do not land: <why>") because the
report classifies rejections from it.

## 3. Slice the plan and review the specs, before the first gates are frozen

Cut the plan into slices of one coherent feature each, split only where files or
contracts separate (offload's *Slice size*). Fewer, larger slices beat many small
ones: every slice costs a spec review, a dispatch, a review and a handoff.

Run these concurrently, as read-only agents:

- for each slice, a **spec reviewer** (`do`'s briefs.md) with the `review`
  checklist and `do`'s review-criteria.md over the slice spec, returning the
  acceptance criteria it would reject on (correctives skip this: their criteria
  are the blockers);
- the plan review(s) the first slice's surface calls for (more than one can apply):
  architecture / data flow / concurrency / migrations → `plan-eng-review`;
  UI / visual / interaction → `plan-design-review`;
  a developer-facing contract someone else builds against (API, CLI, SDK, library,
  public interface, docs) → `plan-devex-review`. Skip them for a trivial goal and
  say so.

Join. Fold the spec reviewers' criteria into each slice's frozen gates and builder
brief, so the builder and the acceptance reviewer hold the same bar. A DO NOT LAND
after green gates later means a criterion was missed here; record it under
*Decisions + why* so the next spec review covers it.

## 4. Resolve authorization once

Carry the user's existing dispatch, commit, push and merge instructions into the
ledger. Do not repeat settled questions. If dispatch would relax permissions
beyond existing authorization, identify the actual configured harness flags and
obtain that authorization before launch; otherwise proceed. Do not reinterpret
merge-ready as merge permission.

## 5. The loop: slices run concurrently; the board is the state

### Builder launch invariant — `dispatch.sh` only

Every builder launch MUST go through `offload` and its `dispatch.sh`. Concurrency
does not change the launcher; it means several independently dispatched slices
are alive at once. Invoke `offload` once per slice and let its dispatcher resolve
the harness and frontend.

Never create a builder with raw `herdr agent start`, `herdr agent spawn`,
`herdr pane split`, `tmux new-window`, Terminal, or a headless harness command.
Those paths bypass offload's handoff marker, activity/turn-end wiring, duplicate
builder guard, harness failover and herdr-tab guarantee. Raw herdr commands are
only for supervising a builder `dispatch.sh` already launched: reading its pane,
sending a ruling, focusing its tab, resuming its process.

The dispatcher's success line is the postcondition. Inside herdr it names
`new herdr tab <tab_id>`, the workspace and the root pane. A pane id without a tab
id is a failed dispatch: Do not set the slice to `dispatched`, record its pane in
the ledger, or arm its wait bridge; surface the launch failure and correct it
through `offload`. The ledger enforces this: `ledger add/set --pane` refuses a
pane that lacks dispatch.sh's signature (a herdr tab labeled `builder` holding one
pane), and `board` flags one that slipped in as `UNMANAGED PANE`. On a refusal,
re-dispatch through `offload`; `OFFLOAD_ALLOW_UNVERIFIED_PANE=1` exists for a
frontend the check cannot see, not for routing around a failed dispatch.

### Fan out

On the first turn, spec every slice the plan separates (step 3 already reviewed
them), then dispatch every slice whose files are disjoint in this same turn, up to
3–4 lanes. Each gets its own worktree, handoff doc, ledger row and bridge, from
one `dispatch-slice.sh` call per slice (offload's *Dispatch*); the calls fit in a
single Bash invocation, and their `NEXT` lines then run as background calls in the
same response. Pre-warm the worktrees (install, baseline suite) while the spec
reviewers run, so the builders' first gate runs are warm. Serialize only on a real
file or dependency conflict; a slice that waits for a sibling waits in `specced`,
and you dispatch it in the turn the sibling's row goes terminal. There is no
turn-taking between slices and you never hold the fleet in your head.

### Each wake

1. Read the board (it arrived with the wake). Act on its flags in this order:

   | Flag | Action |
   | --- | --- |
   | `NO OWNER` | A dispatched slice whose builder exited with no bridge armed. Nobody is working it. Judge what it produced and mark it terminal, or dispatch a corrective onto the same branch. Never leave a wake with a NO OWNER row. |
   | `NEEDS ARCHITECT` | Arbitrate (blocked) or judge the gates (results-ready). |
   | `MISMATCH` | The builder's doc moved past your ledger. The doc is the builder's word: act on it, then bring the ledger level. |
   | `CORRUPT DOC` | Rewrite the status; until then that slice's bridge is deaf. |
   | `DOC MISSING` | STOP. Do not re-dispatch blindly; surface it. |
   | `UNMANAGED PANE` | The recorded pane did not come from dispatch.sh; no signal can reach you from it. Judge what it produced, mark the slice terminal, re-dispatch through `offload`. |

2. Read the bridge's `WAITER:` line and branch per [wait-signals.md](wait-signals.md).
   `ready` → run `offload` on that slice: its step 0 judges the raw gates and runs
   the acceptance `review`, which already applies the spec reviewer's criteria.
3. Branch on the verdict:
   - gates or review fail → `ledger set … --state rejected --verdict "<why>"`;
     relay every confirmed defect in one batch; `offload` specs one corrective
     slice onto the same branch and sends it with `dispatch-slice.sh … --corrective`,
     which reuses the warm builder when it is still at its prompt.
   - gates pass and review clean → `ledger set … --state accepted --verdict "<raw numbers>"`.
   - scope left → dispatch the next ready slice(s).
   - goal met across all slices → step 7.
4. `dispatch-slice.sh` has already set the row to `dispatched` with the verified
   pane; arm that slice's bridge by running its printed `NEXT` line in the
   background (below). Then end the turn; the bridge wakes you. Do not read the
   builder pane for progress and do not ScheduleWakeup for it.

Write terminal states as you decide them, in the same turn, including reversals:
an `accepted` row that CI or a later regression proved wrong goes back to
`rejected` with the reason the turn you learn it. The Stop hook refuses the turn
end once if a row still owes a judgment, a ruling or an owner; when a human ruling
is genuinely required, say so and end the turn.

### Leaving the run unattended

In-session bridges die with the session. Before the user closes it, run
`bash "<core>/complete/unattended.sh" "$PWD"`: for every live slice it stops the
in-session bridge and starts a detached `architect-wake.sh` chain that resumes
this session headlessly when the bridge fires, prompt = the `WAITER:` line plus
the board. In that mode every dispatch and corrective uses
`dispatch-slice.sh … --unattended`, which arms the next chain itself. Wakes run
under `--permission-mode auto` unless `OFFLOAD_WAKE_PERMISSIONS=bypass`; a denied
command or a needed human ruling is written to the handoff's *Open
disagreements* and the turn ends. Each wake appends to `<handoff>.wake.log`; read
those and the board when the user returns. Claude architects only.

### Compaction is safe at a slice boundary

The SessionStart hook restores the board and your handoff path after a
compaction, so a long run no longer has to carry slice state in its context. When
the session-budget check says COMPACT, say so in the status line at the next
terminal state and do not defer it; nothing a wake needs lives only in context.

### Reporting progress

Every status you give the human (a table, "still running", "two are done") is
assembled from this turn's board. If a claim is not on it, run `board` again or
say you do not know.

### The wait bridge (push, not poll)

The builder ends its run with `handoff.mjs ready`, flipping the handoff to
`results-ready`. The bridge turns that file write into a harness wake-up. After
each dispatch, run the `NEXT` line `dispatch-slice.sh` printed, as a background
Bash call:

```
Bash(run_in_background: true):
  WFR_BOARD_CWD="<repo>" bash "<core>/complete/wait-for-ready.sh" "<the slice's handoff>" builder
```

One bridge per dispatched slice, each on that slice's own handoff. To re-arm a
bridge on a later wake, re-derive the path with
`node "<…>/offload/handoff.mjs" path "<the slice's worktree>" "$SID"` (or
`resolve "$PWD"` for a slice in the repo root); shell variables do not survive the
harness wake, and both commands refuse when the native session variables are
empty: surface that, don't guess a path. `WFR_BOARD_CWD` makes the bridge print
the board under its `WAITER:` line, so the wake arrives with the fleet's state. The script blocks outside your context (zero tokens) until a
signal fires: the handoff flips to `results-ready` or `blocked`; the harness's own
turn-end hook settles; the idle backstop; or the liveness/timeout backstops. The
signals and what each one asks of you are in [wait-signals.md](wait-signals.md).

## 6. Field questions through council

When you hit a genuine judgment call (an arbitration ruling, a scope dispute, a
design fork), use `council` when the stakes justify multiple perspectives; resolve
routine choices from the frozen scope and available evidence. The builder block
already instructs the builder to report material unresolved ambiguity before
dependent coding.

## 7. Finish: merge-ready by default, merge only if authorized

Reached when **every ledger row is terminal**, every accepted slice's gates passed
and its per-slice `review` was clean, AND the goal text is fully delivered with
the authorized commit/push steps completed (or an explicit no-push record). Run
`board` and confirm that first: a non-terminal row means you are not finished,
however complete it feels.

1. **Final integration review, the readiness gate.** Run `review` on the FULL
   branch diff against the base; per-slice reviews can't see cross-slice
   integration issues. Treat the verdict as the gate:
   - **SAFE TO LAND** → ready.
   - **LAND WITH CAUTION** → ready, carry the caveats into the report.
   - **DO NOT LAND** → not ready. Feed the blockers back as a corrective slice
     (step 5) and re-run this gate after it lands clean.

   A per-slice gate set proves only what it measured. Before accepting the last
   slice, check what the repo's own CI runs that your frozen gates did not; a
   green local suite next to a red pipeline is a failed slice.

2. **Default: STOP at merge-ready. Do NOT merge.** Report and hand to the human:
   goal, slices shipped, commit SHAs, final gate and review verdicts (and any LAND
   WITH CAUTION caveats), all from `board`; the branch name and the exact merge
   command. Add `handoff.mjs ledger report "$PWD"` so the human sees where the time
   went. Leave the handoffs and the ledger in place for follow-up; do not end them.

3. **Merge, only if the goal explicitly authorized it (step 1).** Use the existing
   authorization without asking again; integrate via the repo's standard path (the
   builder completed each slice's authorized delivery steps, so this is the PR
   merge / fast-forward, not new code; prefer `gh` for a GitHub repo); set each
   merged slice `--state merged`; end the handoffs (`handoff.mjs end "$HANDOFF"`);
   report as in step 2 plus the merge result.

## Hard rules

- You never write implementation code. If tempted, hand a tighter slice to offload.
- Every builder launch goes through `offload` and `dispatch.sh`. A herdr pane id
  without a tab id is a failed launch. The ledger refuses an unmanaged pane and
  `board` flags one that slipped in; treat either as a dispatch to redo.
- Report only what this turn's board says. Slice state narrated from memory
  cannot see a builder that exited and does not survive a compaction.
- Write terminal states, including reversals, in the turn you decide them.
- Resolve every `NO OWNER` row before the turn ends: judge it or dispatch a
  corrective. Diagnosing without dispatching leaves the slice with nobody on it.
- Never poll or ScheduleWakeup for a builder; the bridge wakes you.
- Never hand-delete a `.turn-ended` marker or hand-splice a handoff's markdown.
- Verdicts come from raw gate numbers vs frozen gates, never the builder's prose.
- Nothing is merge-ready until every slice passed `review` and the final
  integration `review` returns no DO NOT LAND.
- Never edit frozen gates after results exist.
- Default is stop-at-merge-ready. Merge only when the goal text explicitly
  authorized it; when ambiguous, stop and hand to the human.
- The handoffs and the ledger are session-scoped and never committed.
- Re-derive each handoff path via `resolve`/`path` on every wake. An ownership
  `refusing:` error from the CLI means the wrong document: stop and surface it,
  never `--steal` past it.
