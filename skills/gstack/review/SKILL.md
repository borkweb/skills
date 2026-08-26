---
name: review
description: >
  Pre-landing PR review. Analyzes diff against the base branch for SQL safety,
  migration safety, auth/permission gaps, error handling anti-patterns, API
  contract breaks, LLM trust boundary violations, conditional side effects, and
  other structural issues. Includes adversarial subagent review, design review
  for frontend changes, and a landing verdict (SAFE TO LAND / LAND WITH
  CAUTION / DO NOT LAND). Use when asked to "review this PR", "code review",
  "pre-landing review", or "check my diff". Proactively suggest when the user
  is about to merge or land code changes.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
---

## Step 1: Detect base branch

Determine which branch this PR targets. Use the result as "the base branch" in all subsequent steps.

```bash
BASE=$(bash "$CLAUDE_PLUGIN_ROOT/scripts/detect-base-branch.sh")
```

The helper checks PR target → repo default → `main`. It always prints a usable name. Substitute `$BASE` wherever the instructions say "the base branch."

---

# Pre-Landing PR Review

You are running the `/review` workflow. Analyze the current branch's diff against the base branch for structural issues that tests don't catch.

---

## Step 2: Check branch

1. Run `git branch --show-current` to get the current branch.
2. If on the base branch, output: **"Nothing to review — you're on the base branch or have no changes against it."** and stop.
3. Run `git fetch origin <base> --quiet && git diff origin/<base> --stat` to check if there's a diff. If no diff, output the same message and stop.

---

## Step 3: Scope Drift Detection

Before reviewing code quality, check: **did they build what was requested — nothing more, nothing less?**

1. Read `TODOS.md` (if it exists). Read PR description (`gh pr view --json body --jq .body 2>/dev/null || true`).
   Read commit messages (`git log origin/<base>..HEAD --oneline`).
   **If no PR exists:** rely on commit messages and TODOS.md for stated intent.
2. Identify the **stated intent** — what was this branch supposed to accomplish?
3. Run `git diff origin/<base> --stat` and compare the files changed against the stated intent.
4. Evaluate with skepticism:

   **SCOPE CREEP detection:**
   - Files changed that are unrelated to the stated intent
   - New features or refactors not mentioned in the plan
   - "While I was in there..." changes that expand blast radius

   **MISSING REQUIREMENTS detection:**
   - Requirements from TODOS.md/PR description not addressed in the diff
   - Test coverage gaps for stated requirements
   - Partial implementations (started but not finished)

   **TODOS.md cross-reference:**
   - Does this PR close any open TODOs? Note: "This PR addresses TODO: <title>"
   - Does this PR create work that should become a TODO? Flag as informational.
   - Are there related TODOs that provide context for this review? Reference them when discussing related findings.

5. Output (before the main review begins):
   ```
   Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
   Intent: <1-line summary of what was requested>
   Delivered: <1-line summary of what the diff actually does>
   [If drift: list each out-of-scope change]
   [If missing: list each unaddressed requirement]
   [If TODOs addressed: list each]
   [If new TODOs needed: list each]
   ```

6. This is **INFORMATIONAL** — does not block the review. Proceed to Step 4.

---

## Step 4: Read the checklist

Read the `checklist.md` file in this skill's directory.

**If the file cannot be read, STOP and report the error.** Do not proceed without the checklist.

---

## Step 5: Get the diff

Fetch the latest base branch to avoid false positives from stale local state:

```bash
git fetch origin <base> --quiet
```

Run `git diff origin/<base>` to get the full diff. This includes both committed and uncommitted changes against the latest base branch.

### Step 5b: Dispatch the adversarial reviewer — now, not at Step 8

The adversarial pass is **launched here** and **collected at Step 8**, so it runs
concurrently with your own checklist pass instead of adding its latency to the
end of the review. Dispatch it as soon as you have the diff, then carry straight
on to Step 6 without waiting.

Dispatch when the diff meets ANY of:
- More than 200 lines changed
- Touches auth, payment, or security-related files
- Introduces new external service integrations
- User explicitly requests it

Otherwise skip it, and record it as SKIPPED rather than as zero findings.

**Dispatch rules — these are not stylistic, the pass silently fails without them:**

