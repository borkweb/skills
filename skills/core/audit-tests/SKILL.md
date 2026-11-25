---
name: audit-tests
description: "Audit a test suite, file, or the tests a branch or PR adds for quality: find tests to delete, rewrite, or add, and produce a structured report. Use for 'audit the tests', 'review the tests in this repo', 'are these tests testing anything useful', 'which tests should I delete' or 'audit the test suite for smells'. Does not blindly add tests. To write tests for a change, use writing-tests."
argument-hint: "[path, file, PR, branch, or --diff]"
allowed-tools:
  - Bash
  - Glob
  - Grep
  - Read
  - Edit
  - Write
  - Agent
---

# Audit tests

Run a test quality audit with the auditor in [references/auditor.md](references/auditor.md). It reviews existing tests and makes them better — not bigger.

**Target:** the path, file, PR, branch or `--diff` the user gave (defaults to the current directory if none)

## Workflow

### 1. Determine scope

- If a path argument is provided, audit that specific file or directory
- If the argument is a PR number or URL, a branch name, or `--diff`, run in **diff mode**. Audit only the tests added or changed against the default branch (`git diff <base>...HEAD`, or the PR's diff).
- If no argument, audit the current working directory
- Find all test files using standard patterns:
  - `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**` (JavaScript)
  - `**/tests/**/*Test.php`, `**/*Test.php` (PHP)

### 2. Launch audit

Run the audit in a fresh context so the report isn't anchored on this session. Where a subagent tool exists (Claude Code's Agent tool), launch a general-purpose subagent. Pass the absolute path of `references/auditor.md` and tell it to read that file first and follow it. Without a subagent tool (Codex), read `references/auditor.md` yourself and follow it inline.

Use a prompt like:

```
Read {absolute path to references/auditor.md} and follow it as your instructions.

Audit the test suite at {target path}. Follow your full workflow:
1. Discover all test files
2. Run the existing suite for a baseline
3. Audit each test file against the decision framework and smell catalog
4. Produce the structured audit report

Target: {path}
```

In diff mode, use this prompt instead:

```
Read {absolute path to references/auditor.md} and follow it as your instructions.

Review the tests added or changed in {PR, branch, or diff}. Follow "Repo-local test rules"
and "Reviewing new tests in a diff": load the repo's own test rules and checkers, search
the suite for existing coverage before accepting each new test, and leave pre-existing
tests alone. If the diff changes setup, teardown, fixtures, or reset helpers, also follow
"Reviewing fixture and isolation changes". Produce the structured audit report for the
new and changed tests only.

Target: {PR, branch, or diff}
```

If the user wants changes applied (not just a report), add:

```
After producing the audit report, apply the recommended changes:
- Delete tests that should be deleted (with explanations)
- Rewrite tests that have fixable smells
- Add tests only where genuine gaps exist
- Run the suite again to verify all changes pass
```

### 3. Present results

Show the structured audit report to the user. Keep the report's **Repo rules loaded**, **Ratio (diff mode)**, and applicable **Necessity evidence** lines as written; don't paraphrase or drop them. Don't present a change with unproven benefit as a fix. Highlight:
- **Critical findings** — tests that are actively hiding bugs (mock-testing-mocks, constructor drift, dodgers)
- **Quick wins** — tests to delete that add no value (framework testers, coverage chasers)
- **Gaps** — missing tests for high-risk code paths

### 4. Offer next steps

After the report, ask if the user wants to:
1. Apply recommended changes (delete/rewrite/add)
2. Focus on a specific file or smell type

## Usage examples

**Audit everything:**
```
/audit-tests
```

**Audit a specific directory:**
```
/audit-tests src/components/__tests__
```

**Audit a specific file:**
```
/audit-tests tests/unit/UserServiceTest.php
```

**Review only the tests a branch or PR adds:**
```
/audit-tests --diff
/audit-tests 1234
```

## What the audit does NOT do

- Blindly add tests to increase coverage numbers
- Test framework behavior (React rendering, WordPress hooks)
- Change expected values to make failing tests pass
- Add tests for trivial code (getters, setters, constructors)
- Recommend boundary or edge-case tests beyond the happy path and 1–3 high-impact flows
- Accept added setup or teardown just because the tests pass with it
