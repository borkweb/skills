---
name: plan-design-review
description: "Review a UI plan for interaction states, design-system fit, accessibility and visual acceptance. Improve the plan when requested; preserve existing brand choices."

allowed-tools:
  - Read
  - Edit
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
---

# Design Plan Review

Resolve the design decisions needed to build the requested interface, with an executable plan and clear visual acceptance criteria.

## Scope and pacing

Read the supplied plan and relevant existing implementation. For a plan-only request, do not require a branch. For a hybrid request, pin the requested diff as well. Preserve settled constraints, protected paths and prior decisions.

Use the user's requested interaction mode. Otherwise batch independent findings and ask only about genuine unresolved choices that affect scope or design. Apply obvious plan corrections when improvement is requested; report-only means no edits. Honor “skip questions” immediately, state assumptions and continue useful work. An assumption does not authorize a scope change. Do not re-ask a decision already made.

Review plans, not implementation: do not modify source, commit, push or create remote tasks. Stop after the relevant acceptance criteria are addressed or report the remaining blocker. Ratings are optional summaries, not targets that require repeated polishing to 10/10.

## Review

Calibrate to DESIGN.md, existing tokens, components, brand assets and rendered screens. Absence of DESIGN.md is not absence of a design system. Preserve intentional style choices.

Use [checks.md](checks.md) for the affected interaction and visual surfaces. Full mode evaluates all applicable checks; quick mode focuses on the changed component, its states, responsiveness and accessibility. Report unavailable evidence rather than assigning an invented score.

For each issue, state the observable consequence, plan reference and concrete revision. Separate accessibility/functional failures from taste suggestions. Do not invent a user journey, theme or animation solely to fill a rubric.

## Deliver

Update the requested plan or return findings in report-only mode. Include unresolved decisions, chosen states and behavior, relevant reuse, acceptance screenshots/interactions and remaining evidence needs. Stop at **READY**, **NEEDS DECISIONS** or **INCOMPLETE**; do not repeatedly rewrite to reach a numeric rating.
