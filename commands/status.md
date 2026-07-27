---
name: status
description: Branch status and workflow progress report. Shows current branch state, PR status, what skills have been run, and what's left before the work is shippable. Use when asked to "status", "where am I", "what's left", "progress check", or "am I ready to ship".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Status — Where Am I?

You are running the `/status` command. Give the user a quick situational awareness report — where they are, what's been done, and what's left.

**This is read-only.** Don't change any files or run any fixes.

---

## Step 1: Branch State

```bash
BRANCH=$(git branch --show-current)
BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")

echo "Branch: $BRANCH"
echo "Base: $BASE"

# Diff summary
git fetch origin $BASE --quiet 2>/dev/null
git diff origin/$BASE --shortstat
git log origin/$BASE..HEAD --oneline

# Working tree
git status --porcelain | head -20
```

---

## Step 2: PR Status

```bash
gh pr view --json number,title,state,isDraft,reviewDecision,statusCheckRollup,labels,url 2>/dev/null
```

If a PR exists, report:
- PR number, title, URL
- State (open/closed/merged)
- Draft status
- Review status (approved, changes requested, pending)
- CI status (passing, failing, pending)
- Labels

If no PR exists, note: "No PR created yet."

---

## Step 3: Workflow Progress Detection

Detect which workflow skills have been run by scanning for their artifacts:

| Skill | Detection signal |
|-------|-----------------|
| `/plan-session` | Design doc exists (look for `*design*.md`, `*plan*.md`, `*spec*.md` in project root or docs/) |
| `/plan-deep-review` | Design doc contains "READINESS VERDICT" or "SCOPE EXPANSION" markers |
| `/plan-eng-review` | Design doc contains "ENGINEERING REVIEW" or architecture diagrams |
| `/plan-design-review` | Design doc contains "DESIGN REVIEW" or design dimension ratings |
| `/design-consultation` | `DESIGN.md` exists in project root |
| `/review` | Commit messages contain `[AUTO-FIXED]` or PR body contains "Pre-Landing Review" |
| `/design-review` | Commit messages contain `fix(design):` |
| `/qa` | Commit messages contain `fix(qa):` |

Also check:
- `TODOS.md` for open items related to this branch
- `CHANGELOG.md` for whether this branch's work is documented
- `VERSION` file for current version

```bash
# Check for workflow artifacts
git log origin/$BASE..HEAD --oneline --format="%s" | head -30
ls TODOS.md CHANGELOG.md VERSION DESIGN.md 2>/dev/null
```

---

## Step 4: Readiness Assessment

Use this dependency map to pick the next action based on what's been detected:

| After completing... | Suggest next... | Why |
|---------------------|----------------|-----|
| `/plan-session` | `/plan-deep-review` or `/plan-eng-review` | Design doc needs validation before implementation |
| `/plan-deep-review` | `/plan-eng-review` | Scope is locked — now lock the architecture |
| `/plan-eng-review` | `/plan-design-review` (if UI) or start coding | Architecture is locked — design review or implement |
| `/plan-design-review` | `/design-consultation` (if no design system) or start coding | Design is validated — implement |
| `/design-consultation` | Start coding | Design system established |
| Implementation done | `/review` | Code needs review before testing |
| `/review` | `/qa` or `/design-review` (if frontend) | Reviewed code needs testing |
| `/design-review` | `/qa` | Design is fixed — functional QA next |
| `/qa` | Open the PR and merge | QA passed — ready to land |
| Merged | `/plan-session` for next feature | Cycle complete — start next iteration |

Then output the readiness assessment:

```
STATUS REPORT
══════════════════════════════════════════════

Branch:          [branch] → [base]
Diff:            N files changed, +X -Y
Commits:         N commits
Working tree:    clean / N uncommitted changes

PR:              [#N title (url)] / Not created
PR State:        [draft/open] — [review status] — [CI status]

WORKFLOW PROGRESS
─────────────────
[✓] Plan session       — design doc found
[✓] Eng review         — architecture review markers found
[ ] Design review      — not detected
[✓] Code review        — N auto-fix commits found
[✓] QA                 — N fix(qa) commits found
[ ] Ship               — PR is still draft

OPEN ITEMS
──────────
- TODOS.md: N open items related to this branch
- Uncommitted changes: [list if any]
- Unresolved review items: [if detectable from PR comments]

NEXT STEPS
──────────
Based on current progress, suggested next action(s):
→ [specific recommendation, e.g., "Run /review — no code review detected yet"]
→ [e.g., "Open the PR — code is reviewed, QA'd, and tests pass"]
```

---

## Step 5: Quick Health Indicators

Run fast, non-destructive checks:

```bash
# Are tests passing?
# Try to detect the test command without running the full suite
# Just report what the test command would be

# Is the branch up to date with base?
git merge-base --is-ancestor origin/$BASE HEAD && echo "UP_TO_DATE" || echo "BASE_HAS_NEW_COMMITS"

# Any merge conflicts pending?
git merge-tree $(git merge-base origin/$BASE HEAD) origin/$BASE HEAD 2>/dev/null | grep -c "^<<<<<<<" || echo "0"
```

If the base branch has new commits, note:
```
⚠ Base branch has new commits not merged into this branch.
  Run: git merge origin/<base>
```

---

## Important Rules

- **Read-only.** This command observes and reports. It never changes files, makes commits, or modifies state.
- **Fast.** This should complete in under 10 seconds. Don't run tests, don't open browsers, don't analyze diffs deeply.
- **Actionable.** Every status report ends with specific next-step recommendations.
- **Honest.** If a workflow step can't be detected, say "not detected" rather than guessing. Absence of evidence is not evidence of absence — the user may have run the skill in a different session.
