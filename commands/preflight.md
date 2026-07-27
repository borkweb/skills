---
name: preflight
description: Quick pre-merge safety check. Classifies the full /review checklist, emits only critical findings, runs smoke-test QA (homepage + affected pages), and runs a quick test suite. Designed for small PRs where /full-review is overkill. Use when asked to "preflight", "quick check", "safe to merge?", "sanity check", or "pre-merge check".
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---

# Preflight — Fast Pre-Merge Safety Check

You are running the `/preflight` command. This is the fast lane — a lightweight safety check for small PRs where `/full-review` is overkill. It runs three quick passes and gives a go/no-go verdict in under 2 minutes.

**This is NOT a substitute for `/full-review`.** Use `/preflight` for:
- PRs under 100 lines
- Config changes, copy changes, dependency bumps
- Follow-up fixes to already-reviewed PRs
- "Just checking before I merge" situations

For anything touching auth, payments, data models, or new features — use `/full-review` instead.

---

## Step 0: Detect base branch

1. `gh pr view --json baseRefName -q .baseRefName`
2. Fall back: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`
3. Fall back: `main`

---

## Step 1: Scope check

```bash
BRANCH=$(git branch --show-current)
git fetch origin <base> --quiet
DIFF_STAT=$(git diff origin/<base> --stat)
DIFF_SIZE=$(git diff origin/<base> --shortstat)
FILES_CHANGED=$(git diff origin/<base> --name-only)
```

If on the base branch or no diff exists, abort.

**Auto-escalation:** If ANY of these are true, recommend `/full-review` instead:
- More than 200 lines changed
- More than 10 files changed
- Diff touches auth, payment, security, or migration files
- New database tables or schema changes
- New external service integrations

```
The diff is larger/more sensitive than a typical preflight.

A) Run /full-review instead (recommended)
B) Continue with preflight anyway
```

If the user chooses A, hand off to `/full-review`. If B, continue.

---

## Step 2: Full classification, critical-only output

Read the review checklist from `skills/gstack/review/checklist.md`.

Run both Pass 1 (CRITICAL) and Pass 2 (INFORMATIONAL) against the diff, classifying each candidate by confidence and severity:
- SQL & Data Safety
- Migration & Schema Safety
- Race Conditions & Concurrency
- Auth & Permission Gaps
- LLM Output Trust Boundary
- Enum & Value Completeness
- API Contract Breaking Changes

Skip design review and adversarial review; apply the severity filter only when producing preflight output.

**For any CRITICAL finding:**
- AUTO-FIX if mechanical (missing WHERE clause, unsanitized input)
- ASK if judgment is needed

Output:
```
Critical Review: [CLEAN / N issues found]
[If issues: list each with one-line description and action taken]
```

---

## Step 3: Smoke test

**Skip if no browser tool is available.** Output: `Smoke test: SKIPPED (no browser)`

If a browser is available:

1. Detect the running app (check ports 3000, 4000, 8080, 8000). If no app found, skip with note.

2. Identify affected pages from the diff:
   ```bash
   git diff origin/<base> --name-only
   ```
   Map changed files to routes using the same heuristics as `/qa` diff-aware mode.

3. Visit the homepage + each affected page (max 5 pages). At each page:
   - Take a screenshot
   - Check console for errors (JS errors, failed network requests)
   - Click one primary interactive element if obvious

4. Output:
   ```
   Smoke Test: [CLEAN / N issues]
   Pages checked: N
   Console errors: N
   [If issues: list each with page and description]
   ```

---

## Step 4: Quick test run

Detect and run the project's test suite:

```bash
# Detect test runner
# npm test, composer test, bundle exec rspec, pytest, go test, cargo test, etc.
```

If tests pass, note the count. If tests fail, report which tests failed and whether the failures are related to the current diff.

```
Tests: PASS (N tests) / FAIL (N failed, M related to diff)
```

---

## Step 5: Preflight Verdict

```
+════════════════════════════════════════+
|         PREFLIGHT CHECK                |
+════════════════════════════════════════+
| Branch:        [branch] → [base]      |
| Diff:          N files, +X -Y         |
+────────────────────────────────────────+
| Critical Review:  CLEAN / N issues    |
| Smoke Test:       CLEAN / N issues    |
| Tests:            PASS / FAIL         |
+────────────────────────────────────────+
| Verdict:  GO / NO-GO                  |
+════════════════════════════════════════+
```

**GO** — No critical issues, smoke test clean (or skipped), tests pass.
**NO-GO** — Any critical issue unresolved, OR tests fail. List blockers.

If the verdict is GO but there were any auto-fixed issues, remind:
```
Auto-fixed N issues. Remember to commit the fixes before merging.
```

---

## Important Rules

- **Speed over thoroughness.** This is a 2-minute check, not a 20-minute review.
- **Critical output only.** Do not narrow the search by severity; after classification, emit only CRITICAL findings and retain lower-severity findings for `/full-review`.
- **Auto-escalate.** If the diff is too big or too sensitive for preflight, say so immediately.
- **Never block on informational findings.** The question is "will this break prod?" not "is this perfect?"
- **Smoke test is optional.** If no browser or no running app, skip gracefully.
