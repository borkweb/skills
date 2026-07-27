---
name: pre-push
description: Pre-push safety net. Classifies the full review checklist and emits only critical findings (SQL injection, auth bypasses, race conditions, API contract breaks) before any push. Fast — reports only the CRITICAL pass from /review. Blocks the push if unresolved critical issues are found. Designed to catch catastrophic bugs without slowing down normal development.
event: pre-push
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pre-Push Safety Net

This hook runs automatically before `git push`. It classifies both passes from the `/review` checklist, then emits only CRITICAL findings that could cause catastrophic remote failures.

**Design goal:** Fast enough that developers don't bypass it. Under 30 seconds for typical diffs.

---

## Step 1: Quick exit conditions

Exit immediately (allow push) if ANY of:

```bash
BRANCH=$(git branch --show-current)
BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
```

- On the base branch (pushing to main/master directly is allowed — branch protection should handle that)
- No diff against base (`git diff origin/$BASE --stat` is empty)
- Diff is documentation-only (all changed files match `*.md`, `*.txt`, `*.rst`, `LICENSE`, `CHANGELOG*`)
- Diff is test-only (all changed files match `*test*`, `*spec*`, `*_test.*`, `*.test.*`)

```bash
# Check if diff is docs-only or test-only
FILES=$(git diff origin/$BASE --name-only)
NON_DOC=$(echo "$FILES" | grep -vE '\.(md|txt|rst)$' | grep -v 'LICENSE' | grep -v 'CHANGELOG' | head -1)
NON_TEST=$(echo "$FILES" | grep -vE '(test|spec|_test\.|\.test\.)' | head -1)

if [ -z "$NON_DOC" ]; then
  echo "pre-push: docs-only change, skipping review"
  exit 0
fi
```

---

## Step 2: Get the diff

```bash
git fetch origin $BASE --quiet 2>/dev/null
DIFF=$(git diff origin/$BASE)
DIFF_STAT=$(git diff origin/$BASE --shortstat)
```

---

## Step 3: Full classification, critical-only gate output

Read the review checklist from `skills/gstack/review/checklist.md`.

Run all CRITICAL and INFORMATIONAL checklist categories against the diff, assigning confidence and severity before filtering. These seven CRITICAL categories are the ones the gate blocks on:

1. **SQL & Data Safety** — Raw SQL without parameterization, missing WHERE on UPDATE/DELETE, SQL injection vectors
2. **Migration & Schema Safety** — Destructive migrations without reversibility, data-loss operations
3. **Race Conditions & Concurrency** — Shared mutable state without locking, check-then-act without atomicity
4. **Auth & Permission Gaps** — Missing auth checks on new endpoints, privilege escalation paths
5. **LLM Output Trust Boundary** — Unsanitized LLM output used in SQL, HTML, or system commands
6. **Enum & Value Completeness** — New enum values not handled in all switch/match statements
7. **API Contract Breaking Changes** — Removed fields, changed response shapes, renamed endpoints

**Speed optimization:** Only read files that are in the diff. Don't grep the entire codebase unless checking enum completeness (which requires finding all references to sibling values).

---

## Step 4: Report and gate

**If no critical issues found:**
```
pre-push ✓ Critical review clean ($DIFF_STAT)
```
Allow the push.

**If critical issues found:**
```
pre-push ✗ BLOCKED — N critical issue(s) found

1. [file:line] SQL injection — raw user input in query string
2. [file:line] Auth gap — new endpoint /api/admin/users has no auth middleware

Fix these before pushing. Run /review for the full analysis.
```

**Block the push** (exit with non-zero status).

---

## Step 5: Override escape hatch

If the hook blocks and the developer is confident the findings are false positives, they can bypass with:

```bash
git push --no-verify
```

The hook should note this in its blocked output:
```
To push anyway: git push --no-verify (use with caution)
```

---

## Important Rules

- **Speed is everything.** This hook must complete in under 30 seconds. If it's slow, developers will bypass it.
- **Critical gate output only.** After classification, report and block only on CRITICAL findings; suppress informational, design, and style findings from hook output.
- **No auto-fixing.** This is a gate, not a fixer. Report and block — the developer fixes.
- **Quiet when clean.** One line of output when everything is fine. Developers shouldn't dread seeing the hook output.
- **Smart skip.** Docs-only and test-only changes skip the review entirely. Don't waste time checking README changes for SQL injection.
- **Never modify files.** This hook reads and reports. It never edits, commits, or changes anything.
