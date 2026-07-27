---
name: autoplan
description: >
  Auto-review pipeline. Chains the four plan-* reviews (plan-deep-review,
  plan-design-review, plan-eng-review, plan-devex-review) at full depth with
  intermediate AskUserQuestion calls auto-decided by 6 principles. Surfaces
  taste decisions and user challenges at a single Final Approval Gate.
  Sequential Deep → Design → Eng → DX. Each phase optionally gets an
  independent Claude subagent voice for cross-model consensus. Use when
  asked to "autoplan", "run all the plan reviews", "auto-review this plan",
  or when the user wants comprehensive plan vetting without sitting through
  every intermediate question.
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - Agent
  - AskUserQuestion
  - WebSearch
---

# /autoplan — Auto-Review Pipeline

One command. Rough plan in, fully reviewed plan out.

/autoplan follows the deep (plan-deep-review), design, eng, and DX review skill methodologies at full depth — same rigor, same sections, same outputs as running each skill manually. The only difference: intermediate AskUserQuestion calls are auto-decided using the 6 principles below. Taste decisions (where reasonable people could disagree) and user challenges (where both reviewers think the user's stated direction should change) are surfaced at a single final approval gate.

This is a **non-interactive, fully automated** workflow with exactly two human-decision gates: premise confirmation in Phase 1, and the Final Approval Gate at the end.

---

## The 6 Decision Principles

These rules auto-answer every intermediate question:

1. **Choose completeness** — Ship the whole thing. Pick the approach that covers more edge cases.
2. **Boil lakes** — Fix everything in the blast radius (files modified by this plan + direct importers). Auto-approve expansions that are in blast radius AND < 1 day of CC effort (< 5 files, no new infra).
3. **Pragmatic** — If two options fix the same thing, pick the cleaner one. 5 seconds choosing, not 5 minutes.
4. **DRY** — Duplicates existing functionality? Reject. Reuse what exists.
5. **Explicit over clever** — 10-line obvious fix > 200-line abstraction. Pick what a new contributor reads in 30 seconds.
6. **Bias toward action** — Merge > review cycles > stale deliberation. Flag concerns but don't block.

**Conflict resolution (context-dependent tiebreakers):**
- **Deep phase:** P1 (completeness) + P2 (boil lakes) dominate.
- **Eng phase:** P5 (explicit) + P3 (pragmatic) dominate.
- **Design phase:** P5 (explicit) + P1 (completeness) dominate.
- **DX phase:** P5 (explicit) + P1 (completeness) dominate.

---

## Decision Classification

Every auto-decision is classified:

**Mechanical** — one clearly right answer. Auto-decide silently. Example: reduce scope on a complete plan (always no). Running a subagent is never automatic.

**Taste** — reasonable people could disagree. Auto-decide with recommendation, but surface at the final gate. Three natural sources:
1. **Close approaches** — top two are both viable with different tradeoffs.
2. **Borderline scope** — in blast radius but 3-5 files, or ambiguous radius.
3. **Subagent disagreements** — independent subagent voice recommends differently and has a valid point.

**User Challenge** — both Claude and the independent subagent agree the user's stated direction should change. This is qualitatively different from taste decisions. When both voices recommend merging, splitting, adding, or removing features that the user specified, this is a User Challenge. It is NEVER auto-decided.

User Challenges go to the final approval gate with richer context than taste decisions:
- **What the user said:** (their original direction)
- **What both voices recommend:** (the change)
- **Why:** (the voices' reasoning)
- **What context we might be missing:** (explicit acknowledgment of blind spots)
- **If we're wrong, the cost is:** (what happens if the user's original direction was right)

The user's original direction is the default. The voices must make the case for change, not the other way around.

**Exception:** If both voices flag the change as a security vulnerability or feasibility blocker (not a preference), the AskUserQuestion framing explicitly warns: "Both voices believe this is a security/feasibility risk, not just a preference." The user still decides, but the framing is appropriately urgent.

---

## Sequential Execution — MANDATORY

Phases MUST execute in strict order: Deep → Design → Eng → DX. Each phase MUST complete fully before the next begins. NEVER run phases in parallel — each builds on the previous.

Between each phase, emit a phase-transition summary and verify that all required outputs from the prior phase are written before starting the next.

---

## What "Auto-Decide" Means

Auto-decide replaces the USER'S judgment with the 6 principles. It does NOT replace the ANALYSIS. Every section in the loaded skill files must still be executed at the same depth as the interactive version. The only thing that changes is who answers the AskUserQuestion: you do, using the 6 principles, instead of the user.

**Two exceptions — never auto-decided:**
1. Premises (Phase 1) — require human judgment about what problem to solve.
2. User Challenges — when both voices agree the user's stated direction should change (merge, split, add, remove features/workflows). The user always has context the voices lack.

**You MUST still:**
- READ the actual code, diffs, and files each section references
- PRODUCE every output the section requires (diagrams, tables, registries, scorecards)
- IDENTIFY every issue the section is designed to catch
- DECIDE each issue using the 6 principles (instead of asking the user)
- LOG each decision in the audit trail
- WRITE all required artifacts (in the plan file or conversation, per skill's spec)

**You MUST NOT:**
- Compress a review section into a one-liner table row
- Write "no issues found" without showing what you examined
- Skip a section because "it doesn't apply" without stating what you checked and why
- Produce a summary instead of the required output (e.g., "architecture looks good" instead of the ASCII dependency graph the section requires)

"No issues found" is valid only after doing the analysis. State what you examined and why nothing was flagged, using no more words than the evidence needs. "Skipped" is never valid for a non-skip-listed section.

---

## Phase 0: Intake + Restore Point

### Step 1: Capture restore point

Before doing anything, save the plan file's current state. If a plan file path is in conversation context, copy it to a sibling restore file:

```bash
PLAN_FILE="<path provided by user or detected>"
[ -f "$PLAN_FILE" ] || { echo "No plan file — skipping restore point."; }
if [ -f "$PLAN_FILE" ]; then
  RESTORE_PATH="${PLAN_FILE%.md}-autoplan-restore-$(date +%Y%m%d-%H%M%S).md"
  cp "$PLAN_FILE" "$RESTORE_PATH"
  echo "Restore point: $RESTORE_PATH"
fi
```

If a plan file exists, prepend a one-line HTML comment so the user can see and re-run:
`<!-- /autoplan restore point: [RESTORE_PATH] -->`

If no plan file exists, log: "Running /autoplan against branch diff (no plan file)."

### Step 2: Detect platform and base branch

Determine which branch this PR targets. Use the result as "the base branch" in every subsequent `git diff`, `git log`, and `git fetch` command.

1. `gh pr view --json baseRefName -q .baseRefName` — if succeeds, use it
2. `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` — if succeeds, use it
3. Fall back to `main`.

Print the detected base branch name.

### Step 3: Read context

- Read CLAUDE.md / AGENTS.md if present, TODOS.md if present
- `git log --oneline -30`, `git diff <base> --stat`
- The plan file (if discovered above), or use the branch diff as the plan-equivalent
- **Detect UI scope:** grep the plan/diff for view/rendering terms (component, screen, form, button, modal, layout, dashboard, sidebar, nav, dialog). Require 2+ matches. Exclude false positives ("page" alone, "UI" in acronyms).
- **Detect DX scope:** grep the plan/diff for developer-facing terms (API, endpoint, REST, GraphQL, gRPC, webhook, CLI, command, flag, argument, terminal, shell, SDK, library, package, npm, pip, import, require, SKILL.md, MCP, agent, developer docs, getting started, onboarding, integration, error message). Require 2+ matches. Also trigger DX scope if the product IS a developer tool (something developers install, integrate, or build on top of).

Output: "Here's what I'm working with: [plan summary]. UI scope: [yes/no]. DX scope: [yes/no]. Starting full review pipeline with auto-decisions."

### Step 4: Locate the bork plan-* skill files

Each phase below follows a plan-* skill at full depth. Find the bork plugin's gstack skill files so you can read the methodology if needed. Common locations:
- `~/.claude/plugins/bork/skills/gstack/<skill-name>/SKILL.md`
- Detect via: `find ~/.claude -type f -path '*bork/skills/gstack/plan-eng-review/SKILL.md' 2>/dev/null | head -1`

For each phase that runs, read the corresponding SKILL.md if you can locate it; otherwise, follow the methodology you already know from the skill description and the phase override rules below.

**Section skip list — when following a loaded plan-* skill, SKIP these (already handled here):**
- Review Context Detection (already done in Step 3)
- Review Pacing (autoplan forces a faster pace — auto-decided, not user-paced)
- PRE-REVIEW SYSTEM AUDIT (already done in Step 3)
- Prerequisite Skill Offer

Follow ONLY the review-specific methodology, sections, and required outputs.

### Step 5: Premise gate — prerequisite skill offer

If no plan file was discovered AND the change appears greenfield or substantial:

> "No plan file found for this branch. `/plan-session` produces a structured problem statement, premise challenge, and explored alternatives — it gives autoplan much sharper input to work with. Takes about 10 minutes."

Options: **A)** Run /plan-session first (we'll pick up autoplan right after). **B)** Skip — autoplan will work against the branch diff.

If A: run /plan-session, then return here with the design doc as the plan file. If B: continue.

---

## Phase 1: Deep Review (Strategy & Scope)

Follow plan-deep-review's methodology at full depth. Override: every AskUserQuestion → auto-decide using the 6 principles.

### Override rules

- **Mode selection:** SELECTIVE EXPANSION
- **Premises:** accept reasonable ones (P6), challenge only clearly wrong ones
- **GATE: Present premises to user for confirmation** — this is the ONE AskUserQuestion in this phase that is NOT auto-decided. Premises require human judgment.
- **Alternatives:** pick highest completeness (P1). If tied, pick simplest (P5). If top 2 are close → mark TASTE DECISION.
- **Scope expansion:** in blast radius + < 1d CC → approve (P2). Outside → defer to TODOS.md (P3). Duplicates → reject (P4). Borderline (3-5 files) → mark TASTE DECISION.
- **All 12 review sections (from plan-deep-review):** run fully, auto-decide each issue, log every decision.
- **Outside voice:** Dispatch only if this phase has the workflow's highest-impact unresolved judgment and no outside-voice subagent has run; otherwise skip.

### Outside Voice — Claude Subagent

Only in the selected outside-voice phase, run the following independent reviewer; otherwise skip this section and its consensus table.

Run an independent reviewer via the Agent tool. Subagent prompt:

> "Read the plan file at <plan_path> (or branch diff <base>...HEAD if no plan file). You are an independent strategist reviewing this plan. You have NOT seen any prior review. Evaluate:
> 1. Is this the right problem to solve? Could a reframing yield 10x impact?
> 2. Are the premises stated or just assumed? Which ones could be wrong?
> 3. What's the 6-month regret scenario — what will look foolish?
> 4. What alternatives were dismissed without sufficient analysis?
> 5. What's the competitive risk — could someone else solve this first/better?
>
> For each finding: what's wrong, severity (critical/high/medium), and the fix. Be adversarial. No compliments."

**Subagent failure handling:** If the subagent fails or times out, log "Outside voice unavailable — proceeding with primary review only" and tag this phase `[single-voice]`. Do not retry.

### Consensus table

After the subagent returns, present its output under `OUTSIDE VOICE (deep — strategic independence):` and produce a consensus table:

```
DEEP REVIEW CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                            Primary  Subagent  Consensus
  ──────────────────────────────────── ─────── ──────── ─────────
  1. Premises valid?                   —       —        —
  2. Right problem to solve?           —       —        —
  3. Scope calibration correct?        —       —        —
  4. Alternatives sufficiently explored? —     —        —
  5. Competitive/market risks covered? —       —        —
  6. 6-month trajectory sound?         —       —        —
═══════════════════════════════════════════════════════════════
CONFIRMED = both agree. DISAGREE = voices differ (→ taste decision).
Missing voice = N/A. Single critical finding from one voice = flagged regardless.
```

### Required execution checklist (Deep)

Step 0 (0A-0F from plan-deep-review) — run each and produce:
- 0A: Premise challenge with specific premises named and evaluated
- 0B: Existing code leverage map (sub-problems → existing code)
- 0C: Dream state diagram (CURRENT → THIS PLAN → 12-MONTH IDEAL)
- 0C-bis: Implementation alternatives table (2-3 approaches with effort/risk/pros/cons)
- 0D: Mode-specific analysis with scope decisions logged
- 0E: Temporal interrogation (HOUR 1 → HOUR 6+)
- 0F: Mode selection (SELECTIVE EXPANSION, per override)

Sections 1-12 from plan-deep-review — for EACH section, run the evaluation criteria:
- Sections WITH findings: full analysis, auto-decide each issue, log to audit trail
- Sections with NO findings: state what was examined and why nothing was flagged, using no more words than the evidence needs.
- Section 12 (Design): run only if UI scope was detected in Phase 0

### Mandatory outputs from Phase 1

- "NOT in scope" section with deferred items and rationale
- "What already exists" section mapping sub-problems to existing code
- Dream state delta (where this plan leaves us vs 12-month ideal)
- Error & Rescue Registry table
- Failure Modes Registry table
- Completion Summary table (from plan-deep-review)

### Phase 1 transition

**PHASE 1 COMPLETE.** Emit:

> Phase 1 complete. Outside voice: [N concerns]. Consensus: [X/6 confirmed, Y disagreements → surfaced at gate]. Passing to Phase 2.

Do NOT begin Phase 2 until all Phase 1 outputs are written and the premise gate has been passed.

**Pre-Phase 2 checklist (verify before starting):**
- [ ] Deep review completion summary produced
- [ ] Deep outside voice and consensus table completed if Phase 1 was selected; otherwise noted skipped
- [ ] Premise gate passed (user confirmed)
- [ ] Phase-transition summary emitted

---

## Phase 2: Design Review (conditional — skip if no UI scope)

If UI scope was NOT detected in Phase 0, skip this phase entirely. Log: "Phase 2 skipped — no UI scope detected."

Follow plan-design-review's methodology at full depth. Override: every AskUserQuestion → auto-decide using the 6 principles.

### Override rules

- **Focus areas:** all 10 dimensions (P1)
- **Structural issues** (missing states, broken hierarchy): auto-fix (P5)
- **Aesthetic/taste issues:** mark TASTE DECISION
- **Design system alignment:** auto-fix if DESIGN.md exists and fix is obvious
- **Outside voice:** Dispatch only if this phase has the workflow's highest-impact unresolved judgment and no outside-voice subagent has run; otherwise skip.

### Outside Voice — Claude Subagent

Only in the selected outside-voice phase, run the following independent reviewer; otherwise skip this section and its consensus table.

Subagent prompt:

> "Read the plan file at <plan_path>. You are an independent senior product designer reviewing this plan. You have NOT seen any prior review. Evaluate:
> 1. Information hierarchy: what does the user see first, second, third? Is it right?
> 2. Missing states: loading, empty, error, success, partial — which are unspecified?
> 3. User journey: what's the emotional arc? Where does it break?
> 4. Specificity: does the plan describe SPECIFIC UI or generic patterns?
> 5. What design decisions will haunt the implementer if left ambiguous?
>
> For each finding: what's wrong, severity (critical/high/medium), and the fix."

No prior-phase context — subagent must be truly independent.

### Required execution checklist (Design)

1. Step 0 from plan-design-review: rate completeness 0-10, check DESIGN.md, map existing patterns
2. If Design is the selected outside-voice phase, run the reviewer and produce the consensus table; otherwise record skipped.
3. Passes 1-10 from plan-design-review: run each, rate 0-10, auto-decide each issue. DISAGREE items from the consensus table → raised in the relevant pass with both perspectives.

### Mandatory outputs from Phase 2

- All 10 passes rated initial → after fixes
- Plan file edited with all design decisions resolved
- Completion Summary table
- Design Readiness verdict (must be consistent with ratings)

### Phase 2 transition

**PHASE 2 COMPLETE.** Emit:

> Phase 2 complete. Outside voice: [N concerns]. Consensus: [X/Y confirmed, Z disagreements → surfaced at gate]. Passing to Phase 3.

**Pre-Phase 3 checklist (verify before starting):**
- [ ] All Phase 1 items confirmed
- [ ] Design completion summary written (or "skipped — no UI scope")
- [ ] Design outside voice and consensus table completed if Phase 2 was selected; otherwise noted skipped
- [ ] Phase-transition summary emitted

---

## Phase 3: Eng Review

Follow plan-eng-review's methodology at full depth. Override: every AskUserQuestion → auto-decide using the 6 principles.

### Override rules

- **Scope challenge:** never reduce (P2)
- **Architecture choices:** explicit over clever (P5). If subagent disagrees with valid reason → TASTE DECISION. Scope changes both voices agree on → USER CHALLENGE.
- **Test gaps:** always add tests for new codepaths (P1). Test plan goes in the plan file or conversation, not silently dropped.
- **TODOS.md:** collect all deferred scope expansions from Phase 1, auto-write
- **Outside voice:** Dispatch only if this phase has the workflow's highest-impact unresolved judgment and no outside-voice subagent has run; otherwise skip.

### Outside Voice — Claude Subagent

Only in the selected outside-voice phase, run the following independent reviewer; otherwise skip this section and its consensus table.

Subagent prompt:

> "Read the plan file at <plan_path> (or branch diff). You are an independent senior engineer reviewing this plan. You have NOT seen any prior review. Evaluate:
> 1. Architecture: is the component structure sound? Coupling concerns?
> 2. Edge cases: what breaks under 10x load? What's the nil/empty/error path?
> 3. Tests: what's missing from the test plan? What would break at 2am Friday?
> 4. Security: new attack surface? Auth boundaries? Input validation?
> 5. Hidden complexity: what looks simple but isn't?
>
> For each finding: what's wrong, severity, and the fix."

No prior-phase context — subagent must be truly independent.

### Required execution checklist (Eng)

1. **Step 0 (Scope Challenge):** Read actual code referenced by the plan. Map each sub-problem to existing code. Run the complexity check. Produce concrete findings.
2. If Eng is the selected outside-voice phase, run the reviewer and produce the consensus table; otherwise record skipped.

```
ENG CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                            Primary  Subagent  Consensus
  ──────────────────────────────────── ─────── ──────── ─────────
  1. Architecture sound?               —       —        —
  2. Test coverage sufficient?         —       —        —
  3. Performance risks addressed?      —       —        —
  4. Security threats covered?         —       —        —
  5. Error paths handled?              —       —        —
  6. Deployment risk manageable?       —       —        —
═══════════════════════════════════════════════════════════════
```

3. **Section 1 (Architecture):** Produce ASCII dependency graph showing new components and their relationships to existing ones. Evaluate coupling, scaling, security.
4. **Section 2 (Security):** Threat-model each new attack surface. Auto-decide each issue.
5. **Section 3 (Code Quality):** Identify DRY violations, naming issues, complexity. Reference specific files and patterns.
6. **Section 4 (Test Review) — NEVER SKIP OR COMPRESS.** This section requires reading actual code, not summarizing from memory.
   - Read the diff or the plan's affected files
   - Build the test diagram: list every NEW UX flow, data flow, codepath, and branch
   - For EACH item in the diagram: what type of test covers it? Does one exist? Gaps?
   - Auto-deciding test gaps means: identify the gap → decide whether to add a test or defer (with rationale and principle) → log the decision. It does NOT mean skipping the analysis.
7. **Sections 5-8 (Performance, Observability, Deployment, Concurrency):** evaluate each, auto-decide each finding.

### Mandatory outputs from Phase 3

- "NOT in scope" section
- "What already exists" section
- Architecture ASCII diagram (Section 1)
- Test diagram mapping codepaths to coverage (Section 4)
- Error & rescue map
- Failure modes registry with critical gap flags
- Completion Summary
- Readiness verdict (READY TO IMPLEMENT / READY WITH CONDITIONS / NEEDS REWORK)

### Phase 3 transition

**PHASE 3 COMPLETE.** Emit:

> Phase 3 complete. Outside voice: [N concerns]. Consensus: [X/6 confirmed, Y disagreements → surfaced at gate]. Passing to Phase 3.5 (DX) or Phase 4 (Final Gate).

---

## Phase 3.5: DX Review (conditional — skip if no developer-facing scope)

If DX scope was NOT detected in Phase 0, skip this phase entirely. Log: "Phase 3.5 skipped — no developer-facing scope detected."

Follow plan-devex-review's methodology at full depth. Override: every AskUserQuestion → auto-decide using the 6 principles.

### Override rules

- **Mode selection:** DX POLISH
- **Persona:** infer from README/docs, pick the most common developer type (P6)
- **Competitive benchmark:** run searches if WebSearch available, use reference benchmarks otherwise (P1)
- **Magical moment:** pick the lowest-effort delivery vehicle that achieves the competitive tier (P5)
- **Getting started friction:** always optimize toward fewer steps (P5)
- **Error message quality:** always require problem + cause + fix + docs link (P1)
- **API/CLI naming:** consistency wins over cleverness (P5)
- **DX taste decisions** (e.g., opinionated defaults vs flexibility): mark TASTE DECISION
- **Outside voice:** Dispatch only if this phase has the workflow's highest-impact unresolved judgment and no outside-voice subagent has run; otherwise skip.

### Outside Voice — Claude Subagent

Only in the selected outside-voice phase, run the following independent reviewer; otherwise skip this section and its consensus table.

Subagent prompt:

> "Read the plan file at <plan_path>. You are an independent DX engineer reviewing this plan. You have NOT seen any prior review. Evaluate:
> 1. Getting started: how many steps from zero to hello world? What's the TTHW?
> 2. API/CLI ergonomics: naming consistency, sensible defaults, progressive disclosure?
> 3. Error handling: does every error path specify problem + cause + fix + docs link?
> 4. Documentation: copy-paste examples? Information architecture? Interactive elements?
> 5. Escape hatches: can developers override every opinionated default?
>
> For each finding: what's wrong, severity (critical/high/medium), and the fix."

No prior-phase context.

### Required execution checklist (DX)

1. Auto-detect product type. Map the developer journey. Rate initial DX completeness 0-10. Assess TTHW.
2. If DX is the selected outside-voice phase, run the reviewer and produce the consensus table; otherwise record skipped.

```
DX CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                            Primary  Subagent  Consensus
  ──────────────────────────────────── ─────── ──────── ─────────
  1. Getting started < 5 min?          —       —        —
  2. API/CLI naming guessable?         —       —        —
  3. Error messages actionable?        —       —        —
  4. Docs findable & complete?         —       —        —
  5. Upgrade path safe?                —       —        —
  6. Dev environment friction-free?    —       —        —
═══════════════════════════════════════════════════════════════
```

3. Passes 1-8 from plan-devex-review: run each, rate 0-10, auto-decide each issue. DISAGREE items from consensus → raised in the relevant pass with both perspectives.

### Mandatory outputs from Phase 3.5

- Developer Persona Card (from Step 0A)
- Developer Empathy Narrative (from Step 0B)
- Developer Journey Map (from Step 0F)
- DX Scorecard with all 8 dimension scores
- DX Implementation Checklist
- TTHW assessment with target
- DX Readiness Verdict

### Phase 3.5 transition

**PHASE 3.5 COMPLETE.** Emit:

> Phase 3.5 complete. DX overall: [N]/10. TTHW: [N] min → [target] min. Outside voice: [N concerns]. Consensus: [X/6 confirmed, Y disagreements → surfaced at gate]. Passing to Phase 4 (Final Gate).

---

## Decision Audit Trail

After each auto-decision, append a row to the audit trail. Keep it in conversation output during the run, then echo the full table as part of the Final Gate output:

```markdown
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected option |
|---|-------|----------|----------------|-----------|-----------|-----------------|
```

If a plan file exists, also write the audit trail to it under a `## Decision Audit Trail` heading using Edit (one row at a time, incrementally — never accumulate the entire table in conversation context).

---

## Phase 4: Final Approval Gate

**STOP here and present the final state to the user.**

Present as a message, then use AskUserQuestion:

```
## /autoplan Review Complete

### Plan Summary
[1-3 sentence summary]

### Decisions Made: [N] total ([M] auto-decided, [K] taste choices, [J] user challenges)

### User Challenges (both voices disagree with your stated direction)
[For each user challenge:]
**Challenge [N]: [title]** (from [phase])
You said: [user's original direction]
Both voices recommend: [the change]
Why: [reasoning]
What we might be missing: [blind spots]
If we're wrong, the cost is: [downside of changing]
[If security/feasibility: "⚠️ Both voices flag this as a security/feasibility risk, not just a preference."]

Your call — your original direction stands unless you explicitly change it.

### Your Choices (taste decisions)
[For each taste decision:]
**Choice [N]: [title]** (from [phase])
I recommend [X] — [principle]. But [Y] is also viable:
  [1-sentence downstream impact if you pick Y]

### Auto-Decided: [M] decisions [see Decision Audit Trail above or in plan file]

### Review Scores
- Deep: [summary] | Outside voice: [summary] | Consensus: [X/6 confirmed]
- Design: [summary or "skipped, no UI scope"] | Outside voice: [summary] | Consensus: [X/Y confirmed]
- Eng: [summary] | Outside voice: [summary] | Consensus: [X/6 confirmed]
- DX: [summary or "skipped, no developer-facing scope"] | Outside voice: [summary] | Consensus: [X/6 confirmed]

### Cross-Phase Themes
[For any concern that appeared in 2+ phases' outside voices independently:]
**Theme: [topic]** — flagged in [Phase 1, Phase 3]. High-confidence signal.
[If no themes span phases:] "No cross-phase themes — each phase's concerns were distinct."

### Deferred to TODOS.md
[Items auto-deferred with reasons]

### Implementation Tasks
[Flat list of build-actionable tasks synthesized from this review's findings.
Each task derives from a specific finding. Priority: P1 blocks ship, P2 should
land same branch, P3 is a follow-up TODO. Format:
- [ ] **T1 (P1)** — <component> — <imperative title>
  - Surfaced by: <phase> — <specific finding>
  - Files: <paths>
If zero tasks from a phase, note "_No new tasks from <phase>._"]
```

**Cognitive load management:**
- 0 user challenges: skip "User Challenges" section
- 0 taste decisions: skip "Your Choices" section
- 1-7 taste decisions: flat list
- 8+: group by phase. Add warning: "This plan had unusually high ambiguity ([N] taste decisions). Review carefully."

AskUserQuestion options:
- **A)** Approve as-is (accept all recommendations)
- **B)** Approve with overrides (specify which taste decisions to change)
- **B2)** Approve with user challenge responses (accept or reject each challenge)
- **C)** Interrogate (ask about any specific decision)
- **D)** Revise (the plan itself needs changes)
- **E)** Reject (start over)

