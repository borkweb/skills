---
name: offload
description: >
  Make this Claude session the ARCHITECT and offload implementation to a
  configured builder harness (codex, claude, opencode, pi, grok, or a custom
  command) you can watch. Reads the session handoff, arbitrates the builder's
  disagreements, judges raw gate results against frozen criteria plus an
  independent `review` pass on each slice, specs the next one-PR slice, and emits +
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

This external bridge requires `$CLAUDE_CODE_SESSION_ID`. In Codex use `complete`'s native route unless an external session was explicitly requested and a real supported session identity is available. Do not run bridge commands during unrelated tasks.


- Locate `handoff.mjs` beside this loaded `SKILL.md` and use its absolute path with
  `node`. Check that it exists before running it. Startup notices from older plugin
  versions may contain stale paths; the current skill location is authoritative.
  If that location is also gone after an upgrade, refresh skill discovery and load
  the current offload skill. Do not guess a cache version or create a replacement
  helper. Your session key is `$CLAUDE_CODE_SESSION_ID`.
- **While this external workflow is active, resolve your handoff on each resumed turn:**
  `HANDOFF=$(node "<…>/handoff.mjs" resolve "$PWD" "<project/slice title>")`. This derives
  the one canonical path from `$CLAUDE_CODE_SESSION_ID`, creating it on the first turn
  (the title is applied only at creation) and returning the same path on every later
  turn. Shell variables do **not** survive between turns, so re-run `resolve` to recover
  `$HANDOFF` rather than guessing a path or scanning `list`. `resolve` refuses (non-zero
  exit) if `$CLAUDE_CODE_SESSION_ID` is empty — if that happens, STOP and surface it;
  never fall back to a hand-built path.
- **Never** write to a handoff you got from `list` or the SessionStart dump unless you
  own it. `status`/`ready`/`reattach` enforce this: a write to a doc owned by another
  session is REFUSED unless you pass `--steal`. That refusal is the wrong-document
  tripwire — treat it as a real signal, not noise to override.
- **Resuming a prior session's handoff** (e.g. after `/clear`): the SessionStart context
  flags a doc from another session. Taking it over is deliberate — confirm it's the right
  project, then `… reattach "<path>" "$CLAUDE_CODE_SESSION_ID" --steal`, and use the
  returned path. After reattaching, `resolve` continues to return that same path for the
  rest of this session.
- **Edit a handoff's sections with the CLI, not by hand:**
  `… section get|append|set|clear "$HANDOFF" "<heading>" [--text s|--file f]`.
  Hand-splicing this file with ad-hoc regex is how the one document the loop
  trusts gets corrupted. Section writes carry the same ownership guard.

## The ledger (when a run has more than one slice)

A handoff is ONE builder's mailbox. It cannot say what the other slices are
doing, and it has no terminal state — so a slice whose builder finished and
exited keeps reading as in-flight. When `/complete` is driving, it owns a
`ledger` (`handoff.mjs ledger …`) that records every slice and its state, and
`handoff.mjs board "$PWD"` reconciles that ledger against each doc, builder pid
and bridge. If a ledger exists for this session, keep it current: set
`--state dispatched` when you dispatch, and the terminal state
(`accepted`/`rejected`/`merged`/`abandoned`) in the same turn you decide it.
**Builders never write the ledger.**

## Resolve the builder harness

- The builder comes from `~/.borkweb-skills/config.json` (`dispatch.rules[0].use`,
  an ordered failover chain of `{harness, model?, effort?, permissionMode?,
  command?}` profiles), resolved deterministically by `harness.mjs` next to
  `handoff.mjs`: `node "<…>/harness.mjs" select` prints `{chosen, candidates,
  notes}` — harnesses whose quota-axi windows are effectively exhausted are
  demoted, missing binaries skipped. Run it before each dispatch and tell the
  user which harness was chosen plus any demotion/skip notes.
