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

## 2. Discover — use whatever search the environment has

Detect what's available before committing to a search method, then take the path that fits:

- **grepika** (`mcp__*grepika*` tools) present → use its `search` / `refs` / `outline` for ranked, snippet-level discovery.
- **graphify** (a `graphify-out/` dir or the graphify skill) present → query the graph for structure and relationships.
- Neither → fall back to built-in **Grep** / **Glob**.

State in one line which method you used, so the choice is visible and correctable.

Whatever the tool, the discovery **goal** is the same — find:

- the entry point(s) for the feature or bug
- direct callers and callees of the symbols the change will touch
- the test(s) covering that area
- the config / schema / build files the change implies

Don't exhaustively crawl. Stop when the named set is enough to start; the brief's OPEN section carries the rest.

## 3. Degrade gracefully

If discovery can't complete — no search tool resolves the area, the codebase is unfamiliar, or the task description is too vague to localize — **do not block and do not guess silently.** Emit a partial brief: list what you did find, mark it partial, and put what you couldn't localize in OPEN. A half-scoped task started honestly beats a fully-scoped one built on guesses.

## 4. Emit the brief — fixed shape

Output exactly this block, nothing reformatted into prose:

```
## Scope: <task in one line>
Discovery: <grepika | graphify | grep/glob> [+ "partial" if incomplete]

IN — read / edit:
  - path/to/a.ext        (why: entry point)
  - path/to/b.ext        (why: caller)
  - path/to/b.test.ext   (why: coverage)

OUT — leave alone:
  - vendor/, build/, generated output
  - <unrelated module or area the task does NOT touch>

OPEN — unresolved scope:
  - <question, with the assumption you're proceeding on>
```

Rules for the block:

- IN holds the working set — keep it to the files the task actually needs, not everything tangentially related. If IN exceeds ~15 entries, the task likely needs decomposition; say so.
- Every IN entry carries a one-clause `why`.
- OUT names concrete areas worth explicitly excluding (the ones an unscoped pass would waste reads on), not a generic "everything else."
- OPEN states each open question **with the assumption you'll proceed under**, so silence from the user means the assumption stands.

## 5. Continue

After emitting the brief, proceed straight into the task against that scope — no confirmation gate. The brief stays on screen; if it mis-scoped, the user's next message corrects it. Treat a correction as authoritative and re-scope from it.

## Boundaries

- This skill scopes file relevance. It does not break the task into sub-tasks (that's planning) and does not edit code itself.
- It produces no disk artifact. If a task is large enough to need a durable, reviewable scope across a `/clear` or restart, that's a different request — flag it rather than silently writing a file.
