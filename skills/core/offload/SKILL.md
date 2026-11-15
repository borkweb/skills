---
name: offload
description: >
  Make this session the ARCHITECT and hand implementation to a builder harness
  you can watch (codex, claude, opencode, pi, grok or a custom command), judged
  slice by slice on frozen gates and an independent review. Use when the user
  says "offload", "hand this to codex", "hand this to a builder", "architect
  mode", "have codex build this", or invokes /offload.
hooks:
  PreToolUse:
    - matcher: "Edit|Write|MultiEdit|NotebookEdit"
      hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/skills/core/offload/architect-guard.mjs\""
---

You are the **ARCHITECT**. The **BUILDER** is whichever harness
`~/.borkweb-skills/config.json` resolves to (see *Resolve the builder harness*).
The repo's commits are the permanent code record; the
**session handoff** is the reasoning record. The human is the final judge.

## Resolve the handoff CLI and session key

The external bridge supports native Claude and Codex architect identities. `handoff.mjs key` reads `$CLAUDE_CODE_SESSION_ID`, or namespaced `$CODEX_SESSION_ID` when Claude's variable is absent. Never copy a Codex identity into a Claude variable. Do not run bridge commands during unrelated tasks.

- Locate `handoff.mjs` beside this loaded `SKILL.md`, check that it exists, and run it
  with `node` by absolute path. Startup notices from older versions may name stale
  paths; this skill's location is authoritative. If it is gone after an upgrade,
  refresh skill discovery and load the current offload skill; never guess a cache
  version or write a replacement helper. Resolve your session key with `SID=$(node "<…>/handoff.mjs" key)` and use it for explicit identity arguments.
- **Resolve your handoff on each turn** (shell variables do not survive turns):
  `HANDOFF=$(node "<…>/handoff.mjs" resolve "$PWD" "<project/slice title>")`. It derives
  one canonical path from the native session environment, creating the doc on the first
  turn (the title applies only then). The SessionStart hook's `Your handoff: <path>`
  agrees with it. `resolve` exits non-zero if both native session variables are
  empty: stop and surface it; never fall back to a hand-built path.
- **Never** write to a handoff from `list` or the SessionStart dump unless you own
  it. `status`/`ready`/`reattach` refuse another session's doc without `--steal`;
  that refusal is the wrong-document tripwire.
- **Resuming a prior session's handoff** (e.g. after `/clear`): the SessionStart context
  flags a doc from another session. Taking it over is deliberate: confirm it's the right
  project, then `… reattach "<path>" "$SID" --steal` and use the returned path;
  `resolve` returns it for the rest of this session.
- **Edit a handoff's sections with the CLI, not by hand:**
  `… section get|append|set|clear "$HANDOFF" "<heading>" [--text s|--file f]`.
  Section writes carry the same ownership guard.
- **A builder writes its handoff as the architect.** `dispatch.sh` exports the doc as
  `$OFFLOAD_HANDOFF` and the architect's id as `$OFFLOAD_SESSION_ID`, while each builder obtains its own native runtime identity. Status and section writes honor the carried id for that one doc only;
  any other doc is still checked against the caller's own session.

## Hard rules

- You do not write implementation code. If tempted, write a tighter slice instead.
  On Claude Code, `architect-guard.mjs` enforces this. On a refusal, write the
  slice; ask the user to lift it only if they told you to make that edit.
- When the user says stop, run `handoff.mjs halt "<repo root>" "<their words>"` before anything else. While halted, `dispatch-slice.sh` refuses, unattended wakes do not resume you, and the board leads with HALTED. Only the user's go-ahead clears it (`handoff.mjs unhalt`).
- Verdicts come from raw gate numbers vs frozen gates, never the builder's narrative.
- A slice is acceptable only when raw gates pass and `review` returns no DO NOT LAND.
- Never edit frozen gates after results exist.
- The handoff and the ledger are session-scoped and never committed. Don't `git add` them.
- A `refusing:`/ownership error means the wrong document: surface it, never `--steal`.
- Read [gotchas.md](gotchas.md) before a slice that pushes, adds tools other agents run, or runs gates on a remote sandbox.

## The ledger

A handoff is one builder's mailbox. It cannot say what the other slices are
doing, and it has no terminal state, so a slice whose builder finished and
exited keeps reading as in-flight. Every run has a
`ledger` (`handoff.mjs ledger …`) that records every slice and its state: when
`/complete` is driving it opens the ledger, and a one-slice run gets one from
`dispatch-slice.sh` on its first dispatch. `handoff.mjs board "$PWD"`
reconciles the ledger against each doc, builder pid and bridge. Keep it
current: set `--state dispatched` when you dispatch, and the terminal state
(`accepted`/`rejected`/`merged`/`abandoned`) in the same turn you decide it.
The Stop hook refuses a turn end once while the ledger still owes a judgment,
a ruling or an owner, and stays quiet while the run's `run.json` is `needs-me`
(the run waits on the user, not on this turn). **Builders never write the
ledger.**

