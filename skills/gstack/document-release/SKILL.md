---
name: document-release
description: >
  Post-ship documentation update. Reads all project docs, cross-references the
  diff, updates README/ARCHITECTURE/CONTRIBUTING/CLAUDE.md to match what
  shipped, polishes CHANGELOG voice, cleans up TODOS, and optionally bumps
  VERSION. Use when asked to "update the docs", "sync documentation", or
  "post-ship docs". Proactively suggest after a PR is merged or code is
  shipped.
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

## Step 0: Prerequisites & Base Branch Detection

Before doing anything else, verify the environment can support this workflow. These checks
prevent confusing failures mid-run.

1. **Git repo check:** Run `git rev-parse --git-dir`. If it fails, abort: "Not a git repository."
2. **gh CLI check:** Run `gh auth status`. If it fails, warn: "gh CLI is not authenticated —
   PR-related steps (body update, base branch detection via PR) will be skipped. Falling back to
   git-only detection." Continue the workflow but skip PR body updates in Step 9.
3. **Clean working tree check:** Run `git status --porcelain` (never use `-uall`). If there are
   uncommitted changes to documentation files (`.md`, `VERSION`, `CHANGELOG*`), warn the user:
   "You have uncommitted changes to doc files that may conflict with this workflow. Continue
   anyway?" via AskUserQuestion.

Then determine which branch this PR targets. Use the result as "the base branch" in all
subsequent steps.

4. Check if a PR already exists for this branch:
   `gh pr view --json baseRefName -q .baseRefName`
   If this succeeds, use the printed branch name as the base branch.

5. If no PR exists (command fails), detect the repo's default branch:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`

6. If both commands fail, fall back to `main`.

---

# Document Release: Post-Ship Documentation Update

You are running the `/document-release` workflow. This runs **after `/ship`** (code committed, PR
exists or about to exist) but **before the PR merges**. Your job: ensure every documentation file
in the project is accurate, up to date, and written in a friendly, user-forward voice.

You are mostly automated. Make obvious factual updates directly. Stop and ask only for risky or
subjective decisions.

**Dry-run mode:** If the user says "dry run", "preview", or "what would change", run Steps 0–2
in full (analysis and audit) but do NOT apply any edits. Instead, output a structured preview of
every planned change — organized by file, with each change classified as auto-update or
ask-user. Then stop and ask: "Ready to apply these changes, or do you want to adjust the plan?"
If the user approves, continue from Step 3 onward using the plan. If they adjust, incorporate
their feedback and re-preview.

**Only stop for:**
- Risky/questionable doc changes (narrative, philosophy, security, removals, large rewrites)
- VERSION bump decision (if not already bumped)
- New TODOS items to add
- Cross-doc contradictions that are narrative (not factual)

**Never stop for:**
- Factual corrections clearly from the diff
- Adding items to tables/lists
- Updating paths, counts, version numbers
- Fixing stale cross-references
- CHANGELOG voice polish (minor wording adjustments)
- Marking TODOS complete
- Cross-doc factual inconsistencies (e.g., version number mismatch)

**NEVER do:**
- Overwrite, replace, or regenerate CHANGELOG entries — polish wording only, preserve all content
- Bump VERSION without asking — always use AskUserQuestion for version changes
- Use `Write` tool on CHANGELOG.md — always use `Edit` with exact `old_string` matches

---

## Step 1: Pre-flight & Diff Analysis

1. Check the current branch. If on the base branch, **abort**: "You're on the base branch. Run from a feature branch."

2. Gather context about what changed:

```bash
git diff <base>...HEAD --stat
git log <base>..HEAD --oneline
git diff <base>...HEAD --name-only
```

3. Discover all documentation files in the repo using the Glob tool (not `find`):

   - `**/*.md` at the project root, then filter out `.git/`, `node_modules/`, and `vendor/` paths.
   - Focus on top-level and one-level-deep files first — those are the primary docs. Deeper files
     are usually auto-generated or less critical.

4. Classify the changes into categories relevant to documentation:
   - **New features** — new files, new commands, new skills, new capabilities
   - **Changed behavior** — modified services, updated APIs, config changes
   - **Removed functionality** — deleted files, removed commands
   - **Infrastructure** — build system, test infrastructure, CI

5. Output a brief summary: "Analyzing N files changed across M commits. Found K documentation files to review."

---

## Step 2: Per-File Documentation Audit

Read each documentation file and cross-reference it against the diff:

**README.md:**
- Does it describe all features and capabilities visible in the diff?
- Are install/setup instructions consistent with the changes?
- Are examples, demos, and usage descriptions still valid?
- Are troubleshooting steps still accurate?

**ARCHITECTURE.md:**
- Do ASCII diagrams and component descriptions match the current code?
- Are design decisions and "why" explanations still accurate?
- Be conservative — only update things clearly contradicted by the diff.

**CONTRIBUTING.md — New contributor smoke test:**
- Walk through the setup instructions as if you are a brand new contributor.
- Are the listed commands accurate? Would each step succeed?
- Flag anything that would fail or confuse a first-time contributor.