- **Never pass a `name`.** A named agent is a *teammate*: the Agent tool returns
  a spawn receipt (`"Spawned successfully… will receive instructions via
  mailbox"`) instead of the findings, the agent reports over a mailbox this
  workflow never reads, and its report is lost. Worse, if `/review` is itself
  running inside a named teammate, a named dispatch fails outright with
  `"Teammates cannot spawn other teammates — the team roster is flat."`
  Dispatch an **unnamed subagent** so the findings come back as the tool result.
- **One dispatch, one attempt.** If it errors, do not re-dispatch with a
  variation — record it as unavailable and move on.
- Give the subagent the **absolute path** of the directory to review. Do not
  assume it inherits your working directory.

Subagent prompt:
"Read the diff for this branch with `git diff origin/<base>` in <absolute path to the review directory>. Think like an attacker and a chaos engineer. Your job is to find ways this code will fail in production. Look for: edge cases, race conditions, security holes, resource leaks, failure modes, silent data corruption, logic errors that produce wrong results silently, error handling that swallows failures, and trust boundary violations. Be adversarial. Be thorough. No compliments — just the problems. For each finding, classify as FIXABLE (you know how to fix it) or INVESTIGATE (needs human judgment).

OUTPUT CONTRACT — your final message IS your return value. It is read by a program, not a person. Do not write findings to a file, do not announce that you are done in some other channel, and do not end your turn without them. If you found nothing, your final message must be exactly `NO FINDINGS` — that is a valid, expected, and useful answer. If you ran out of time or context, return whatever you confirmed so far under the heading `PARTIAL`. Returning nothing at all is the only failing outcome.

Do not modify any file. You are read-only. If you believe a fix is warranted, describe it as a finding."

---

## Step 6: Two-pass review

Apply the checklist against the diff in two passes:

1. **Pass 1 (CRITICAL):** SQL & Data Safety, Migration & Schema Safety, Race Conditions & Concurrency, Auth & Permission Gaps, LLM Output Trust Boundary, Enum & Value Completeness, API Contract Breaking Changes
2. **Pass 2 (INFORMATIONAL):** Error Handling Anti-Patterns, Conditional Side Effects, Magic Numbers & String Coupling, Dead Code & Consistency, LLM Prompt Issues, Test Gaps, Crypto & Entropy, Time Window Safety, Type Coercion at Boundaries, View/Frontend, Performance & Bundle Impact

**Security pattern references:** For deeper CVE-grounded patterns on any of the areas below, read the matching file from `../../core/review-security/patterns/` BEFORE flagging. These calibrate findings against real incidents (Heartbleed, Log4Shell, Next.js CVE-2025-29927, runc escape, etc.) and catch failure modes the checklist's one-liners miss.

| Diff touches…                       | Read pattern(s)                        |
|-------------------------------------|----------------------------------------|
| Buffer/array handling (C/C++)       | 01 Bounds, 11 Integer Arithmetic       |
| New/changed auth or middleware      | 03 Auth                                |
| Crypto ops (hashing, signing, RNG)  | 04 Crypto Hygiene                      |
| Parsers / deserialization / uploads | 17 Canonicalization, 02 Injection, 01  |
| Concurrency / goroutines / locks    | 05 Race Conditions                     |
| Error paths on privileged ops       | 07 Error Handling                      |
| Dependency / lockfile / CI config   | 08 Supply Chain                        |
| Web / browser / frontend            | 16 Web App Security                    |
| New HTTP endpoint                   | 03 Auth, 02 Injection, 16 Web          |
| Refactors of security-sensitive code| 14 Regression Prevention               |

Read the pattern file, apply its "What To Check" list to the diff, cite the specific Red Flag when flagging.

**Enum & Value Completeness requires reading code OUTSIDE the diff.** When the diff introduces a new enum value, status, tier, or type constant, use Grep to find all files that reference sibling values, then Read those files to check if the new value is handled. This is the one category where within-diff review is insufficient.

**Search-before-recommending:** When recommending a fix pattern (especially for concurrency, caching, auth, or framework-specific behavior):
- Verify the pattern is current best practice for the framework version in use
- Check if a built-in solution exists in newer versions before recommending a workaround
- Verify API signatures against current docs (APIs change between versions)

If WebSearch is unavailable, note it and proceed with existing knowledge.

Follow the output format specified in the checklist. Respect the suppressions — do NOT flag items listed in the "DO NOT flag" section.

---

## Step 7: Design Review (conditional)