**Option handling:**
- **A:** Mark APPROVED. Suggest `/ship` when ready to create the PR.
- **B:** Ask which overrides, apply, re-present gate.
- **B2:** Walk each user challenge, accept or reject, apply, re-present gate.
- **C:** Answer free-form, re-present gate.
- **D:** Make changes. Re-run affected phases (scope → Phase 1; design → Phase 2; test plan or arch → Phase 3; DX → Phase 3.5). Max 3 cycles.
- **E:** Start over — invoke `/plan-session` to rebuild.

---

## Important Rules

- **Never abort.** The user chose /autoplan. Respect that choice. Surface all taste decisions and user challenges at the final gate — never redirect mid-flow to an interactive review.
- **Two gates.** The non-auto-decided AskUserQuestions are: (1) premise confirmation in Phase 1, and (2) User Challenges at the Final Gate. Everything else is auto-decided using the 6 principles.
- **Log every decision.** No silent auto-decisions. Every choice gets a row in the audit trail.
- **Full depth means evidence, not sentence count.** Execute every required section except Phase 0 skip-list items. Read the required code, produce the required outputs, identify every issue, and decide each one. For no-finding sections, state what was examined and why nothing was flagged, using no more words than the evidence needs.
- **Artifacts are deliverables.** Test diagram, failure modes registry, error/rescue table, ASCII diagrams, DX scorecard — these must exist in the plan file or conversation when the review completes. If they don't exist, the review is incomplete.
- **Sequential order.** Deep → Design → Eng → DX. Each phase builds on the last. NEVER run phases in parallel.
- **Subagent failures don't block.** If the outside voice fails or times out in any phase, log `[single-voice]` and continue with the primary review only.