**CLAUDE.md / AGENTS.md / project instructions:**
- Does the project structure section match the actual file tree?
- Are listed commands and scripts accurate?
- Do build/test instructions match what's in config files?

**Any other .md files:**
- Read the file, determine its purpose and audience.
- Cross-reference against the diff to check if it contradicts anything the file says.

**Inline and generated documentation:**
Code-level documentation often falls out of sync with markdown docs. When the diff includes
changes to public APIs, check for staleness in:
- **PHPDoc / JSDoc / docblocks** — If a function signature, return type, or behavior changed in
  the diff, verify the accompanying docblock still matches. Use Grep to search for `@param`,
  `@return`, `@throws` in the changed files.
- **OpenAPI / Swagger specs** — If API endpoints were added, changed, or removed, check whether
  an `openapi.yaml`, `swagger.json`, or similar spec file exists and needs updating. Use Glob
  to find `**/openapi.*`, `**/swagger.*`.
- **README badges / auto-generated sections** — If the repo uses badges (coverage, version,
  build status), verify they still reference correct values. If sections are marked as
  auto-generated (e.g., `<!-- AUTO-GENERATED -->`), flag them rather than editing — they should
  be regenerated by their tooling, not hand-edited.

These are supplementary checks — don't deep-dive into every source file. Focus on files that
appear in the diff and have public-facing documentation implications.

For each file, classify needed updates as:

- **Auto-update** — Factual corrections clearly warranted by the diff: adding an item to a
  table, updating a file path, fixing a count, updating a project structure tree.
- **Ask user** — Narrative changes, section removal, security model changes, large rewrites
  (more than ~10 lines in one section), ambiguous relevance, adding entirely new sections.

---

## Step 3: Apply Auto-Updates

Make all clear, factual updates directly using the Edit tool.

For each file modified, output a one-line summary describing **what specifically changed** — not
just "Updated README.md" but "README.md: added /new-skill to skills table, updated skill count
from 9 to 10."

**Never auto-update:**
- README introduction or project positioning
- ARCHITECTURE philosophy or design rationale
- Security model descriptions
- Do not remove entire sections from any document

---

## Step 4: Ask About Risky/Questionable Changes

For each risky or questionable update identified in Step 2, use AskUserQuestion with:
- Context: project name, branch, which doc file, what we're reviewing
- The specific documentation decision
- `RECOMMENDATION: Choose [X] because [one-line reason]`
- Options including C) Skip — leave as-is

Apply approved changes immediately after each answer.

---

## Step 5: VERSION Bump Question

VERSION comes before CHANGELOG polish because if the user bumps the version here, the CHANGELOG
entry and cross-doc consistency checks in later steps will reflect the correct version number.

**CRITICAL — NEVER BUMP VERSION WITHOUT ASKING.**

1. **If VERSION does not exist:** Skip silently.

2. Check if VERSION was already modified on this branch:

```bash
git diff <base>...HEAD -- VERSION
```

3. **If VERSION was NOT bumped:** Use AskUserQuestion:
   - RECOMMENDATION: Choose C (Skip) because docs-only changes rarely warrant a version bump
   - A) Bump PATCH — if doc changes ship alongside code changes
   - B) Bump MINOR — if this is a significant standalone release
   - C) Skip — no version bump needed

4. **If VERSION was already bumped:** Check whether the bump covers the full scope. If there are
   significant uncovered changes, ask whether to bump again or fold into the existing version.

---

## Step 6: CHANGELOG Voice Polish

**CRITICAL — NEVER CLOBBER CHANGELOG ENTRIES.**

This step polishes voice. It does NOT rewrite, replace, or regenerate CHANGELOG content.

**Rules:**
1. Read the entire CHANGELOG.md first. Understand what is already there.
2. Only modify wording within existing entries. Never delete, reorder, or replace entries.
3. Never regenerate a CHANGELOG entry from scratch. The entry was written from the actual diff
   and commit history. It is the source of truth. You are polishing prose, not rewriting history.
4. If an entry looks wrong or incomplete, use AskUserQuestion — do NOT silently fix it.
5. Use Edit tool with exact `old_string` matches — never use Write to overwrite CHANGELOG.md.

**If CHANGELOG was not modified in this branch:** skip this step.

**If CHANGELOG was modified in this branch**, review the entry for voice:

- **Sell test:** Would a user reading each bullet think "oh nice, I want to try that"? If not,
  rewrite the wording (not the content).
- Lead with what the user can now **do** — not implementation details.
- "You can now..." not "Refactored the..."
- Flag and rewrite any entry that reads like a commit message.
- Internal/contributor changes belong in a separate "### For contributors" subsection.
- Auto-fix minor voice adjustments. Use AskUserQuestion if a rewrite would alter meaning.
- If VERSION was bumped in Step 5, verify the CHANGELOG entry references the correct version.

---

## Step 7: Cross-Doc Consistency, Links & Discoverability Check

