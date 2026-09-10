---
name: design-review
description: "Inspect rendered UI for design, responsive and interaction defects against the product’s design system. Apply scoped fixes when requested; report evidence and untested coverage."

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
  - mcp__Claude_in_Chrome__computer
  - mcp__Claude_in_Chrome__read_page
  - mcp__Claude_in_Chrome__get_page_text
  - mcp__Claude_in_Chrome__navigate
  - mcp__Claude_in_Chrome__javascript_tool
  - mcp__Claude_in_Chrome__read_console_messages
  - mcp__Claude_in_Chrome__find
  - mcp__Claude_in_Chrome__upload_image
  - mcp__Claude_in_Chrome__resize_window
  - mcp__Claude_in_Chrome__gif_creator
  - mcp__Claude_in_Chrome__shortcuts_execute
  - mcp__Claude_in_Chrome__tabs_context_mcp
---

# Design Review

Review the rendered interface for visual and interaction defects, then fix confirmed issues when requested or already authorized. A review-only request produces findings and evidence without source edits.

## Scope

Identify the target URL and changed routes, using the actual base/merge-base for a diff-aware review. Follow the shared [QA exploration](../qa/exploration.md) for browser access, snapshots, role/viewport coverage and safe interactions. Preserve unrelated dirt; use a separate checkout when needed rather than stashing or committing everything.

Use Full mode for the requested product surfaces, Quick for critical screens/states and Deep for an explicitly broader interaction/accessibility audit. Record what was inspected. Resolve genuine scope ambiguity once; reuse the user's answers and authorization.

## Inspect

Calibrate to DESIGN.md, tokens, components, brand assets and rendered pages. Use relevant [design checks](../plan-design-review/checks.md): hierarchy, typography, spacing/alignment, copy, states, responsive reflow, keyboard/focus, contrast, motion and supported themes.

Separate visible/computed defects from aesthetic suggestions. A font, grid, color or border radius is not evidence of a defect by itself. Preserve intentional brand choices. Inspect actual text/background colors and font size/weight: 18px regular text is normal text and needs 4.5:1 at WCAG AA. The large-text threshold is 24px regular or about 18.67px bold.

Trace critical interactions across pages. Confirm focus order, error/recovery states and continuity, not just static screenshots. Consolidate repeated symptoms into a systemic finding when the evidence supports a shared cause. Record severity from user impact, a screenshot or computed evidence, reproduction and the proposed correction.

## Correct and verify

In fix mode, change the smallest owned scope, verify the affected route and neighboring states, and capture before/after evidence. Run relevant configured checks on final files once. Commit only verified owned changes when explicitly authorized; honor no-commit mode. Fix regressions or reverse only your own edit. Do not auto-revert HEAD or use an invented probability formula to decide whether to continue.

Reassess on regressions, repeated failed corrections, unclear causes or scope changes. Stop at the requested acceptance criteria or agreed budget and report anything unresolved. Do not chase a 10/10 score through unrelated polish.

## Deliver

Report tested routes/viewports/states, findings, verified changes, remaining blockers and evidence links. Distinguish incomplete verification from a defect. A clean verdict requires the relevant checks to have run. Scores, if requested, are labeled qualitative assessments and cannot override blockers. Keep source fixes, commit state and optional backlog suggestions distinct.
