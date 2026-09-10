---
name: plan-devex-review
description: "Review developer-facing plans for setup, API/CLI ergonomics, errors and compatibility. Triage covers install and first-run errors; polish and expansion cover broader journeys."

allowed-tools:
  - Read
  - Edit
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
  - WebSearch
---

# Developer Experience Plan Review

Improve a plan for an API, CLI, SDK, library, developer platform or its documentation. A strategy document without a developer-facing interface does not require an eight-pass DX review.

## Scope and pacing

Read the supplied plan and relevant existing implementation. For a plan-only request, do not require a branch. For a hybrid request, pin the requested diff as well. Preserve settled constraints, protected paths and prior decisions.

Use the user's requested interaction mode. Otherwise batch independent findings and ask only about genuine unresolved choices that affect scope or design. Apply obvious plan corrections when improvement is requested; report-only means no edits. Honor “skip questions” immediately, state assumptions and continue useful work. An assumption does not authorize a scope change. Do not re-ask a decision already made.

Review plans, not implementation: do not modify source, commit, push or create remote tasks. Stop after the relevant acceptance criteria are addressed or report the remaining blocker. Ratings are optional summaries, not targets that require repeated polishing to 10/10.

## Mode and preparation

| Mode | Required review scope | Optional discovery |
|---|---|---|
| DX TRIAGE | Pass 1 and Pass 3; install and first successful result only | No competitor survey or broad persona exercise |
| DX POLISH | All applicable passes, within the existing interface scope | Investigate only missing context that affects a decision |
| DX EXPANSION | All applicable passes plus proposed opportunities | Targeted competitor research and broader journey exploration |

This table is authoritative. Triage reduces work, not just which findings are displayed. Use the user's mode; otherwise choose TRIAGE for a narrow change and POLISH for a whole interface. State the choice briefly without requiring a confirmation when scope is clear.

Identify the actual consumer, task, supported environment and first useful result from existing evidence. Reuse supplied answers. For incremental work, start with the interface and failure paths. A narrative persona, magical moment or competitive benchmark is not a prerequisite.

## Review

Read only the selected passes in [checks.md](checks.md). Record commands, outputs and observed friction where runnable. Never claim personal onboarding experience, user abandonment, benchmark timing or adoption statistics without evidence. Label simulated journeys as hypotheses; unavailable runtime checks remain unverified.

For each real gap, give the evidence, consequence, suggested correction and verification. Ratings may communicate an assessment but do not gate completion or require polishing to 10. Expansion proposals remain optional until accepted. Use one correction pass and verify it; continue only for remaining acceptance failures or new user direction.

## Deliver

Update the requested plan or return a report. Include reviewed passes and omissions, actual consumer/task, material findings, accepted changes, unresolved decisions and concrete acceptance checks. Give **READY**, **NEEDS DECISIONS** or **INCOMPLETE** based on that scope. Do not create unrelated SDKs, community programs, themes or hosted playgrounds to improve a score.