After auditing each file individually, do a cross-doc consistency pass:

1. Does the README's feature/capability list match what CLAUDE.md/AGENTS.md describes?
2. Does ARCHITECTURE's component list match CONTRIBUTING's project structure description?
3. Does CHANGELOG's latest version match the VERSION file?
4. **Discoverability:** Is every documentation file reachable from README.md or CLAUDE.md? If
   ARCHITECTURE.md exists but neither README nor CLAUDE.md links to it, flag it. Every doc
   should be discoverable from one of the two entry-point files.
5. Flag any contradictions between documents. Auto-fix clear factual inconsistencies (e.g., a
   version mismatch). Use AskUserQuestion for narrative contradictions.
6. **Internal link check:** Scan all documentation files for relative links — both file links
   like `[Architecture](./ARCHITECTURE.md)` and anchor links like `[see setup](#setup)`. For
   file links, verify the target file exists using Glob. For anchor links, verify the target
   heading exists in the linked file. This is especially important when the diff includes file
   renames, deletions, or heading changes. Auto-fix broken file links when the target was
   clearly renamed (use `git diff --diff-filter=R` to detect renames). Use AskUserQuestion for
   ambiguous cases where the intended target isn't clear.

---

## Step 8: TODOS.md Cleanup

If TODOS.md does not exist, skip this step.

1. **Completed items not yet marked:** Cross-reference the diff against open TODO items. If a
   TODO is clearly completed by the changes in this branch, move it to the Completed section
   with `**Completed:** vX.Y.Z (YYYY-MM-DD)`. Be conservative — only mark items with clear
   evidence in the diff.

2. **Items needing description updates:** If a TODO references files or components that were
   significantly changed, its description may be stale. Use AskUserQuestion to confirm whether
   the TODO should be updated, completed, or left as-is.

3. **New deferred work:** Check the diff for `TODO`, `FIXME`, `HACK`, and `XXX` comments. For
   each one that represents meaningful deferred work (not a trivial inline note), use
   AskUserQuestion to ask whether it should be captured in TODOS.md.

---

## Step 9: Commit & Output

**Empty check first:** Run `git status` (never use `-uall`). If no documentation files were
modified by any previous step, output "All documentation is up to date." and exit without
committing.

**Commit:**

1. Stage modified documentation files by name (never `git add -A` or `git add .`).
2. Build a descriptive commit message from the one-line summaries you produced in Steps 3–6.
   Combine them into a commit body so `git log` actually tells the story of what changed — not
   just "updated docs." For example:

```bash
git commit -m "$(cat <<'EOF'
docs: update documentation to match shipped changes

- README.md: added /new-skill to skills table, updated skill count from 9 to 10
- ARCHITECTURE.md: updated component diagram to reflect new service layer
- CHANGELOG.md: polished voice for v2.3.0 entry

EOF
)"
```

   Keep the subject line under 72 characters. List each modified file with its one-line summary
   as a bullet in the body. If only one file changed, the subject line alone is enough.

3. Push to the current branch:

```bash
git push
```

**PR body update (if PR exists):**

1. Read the existing PR body into a temp file (use `mktemp` to avoid collisions):
```bash
PR_BODY_TMP=$(mktemp /tmp/pr-body-XXXXXX.md)
gh pr view --json body -q .body > "$PR_BODY_TMP"
```

2. If the body already contains a `## Documentation` section, replace it. Otherwise append one.
   Include a **doc diff preview** — for each file modified, describe what specifically changed.

3. Write back and clean up:
```bash
gh pr edit --body-file "$PR_BODY_TMP"
rm -f "$PR_BODY_TMP"
```

4. If `gh pr view` fails (no PR exists): skip with "No PR found — skipping body update."

**Structured doc health summary (final output):**

```
Documentation health:
  README.md       [status] ([details])
  ARCHITECTURE.md [status] ([details])
  CONTRIBUTING.md [status] ([details])
  CHANGELOG.md    [status] ([details])
  TODOS.md        [status] ([details])
  VERSION         [status] ([details])
```

Where status is one of:
- Updated — with description of what changed
- Current — no changes needed
- Voice polished — wording adjusted
- Links fixed — broken links repaired
- Not bumped — user chose to skip
- Already bumped — version was set by /ship
- Skipped — file does not exist

If `gh` was unavailable (detected in Step 0), note "PR body update skipped (gh not authenticated)"
in the summary.

---

## Important Rules

- **Read before editing.** Always read the full content of a file before modifying it.
- **Never clobber CHANGELOG.** Polish wording only. Never delete, replace, or regenerate entries.
- **Never bump VERSION silently.** Always ask.
- **Be explicit about what changed.** Every edit gets a one-line summary.
- **Generic heuristics, not project-specific.** The audit checks work on any repo.
- **Discoverability matters.** Every doc file should be reachable from README or CLAUDE.md.
- **Voice: friendly, user-forward, not obscure.** Write like you're explaining to a smart person
  who hasn't seen the code.