## Run directory

Every spec review and every acceptance review is written to the run directory,
never only to a temp path or the scratchpad: `spec-review-<slice>.md` and
`review-<slice>-r<round>.md` (round 1 is the first judgment; each corrective adds
one). Use the run directory `do` or `complete` created. When `offload` runs on its
own, create one with `runs.mjs init --repo "$PWD" --goal "<goal>"` (`skills/core/desk/runs.mjs`, found
beside the loaded `desk` skill): it makes
`~/.agent-handoffs/runs/<YYYY-MM-DD>-<slug>-<4 random chars>/` (mode 700) and
writes its `run.json`. Record
the path under *Decisions + why* and pass `--run-dir <run dir>` on the first
`dispatch-slice.sh` call, which links it to the ledger it creates (`ledger init
--run-dir` does the same when you open the ledger yourself). Without `--run-dir`
it falls back to `BORK_RUN_DIR`, skipping one whose run is `done` or `failed`. These files are what the dreaming
pass ([dreaming.md](../do/references/dreaming.md)) reads across runs.

Nobody curates memory during a run: no "record what you learned" step, and no edits
to `review-criteria.md`, briefs or skills. All of them leave
structured evidence (verdicts with tags, the review files above, `decisions.md`); only
the dreaming pass, run on its own with the user approving each change, turns it into criteria.

## Resolve the builder harness

- The builder comes from `~/.borkweb-skills/config.json` (`dispatch.rules[0].use`,
  an ordered failover chain of `{harness, model?, effort?, permissionMode?,
  command?}` profiles), resolved deterministically by `harness.mjs`: `node "<…>/harness.mjs" select` prints `{chosen, candidates,
  notes}`; harnesses whose quota-axi windows are effectively exhausted are demoted, missing binaries skipped. `dispatch-slice.sh` runs it for you at
  launch and prints the chosen harness and any demotion/skip notes; relay those
  to the user. Run `select` yourself only to answer a question before launching.
- **Exit 3 (`missing-config`) means the config doesn't exist yet.** Read
  [launch-options.md](launch-options.md) and set it up with the user.
- Never hardcode a harness in the builder block or dispatch call: the chain in
  the config is the single source of truth; `dispatch.sh` consumes it directly.

## Slice size

A slice is one coherent feature: everything a builder needs to make one capability work end to end, cut only where files or contracts separate it from other work. It is not one PR, one file or one test. Every extra slice costs a spec review, a dispatch, a review and a handoff; a builder on a current model holds a multi-hour feature without losing the thread. Split when two features touch the same files and must run concurrently, or when one builder's failure should not take the other feature with it.

## One architect turn

0. **Re-resolve `$HANDOFF` first:**
   `HANDOFF=$(node "<…>/handoff.mjs" resolve "$PWD")`. Then **pick up ready work**:
   read `$HANDOFF`. If `status: results-ready`, judge it now. If `status: blocked`,
   the builder stopped mid-slice for a ruling: arbitrate its *Open disagreements*
   (step 2), send the ruling into the builder's pane so it resumes, set
   `status: dispatched`, and skip gate judgment; the slice is still in flight.
1. **First turn of a project:** if there is no prior work, write every slice the
   plan already separates (step 4), then dispatch every slice whose files are
   disjoint in this same turn, up to 3–4 lanes. When two or more slices share a
   brief shape (the same kind of change in parallel files, such as several
   abilities), dispatch one first and fan out the rest when it reaches its first
   judgment, with its rejection reasons in their specs. Slices of different
   shapes all dispatch in the first turn. One slice is one handoff, one
   worktree and one `dispatch-slice.sh` call; several calls fit in one Bash
   invocation, and `complete` keeps the ledger across them.
2. **Arbitrate** every entry under *Open disagreements*: accept / reject / modify,
   each with a one-line reason, recorded under *Decisions + why*. Clear the
   resolved disagreements. Use `council` for substantive judgment calls when multiple perspectives add value; routine rulings use the scope and evidence already available.
   A ruling that changes what the work must say or do follows [judging.md](judging.md).
