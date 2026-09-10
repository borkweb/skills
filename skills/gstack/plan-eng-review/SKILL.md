---
name: plan-eng-review
description: "Review an implementation plan for architecture, contracts, failure paths, concurrency and verification. Improve the plan when requested; do not implement it."

allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - AskUserQuestion
  - Bash
  - WebSearch
---

# Engineering Plan Review

Make the implementation plan coherent, testable and ready to execute. Preserve the complete requested scope; propose reductions with reasons rather than silently dropping requirements.

## Scope and pacing

Read the supplied plan and relevant existing implementation. For a plan-only request, do not require a branch. For a hybrid request, pin the requested diff as well. Preserve settled constraints, protected paths and prior decisions.

Use the user's requested interaction mode. Otherwise batch independent findings and ask only about genuine unresolved choices that affect scope or design. Apply obvious plan corrections when improvement is requested; report-only means no edits. Honor “skip questions” immediately, state assumptions and continue useful work. An assumption does not authorize a scope change. Do not re-ask a decision already made.

Review plans, not implementation: do not modify source, commit, push or create remote tasks. Stop after the relevant acceptance criteria are addressed or report the remaining blocker. Ratings are optional summaries, not targets that require repeated polishing to 10/10.

## Review

Identify the minimal working set and existing code that solves part of the problem. Verify important framework/API assumptions against installed code or authoritative documentation. File or class counts alone are not evidence of overengineering.

Read the relevant sections of [checks.md](checks.md): architecture/contracts, security, quality/tests, failure/concurrency, performance/operations and deployment/migration. Full mode covers every applicable section; quick mode prioritizes changed boundaries, failure paths and acceptance tests. State any omitted material coverage. Do not force all sections onto a small prose or configuration change.

For each real gap, identify the concrete trigger, file/plan reference, consequence and correction. For genuine choices, give viable options and a recommendation. A scope ruling remains settled throughout the review.

## Deliver

Return or update the plan with the chosen approach, reusable code, relevant failure/verification table, dependencies, acceptance criteria and unresolved decisions. Record deferred work only when actually considered; do not invent a backlog. Add TODOs only within the requested document scope or existing authorization.

Verdict: **READY** when the required decisions and execution criteria are settled; **NEEDS DECISIONS** for material open choices; **INCOMPLETE** for missing required evidence. Plan readiness is not proof that implementation or deployment has passed.
