---
name: auto-scope
description: >
  Scopes a coding task before implementation — names the handful of files actually relevant
  (read/edit these), the areas to leave alone, and any open scope questions, so work doesn't start
  by reading the whole repo. Fires proactively at the start of substantive, multi-file, or
  unfamiliar-area work; stays silent on single-file edits, one-line fixes, questions, and continued
  work in an area already scoped this session. Use when beginning a feature, bug fix, or refactor
  that could plausibly touch several files or an area not yet seen this session.
---

# Auto-Scope

Before diving into a substantive coding task, name the files that matter and the ones that don't — so the work doesn't open by reading the whole repo to orient.

The output is an **in-context scope brief**, not a file on disk and not a lock on the filesystem. Any file can still be read later; the brief steers the default, it doesn't enforce it. The win is that 5–15 named files replace an exploratory sprawl.

## 1. Self-gate — decide whether to fire at all

Run only when the task plausibly touches **multiple files or an area not seen this session.**

**Skip silently** — emit nothing, not even a note that you skipped — when the task is any of:

- a single-file or one-line edit
- a question, explanation, or review with no code change
- continued work in an area already scoped earlier this session

If you're skipping, say nothing about scoping and proceed normally. A "I decided not to scope this" line is itself noise.

## 2. Discover

Use the current runtime's working search tool. Find entrypoints, direct callers, relevant tests and implicated config/schema files. Stop when there is enough evidence to start; do not inventory tools or narrate routine tool selection.

## 3. Degrade gracefully

If discovery can't complete — no search tool resolves the area, the codebase is unfamiliar, or the task description is too vague to localize — **do not block and do not guess silently.** Emit a partial brief: list what you did find, mark it partial, and put what you couldn't localize in OPEN. A half-scoped task started honestly beats a fully-scoped one built on guesses.

## 4. Briefly state scope

Name the relevant files and why, concrete areas to leave alone, and material unresolved scope. Use prose or IN/OUT/OPEN lists as appropriate. Distinguish assumptions safe to proceed on from questions that block dependent work; silence is not approval. Avoid a fixed template for an obvious scope.

## 5. Continue

After emitting the brief, proceed straight into the task against that scope — no confirmation gate. The brief stays on screen; if it mis-scoped, the user's next message corrects it. Treat a correction as authoritative and re-scope from it.

## Boundaries

- This skill scopes file relevance. It does not break the task into sub-tasks (that's planning) and does not edit code itself.
- It produces no disk artifact. If a task is large enough to need a durable, reviewable scope across a `/clear` or restart, that's a different request — flag it rather than silently writing a file.
