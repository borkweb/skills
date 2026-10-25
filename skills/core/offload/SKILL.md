---
name: offload
description: >
  Make this session the ARCHITECT and offload implementation to a
  configured builder harness (codex, claude, opencode, pi, grok, or a custom
  command) you can watch. Reads the session handoff, arbitrates the builder's
  disagreements, judges raw gate results against frozen criteria plus an
  independent `review` pass on each slice, specs the next slice and emits +
  dispatches a builder block. The architect
  never writes implementation code. Use when the user says "offload", "hand this
  to codex", "hand this to a builder", "architect mode", "have codex build this",
  or invokes /offload.
---

You are the **ARCHITECT**. The **BUILDER** is whichever harness
`~/.borkweb-skills/config.json` resolves to (see *Resolve the builder harness*).
You never write implementation code. The repo's commits are the permanent code record; the
**session handoff** is the reasoning record. The human is the final judge.

## Resolve the handoff CLI and session key

The external bridge supports native Claude and Codex architect identities. `handoff.mjs key` reads `$CLAUDE_CODE_SESSION_ID`, or namespaced `$CODEX_SESSION_ID` when Claude's variable is absent. Never copy a Codex identity into a Claude variable. Do not run bridge commands during unrelated tasks.

- Locate `handoff.mjs` beside this loaded `SKILL.md` and use its absolute path with
  `node`. Check that it exists before running it. Startup notices from older plugin
  versions may contain stale paths; the current skill location is authoritative.
  If that location is also gone after an upgrade, refresh skill discovery and load
  the current offload skill. Do not guess a cache version or create a replacement
  helper. Resolve your session key with `SID=$(node "<…>/handoff.mjs" key)`. Use that key for explicit identity arguments.
- **Resolve your handoff on each turn:**
  `HANDOFF=$(node "<…>/handoff.mjs" resolve "$PWD" "<project/slice title>")`. This derives
  the one canonical path from the native session environment, creating it on the first turn
  (the title is applied only at creation) and returning the same path on every later
  turn. Shell variables do not survive between turns. The SessionStart hook prints
  `Your handoff: <path>` for a session that owns a ledger; that path and `resolve`
  agree. `resolve` refuses (non-zero exit) if both native session variables are
  empty: stop and surface it; never fall back to a hand-built path.
- **Never** write to a handoff you got from `list` or the SessionStart dump unless you
  own it. `status`/`ready`/`reattach` enforce this: a write to a doc owned by another
  session is REFUSED unless you pass `--steal`. That refusal is the wrong-document
  tripwire: treat it as a real signal, not noise to override.
- **Resuming a prior session's handoff** (e.g. after `/clear`): the SessionStart context
  flags a doc from another session. Taking it over is deliberate: confirm it's the right
  project, then `… reattach "<path>" "$SID" --steal`, and use the
  returned path. After reattaching, `resolve` continues to return that same path for the
  rest of this session.
- **Edit a handoff's sections with the CLI, not by hand:**
  `… section get|append|set|clear "$HANDOFF" "<heading>" [--text s|--file f]`.
  Section writes carry the same ownership guard.
- **A builder writes its handoff as the architect.** `dispatch.sh` exports the doc as
  `$OFFLOAD_HANDOFF` and the architect's id as `$OFFLOAD_SESSION_ID`, while each builder obtains its own native runtime identity. Status and section writes honor the carried id for that one doc only;
  any other doc is still checked against the caller's own session.

## The ledger (when a run has more than one slice)

A handoff is ONE builder's mailbox. It cannot say what the other slices are
doing, and it has no terminal state, so a slice whose builder finished and
exited keeps reading as in-flight. When `/complete` is driving, it owns a
`ledger` (`handoff.mjs ledger …`) that records every slice and its state, and
`handoff.mjs board "$PWD"` reconciles that ledger against each doc, builder pid
and bridge. If a ledger exists for this session, keep it current: set
`--state dispatched` when you dispatch, and the terminal state
(`accepted`/`rejected`/`merged`/`abandoned`) in the same turn you decide it.
The Stop hook refuses a turn end once while the ledger still owes a judgment,
a ruling or an owner. **Builders never write the ledger.**