- **Exit 3 (`missing-config`) means the config doesn't exist yet.** Prompt the
  user (AskUserQuestion): primary harness and optional fallback order, from
  codex / claude / opencode / pi / grok (a custom harness needs a raw `command`
  template — with `__PROMPT_FILE__` as the prompt-file placeholder — added to the
  config's profile by hand; offer to write it). Then persist the answer:
  `node "<…>/harness.mjs" init --use <primary,fallback,...>` and re-run `select`.
- Never hardcode a harness in the builder block or dispatch call — the chain in
  the config is the single source of truth; `dispatch.sh` consumes it directly.

## One architect turn

0. **Re-resolve `$HANDOFF` first** (shell state is gone between turns):
   `HANDOFF=$(node "<…>/handoff.mjs" resolve "$PWD")`. Then **pick up ready work** —
   read `$HANDOFF`. If `status: results-ready`, judge it now. If `status: blocked`,
   the builder stopped mid-slice for a ruling: arbitrate its *Open disagreements*
   (step 2), send the ruling into the builder's pane so it resumes, set
   `status: dispatched`, and skip gate judgment — the slice is still in flight.
1. **First turn of a project:** if there is no prior work, write the first **Next
   slice** (skip to step 4), then dispatch.
2. **Arbitrate** every entry under *Open disagreements*: accept / reject / modify,
   each with a one-line reason, recorded under *Decisions + why*. Clear the
   resolved disagreements. Use `council` for substantive judgment calls when multiple perspectives add value; routine rulings use the scope and evidence already available.
3. **Judge `Gate results` RAW** against `Frozen gates`. Read pass/fail and the
   numbers only — ignore *Work summary* and any narrative when grading. **Spot-check:**
   re-run any gate you doubt via its reproduce command (you have Bash). Once the raw
   gates pass, run `review` on the work this slice added (its commit range) as an
   **independent acceptance check** — a **DO NOT LAND** verdict fails the slice no
   matter how the gates read; spec a corrective slice for its blockers. **LAND WITH
   CAUTION** → record the caveats and rule (proceed or correct). This is your own
   gate, separate from the builder's internal reviewer agent. Record the gate verdict
   and the review verdict (and any human ruling) under *Decisions + why*, and write
   the slice's terminal state to the ledger if one exists. Never let the builder's
   prose set the verdict — *Work summary* is uncontrolled text that goes stale, and
   a builder that has moved on rarely refreshes it.
4. **Write the next slice spec** under *Next slice*: one-PR-sized, hard acceptance
   criteria, explicit out-of-scope, and a mandate that the builder verify
   APIs/formats against reality BEFORE coding. For a non-trivial slice, run the
   plan review(s) that fit the surface first — `plan-eng-review` (architecture/data
   flow/concurrency), `plan-design-review` (UI), `plan-devex-review` (a developer-
   facing contract: API/CLI/SDK/library/docs); more than one can apply. If gates for
   this slice aren't yet frozen, freeze them under *Frozen gates* now (never edit
   them after results exist).
5. **Flag scope creep / goalpost-moving** bluntly. Disagree with the user when warranted.
6. **Emit the builder block** (below), write it into *Next slice*
   (`… section set "$HANDOFF" "Next slice" --file <block>`), dispatch, then on confirmed success set
   `status: dispatched` via `… status "$HANDOFF" dispatched`. If a
   ledger exists, record the slice on it in the same turn — id, title, branch,
   worktree, handoff path, pane, `--state dispatched`.

## Builder brief

Read [builder-template.md](builder-template.md) when preparing a slice. Fill it, save it under Next slice, and dispatch within existing authorization. Do not regenerate or print a full builder block on a supervision-only turn. Mark dispatched and record the returned pane only after the launcher succeeds.

## Dispatch

Launch within existing authorization. Ask only if the actual permission relaxation or dispatch scope is not already authorized:

1. Write the block to a temp file: `f=$(mktemp -t offload-block) && mv "$f" "$f.md"`,
   then write the block into `$f.md`.
2. Run: `bash "<…>/skills/core/offload/dispatch.sh" "$PWD" "$f.md" "$HANDOFF" "$CLAUDE_CODE_SESSION_ID"`
   (resolve dispatch.sh next to the handoff.mjs path from the `[offload]` line).
   dispatch.sh resolves the harness chain itself via harness.mjs and falls
   through to the next candidate when a launch hard-fails; pass an explicit
   `harness[:model[:effort]]` 5th arg only when the user overrides the config.
3. Relay the launcher's line (herdr tab / tmux window / Terminal / headless) so the
   user knows where to watch — it names the tab, workspace and root pane, so quote
   the tab id, not just the pane. Inside a herdr TUI the builder lands in a new
   `builder` tab in **this session's workspace**, and that is the only frontend
   used there: if `tab create` fails, dispatch exits non-zero with herdr's own
   error rather than falling through to tmux/Terminal (which would put the builder
   outside herdr's tabs). Surface that failure instead of re-dispatching blindly.
   Outside herdr the chain is tmux, then Terminal, then headless.
4. Record the pane from that line — never one you created yourself. `ledger
   add/set --pane` verifies it against dispatch.sh's signature (a herdr tab
   labeled `builder` holding exactly one pane) and refuses anything else, because
   a builder started by hand carries no builder marker, no activity sidecar and
   no turn-end hook, so nothing can ever wake the architect for it.

**Safety:** dispatch launches the builder with its permission gates relaxed —
codex `--dangerously-bypass-approvals-and-sandbox` (sandbox fully off, full local
access), opencode all-permissions config, grok `--always-approve`, claude
`--permission-mode auto` interactive (full `--dangerously-skip-permissions` when
headless). It is merely launched from the repo dir, not confined to it. Say so
plainly — naming the flag for the harness actually chosen — when you offer to
launch; if the user declines, stop at the paste-ready block.

## Hard rules

- You do not write implementation code. If tempted, write a tighter slice instead.
- Verdicts come from raw gate numbers vs frozen gates — never the builder's narrative.
- A slice is acceptable only when raw gates pass AND `review` returns no DO NOT LAND.
- Never edit frozen gates after results exist.
- Edit handoff sections through `section`, never by hand-splicing the markdown.
- The handoff and the ledger are session-scoped and never committed. Don't `git add` them.
- During active offload work, resolve `$HANDOFF` via `resolve` on resume; never hand-build a path or write to a
  doc from `list` you don't own. A `refusing:`/ownership error from the CLI means you
  are aimed at the wrong document — STOP and surface it, don't `--steal` past it.