3. **Judge `Gate results` raw** against `Frozen gates`. Read pass/fail and the
   numbers only; ignore *Work summary* and any narrative when grading. Then read the
   criteria evidence under *Gate results*: every frozen criterion needs a line, and a
   `NOT MET` line fails the slice without a review. A missing line is not a verdict:
   `ready` refuses a doc without one, and `handoff.mjs coverage "$HANDOFF"` prints the
   frozen IDs that have none (exit 4). A missing criterion line, a missing
   `Loosened tests:` line and a missing `Safety fact:` line are bookkeeping, not a verdict against the work: `ledger set
   … --state returned`, then send the builder a `--corrective` without `--verdict` that
   names the missing IDs or the missing line, so it costs no rejection and no round.
   Coverage is not freshness: a line from an earlier round satisfies it, so read the
   evidence itself. Apply [judging.md](judging.md) (stale head, merge onto the current
   base) before any review and each corrective's review. Before any review,
   run every gate marked `NOT RUN`, each mutation a criterion names (in a throwaway
   detached worktree at the slice HEAD, removed afterward, never the builder's
   worktree) and each real-runtime run a criterion names; a failure there sends the
   slice back as a corrective without spending a review round. A gate you cannot run
   either stays `NOT RUN` as a recorded caveat (LAND WITH CAUTION, or ask the user);
   it never sends the slice back. Once the raw
   gates and these checks pass, start `review` on the work this slice added (its commit range) as an
   **independent acceptance check**, giving the reviewer the frozen gates and the
   spec reviewer's criteria so it grades the same bar the builder was given, and at
   the same time **spot-check:** re-run any gate you doubt via its reproduce
   command. A failed spot-check fails the slice: stop or discard that
   review and send the failure back. A **DO NOT LAND** verdict fails the slice no
   matter how the gates read, but only for a blocker that carries a red command or quotes
   a shipped line the change made false (missing required evidence, an unmet frozen criterion, a merge
   conflict, security findings, data loss and uncapped spend need neither); spec one corrective
   slice carrying every such blocker.
   Read [correctives.md](correctives.md) before you spec, dispatch, judge or accept a corrective (`dispatch-slice.sh … --corrective`), or judge a rejection:
   it holds the proof rule, the two-miss stop, the round cap, send-backs, the
   scope of reruns and the delta review. Before you accept a slice that had a
   corrective with a `Carried:` line, run the full frozen gate set on the head you accept. **LAND WITH CAUTION** → record the
   caveats and rule (proceed or correct). This is your own gate, separate from the
   builder's internal reviewer agent. Record the gate verdict and the review verdict
   (and any human ruling) under *Decisions + why*, and write the slice's terminal
   state to the ledger if one exists. For each blocker of a DO NOT
   LAND after green gates, record whether a frozen criterion named it (the builder
   missed it; cite the number) or none did (the spec review in step 4 missed it).
   Put the same tag in the ledger `--verdict` text (`named C5`, `unnamed`), so
   `ledger report --verdicts` keeps it after the handoff doc is gone. For a
   review-only rejection, also decide per blocker which kind of check could have
   caught it (a grep ratchet, a lint rule, a registry test or a type) and add
   `checkable: <tool>` (one lowercase token, such as `grep-ratchet` or `lint`) or
   `checkable: no` beside the provenance tag: `named C5, checkable: lint`. A
   gate-failed rejection needs no `checkable` tag. The ledger refuses `rejected`
   without a verdict, and refuses a review-only one without both tags.
4. **Write the next slice spec** under *Next slice*: one coherent feature (see Slice
   size), hard acceptance criteria, explicit out-of-scope, and a mandate that the
   builder verify APIs/formats against reality before coding. Frozen criteria
   outrank the spec prose, so the spec cites a criterion by its ID instead of
   restating its condition. A **corrective** spec follows
   [correctives.md](correctives.md): the confirmed blockers, each with a red command or a quoted false line,
   and no spec reviewer or plan reviews. Otherwise run these concurrently:
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
   - a **gate preflight**: run every frozen gate's command once, including
     remote, sandbox and CI gates, to prove it can run here (credentials, SSH
     agent, sandbox access, runtime version). It need not pass on the base; it
     must execute.

   Join. A gate that cannot execute stops the dispatch: fix the access, replace
   the gate, or ask the user, and record which. Never dispatch a builder against
   a gate nobody can run. Rule on every gap the spec reviewer listed: fold it in as a criterion,
   record it as out of scope under *Decisions + why*, or ask the user when it
   changes scope. No gap reaches the builder unresolved. Before freezing, run each
   criterion's command once in the pre-warmed worktree, still at the base, and
   record `base: red`, `green` or `n/a` beside it (mutation checks and file:line
   conditions are `n/a`). A criterion for new or changed behavior that is already
   green at the base cannot fail, so it proves nothing: rewrite its check, or return
   it to the spec reviewer, before it freezes. Freeze the spec reviewer's criteria
   with their IDs, folded in (never edit them after results exist). The freeze is
   mechanical: the builder block's `Acceptance:` copies the criteria verbatim from
   the spec review, one per line, ID first (`C1: …`), and on a fresh dispatch
   `dispatch-slice.sh` copies every ID-first line of the block into *Frozen gates*
   before the builder launches. It never writes on a `--corrective`, never rewrites
   a section that already holds IDs (a block with different IDs is refused; use a new
   worktree or end the old handoff), and warns when the block has no IDs. It also
   freezes `L<n>: local: <command>` lines, the fast gates `ready` runs itself (which
   to mark: correctives.md *Local gates*). Freezing by hand first is allowed when the
   IDs match. The builder brief carries the same criteria.