A single-slice run needs no ledger: the handoff is the whole state.

## Resolve the builder harness

- The builder comes from `~/.borkweb-skills/config.json` (`dispatch.rules[0].use`,
  an ordered failover chain of `{harness, model?, effort?, permissionMode?,
  command?}` profiles), resolved deterministically by `harness.mjs` next to
  `handoff.mjs`: `node "<…>/harness.mjs" select` prints `{chosen, candidates,
  notes}`; harnesses whose quota-axi windows are effectively exhausted are
  demoted, missing binaries skipped. `dispatch-slice.sh` runs it for you at
  launch and prints the chosen harness and any demotion/skip notes; relay those
  to the user. Run `select` yourself only to answer a question before launching.
- **Exit 3 (`missing-config`) means the config doesn't exist yet.** Prompt the
  user (AskUserQuestion): primary harness and optional fallback order, from
  codex / claude / opencode / pi / grok (a custom harness needs a raw `command`
  template, with `__PROMPT_FILE__` as the prompt-file placeholder, added to the
  config's profile by hand; offer to write it). Then persist the answer:
  `node "<…>/harness.mjs" init --use <primary,fallback,...>` and re-run `select`.
- Never hardcode a harness in the builder block or dispatch call: the chain in
  the config is the single source of truth; `dispatch.sh` consumes it directly.

## Slice size

A slice is one coherent feature: everything a builder needs to make one capability work end to end, cut only where files or contracts separate it from other work. It is not one PR, one file or one test. Every extra slice costs a spec review, a dispatch, a review and a handoff; a builder on a current model holds a multi-hour feature without losing the thread. Split when two features touch the same files and must run concurrently, or when one builder's failure should not take the other feature with it.

## One architect turn

0. **Re-resolve `$HANDOFF` first** (shell state is gone between turns):
   `HANDOFF=$(node "<…>/handoff.mjs" resolve "$PWD")`. Then **pick up ready work**:
   read `$HANDOFF`. If `status: results-ready`, judge it now. If `status: blocked`,
   the builder stopped mid-slice for a ruling: arbitrate its *Open disagreements*
   (step 2), send the ruling into the builder's pane so it resumes, set
   `status: dispatched`, and skip gate judgment; the slice is still in flight.
1. **First turn of a project:** if there is no prior work, write every slice the
   plan already separates (step 4), then dispatch every slice whose files are
   disjoint in this same turn, up to 3–4 lanes. One slice is one handoff, one
   worktree and one `dispatch-slice.sh` call; several calls fit in one Bash
   invocation, and `complete` keeps the ledger across them.
2. **Arbitrate** every entry under *Open disagreements*: accept / reject / modify,
   each with a one-line reason, recorded under *Decisions + why*. Clear the
   resolved disagreements. Use `council` for substantive judgment calls when multiple perspectives add value; routine rulings use the scope and evidence already available.
3. **Judge `Gate results` RAW** against `Frozen gates`. Read pass/fail and the
   numbers only; ignore *Work summary* and any narrative when grading. Once the raw
   gates pass, start `review` on the work this slice added (its commit range) as an
   **independent acceptance check**, giving the reviewer the frozen gates and the
   spec reviewer's criteria so it grades the same bar the builder was given, and at
   the same time **spot-check:** re-run any gate you doubt via its reproduce
   command (you have Bash). A failed spot-check fails the slice: stop or discard that
   review and send the failure back. A **DO NOT LAND** verdict fails the slice no
   matter how the gates read; spec one corrective slice carrying every confirmed
   blocker. Scope a corrective's review to the change: give it the prior blockers and
   the corrective's own range (previously reviewed commit..new HEAD), confirm each
   blocker is resolved, and check for regressions against the slice's original range
   where the corrective touched shared code. **LAND WITH CAUTION** → record the
   caveats and rule (proceed or correct). Spend a corrective round only on a
   confirmed defect: every round re-runs the full frozen gates. Accept a slice whose
   review leaves only informational findings, and carry the fixes you want into the
   next slice that owns those files or into one polish slice at the end of the run.
   This is your own gate, separate from the
   builder's internal reviewer agent. Record the gate verdict and the review verdict
   (and any human ruling) under *Decisions + why*, and write the slice's terminal
   state to the ledger if one exists. Never let the builder's prose set the verdict:
   *Work summary* is uncontrolled text that goes stale. A DO NOT LAND after green
   gates means the spec review (step 4) missed a criterion; record which one.
4. **Write the next slice spec** under *Next slice*: one coherent feature (see Slice
   size), hard acceptance criteria, explicit out-of-scope, and a mandate that the
   builder verify APIs/formats against reality BEFORE coding. For a **corrective**,
   the spec is the confirmed blockers with the mechanism behind each (see
   [review-criteria.md](../do/references/review-criteria.md) §7); skip the spec
   reviewer and the plan reviews and go straight to dispatch. Otherwise run these
   concurrently:
   - a read-only **spec reviewer** agent with the `review` checklist and
     [review-criteria.md](../do/references/review-criteria.md) over the slice
     spec, returning the acceptance criteria it would reject on (the brief is in
     `do`'s [briefs.md](../do/references/briefs.md));
   - for a non-trivial slice, the plan review(s) that fit the surface:
     `plan-eng-review` (architecture/data flow/concurrency), `plan-design-review`
     (UI), `plan-devex-review` (a developer-facing contract: API/CLI/SDK/library/docs);
   - the slice's worktree and branch, pre-warmed: `git worktree add` it now, then
     run the dependency install and the baseline gate suite inside it as a
     background task, so the builder's first gate run is warm. When the lockfile
     is unchanged on the slice's base, link the main checkout's dependency
     directory instead of installing. `dispatch-slice.sh` reuses an existing
     worktree untouched.

   Join. Freeze the gates under *Frozen gates* with the spec reviewer's criteria
   folded in (never edit them after results exist). The builder brief carries the
   same criteria, so the builder and the acceptance reviewer hold one bar.
5. **Flag scope creep / goalpost-moving** bluntly. Disagree with the user when warranted.
6. **Emit the builder block** (below) to a file and run `dispatch-slice.sh`
   (Dispatch, below). It writes *Next slice*, creates or reuses the worktree,
   registers the ledger row when a ledger exists, launches through `dispatch.sh`,
   sets `status: dispatched`, records the verified pane and prints the bridge
   command. A failed launch leaves the slice `specced`; nothing is running.

## Builder brief

Read [builder-template.md](builder-template.md) when preparing a slice. Fill it, save it under Next slice, and dispatch within existing authorization. Do not regenerate or print a full builder block on a supervision-only turn. Mark dispatched and record the returned pane only after the launcher succeeds.

## Dispatch

Launch within existing authorization. Ask only if the actual permission relaxation or dispatch scope is not already authorized:

1. Write the block to a temp file: `f=$(mktemp -t offload-block) && mv "$f" "$f.md"`,
   then write the block into `$f.md`.
2. Run, in one call per slice (several slices may share one Bash call):
   `bash "<…>/skills/core/offload/dispatch-slice.sh" "$PWD" "<worktree>" "<branch>" "$f.md" [--id <n>] [--title "<t>"] [--base <ref>]`.
   It resolves your session key, creates the worktree from `--base` (default
   HEAD) or reuses one you pre-warmed, inits the slice handoff, writes *Next
   slice*, adds or updates the ledger row, launches the builder through
   `dispatch.sh` (which resolves the harness chain via harness.mjs and falls
   through on a hard failure; pass `--harness harness[:model[:effort]]` only when
   the user overrides the config), flips the handoff to `dispatched`, records the
   verified pane, and prints the launcher's line plus a final
   `NEXT (background): …` line. Under the hood the launch is
   `bash "<…>/skills/core/offload/dispatch.sh" "$PWD" "$f.md" "$HANDOFF" "$SID"`;
   never call it by hand for a slice, and never launch a builder any other way.
3. Run the `NEXT` line exactly as printed, as a background Bash call. It is the
   wait bridge for that slice, with `WFR_BOARD_CWD` set so the wake carries the
   board. Nothing else wakes you.
4. Relay the launcher's line (herdr tab / tmux window / Terminal / headless) so the
   user knows where to watch. It names the tab, workspace and root pane, so quote
   the tab id, not just the pane. Inside a herdr TUI the builder lands in a new
   `builder` tab in **this session's workspace**, and that is the only frontend
   used there: if `tab create` fails, dispatch exits non-zero with herdr's own
   error rather than falling through to tmux/Terminal (which would put the builder
   outside herdr's tabs). Surface that failure instead of re-dispatching blindly.
   Outside herdr the chain is tmux, then Terminal, then headless.
5. The pane in the ledger is the one `dispatch.sh` recorded, never one you created
   yourself. `ledger add/set --pane` verifies it against dispatch.sh's signature (a
   herdr tab labeled `builder` holding exactly one pane) and refuses anything else,
   because a builder started by hand carries no builder marker, no activity sidecar
   and no turn-end hook, so nothing can ever wake the architect for it.

**Correctives reuse the warm builder.** After a rejection, write the corrective
block (the confirmed blockers, the same owned files and gates) and run
`dispatch-slice.sh … "<fix>.md" --id <n> --corrective --verdict "<why>"`. The
verdict lands on the ledger's rejected entry, so `ledger report` can count it as
review-only or gate-failed. When the builder that just
reported is still at its prompt, the brief goes into its pane and it continues
with the code already in context: no boot, no re-reading the plan. When the
builder is gone, the script says so and re-dispatches cold. Either way, run the
printed `NEXT` line again.

**Leaving the run unattended.** The `NEXT` bridge is a background task of this
session and dies with it. When the user is leaving (closing the laptop, clearing,
walking away), hand the fleet to detached wakes instead: run
`bash "<core>/complete/unattended.sh" "$PWD"` as the last action before the
session closes, or pass `--unattended` to `dispatch-slice.sh` so each new slice
arms a detached bridge + `architect-wake.sh` chain directly. When a bridge fires,
the chain resumes this architect session headlessly (`claude -p --resume`) with
the `WAITER:` line and board as the prompt, under `--permission-mode auto`
(`OFFLOAD_WAKE_PERMISSIONS=bypass` for the builders' posture; say so plainly when
you choose it). Claude architects only. While the interactive session is still
open the resume is refused and logged, so do not keep working after handing off;
on return, read the `.wake.log` beside each handoff and the board.

**Lean builder boot.** A claude builder launches with no MCP servers
(`OFFLOAD_BUILDER_MCP=none`, the default): it needs node and the skills, not the
machine's MCP fleet or its tool schemas on every turn. Set
`OFFLOAD_BUILDER_MCP=inherit` for the user's full MCP configuration, or a path to
load exactly that `--mcp-config` file, when a slice genuinely needs an MCP tool.

**Safety:** dispatch launches the builder with its permission gates relaxed:
codex `--dangerously-bypass-approvals-and-sandbox` (sandbox fully off, full local
access), opencode all-permissions config, grok `--always-approve`, claude
`--permission-mode auto` interactive (full `--dangerously-skip-permissions` when
headless). It is merely launched from the repo dir, not confined to it. Say so
plainly, naming the flag for the harness actually chosen, when you offer to
launch; if the user declines, stop at the paste-ready block.

## Hard rules

- You do not write implementation code. If tempted, write a tighter slice instead.
- Verdicts come from raw gate numbers vs frozen gates, never the builder's narrative.
- A slice is acceptable only when raw gates pass AND `review` returns no DO NOT LAND.
- Never edit frozen gates after results exist.
- Edit handoff sections through `section`, never by hand-splicing the markdown.
- The handoff and the ledger are session-scoped and never committed. Don't `git add` them.
- Resolve `$HANDOFF` via `resolve` on each turn; never hand-build a path or write to a
  doc from `list` you don't own. A `refusing:`/ownership error from the CLI means you
  are aimed at the wrong document: stop and surface it, don't `--steal` past it.
