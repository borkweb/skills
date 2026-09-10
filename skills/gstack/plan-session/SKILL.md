---
name: plan-session
description: "Run a product or builder design session, resolve consequential unknowns and produce a concrete plan. Reuse supplied context and honor requests to skip questions."

disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - AskUserQuestion
  - WebSearch
---

# Design Session

Understand the problem and produce a concrete design or plan. Use Product mode for demand and user outcomes, Builder mode for exploratory tools and ideas. Infer the mode from the request or ask if the distinction materially changes the work; load only that section of [discovery.md](discovery.md).

## Conversation

Read existing briefs and constraints first. Ask a focused question only for consequential missing information; batch independent questions when useful. Preserve the user's answers, scope rulings and preferred pace. Honor “skip questions” on the first request, state any assumptions and proceed. Do not require a final forcing question or another confirmation of settled context.

Challenge a premise with evidence when it matters. No fabricated disagreement, adversarial performance or diagnostic labels. If the user wants a creative experiment, do not force a commercial demand test. If the problem is already defined, move directly to alternatives or the design.

## Design

Synthesize the actual problem, intended users, constraints and evidence. Compare distinct approaches when there is a meaningful choice, including reuse of existing work. State a recommendation and its tradeoffs; preserve accepted direction.

Write the requested design document with the sections that help execution: goal, chosen approach, scope, relevant alternatives, data/interaction contracts, dependencies, risks, acceptance criteria and next action. Use realistic content and the existing product conventions. Link evidence instead of copying the entire conversation.

## Finish

For a session asking for approval of a design, present one concrete reviewable document and the remaining decisions. Do not repeatedly approve each section. If the user already authorized continuing and the design is settled, complete the requested next step; the skill itself does not authorize implementation, remote publication or changes outside scope.