Check if the diff touches frontend files:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/detect-frontend-files.sh" "$BASE"
```

**If output is empty:** Skip design review silently. No output.

**If frontend files changed:**

1. **Check for DESIGN.md.** If `DESIGN.md` or `design-system.md` exists in the repo root, read it. All design findings are calibrated against it — patterns blessed in DESIGN.md are not flagged. If not found, use universal design principles.

2. **Read the `design-checklist.md` file** in this skill's directory. If the file cannot be read, skip design review with a note: "Design checklist not found — skipping design review."

3. **Read each changed frontend file** (full file, not just diff hunks).

4. **Apply the design checklist** against the changed files. For each item:
   - **[HIGH] mechanical CSS fix** (`outline: none`, `!important`, `font-size < 16px`): classify as AUTO-FIX
   - **[HIGH/MEDIUM] design judgment needed**: classify as ASK
   - **[LOW] intent-based detection**: present as "Possible — verify visually"

5. **Include findings** in the review output under a "Design Review" header. Design findings merge with code review findings into the same Fix-First flow.

---

## Step 8: Adversarial Review — collect

The adversarial reviewer was dispatched back at Step 5b and has been working while
you ran Steps 6 and 7. Collect it here. It has fresh context — no checklist bias
from the structured review.

If Step 5b skipped the dispatch, skip this step too and carry `SKIPPED` into
Step 12.

### The pass reported

Present findings under an `ADVERSARIAL REVIEW:` header. **FIXABLE findings** flow
into the same Fix-First pipeline. **INVESTIGATE findings** are presented as
informational. Record the count for Step 12.

A report of `NO FINDINGS` is a real result — record it as `0 findings` and move on.

### The pass did not report

This is common and you must handle it without stalling. A subagent that has gone
quiet is **not** a subagent that found nothing.

1. **Ping once. Only once.** Ask for what it has already confirmed, and state
   that partial results and "nothing found" are both acceptable answers.
2. **If the ping does not produce findings, stop.** Do not ping a second time —
   in this workflow's history a third ping has never once produced output. Do not
   re-dispatch. Do not wait on it while the rest of the review idles.
3. **Check the working tree before calling the pass empty.** A silent reviewer
   may still have edited files. Run `git status --porcelain` in the review
   directory. If anything changed, read the diff and either verify and report each
   change as a finding, or revert it — never leave an unreported edit on disk.
4. **Run the adversarial questions yourself** against the highest-risk part of the
   diff, and label those findings as your own, not as the subagent's.
5. **Carry `NO RESPONSE` into Step 12** — never `0 findings`. Silence is missing
   evidence, not a clean bill of health, and the landing verdict depends on the
   difference.

Never block Step 9 on this step. If the adversarial pass has not reported by the
time you reach the Fix-First flow, proceed without it and say so.

---

## Step 9: Fix-First Review

**Every finding gets action — not just critical ones.**

Output a summary header: `Pre-Landing Review: N issues (X critical, Y informational)`

### Step 9a: Classify each finding

For each finding, classify as AUTO-FIX or ASK per the Fix-First Heuristic in
checklist.md. Critical findings lean toward ASK; informational findings lean
toward AUTO-FIX.

### Step 9b: Auto-fix all AUTO-FIX items

Apply each fix directly. For each one, output a one-line summary:
`[AUTO-FIXED] [file:line] Problem → what you did`

### Step 9c: Batch-ask about ASK items

If there are ASK items remaining, present them in ONE AskUserQuestion:

- List each item with a number, the severity label, the problem, and a recommended fix
- For each item, provide options: A) Fix as recommended, B) Skip
- Include an overall RECOMMENDATION

Example format:
```
I auto-fixed 5 issues. 2 need your input:

1. [CRITICAL] app/models/post.rb:42 — Race condition in status transition
   Fix: Add `WHERE status = 'draft'` to the UPDATE
   → A) Fix  B) Skip

2. [INFORMATIONAL] app/services/generator.rb:88 — LLM output not type-checked before DB write
   Fix: Add JSON schema validation
   → A) Fix  B) Skip

