---
name: writing-plan-documents
description: Use when writing any plan document — project plans, PRDs, proposals, implementation plans, or design docs. Applies as a writing style layer alongside other planning skills like superpowers:writing-plans.
user-invocable: false
model: sonnet
effort: low
---

# Writing Plan Documents

## Overview

Writing style rules for plan documents. Apply these rules to all plans — project plans, PRDs, proposals, implementation plans, design docs. Use alongside other planning skills (e.g. superpowers:writing-plans handles structure and process; this skill handles prose quality).

## Rules

### Stand-alone document

The plan must make sense without the prompt that triggered it. Do not echo, react to, or frame around the request. Open with what the plan is, not why it was requested.

### No filler adjectives

Cut every adjective that doesn't add information. These words are banned:

robust, elegant, comprehensive, seamless, cutting-edge, scalable (unless discussing specific scaling requirements), innovative, streamlined, holistic, state-of-the-art, world-class, best-in-class, leveraging, synergy, paradigm

If removing an adjective doesn't change the meaning, remove it.

### No AI flavor text

Do not include:

- Preamble ("Great question! Let me outline...")
- Hedging ("It might be worth considering...")
- Enthusiasm ("This is an exciting opportunity to...")
- Meta-commentary ("This plan covers the following areas...")
- Summaries that repeat what was just said

### Concise by default

- Lead with decisions, not reasoning. Put rationale after if needed.
- One sentence where one sentence works. Don't pad sections.
- Use lists and tables for structured information. Use prose only when relationships between ideas matter.
- Cut any section that doesn't help someone act on the plan.

### Structure

When no other skill dictates structure, use whatever sections fit. Common ones:

- **Goal** — What this achieves, in one or two sentences.
- **Background** — Only if readers need context they won't already have.
- **Approach** — What will be done and how. Be specific.
- **Scope** — What's in and what's out.
- **Risks** — Known risks and how they'll be handled.
- **Milestones** — Deliverables and sequence. Use phase numbers or dependency order, not calendar time (no "Week 1", "Week 2", "Days 3-5"). Plans executed with AI assistance collapse timelines unpredictably, so time estimates mislead. Instead, describe what must happen before each phase can start and what it produces.
- **Decisions** — Where the plan requires a choice that hasn't been made, don't leave it as a bare question. Give each decision a descriptive heading that summarizes what's being decided (e.g., "### Cache invalidation strategy" or "### Email delivery provider"), then propose 2-3 concrete options with tradeoffs underneath. Frame as "Option A: ... Option B: ..." with a brief recommendation if you have one. The heading lets readers scan for decisions relevant to them without reading every option. Unanswered questions stall plans; proposed options keep them moving.

Skip sections that don't apply. Don't include empty or trivial sections.

When another skill provides structure (e.g. superpowers:writing-plans), follow that structure and apply these writing rules to the content within it.

## Quick Reference

| Do | Don't |
|---|---|
| Start with the goal | Start with "Based on your request..." |
| State facts and decisions | Qualify everything with "potentially" |
| Use plain adjectives (fast, small, simple) | Use inflated adjectives (robust, elegant, seamless) |
| Cut sections that add nothing | Include every possible heading for completeness |
| Write for someone who hasn't seen the prompt | Echo or summarize the prompt |
| Propose options with tradeoffs for undecided points | Leave open questions dangling without recommendations |
| Sequence milestones by dependency ("after X, do Y") | Assign calendar time ("Week 1", "Days 3-5") |

## Anti-patterns (NEVER DO THESE)

### Setup-then-reveal juxtaposition

The most common AI writing tell. Any sentence that exists to manufacture a reaction — creating influence or false excitement — rather than conveying information. The fix is always the same: delete the setup sentence and lead with the fact. If the fact is significant, it'll land on its own.

- **Contrastive reframes**: "This isn't about technology. It's about people." "These weren't demos. Several are now running in production." — just state the actual point.
- **Declarative setups**: "This didn't happen by accident." "This is the biggest development in X." — declares significance instead of letting the content show it.
- **Theatrical reveals**: "But here's the catch —" "And here's the structural insight that matters:" — stage directions before the point. Just say the point.
- **Anticipation builders**: "The most subversive moment came when..." — builds suspense where none is needed.

### "This isn't X. It's Y."

Sentences where an idea is raised and then immediately contradicted and replaced with a different idea. This tries to create drama or influence but ends up confusing and wordy. Just say the actual point without the setup.

- "This isn't a checkout problem. It's a content problem." → "The content is the problem."
- "This isn't about technology. It's about people." → "This affects people more than systems."

## Common Mistakes

- **Reacting to the prompt.** "You asked for X, so here's X" — readers don't have the prompt. Just write X.
- **Padding thin sections.** If scope is obvious, skip the scope section. Don't write "Scope: Everything described above."
- **Burying the point.** The first sentence of each section should carry the key information.
- **Using ten words where five work.** "In order to facilitate the process of" → "To".
- **Calendar-based milestones.** "Week 1: Setup, Week 2: Implementation" — these are fiction. Use sequenced phases tied to what each step produces and what it depends on.
- **Dangling open questions.** "Should we use X or Y?" without a recommendation wastes the reader's time. Give each decision a heading summarizing the choice, then propose options with tradeoffs: "### Storage backend — Option A: X (faster, less flexible). Option B: Y (slower, handles edge cases). Recommend A unless edge cases are common."
