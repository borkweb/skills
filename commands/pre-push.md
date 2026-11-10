---
description: Critical-only safety review of the diff a push would send. Runs on request, loads the review checklist and reports only CRITICAL findings (SQL injection, auth gaps, race conditions, API contract breaks, weakened gates). It reports and never changes or stops a push.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Skill
---

# Pre-Push Safety Net

You are running the `/pre-push` command. It runs on request, before you push. It reads the diff a push would send, applies the CRITICAL pass of the `review` checklist, and reports only CRITICAL findings that could cause catastrophic remote failures. It reports. The developer decides what to do.

**Design goal:** Fast enough to run every time. Under 30 seconds for typical diffs.

---

## Step 1: Find the base and the diff range

```bash
BRANCH=$(git branch --show-current)
BASE=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
BASE=${BASE#origin/}
if [ -z "$BASE" ]; then
  for B in main master; do
    git rev-parse --verify --quiet "origin/$B" >/dev/null && BASE=$B && break
  done
fi
[ -n "$BASE" ] && git fetch origin "$BASE" --quiet 2>/dev/null
if [ "$BRANCH" = "$BASE" ]; then
  FROM=$(git merge-base '@{u}' HEAD 2>/dev/null)
else
  FROM=$(git merge-base "origin/$BASE" HEAD 2>/dev/null)
fi
```

The diff starts at `FROM`. On a feature branch that is the merge-base with the base branch. On the base branch itself it is the merge-base with the upstream, so it reviews the commits that are not pushed yet. Work another person pushed, which the fetch just brought in, is never part of the diff.

Stop and print `pre-push: cannot determine base (<reason>). Nothing was reviewed.` when `BRANCH` is empty (detached HEAD), `BASE` is empty, `origin/$BASE` does not exist, `FROM` is empty, or the base branch has no upstream. This is never a clean result.

```bash
DIFF_STAT=$(git diff "$FROM" HEAD --shortstat)
```

When the diff is empty, print `pre-push: no changes against $BASE, nothing to review` and stop. Uncommitted changes are not part of what a push sends, so they are not in the diff.

---

## Step 2: Get the diff

```bash
git diff "$FROM" HEAD --name-only
git diff "$FROM" HEAD
```

Classify each changed file by what it does at runtime, not by its extension. Code, configuration, migrations, CI files and tests are in scope. So is Markdown that is loaded as instructions: a skill, command, agent or prompt file steers a model at runtime and gets the same review as code. Prose that only people read, such as a README or a changelog, cannot trigger a CRITICAL category, so skim it. Review every other changed file, whatever its name or extension.

---

## Step 3: Load the checklist, classify, report CRITICAL only

Invoke `bork:review` with the Skill tool, unless it is already loaded in this turn. Then read `checklist.md` in the base directory the loaded skill reports. Do not search the repo for it and do not use a path inside the repo.

Use only that checklist. Do not run the `review` workflow: no scope pinning, verdict, fixes or independent review. Ignore those steps of the skill.

If the `review` skill or its `checklist.md` cannot be loaded, print `pre-push: review checklist unavailable. Nothing was reviewed.` and stop. Never print the clean line in that case.

Run all CRITICAL and INFORMATIONAL checklist categories against the diff, assigning confidence and severity before filtering. These eight CRITICAL categories are the ones this command reports:

1. **SQL & Data Safety** — Raw SQL without parameterization, missing WHERE on UPDATE/DELETE, SQL injection vectors
2. **Migration & Schema Safety** — Destructive migrations without reversibility, data-loss operations
3. **Race Conditions & Concurrency** — Shared mutable state without locking, check-then-act without atomicity
4. **Auth & Permission Gaps** — Missing auth checks on new endpoints, privilege escalation paths
5. **LLM Output Trust Boundary** — Unsanitized LLM output used in SQL, HTML, or system commands
6. **Enum & Value Completeness** — New enum values not handled in all switch/match statements
7. **API Contract Breaking Changes** — Removed fields, changed response shapes, renamed endpoints
8. **Gate Integrity** — Tests removed or skipped, snapshots regenerated without their owning test, thresholds or timeouts raised, suppression pragmas or CI bypasses added, exceptions swallowed, with no measurement or decision in the diff that justifies it

**Speed optimization:** Only read files that are in the diff. Don't grep the entire codebase unless checking enum completeness (which requires finding all references to sibling values).

---

## Step 4: Report

**If no critical issues found:**
```
pre-push ✓ Critical review clean ($DIFF_STAT)
```

**If critical issues found:**
```
pre-push ✗ N critical issue(s) found

1. [file:line] SQL injection — raw user input in query string
2. [file:line] Auth gap — new endpoint /api/admin/users has no auth middleware

Run /review for the full analysis.
```

Then stop. Do not touch the push.

---

## Important Rules

- **Speed is everything.** This command must complete in under 30 seconds. If it is slow, developers will skip it.
- **Critical output only.** After classification, report only CRITICAL findings. Suppress informational, design, and style findings.
- **No auto-fixing.** This is a report, not a fixer. The developer fixes.
- **Quiet when clean.** One line of output when everything is fine.
- **Never read clean from a failure.** A missing base, a missing upstream or an unavailable checklist is reported as such, never as a clean result.
- **Never modify files.** This command reads and reports. It never edits, commits, or changes anything.
