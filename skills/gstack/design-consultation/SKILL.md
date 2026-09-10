---
name: design-consultation
description: "Propose a product-specific design system and verified preview, grounded in existing brand assets and user constraints. Covers typography, color, layout, components and accessibility."

allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - WebSearch
  - WebFetch
---

# Design Consultation

Propose a coherent design system for the user's product and show it in a realistic preview. Begin with existing DESIGN.md, theme/tokens, components, brand assets and rendered pages. Match that foundation unless the user requests a new direction.

## Direction

Resolve consequential unknowns about audience, task, constraints and desired character. Reuse supplied answers; do not require a questionnaire for a clear brief. Offer an opinionated direction with reasons and let the user adjust it.

Research current alternatives when requested or needed to support a recommendation. Use actual rendered pages for claims about competitors' visuals. Label interpretations and avoid treating brand reputation as observed evidence.

Choose typography, color, layout/density, spacing, borders, imagery/icons and motion that reinforce the product. Avoid defaulting every project to brutalism or generic feature cards; intentional grids, familiar fonts and unusual combinations may fit the brief. Treat aesthetic preferences as preferences, not universal defects or proof of AI authorship.

Specify font roles/weights/fallbacks, actual supported loading sources, semantic color pairs, relevant component tokens and responsive states. Preserve supported themes; propose additions separately. Explain coherence tradeoffs without reopening settled choices.

## Accessibility and verification

Normal text needs 4.5:1 contrast at WCAG AA. Large text is at least 18pt (24px) regular or 14pt (about 18.67px) bold and needs 3:1. Label any stricter house targets separately from the standard. Verify relevant exceptions and non-text requirements against W3C when necessary.

Include keyboard/focus behavior, non-color cues and reduced motion where applicable. Do not equate a recommended 44px touch target with every WCAG AA requirement; check the applicable criterion and spacing exceptions.

Build and inspect a preview using [preview.md](preview.md), unless the user asks to skip it. Confirm actual font loading and computed/rendered appearance, not just declarations.

## Deliver

Write or update the requested DESIGN.md with the chosen direction, tokens, relevant component states, accessibility targets and decision rationale. Present the concrete proposal for review when a decision is pending; do not ask again about choices already authorized. Do not append new global approval rules to AGENTS.md or CLAUDE.md as an incidental side effect. Changing application code or publishing the design requires task authorization.
