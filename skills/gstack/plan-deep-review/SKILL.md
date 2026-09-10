---
name: plan-deep-review
description: "Review a plan’s strategy and execution risks in expansion, selective expansion, hold-scope or reduction mode. Preserve settled scope and load only relevant domain checks."

disable-model-invocation: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
  - WebSearch
---

# Deep Plan Review

Evaluate the plan's scope, strategic choices and execution risks. Resolve the mode before loading detailed review material.

## Scope and pacing

Read the supplied plan and relevant existing implementation. For a plan-only request, do not require a branch. For a hybrid request, pin the requested diff as well. Preserve settled constraints, protected paths and prior decisions.

Use the user's requested interaction mode. Otherwise batch independent findings and ask only about genuine unresolved choices that affect scope or design. Apply obvious plan corrections when improvement is requested; report-only means no edits. Honor “skip questions” immediately, state assumptions and continue useful work. An assumption does not authorize a scope change. Do not re-ask a decision already made.

Review plans, not implementation: do not modify source, commit, push or create remote tasks. Stop after the relevant acceptance criteria are addressed or report the remaining blocker. Ratings are optional summaries, not targets that require repeated polishing to 10/10.

## Mode

| Mode | Scope contract |
|---|---|
| SCOPE EXPANSION | Propose broader opportunities; additions require acceptance. |
| SELECTIVE EXPANSION | Preserve baseline and offer a few worthwhile additions. |
| HOLD SCOPE | Improve rigor without adding or dropping features. |
| SCOPE REDUCTION | Propose a smaller complete solution; preserve must-haves. |

Honor a supplied mode. Otherwise default to HOLD SCOPE; ask only if the request's intended scope cannot be inferred. Read only the relevant section of [strategy.md](strategy.md).

## Review routing

- Architecture, data, security, failures, tests, performance or deployment: relevant sections of [engineering checks](../plan-eng-review/checks.md).
- UI scope: relevant [design checks](../plan-design-review/checks.md), grounded in the existing product.
- Developer-facing contracts: relevant [DX checks](../plan-devex-review/checks.md).

Full mode reviews all applicable domains; quick/batched mode prioritizes the decisions and failure paths changed by the plan. Record material coverage limits. Inspect current code, plans and evidence before proposing replacements; no mandatory broad system audit or competitor search for a narrow change.

## Deliver

Capture the accepted scope, existing components to reuse, consequential alternatives, failure/verification requirements and open decisions. Use one failure table and diagrams only where they clarify nontrivial relationships. Expansion/reduction decisions must state accepted versus proposed work. Update the requested plan when authorized; backlog changes are separate unless included in scope.

Finish with **READY**, **NEEDS DECISIONS** or **INCOMPLETE**, and the concrete remaining requirement. Do not confuse plan readiness with implemented or tested behavior.
