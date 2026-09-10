---
name: qa
description: "Test a web application and fix reproducible bugs within the requested scope, with browser evidence and appropriate regression checks. Honors report-only and no-commit requests."

disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - WebSearch
---

# QA: Test, Fix, Verify

Test the requested web application and correct reproducible bugs within scope. Use [exploration.md](exploration.md) for shared browser testing and reporting. A requested report-only run follows qa-only's no-source-edit boundary.

## Fix loop

Record the starting checkout and preserve unrelated dirt. Use an isolated checkout when required; do not stash or commit the user's entire tree to begin QA. Honor no-commit instructions. A QA invocation does not itself authorize commit, push, merge or publication.

For each confirmed issue, trace the cause and make a scoped correction. Reproduce the original scenario against the fix, collect appropriate before/after evidence and check adjacent behavior. Write a meaningful regression test for logic or contract bugs where the project supports it: demonstrate failure without the fix and success with it. Do not delete a failing test to finish; fix the bug or report the unresolved failure.

Run appropriate checks once against the final changed files. Commit only verified, owned changes when authorized, following the repository's commit conventions. An unverified fix stays explicitly unverified; a regression requires correction or reversal of only your own edit, not an indiscriminate `git revert HEAD`.

Reassess after a regression, repeated failed correction, an unclear cause or a scope breach. Continue useful in-scope investigation; ask only when missing information or a real decision blocks it. Respect the agreed time/iteration budget. Do not calculate a synthetic risk percentage or repeatedly polish low-priority issues after the requested acceptance criteria are met.

## Finish

Report confirmed issues, verified corrections, unresolved blockers, coverage and remaining checks, plus exact commit/no-commit state. Distinguish fixed, unverified and deferred. Numeric scores never override a blocker or missing required evidence. Add backlog items only within existing authorization and never use a TODO as a substitute for a requested fix.
