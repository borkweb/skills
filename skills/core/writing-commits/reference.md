# Commit Message Reference

## Conventional Commits Specification

- **Format**: `<type>(<scope>): <description>`
- **Spec version**: v1.0.0 (conventionalcommits.org)
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
- Optional body and footer separated by blank lines
- Breaking changes marked with `BREAKING CHANGE:` footer or `!` after type/scope

## Subject Line Rules

- **Length**: 50 characters ideal, 72 hard limit (applies to the subject line ONLY)
- **Mood**: Imperative ("Add feature" not "Added feature")
- **Formatting**: Capitalize first letter, no trailing period
- **Separation**: Blank line between subject and body
- **Focus**: State the outcome, theme, or reason; do not narrate how the code was edited (the diff shows that)
- **No AI attribution**: Never include Co-Authored-By or similar

## Body Rules

- **Do NOT hard wrap body lines.** Each paragraph is a single continuous line — no manual newlines mid-sentence or mid-paragraph to enforce a column width. The 50/72 rule above is for the subject only.
- Use blank lines to separate paragraphs, sections, and list items.
- Bullet/numbered list items are each a single unwrapped line.
- Prefer concrete, familiar words when they are as accurate as a technical term.
- Keep technical and domain terms when they identify the subject of the change, match the repository's normal language, or preserve needed precision.
- Group related edits under one theme. Do not list files, functions, or mechanical code actions unless one records a consequential decision that the diff cannot explain on its own.

## Scope Conventions

Scopes represent the area of the codebase affected:

**Good scopes**: `auth`, `database`, `api`, `ui`, `payments`, `notifications`, `search`, `core`

**Avoid**: `code`, `files`, `app` (too generic), `UserController.ts` (too specific), `bugfix`, `update` (those are types, not scopes)

## Footer Formats

```
Closes #123              # issue references
Fixes #456
Refs #100, #200

BREAKING CHANGE: Changed API response format.

Signed-off-by: Name <email@example.com>
```

## Semantic Versioning Connection

In automated release systems, commits drive version bumps:
- `fix` → patch (0.0.x)
- `feat` → minor (0.x.0)
- `BREAKING CHANGE` → major (x.0.0)

## Common Anti-Patterns

| Anti-pattern | Bad | Good |
|---|---|---|
| Vague messages | "Fix bug" | `fix(auth): Stop expired sessions from refreshing forever` |
| Multiple concerns | "Add feature X, fix bug Y, update docs" | Split into separate commits |
| Implementation inventory | "Extract PermissionGate and replace controller checks" | `refactor(auth): Keep permission checks consistent` |
| Unneeded jargon | "Improve p95 tail latency for product queries" | `perf(products): Speed up the slowest product requests` |
| Missing context | "Update config" | `build(web): Make production downloads smaller` |
| Personal notes | "Finally got this working!" | `fix(parser): Accept brackets inside brackets` |

## Emoji Commits (only if repo already uses them)

- ✨ New feature
- 🐛 Bug fix
- 📝 Documentation
- ♻️ Refactoring
- ⚡️ Performance
- ✅ Tests
- 🔧 Configuration

## Decision Tree

```
New feature for users?           → feat
Fixing a bug?                    → fix
Only documentation?              → docs
Restructuring, no behavior change? → refactor
Performance improvement?         → perf
Only test changes?               → test
Build system or tooling?         → build or ci
Dependency update / maintenance? → chore
Reverting a commit?              → revert
```
