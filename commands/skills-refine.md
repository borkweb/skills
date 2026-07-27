---
name: skills-refine
description: Read the back-and-forth that followed a Skill invocation in the current session and propose edits to fold that feedback into the SKILL.md so it handles those cases automatically next time. Per-proposal approval — nothing auto-applies. Use when asked to "refine this skill", "improve this skill", "fold this back into the skill", or after a session where you found yourself correcting or extending a skill's output by hand.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# /skills-refine — fold session feedback into a skill

You are running the `/skills-refine` command. The job is to look at what happened *after* a Skill ran in the current session — the corrections, the clarifications, the manual verifications, the "no, do it this way" exchanges — and propose edits to that skill's SKILL.md so the same back-and-forth wouldn't be needed next time.

Per-proposal approval. Nothing auto-applies. Skill files evolve carefully or they bloat into uselessness.

---

## Arguments

`$ARGUMENTS` — optional. One of:

- A skill name (e.g. `writing-commits`) — focus on the most recent invocation of *that* skill in this session.
- Empty — focus on the most recently invoked skill in this session.

---

## Step 0: Find the current session transcript

The current session's transcript lives at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>` replaces `/` with `-` and prepends a `-`. Take the most recently modified `.jsonl` in that directory.

If no transcript is found or the session is empty, stop with: "No active session transcript found."

---

## Step 1: Locate the target Skill invocation

Scan the transcript for `tool_use` entries where the tool name is `Skill`. Each carries a `skill:` argument.

- If `$ARGUMENTS` names a skill, find the most recent invocation matching that name.
- Otherwise take the most recent invocation of any skill.

If none exist in this session, stop with: "No Skill invocations found in this session — nothing to refine."

Record:

- Skill name and full SKILL.md path (resolve via `plugin.json` or `~/.claude/plugins/cache/*/skills/**/SKILL.md`).
- Message index where the Skill tool returned.
- All subsequent messages up to the end of the transcript (or the next Skill invocation, whichever comes first).

---

## Step 2: Read the SKILL.md

Read the target SKILL.md in full. Hold its current rules, workflow, and "Important rules" footer in working memory — every proposal must be checked against what's already there before being raised.

---

## Step 3: Analyze the post-invocation exchange

Scan the slice from Step 1. Tag each signal with what it suggests:

| Signal | What it suggests |
|---|---|
| Assistant asked a clarifying question the user answered with a stable preference | Skill should default that preference or check it upfront. |
| User said "no", "don't", "actually" and redirected | Missing rule or wrong default. |
| Assistant produced output that didn't compile / didn't match style / referenced a missing file | Missing precondition check or context-gathering step. |
| User added context that should have been gathered automatically (file paths, conventions, prior decisions) | Missing discovery step. |
| User re-prompted because the output drifted past scope | Missing scope-guard rule. |
| User accepted output unchanged with a brief "yes" or "perfect" | No signal — skip. |

For each tagged signal, capture: the message excerpt (≤120 chars), what the skill currently says (or doesn't), and what would have made the manual step unnecessary.

---

## Step 4: Filter — does it generalize?

Throw out signals that won't help future runs. A proposal is only worth raising if you can answer yes to **both**:

1. Would this signal recur for a different user in a different project running the same skill? (Project-specific facts belong in memory, not the skill.)
2. Is the proposed rule narrower than "be smarter"? (If you can't name the trigger condition, drop it.)

Drop:

- One-off stylistic preferences (matches one user's taste, not the skill's purpose).
- Project-specific facts (paths, names, conventions tied to *this* repo).
- Things already covered in the SKILL.md (re-read before each filter pass).
- Corrections that fix a bug in the user's input, not in the skill.

If nothing survives the filter, stop with: "Reviewed N exchanges; nothing generalizes into a skill edit. Session-specific context is better handled via memory."

---

## Step 5: Draft proposals

For each surviving signal, draft a concrete edit. Each proposal has:

- **ID** — `P1`, `P2`, …
- **Where** — section/heading in SKILL.md, or "new section: …"
- **Why** — one-line summary of the user behavior that triggered this.
- **Evidence** — the message excerpt(s) from the transcript.
- **Current text** — what's there now (or "not currently present").
- **Proposed text** — the exact edit, written as it would appear in the SKILL.md.
- **Generalizes because** — one sentence on why this isn't session-specific.

Order proposals by impact: rules that prevent re-prompts > rules that add verification > rules that change defaults > new context-gathering steps.

---

## Step 6: Per-proposal approval

Present proposals one at a time via `AskUserQuestion`. For each, offer four options:

- **Accept** — apply this edit to SKILL.md.
- **Accept with changes** — accept the intent; user provides the refined wording in free text.
- **Reject** — don't apply.
- **Defer** — keep in the final report as "proposed, not applied" so the user can revisit.

Don't batch. One question per proposal. The user's reasoning on one often changes how they vote on the next.

---

## Step 7: Apply accepted edits

For each accepted proposal:

- Edit the SKILL.md in place using exact-match replacements. Preserve surrounding indentation and section ordering.
- If adding a new section, place it next to the most semantically similar existing section (e.g. a new verification rule goes near other verification rules, not at the end).
- Don't add comments explaining why an edit was made — git blame is the audit trail.

---

## Step 8: Final report

Print to chat:

- Skill name and SKILL.md path.
- Counts: N exchanges reviewed, M proposals raised, X accepted, Y rejected, Z deferred.
- For each accepted edit: one-line diff summary.
- For each deferred proposal: ID, where, one-line summary so the user can return to it.
- If the skill now warrants a version bump or changelog entry in `plugin.json`, mention it.

---

## Important rules

- **Per-proposal approval, always.** Never bulk-apply. The whole point is that the user controls what gets folded in.
- **The filter is load-bearing.** Most session feedback is project-specific or stylistic. Be honest about how many signals make it through — a run that surfaces zero proposals is a *good* run, not a failed one.
- **Skill ≠ memory.** If the signal is "I prefer X in this project", that's a memory write, not a skill edit. Say so and move on.
- **Re-read the SKILL.md before every filter pass.** A rule that "feels missing" is often already there in different words.
- **Don't widen the skill's scope.** A refinement makes the skill better at what it already does. If the proposal expands what the skill covers, it's a new skill — point at `/skills-suggest` and stop.
- **No `git commit`.** Edits land in the working tree; let the user review and commit.
- **No structural rewrites.** This command tunes rules and adds small steps. For structural changes (script extraction, references, deduping across skills), point at `/skills-audit`.
- **If `superpowers:writing-skills` is installed**, suggest the user run it after applying edits to verify the SKILL.md still parses and triggers correctly.
