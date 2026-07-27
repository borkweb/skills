---
name: full-review
description: Chains /review + /design-review + /qa into a single workflow. /review-security runs as Stage 2 when the diff touches security-sensitive code (auto-detected) or when --security is passed; skip with --no-security. Runs pre-landing code review, then live design audit, then QA testing — passing context forward between each stage. Use when you want the complete review pipeline in one command. Accepts optional URL, tier, and security flag arguments.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
---

# Full Review Pipeline

You are running the `/full-review` command. This chains three skills into a single workflow: `/review` → `/design-review` → `/qa`. Each stage feeds context to the next. A deep CVE-pattern-based security audit (`/review-security`) auto-inserts as Stage 2 when the diff touches security-sensitive code; `--security` forces it on, `--no-security` forces it off.

## Arguments

- `/full-review` — run all three stages, auto-detect URL, auto-detect security trigger
- `/full-review <url>` — use the given URL for design-review and QA
- `/full-review --quick` — quick tier for QA (critical/high only)
- `/full-review --exhaustive` — exhaustive tier for QA (all severities)
- `/full-review --security` — force `/review-security` to run as Stage 2 even if auto-detect didn't flag the diff. Use for release audits or when you want pattern-library coverage on a diff that doesn't obviously touch sensitive code.
- `/full-review --no-security` — skip `/review-security` even if auto-detect would have triggered it
- `/full-review --skip-design` — skip the design review stage
- `/full-review --skip-qa` — skip the QA stage

---

## Step 0: Detect base branch

Determine which branch this PR targets. Use the result as "the base branch" in all subsequent steps.

1. Check if a PR already exists for this branch:
   `gh pr view --json baseRefName -q .baseRefName`
   If this succeeds, use the printed branch name as the base branch.

2. If no PR exists (command fails), detect the repo's default branch:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`

3. If both commands fail, fall back to `main`.

---

## Step 1: Pre-flight check

1. Run `git branch --show-current`. If on the base branch, **abort**: "Nothing to review — you're on the base branch."
2. Run `git fetch origin <base> --quiet && git diff origin/<base> --stat` to confirm there's a diff.
3. Check for frontend files in the diff:
   ```bash
   git diff origin/<base> --name-only | grep -E '\.(css|scss|less|tsx|jsx|vue|svelte|html|blade\.php)$' | head -5
   ```
   Record whether frontend files changed — this determines whether design-review runs.