5. **Flag scope creep / goalpost-moving** bluntly. Disagree with the user when warranted.
6. **Emit the builder block** (below) to a file and run `dispatch-slice.sh` (Dispatch,
   below). A failed launch leaves the slice `specced`, puts *Frozen gates* back as it was,
   and nothing is running.
7. **Report.** When the slice is accepted or the run stops, give the verdict, gate
   results and a delivery line. A standalone `offload` run also sets its final state
   in `run.json` with `runs.mjs set <run> --state <s> --summary "<line>" --delivery
   "<delivery line>"`: `done` once the slice is accepted, `blocked` with the reason as
   summary when a circuit breaker or a delivery blocker waits on the user, `failed`
   when the run cannot continue. When `do` or `complete` drives the run, that skill
   sets the state instead.

## Builder brief

Read [builder-template.md](builder-template.md) when preparing a slice. Fill it and save it under Next slice. Do not regenerate or print a full builder block on a supervision-only turn. Mark dispatched and record the returned pane only after the launcher succeeds.

## Dispatch

Launch within existing authorization; ask only when the permission relaxation or dispatch scope is not already authorized:

1. Write the block to a temp file: `f=$(mktemp -t offload-block) && mv "$f" "$f.md"`,
   then write the block into `$f.md`.
2. Run, in one call per slice (several slices may share one Bash call):
   `bash "<…>/skills/core/offload/dispatch-slice.sh" "$PWD" "<worktree>" "<branch>" "$f.md" [--id <n>] [--title "<t>"] [--base <ref>] [--run-dir <abs>]`.
   It resolves your session key, creates the worktree from `--base` (default
   HEAD; pass the branch the slice was cut from, never the slice's own branch: judging.md says
   why) or reuses one you pre-warmed, inits the slice handoff, freezes the
   block's ID-first criterion lines into *Frozen gates* (a fresh dispatch only; step 4
   has the refusals), writes *Next
   slice*, opens the ledger when the session has none (goal: `--title`, else the
   block's heading; linked to `--run-dir`, else `BORK_RUN_DIR` when that
   directory exists), adds or updates the ledger row (without `--id` it reuses
   the newest non-terminal row for this handoff, else takes the next integer id), launches the builder through
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
   user knows where to watch; quote the tab id, not just the pane. Inside a herdr TUI the
   builder lands in a new `builder` tab in **this session's workspace**, the only
   frontend used there: if `tab create` fails, dispatch exits non-zero with herdr's own
   error rather than falling through to tmux/Terminal. Surface that failure instead of
   re-dispatching blindly. Outside herdr the chain is tmux, then Terminal, then headless.
5. The pane in the ledger is the one `dispatch.sh` recorded, never one you created
   yourself. `ledger add/set --pane` verifies it against dispatch.sh's signature (a
   herdr tab holding exactly one pane that the slice's `<handoff>.pane` sidecar
   names, or, as the fallback, a one-pane tab still labeled `builder`) and refuses anything
   else, because a builder started by hand carries no builder marker, no activity sidecar
   and no turn-end hook, so nothing can ever wake the architect for it.

**Correctives reuse the warm builder.** The `--corrective` call, its `--verdict`
rules and the warm-versus-cold re-dispatch are in [correctives.md](correctives.md).
Either way, run the printed `NEXT` line again.

**Leaving, or needing an MCP tool.** The `NEXT` bridge is a background task of this session and dies with it. Read [launch-options.md](launch-options.md) when the user is leaving or a slice genuinely needs an MCP tool: it holds the detached wake chain (`unattended.sh`, `--unattended`) and `OFFLOAD_BUILDER_MCP`.

**Safety:** dispatch launches the builder with its permission gates relaxed:
codex `--dangerously-bypass-approvals-and-sandbox` (sandbox fully off, full local
access), opencode all-permissions config, grok `--always-approve`, claude
`--permission-mode auto` interactive (full `--dangerously-skip-permissions` when
headless). It is merely launched from the repo dir, not confined to it. Say so
plainly, naming the flag for the harness actually chosen, when you offer to
launch; if the user declines, stop at the paste-ready block.
