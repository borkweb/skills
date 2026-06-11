---
name: writing-commits
description: "Use this skill to create git commits and write commit messages. Invoke it for ANY of these user goals: committing code changes, crafting or suggesting commit messages, describing diffs for commit purposes, or formatting commits in conventional/angular style. Common triggers: 'commit this', 'commit them', 'write a commit message', 'what should the commit message be', 'help me with the commit', or any variant where the user has finished coding and wants to record their changes in git. Also invoke when users mention pushing code and need the commit authored first, when they ask to split changes into separate commits, or when they ask to summarize what changed for a commit. Exclude: pull requests, code review, changelogs, reverting commits, git log analysis, writing docs about commit conventions."
disable-model-invocation: true
model: sonnet
effort: low
allowed-tools: [Bash, Read, Grep, Glob]
---

# Commit Message Writer

You write clear, accurate git commit messages that help future developers understand what changed and why.

## How to analyze changes

Run these commands to understand what you're working with:

```bash
git diff --staged          # what's actually being committed
git diff                   # unstaged changes (might need staging)
git status                 # overall picture
git log --oneline -10      # recent commit style in this repo
```

Read the diff carefully. Understand the *intent* behind the changes — not just which lines moved, but what problem they solve or what capability they add. If the diff is large or touches unfamiliar code, use `Read` or `Grep` to look at surrounding context.

Check `git log` output closely. If the repo uses a specific convention (emoji prefixes, Jira ticket format, lowercase subjects, Angular-style), match it. Repository convention always wins over the defaults below.

## Choosing the commit type

Use Conventional Commits types by default:

| Type | When to use |
|------|------------|
| `feat` | New user-facing functionality |
| `fix` | Bug fix |
| `refactor` | Restructuring without behavior change |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `build` | Build system or dependency changes |
| `ci` | CI/CD pipeline changes |
| `style` | Formatting, whitespace (no logic change) |
| `chore` | Maintenance that doesn't fit above |

Pick the type that best describes the *primary* intent. If changes genuinely span multiple types, suggest splitting into separate commits.

## Structuring the message

Scale the message to the change. Not every commit needs a five-section essay.

### Small changes (single-concern, obvious intent)

A subject line is often enough:

```
fix(auth): prevent token refresh loop on expired sessions
```

Or subject + a brief body if the "why" isn't obvious from context:

```
refactor(database): extract query builder to separate module

Improves maintainability by separating query building logic from repository classes. No functional changes.
```

### Larger changes (multi-file, non-obvious motivation)

Use the full structure. The goal of each section is to answer a distinct question a reviewer or future developer would have:

```
<type>(<scope>): <subject>

## Summary
What changed, at a high level. 1-3 sentences.

Fixes #123 (if applicable)

## Why
What motivated this change? What was broken, missing, or insufficient?

## How
The approach taken — key implementation decisions, trade-offs made.

## Testing (only when there are meaningful verification steps)
- [ ] Concrete steps a reviewer can take to verify
```

**Subject line rules:**
- 50-72 characters, imperative mood ("add" not "added")
- Capitalize first letter, no trailing period
- No AI attribution — never include "Co-Authored-By" or similar

**Body line wrapping rules:**
- **Do NOT hard wrap body lines.** Write each paragraph as a single continuous line. Do not insert manual newlines mid-sentence or mid-paragraph to enforce a column width (no 72-column wrap, no 80-column wrap, no wrap at all). Let the git viewer, terminal, or editor soft-wrap as needed.
- Use blank lines only to separate distinct paragraphs, sections, or list items — never to wrap a single thought across multiple lines.
- Bullet and numbered list items are each a single unwrapped line.
- This applies to every part of the body: summary paragraphs, "Why"/"How" sections, footers, and breaking-change descriptions.

**When to include Testing:** Include it when there are specific, non-obvious steps a reviewer should take — running a test suite, hitting an endpoint, testing a UI flow. Skip it for docs, config changes, refactors with no behavior change, or anything where the verification is self-evident.

## Scope guidelines

Scopes describe the area of the codebase affected. Good scopes are specific but not too granular:

- `auth`, `api`, `database`, `ui/dashboard`, `payments` — these are informative
- `code`, `files`, `bugfix` — these add nothing, skip the scope instead

When changes touch multiple areas, use comma-separated scopes like `(api,cli)` or pick the primary area.

## Handling multi-concern changes

If the staged changes address multiple unrelated concerns (e.g., a feature + an unrelated formatting fix), suggest splitting them:

> "These changes include both the new caching layer and an unrelated linting fix. Want me to help split these into separate commits?"

Only suggest this when the concerns are genuinely separate. Related changes (a feature + its tests, a fix + the migration it needs) belong together.

## Output

### Single commit

Present the commit message in a code block. Then offer to either create the commit directly or adjust the message first.

### Multiple commits (after suggesting a split)

When you've recommended splitting into separate commits, present each commit message in its own code block with a brief label. Then offer to walk the user through staging and committing each one in sequence. For example:

**Commit 1 — docs fix:**
```
docs(readme): fix typo in application description
```

**Commit 2 — database refactor:**
```
refactor(database): enhance connection pool configuration
...
```

Each code block should contain *only* the commit message text — no wrapper headings, no analysis preamble. The surrounding conversation provides the context; the code blocks are what would actually go into `git commit -m`.

For more examples of well-structured commit messages across different types (features, fixes, refactors, performance, breaking changes, etc.), see `examples.md` in this skill's directory.

For reference material on Conventional Commits spec details, scope conventions, footer formats, and anti-patterns, see `reference.md`.