4. **Auto-detect security signals.** Scan the diff for security-sensitive changes. Stage 2 auto-triggers if any signal hits (unless `--no-security` is passed). Skip this step entirely if `--security` was passed (forced on) or `--no-security` was passed (forced off). Signals that count:

   **File-path signals** (`git diff origin/<base> --name-only`):
   - Auth/session/permissions: paths matching `auth`, `session`, `login`, `jwt`, `oauth`, `permission`, `csrf`, `cors`, `bearer`, `middleware`
   - Crypto/secrets: `crypto`, `cert`, `signing`, `secret`, `vault`, `kms` (excluding `keyboard`/`keystroke`)
   - Lockfiles (supply chain): `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `composer.lock`, `Gemfile.lock`, `Cargo.lock`, `go.sum`, `Pipfile.lock`, `poetry.lock`, `requirements*.txt`
   - CI/build/container: `.github/workflows/*`, `.gitlab-ci.yml`, `Dockerfile*`, `docker-compose*`, `Containerfile*`
   - Public API contracts: `openapi*`, `swagger*`, `*.proto`, `*.graphql`

   **Diff-content signals** (run a few targeted greps over `git diff origin/<base>` — don't try to regex the entire diff at once):
   - Code execution sinks: `exec(`, `eval(`, `unserialize(`, `pickle.loads(`, `subprocess`, `shell_exec`, `system(`, `Function(`
   - DOM injection sinks: `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `bypassSecurityTrust`
   - Crypto primitives in code: `crypto.`, `bcrypt`, `argon2`, `hashlib`, `RSA`, `AES`, `HMAC`, `createHash`, `createCipher`
   - Buffer ops (C/C++/unsafe Rust): `memcpy`, `strcpy`, `sprintf`, `strcat`, `unsafe {`
   - SQL constructed from variables: template-literal queries (`` `SELECT … ${…}` ``) or string-concat queries (`"SELECT … " + …`)

   Record which categories hit (e.g. `auto: auth + crypto`). This drives both the Stage 2 decision and the summary output.

Output a brief summary. Resolve the **Security audit** line based on flags + auto-detect, and drop "Security Review" from the **Stages** line if the audit row resolves to a "no":

```
Full Review Pipeline
────────────────────
Branch:          [current branch] → [base branch]
Diff size:       N files, +X -Y
Frontend files:  [yes/no]
Stages:          Review → [Security Review →] Design Review → QA
QA Tier:         [Standard/Quick/Exhaustive]
Security audit:  [yes (--security) / yes (auto: <categories>) / no (--no-security) / no (no signals)]
```

---

## Step 2: Stage 1 — Code Review (/review)

Read the `/review` skill's `SKILL.md` from `skills/gstack/review/SKILL.md`. Execute its full workflow:

- Scope drift detection
- Two-pass checklist review (critical + informational)
- Design review (if frontend files changed — this is the in-diff design review, distinct from Stage 3's live-site review)
- Adversarial review (if diff qualifies)
- Fix-first pipeline (auto-fix + ask)
- Post-fix verification
- Landing verdict

**Capture the review output.** Save:
- Number of issues found (critical/informational)
- Number auto-fixed
- Number user-decided
- Landing verdict
- Any unresolved items

**If landing verdict is DO NOT LAND:** Ask the user:
```
The code review found unresolved critical issues.

A) Continue with design review and QA anyway — I want the full picture
B) Stop here — I'll fix the critical issues first
```

If the user chooses B, stop and output the review summary.

---

## Step 3: Stage 2 — Security Review (/review-security) [conditional]

**Skip conditions** (any of):
- `--no-security` flag was passed (explicit force-off), OR
- `--security` flag was NOT passed AND Step 1 auto-detect found no security signals

**Run conditions** (any of):
- `--security` flag was passed (explicit force-on), OR
- Step 1 auto-detect found at least one security signal AND `--no-security` was NOT passed

If skipping, output nothing for this stage — proceed directly to Stage 3. Do not include a "SKIPPED" line in the summary.

**Otherwise:**

1. Read the `/review-security` skill's `SKILL.md` from `skills/core/review-security/SKILL.md`. Execute its full workflow:
   - Scope the review (same diff as Stage 1)
   - Pick relevant pattern files from the Change Type → Primary Patterns table
   - Apply each selected pattern to the diff (Read the pattern file, walk its "What To Check" list, cite `file:line` + the matched Red Flag)
   - Adversarial pass (if diff qualifies)
   - Fix-First output with CRITICAL/HIGH/INFORMATIONAL severity
   - Verdict: PASS / PASS WITH REMEDIATIONS / FAIL

2. **Capture the security review output.** Save:
   - Number of findings (critical/high/informational)
   - Patterns applied (e.g. "03, 02, 16")
   - Number auto-fixed
   - Number user-decided
   - Security verdict
   - Any unresolved CRITICAL or HIGH findings

**If security verdict is FAIL:** Ask the user:
```
The security review found unresolved CRITICAL or HIGH findings:
  [list each with pattern reference]

A) Continue with design review and QA anyway — I want the full picture
B) Stop here — these need to be fixed before anything lands
```

If the user chooses B, stop and output the review + security summary.

---

## Step 4: Stage 3 — Design Review (/design-review)

**Skip conditions:**
- `--skip-design` flag was passed
- No frontend files changed in the diff
- No browser tool is available

If skipping, output: `Stage 3: Design Review — SKIPPED (no frontend changes)` and proceed to Stage 4.

**Otherwise:**

1. Detect the running app URL. If a URL was provided as an argument, use it. Otherwise check common local dev ports (3000, 4000, 8080, 8000). If no app is found, ask the user for the URL.

2. Read the `/design-review` skill's `SKILL.md` from `skills/gstack/design-review/SKILL.md`. Execute its workflow in **diff-aware mode** — only audit pages affected by the current branch's changes.

3. For each design issue found, apply fixes with atomic commits.

**Capture the design review output.** Save:
- Number of design issues found
- Number fixed
- Category scores and letter grade

---

## Step 5: Stage 4 — QA Testing (/qa)

**Skip conditions:**
- `--skip-qa` flag was passed
- No browser tool is available

If skipping, output: `Stage 4: QA — SKIPPED` and proceed to summary.

**Otherwise:**

1. Use the same URL from Stage 3 (or detect/ask if Stage 3 was skipped).

2. Read the `/qa` skill's `SKILL.md` from `skills/gstack/qa/SKILL.md`. Execute its workflow in **diff-aware mode** with the selected tier.

3. The QA skill will find bugs, fix them atomically, and re-verify.

**Capture the QA output.** Save:
- Number of issues found
- Number fixed (verified/best-effort/reverted/deferred)
- Health score (before → after)

---

## Step 7: Pipeline Summary

Output a combined summary of all stages. Include the Security Review block only if Stage 2 actually ran (either `--security` was passed or auto-detect triggered it).

```
+====================================================================+
|              FULL REVIEW PIPELINE — SUMMARY                         |
+====================================================================+

STAGE 1: CODE REVIEW
├─ Issues found:     N (X critical, Y informational)
├─ Auto-fixed:       N
├─ User-decided:     N (M fixed, K skipped)
├─ Landing verdict:  SAFE TO LAND / LAND WITH CAUTION / DO NOT LAND
└─ Unresolved:       N items

STAGE 2: SECURITY REVIEW                             [only if Stage 2 ran]
├─ Patterns applied: NN, NN, NN
├─ Findings:         N (X critical, Y high, Z informational)
├─ Auto-fixed:       N
├─ User-decided:     N (M fixed, K skipped)
├─ Security verdict: PASS / PASS WITH REMEDIATIONS / FAIL
└─ Unresolved:       N critical/high items

STAGE 3: DESIGN REVIEW
├─ Design issues:    N found, M fixed
├─ Grade:            [A-F]
└─ Status:           COMPLETE / SKIPPED

STAGE 4: QA TESTING
├─ Bugs found:       N
├─ Fixed:            N (verified: X, best-effort: Y, reverted: Z)
├─ Deferred:         N
├─ Health score:     X → Y
└─ Status:           COMPLETE / SKIPPED

OVERALL
├─ Total commits:    N (from all review/fix stages)
├─ Tests:            PASS / FAIL
├─ Ship readiness:   READY / READY WITH CAVEATS / NOT READY
└─ Time elapsed:     Xm Ys

+====================================================================+
```

**Ship readiness logic:**
- **READY** — Code review SAFE TO LAND, security verdict PASS or PASS WITH REMEDIATIONS (if security ran), design grade C or above, QA health ≥ 70, tests pass
- **READY WITH CAVEATS** — Code review LAND WITH CAUTION, or design grade D, or QA health 50-69, or security PASS WITH REMEDIATIONS when unresolved HIGH findings exist
- **NOT READY** — Code review DO NOT LAND, or security FAIL, or design grade F, or QA health < 50, or tests fail

Security verdict FAIL overrides all other signals — NOT READY regardless of other stages.

---

## Important Rules

- **Each stage runs fully.** Don't abbreviate stages — the value is in the thoroughness.
- **Context passes forward.** Issues found in code review inform what to look for in design review and QA.
- **Atomic commits throughout.** Every fix from every stage gets its own commit.
- **Test after the full pipeline.** Not just after each stage — run tests at the end to catch cross-stage interactions.
- **Never auto-skip design review or QA** because the code review was clean. Clean code can still have design bugs and user-facing issues.