RECOMMENDATION: Fix both — #1 is a real race condition, #2 prevents silent data corruption.
```

If 3 or fewer ASK items, you may use individual AskUserQuestion calls instead of batching.

### Step 9d: Apply user-approved fixes

Apply fixes for items where the user chose "Fix." Output what was fixed.

If no ASK items exist (everything was AUTO-FIX), skip the question entirely.

---

## Step 10: Documentation staleness check

Cross-reference the diff against documentation files. For each `.md` file in the repo root (README.md, ARCHITECTURE.md, CONTRIBUTING.md, CLAUDE.md, AGENTS.md, etc.):

1. Check if code changes in the diff affect features, components, or workflows described in that doc file.
2. If the doc file was NOT updated in this branch but the code it describes WAS changed, flag it as an INFORMATIONAL finding:
   "Documentation may be stale: [file] describes [feature/component] but code changed in this branch."

This is informational only — never critical.

If no documentation files exist, skip this step silently.

---

## Step 11: Post-fix verification

After all fixes (auto-fix and user-approved) are applied, verify nothing was broken:

1. **Run the test suite** (if a test runner is detectable):
   - Look for `package.json` scripts (`test`), `Makefile` targets, `composer.json` scripts, `Rakefile`, etc.
   - Run the appropriate test command. If the suite is large, run only tests related to changed files if possible.
   - If tests fail: report which tests failed and whether the failure is from a review fix or was pre-existing.

2. **Syntax/lint check** (if a linter is configured):
   - Run the project's linter on changed files only.
   - Report any new lint errors introduced by fixes.

3. **Diff sanity check:**
   - Run `git diff --stat` to show what the review changed.
   - Verify no unintended files were modified.

If no test runner or linter is detectable, skip to the diff sanity check only.

If any fix introduced a test failure, flag it as a **review regression** and offer to revert that specific fix.

---

## Step 12: Completion Summary & Landing Verdict

### Completion Summary

Display a structured summary of the entire review:

```
  +====================================================================+
  |            PRE-LANDING REVIEW — COMPLETION SUMMARY                  |
  +====================================================================+
  | Base branch          | [detected branch name]                      |
  | Diff size            | ___ files changed, ___ insertions, ___ del  |
  | Scope check          | CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING|
  +--------------------------------------------------------------------+
  | CRITICAL findings    | ___ total (___ auto-fixed, ___ user-decided)|
  | INFORMATIONAL finds  | ___ total (___ auto-fixed, ___ user-decided)|
  | Design findings      | ___ total / SKIPPED (no frontend changes)   |
  | Adversarial findings | ___ FIXABLE, ___ INVESTIGATE / SKIPPED /    |
  |                      | NO RESPONSE (pass did not report)           |
  +--------------------------------------------------------------------+
  | Auto-fixes applied   | ___ total                                   |
  | User-approved fixes  | ___ total                                   |
  | User-skipped items   | ___ total                                   |
  | TODOs addressed      | ___ items from TODOS.md                     |
  | New TODOs flagged    | ___ items                                   |
  | Stale docs flagged   | ___ files                                   |
  | Post-fix tests       | PASSED / ___ FAILED / NOT RUN               |
  | Unresolved items     | ___ (listed below)                          |
  +====================================================================+
```

### Landing Verdict

After completing the summary, issue one of:

* **SAFE TO LAND** — No unresolved CRITICAL findings. All fixes applied cleanly. Tests pass (or no regressions). Ship it.
* **LAND WITH CAUTION** — No unresolved CRITICAL findings, but ___ items need attention. List each with a one-line description. These are non-blocking but the author should be aware.
* **DO NOT LAND** — ___ unresolved CRITICAL findings remain. List each with: what's broken, why it's dangerous, and what's needed to fix it. Do NOT merge until these are resolved.

The verdict must be consistent with the data:
- If any CRITICAL finding was skipped by the user, the verdict cannot be SAFE TO LAND — it is LAND WITH CAUTION at best, with the skipped item noted.
- If any CRITICAL finding is unresolved (not fixed and not explicitly skipped), the verdict is DO NOT LAND.
- If post-fix tests fail due to a review fix, the verdict cannot be SAFE TO LAND until the regression is resolved.
- **If the adversarial pass was dispatched and returned NO RESPONSE, the verdict cannot be SAFE TO LAND.** It is LAND WITH CAUTION at minimum, carrying the line "adversarial pass unavailable this run — coverage is the structured checklist only." An unrun check is missing evidence, not a passed check, and reporting it as `0 findings` would turn a gap into a false assurance. A pass that was never dispatched (SKIPPED, because the diff didn't meet Step 5b's criteria) does not carry this penalty — say which one it was.

---

## Important Rules

- **Read the FULL diff before commenting.** Do not flag issues already addressed in the diff.
- **Fix-first, not read-only.** AUTO-FIX items are applied directly. ASK items are only applied after user approval. Never commit, push, or create PRs.
- **Be terse.** One line problem, one line fix. No preamble.
- **Only flag real problems.** Skip anything that's fine.
