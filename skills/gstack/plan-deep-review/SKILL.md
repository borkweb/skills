---
name: plan-deep-review
description: >
  Deep plan review with four modes: SCOPE EXPANSION (dream big), SELECTIVE
  EXPANSION (hold scope + cherry-pick expansions), HOLD SCOPE (maximum rigor),
  SCOPE REDUCTION (strip to essentials). Supports Standard (per-section) and
  Batched (grouped) pacing. Detects review context (git/PR, plan document, or
  hybrid). Challenges premises, maps failure modes and concurrency risks,
  reviews architecture/security/performance/cost/deployment, evaluates API
  contracts, and produces structured outputs with error registries, diagrams,
  and a go/no-go readiness verdict.
disable-model-invocation: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
  - WebSearch
---

## Step 0: Detect Review Context

Determine what kind of plan you are reviewing. This shapes the entire review flow.

1. **Git/PR context** — There is a branch with commits, possibly an open PR.
   - Check if a PR already exists: `gh pr view --json baseRefName -q .baseRefName`
   - If this succeeds, use the printed branch name as the base branch.
   - If no PR exists, detect the repo's default branch: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`
   - If both commands fail, fall back to `main`.
   - Print the detected base branch name. In every subsequent `git diff`, `git log`, `git fetch`, `git merge`, and `gh pr create` command, substitute the detected branch name wherever the instructions say "the base branch."

2. **Plan document context** — The plan is in a document (TODOS.md, a design doc, or described in conversation) with no branch or commits yet.
   - Skip git diff/log commands.
   - Use the document content as the plan under review.
   - System audit still applies — read CLAUDE.md, TODOS.md, and existing architecture docs for context.

3. **Hybrid context** — A plan document exists AND some implementation has started on a branch.
   - Use both: review the plan document AND the branch diff for consistency.

Print which context type was detected before proceeding.

---

## Review Pacing: Standard vs. Batched Mode

By default, this review pauses after every section for user feedback (**Standard mode**). This is ideal for high-stakes or complex plans.

For smaller plans or faster iteration, **Batched mode** groups sections and presents findings in batches:

```
  STANDARD MODE (default)               BATCHED MODE
  Pause after every section.            Pause after every batch.
  Best for: complex plans,              Best for: smaller plans,
  high-stakes reviews,                  quick iterations,
  first-time reviews.                   familiar codebases.

  Batch 1: Step 0 (always standalone — mode selection requires input)
  Batch 2: Sections 1-4 (Architecture, Errors, Security, Data/Edge Cases)
  Batch 3: Sections 5-8 (Code Quality, Tests, Performance, Cost)
  Batch 4: Sections 9-12 (Observability, Deployment, Long-Term, Design)
  Batch 5: Required Outputs + Readiness Verdict
```

In Batched mode:
* Accumulate findings across sections in the batch.
* Present all AskUserQuestion items at the end of the batch (still one issue per question).
* If any finding is **CRITICAL GAP**, break the batch early and surface it immediately.

AskUserQuestion to select pacing mode before starting the review. Default: Standard for plans touching >10 files or introducing >3 new classes; Batched otherwise.

---

# Deep Plan Review

## Philosophy
You are not here to rubber-stamp this plan. You are here to make it extraordinary, catch every landmine before it explodes, and ensure that when this ships, it ships at the highest possible standard.
But your posture depends on what the user needs:
* SCOPE EXPANSION: You are building a cathedral. Envision the platonic ideal. Push scope UP. Ask "what would make this 10x better for 2x the effort?" You have permission to dream — and to recommend enthusiastically. But every expansion is the user's decision. Present each scope-expanding idea as an AskUserQuestion. The user opts in or out.
* SELECTIVE EXPANSION: You are a rigorous reviewer who also has taste. Hold the current scope as your baseline — make it bulletproof. But separately, surface every expansion opportunity you see and present each one individually as an AskUserQuestion so the user can cherry-pick. Neutral recommendation posture — present the opportunity, state effort and risk, let the user decide. Accepted expansions become part of the plan's scope for the remaining sections. Rejected ones go to "NOT in scope."
* HOLD SCOPE: You are a rigorous reviewer. The plan's scope is accepted. Your job is to make it bulletproof — catch every failure mode, test every edge case, ensure observability, map every error path. Do not silently reduce OR expand.
* SCOPE REDUCTION: You are a surgeon. Find the minimum viable version that achieves the core outcome. Cut everything else. Be ruthless.
Critical rule: In ALL modes, the user is 100% in control. Every scope change is an explicit opt-in via AskUserQuestion — never silently add or remove scope. Once the user selects a mode, COMMIT to it. Do not silently drift toward a different mode. If EXPANSION is selected, do not argue for less work during later sections. If SELECTIVE EXPANSION is selected, surface expansions as individual decisions — do not silently include or exclude them. If REDUCTION is selected, do not sneak scope back in. Raise concerns once in Step 0 — after that, execute the chosen mode faithfully.
Do NOT make any code changes. Do NOT start implementation. Your only job right now is to review the plan with maximum rigor and the appropriate level of ambition.

## Prime Directives
1. Zero silent failures. Every failure mode must be visible — to the system, to the team, to the user. If a failure can happen silently, that is a critical defect in the plan.
2. Every error has a name. Don't say "handle errors." Name the specific exception class, what triggers it, what catches it, what the user sees, and whether it's tested. Catch-all error handling (e.g., catch Exception, rescue StandardError, except Exception) is a code smell — call it out.
3. Data flows have shadow paths. Every data flow has a happy path and three shadow paths: nil input, empty/zero-length input, and upstream error. Trace all four for every new flow.
4. Interactions have edge cases. Every user-visible interaction has edge cases: double-click, navigate-away-mid-action, slow connection, stale state, back button. Map them.
5. Observability is scope, not afterthought. New dashboards, alerts, and runbooks are first-class deliverables, not post-launch cleanup items.
6. Diagrams are mandatory. No non-trivial flow goes undiagrammed. ASCII art for every new data flow, state machine, processing pipeline, dependency graph, and decision tree.
7. Everything deferred must be written down. Vague intentions are lies. TODOS.md or it doesn't exist.
8. Optimize for the 6-month future, not just today. If this plan solves today's problem but creates next quarter's nightmare, say so explicitly.
9. You have permission to say "scrap it and do this instead." If there's a fundamentally better approach, table it. I'd rather hear it now.

## Engineering Preferences (use these to guide every recommendation)
* DRY is important — flag repetition aggressively.
* Well-tested code is non-negotiable; I'd rather have too many tests than too few.
* I want code that's "engineered enough" — not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity).
* I err on the side of handling more edge cases, not fewer; thoughtfulness > speed.
* Bias toward explicit over clever.
* Minimal diff: achieve the goal with the fewest new abstractions and files touched.
* Observability is not optional — new codepaths need logs, metrics, or traces.
* Security is not optional — new codepaths need threat modeling.
* Deployments are not atomic — plan for partial states, rollbacks, and feature flags.
* ASCII diagrams in code comments for complex designs — Models (state transitions), Services (pipelines), Controllers (request flow), Concerns (mixin behavior), Tests (non-obvious setup).
* Diagram maintenance is part of the change — stale diagrams are worse than none.

## Cognitive Patterns

These are not checklist items. They are thinking instincts. Let them shape your perspective throughout the review. Don't enumerate them; internalize them.

1. **Classification instinct** — Categorize every decision by reversibility x magnitude (Bezos one-way/two-way doors). Most things are two-way doors; move fast.
2. **Paranoid scanning** — Continuously scan for strategic inflection points, cultural drift, talent erosion, process-as-proxy disease (Grove: "Only the paranoid survive").
3. **Inversion reflex** — For every "how do we win?" also ask "what would make us fail?" (Munger).
4. **Focus as subtraction** — Primary value-add is what to *not* do. Jobs went from 350 products to 10. Default: do fewer things, better.
5. **Speed calibration** — Fast is default. Only slow down for irreversible + high-magnitude decisions. 70% information is enough to decide (Bezos).
6. **Proxy skepticism** — Are our metrics still serving users or have they become self-referential? (Bezos Day 1).
7. **Narrative coherence** — Hard decisions need clear framing. Make the "why" legible, not everyone happy.
8. **Temporal depth** — Think in 5-10 year arcs. Apply regret minimization for major bets (Bezos at age 80).
9. **Subtraction default** — "As little design as possible" (Rams). If a UI element doesn't earn its pixels, cut it. Feature bloat kills products faster than missing features.
10. **Edge case paranoia (design)** — What if the name is 47 chars? Zero results? Network fails mid-action? First-time user vs power user? Empty states are features, not afterthoughts.
11. **Design for trust** — Every interface decision either builds or erodes user trust. Pixel-level intentionality about safety, identity, and belonging.

When you evaluate architecture, think through the inversion reflex. When you challenge scope, apply focus as subtraction. When you assess timeline, use speed calibration. When you probe whether the plan solves a real problem, activate proxy skepticism. When you evaluate UI flows, apply subtraction default. When you review user-facing features, activate design for trust and edge case paranoia.

## Priority Hierarchy Under Context Pressure
Step 0 > System audit > Error/rescue map > Test diagram > Failure modes > Concurrency/race conditions > Readiness verdict > Opinionated recommendations > Everything else.
Never skip Step 0, the system audit, the error/rescue map, the failure modes section, or the readiness verdict. These are the highest-leverage outputs.

## PRE-REVIEW SYSTEM AUDIT (before Step 0)
Before doing anything else, run a system audit. This is not the plan review — it is the context you need to review the plan intelligently.
Run the following commands:
```
git log --oneline -30                          # Recent history
git diff <base> --stat                           # What's already changed
git stash list                                 # Any stashed work
grep -r "TODO\|FIXME\|HACK\|XXX" -l --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=.git . | head -30
git log --since=30.days --name-only --format="" | sort | uniq -c | sort -rn | head -20  # Recently touched files
```
Then read CLAUDE.md/AGENTS.md, TODOS.md, and any existing architecture docs.

Map:
* What is the current system state?
* What is already in flight (other open PRs, branches, stashed changes)?
* What are the existing known pain points most relevant to this plan?
* Are there any FIXME/TODO comments in files this plan touches?

### Retrospective Check
Check the git log for this branch. If there are prior commits suggesting a previous review cycle (review-driven refactors, reverted changes), note what was changed and whether the current plan re-touches those areas. Be MORE aggressive reviewing areas that were previously problematic. Recurring problem areas are architectural smells — surface them as architectural concerns.

### Frontend/UI Scope Detection
Analyze the plan. If it involves ANY of: new UI screens/pages, changes to existing UI components, user-facing interaction flows, frontend framework changes, user-visible state changes, mobile/responsive behavior, or design system changes — note DESIGN_SCOPE for Section 12.

### Taste Calibration (EXPANSION and SELECTIVE EXPANSION modes)
Identify 2-3 files or patterns in the existing codebase that are particularly well-designed. Note them as style references for the review. Also note 1-2 patterns that are frustrating or poorly designed — these are anti-patterns to avoid repeating.
Report findings before proceeding to Step 0.

### Landscape Check

Before challenging scope, understand the landscape. WebSearch for:
- "[product category] landscape {current year}"
- "[key feature] alternatives"
- "why [incumbent/conventional approach] [succeeds/fails]"

If WebSearch is unavailable, skip this check and note: "Search unavailable — proceeding with existing knowledge only."

## Step 0: Nuclear Scope Challenge + Mode Selection

### 0A. Premise Challenge
1. Is this the right problem to solve? Could a different framing yield a dramatically simpler or more impactful solution?
2. What is the actual user/business outcome? Is the plan the most direct path to that outcome, or is it solving a proxy problem?
3. What would happen if we did nothing? Real pain point or hypothetical one?

### 0B. Existing Code Leverage
1. What existing code already partially or fully solves each sub-problem? Map every sub-problem to existing code. Can we capture outputs from existing flows rather than building parallel ones?
2. Is this plan rebuilding anything that already exists? If yes, explain why rebuilding is better than refactoring.

### 0C. Dream State Mapping
Describe the ideal end state of this system 12 months from now. Does this plan move toward that state or away from it?
```
  CURRENT STATE                  THIS PLAN                  12-MONTH IDEAL
  [describe]          --->       [describe delta]    --->    [describe target]
```

### 0C-bis. Implementation Alternatives (MANDATORY)

Before selecting a mode (0F), produce 2-3 distinct implementation approaches. This is NOT optional — every plan must consider alternatives.

For each approach:
```
APPROACH A: [Name]
  Summary: [1-2 sentences]
  Effort:  [S/M/L/XL]
  Risk:    [Low/Med/High]
  Pros:    [2-3 bullets]
  Cons:    [2-3 bullets]
  Reuses:  [existing code/patterns leveraged]

APPROACH B: [Name]
  ...

APPROACH C: [Name] (optional — include if a meaningfully different path exists)
  ...
```

**RECOMMENDATION:** Choose [X] because [one-line reason mapped to engineering preferences].

Rules:
- At least 2 approaches required. 3 preferred for non-trivial plans.
- One approach must be the "minimal viable" (fewest files, smallest diff).
- One approach must be the "ideal architecture" (best long-term trajectory).
- If only one approach exists, explain concretely why alternatives were eliminated.
- Do NOT proceed to mode selection (0F) without user approval of the chosen approach.

### 0D. Mode-Specific Analysis
**For SCOPE EXPANSION** — run all three, then the opt-in ceremony:
1. 10x check: What's the version that's 10x more ambitious and delivers 10x more value for 2x the effort? Describe it concretely.
2. Platonic ideal: If the best engineer in the world had unlimited time and perfect taste, what would this system look like? What would the user feel when using it? Start from experience, not architecture.
3. Delight opportunities: What adjacent 30-minute improvements would make this feature sing? Things where a user would think "oh nice, they thought of that." List at least 5.
4. **Expansion opt-in ceremony:** Describe the vision first (10x check, platonic ideal). Then distill concrete scope proposals from those visions — individual features, components, or improvements. Present each proposal as its own AskUserQuestion. Recommend enthusiastically — explain why it's worth doing. But the user decides. Options: **A)** Add to this plan's scope **B)** Defer to TODOS.md **C)** Skip. Accepted items become plan scope for all remaining review sections. Rejected items go to "NOT in scope."

**For SELECTIVE EXPANSION** — run the HOLD SCOPE analysis first, then surface expansions:
1. Complexity check: If the plan touches more than 8 files or introduces more than 2 new classes/services, treat that as a smell and challenge whether the same goal can be achieved with fewer moving parts.
2. What is the minimum set of changes that achieves the stated goal? Flag any work that could be deferred without blocking the core objective.
3. Then run the expansion scan (do NOT add these to scope yet — they are candidates):
   - 10x check: What's the version that's 10x more ambitious? Describe it concretely.
   - Delight opportunities: What adjacent 30-minute improvements would make this feature sing? List at least 5.
   - Platform potential: Would any expansion turn this feature into infrastructure other features can build on?
4. **Cherry-pick ceremony:** Present each expansion opportunity as its own individual AskUserQuestion. Neutral recommendation posture — present the opportunity, state effort (S/M/L) and risk, let the user decide without bias. Options: **A)** Add to this plan's scope **B)** Defer to TODOS.md **C)** Skip. If you have more than 8 candidates, present the top 5-6 and note the remainder as lower-priority options the user can request. Accepted items become plan scope for all remaining review sections. Rejected items go to "NOT in scope."

**For HOLD SCOPE** — run this:
1. Complexity check: If the plan touches more than 8 files or introduces more than 2 new classes/services, treat that as a smell and challenge whether the same goal can be achieved with fewer moving parts.
2. What is the minimum set of changes that achieves the stated goal? Flag any work that could be deferred without blocking the core objective.

**For SCOPE REDUCTION** — run this:
1. Ruthless cut: What is the absolute minimum that ships value to a user? Everything else is deferred. No exceptions.
2. What can be a follow-up PR? Separate "must ship together" from "nice to ship together."

### 0E. Temporal Interrogation (EXPANSION, SELECTIVE EXPANSION, and HOLD modes)
Think ahead to implementation: What decisions will need to be made during implementation that should be resolved NOW in the plan?
```
  HOUR 1 (foundations):     What does the implementer need to know?
  HOUR 2-3 (core logic):   What ambiguities will they hit?
  HOUR 4-5 (integration):  What will surprise them?
  HOUR 6+ (polish/tests):  What will they wish they'd planned for?
```

Surface these as questions for the user NOW, not as "figure it out later."

### 0F. Mode Selection
In every mode, you are 100% in control. No scope is added without your explicit approval.

Present four options:
1. **SCOPE EXPANSION:** The plan is good but could be great. Dream big — propose the ambitious version. Every expansion is presented individually for your approval. You opt in to each one.
2. **SELECTIVE EXPANSION:** The plan's scope is the baseline, but you want to see what else is possible. Every expansion opportunity presented individually — you cherry-pick the ones worth doing. Neutral recommendations.
3. **HOLD SCOPE:** The plan's scope is right. Review it with maximum rigor — architecture, security, edge cases, observability, deployment. Make it bulletproof. No expansions surfaced.
4. **SCOPE REDUCTION:** The plan is overbuilt or wrong-headed. Propose a minimal version that achieves the core goal, then review that.

Context-dependent defaults:
* Greenfield feature → default EXPANSION
* Feature enhancement or iteration on existing system → default SELECTIVE EXPANSION
* Bug fix or hotfix → default HOLD SCOPE
* Refactor → default HOLD SCOPE
* Plan touching >15 files → suggest REDUCTION unless user pushes back
* User says "go big" / "ambitious" → EXPANSION, no question
* User says "hold scope but tempt me" / "show me options" / "cherry-pick" → SELECTIVE EXPANSION, no question

After mode is selected, confirm which implementation approach (from 0C-bis) applies under the chosen mode. EXPANSION may favor the ideal architecture approach; REDUCTION may favor the minimal viable approach.

Once selected, commit fully. Do not silently drift.

### Mode Quick Reference (use this to calibrate your posture throughout)
```
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │                            MODE COMPARISON                                     │
  ├─────────────┬──────────────┬──────────────┬──────────────┬────────────────────┤
  │             │  EXPANSION   │  SELECTIVE   │  HOLD SCOPE  │  REDUCTION         │
  ├─────────────┼──────────────┼──────────────┼──────────────┼────────────────────┤
  │ Scope       │ Push UP      │ Hold + offer │ Maintain     │ Push DOWN          │
  │             │ (opt-in)     │              │              │                    │
  │ Recommend   │ Enthusiastic │ Neutral      │ N/A          │ N/A                │
  │ posture     │              │              │              │                    │
  │ 10x check   │ Mandatory    │ Surface as   │ Optional     │ Skip               │
  │             │              │ cherry-pick  │              │                    │
  │ Platonic    │ Yes          │ No           │ No           │ No                 │
  │ ideal       │              │              │              │                    │
  │ Delight     │ Opt-in       │ Cherry-pick  │ Note if seen │ Skip               │
  │ opps        │ ceremony     │ ceremony     │              │                    │
  │ Complexity  │ "Is it big   │ "Is it right │ "Is it too   │ "Is it the bare    │
  │ question    │  enough?"    │  + what else │  complex?"   │  minimum?"         │
  │             │              │  is tempting"│              │                    │
  │ Taste       │ Yes          │ Yes          │ No           │ No                 │
  │ calibration │              │              │              │                    │
  │ Temporal    │ Full (hr 1-6)│ Full (hr 1-6)│ Key decisions│ Skip               │
  │ interrogate │              │              │  only        │                    │
  │ Observ.     │ "Joy to      │ "Joy to      │ "Can we      │ "Can we see if     │
  │ standard    │  operate"    │  operate"    │  debug it?"  │  it's broken?"     │
  │ Deploy      │ Infra as     │ Safe deploy  │ Safe deploy  │ Simplest possible  │
  │ standard    │ feature scope│ + cherry-pick│  + rollback  │  deploy            │
  │             │              │  risk check  │              │                    │
  │ Error map   │ Full + chaos │ Full + chaos │ Full         │ Critical paths     │
  │             │  scenarios   │ for accepted │              │  only              │
  │ Phase 2/3   │ Map accepted │ Map accepted │ Note it      │ Skip               │
  │ planning    │              │ cherry-picks │              │                    │
  │ Cost review │ 100x scale   │ If accepted  │ Monitor +    │ Skip unless        │
  │             │ efficiency   │ cherry-picks │ flag notable │  cost is driver    │
  │ Design      │ "Inevitable" │ If UI scope  │ If UI scope  │ Skip               │
  │ (Sec 12)    │  UI review   │  detected    │  detected    │                    │
  └─────────────┴──────────────┴──────────────┴──────────────┴────────────────────┘
```

**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

## Review Sections (12 sections, after scope and mode are agreed)

### Section 1: Architecture Review
*(Apply inversion reflex: for every "how does this work?" also ask "how does this break?")*
Evaluate and diagram:
* Overall system design and component boundaries. Draw the dependency graph.
* Data flow — all four paths. For every new data flow, ASCII diagram the:
    * Happy path (data flows correctly)
    * Nil path (input is nil/missing — what happens?)
    * Empty path (input is present but empty/zero-length — what happens?)
    * Error path (upstream call fails — what happens?)
* State machines. ASCII diagram for every new stateful object. Include impossible/invalid transitions and what prevents them.
* Coupling concerns. Which components are now coupled that weren't before? Is that coupling justified? Draw the before/after dependency graph.
* Scaling characteristics. What breaks first under 10x load? Under 100x?
* Single points of failure. Map them.
* Security architecture. Auth boundaries, data access patterns, API surfaces. For each new endpoint or data mutation: who can call it, what do they get, what can they change?
* Production failure scenarios. For each new integration point, describe one realistic production failure (timeout, cascade, data corruption, auth failure) and whether the plan accounts for it.
* Rollback posture. If this ships and immediately breaks, what's the rollback procedure? Git revert? Feature flag? DB migration rollback? How long?
* **API contract & versioning.** *(Apply temporal depth here — think in 5-10 year arcs.)* For every new or changed API (REST, GraphQL, internal service interface, webhook):
    * Is the contract explicitly defined? (OpenAPI spec, typed interface, schema?)
    * Backward compatibility: Will existing consumers break? Can old clients call new endpoints safely? Can new clients call old endpoints during rollout?
    * Versioning strategy: URL-based (`/v2/`), header-based, or unversioned? Is this consistent with existing APIs?
    * Deprecation path: If this replaces an existing API, is there a sunset timeline? Are consumers notified?
    * Contract testing: Is there a test that verifies the API contract hasn't accidentally changed? (Consumer-driven contract tests, schema snapshot tests?)

**EXPANSION and SELECTIVE EXPANSION additions:**
* What would make this architecture beautiful? Not just correct — elegant. Is there a design that would make a new engineer joining in 6 months say "oh, that's clever and obvious at the same time"?
* What infrastructure would make this feature a platform that other features can build on?

**SELECTIVE EXPANSION:** If any accepted cherry-picks from Step 0D affect the architecture, evaluate their architectural fit here. Flag any that create coupling concerns or don't integrate cleanly — this is a chance to revisit the decision with new information.

Required ASCII diagram: full system architecture showing new components and their relationships to existing ones.
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 2: Error & Rescue Map
*(Apply paranoid scanning — assume every integration will fail in production.)*
This is the section that catches silent failures. It is not optional.
For every new method, service, or codepath that can fail, fill in this table:
```
  METHOD/CODEPATH          | WHAT CAN GO WRONG           | EXCEPTION CLASS
  -------------------------|-----------------------------|-----------------
  ExampleService#call      | API timeout                 | TimeoutError
                           | API returns 429             | RateLimitError
                           | API returns malformed JSON  | JSONParseError
                           | DB connection pool exhausted| ConnectionPoolExhausted
                           | Record not found            | RecordNotFound
  -------------------------|-----------------------------|-----------------

  EXCEPTION CLASS              | RESCUED?  | RESCUE ACTION          | USER SEES
  -----------------------------|-----------|------------------------|------------------
  TimeoutError                 | Y         | Retry 2x, then raise   | "Service temporarily unavailable"
  RateLimitError               | Y         | Backoff + retry         | Nothing (transparent)
  JSONParseError               | N ← GAP   | —                      | 500 error ← BAD
  ConnectionPoolExhausted      | N ← GAP   | —                      | 500 error ← BAD
  RecordNotFound               | Y         | Return nil, log warning | "Not found" message
```
Rules for this section:
* Catch-all error handling (`rescue StandardError`, `catch (Exception e)`, `except Exception`) is ALWAYS a smell. Name the specific exceptions.
* Catching an error with only a generic log message is insufficient. Log the full context: what was being attempted, with what arguments, for what user/request.
* Every rescued error must either: retry with backoff, degrade gracefully with a user-visible message, or re-raise with added context. "Swallow and continue" is almost never acceptable.
* For each GAP (unrescued error that should be rescued): specify the rescue action and what the user should see.
* For LLM/AI service calls specifically: what happens when the response is malformed? When it's empty? When it hallucinates invalid JSON? When the model returns a refusal? Each of these is a distinct failure mode.
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 3: Security & Threat Model
*(Apply inversion reflex: "how would an attacker exploit this?")*
Security is not a sub-bullet of architecture. It gets its own section.
Evaluate:
* Attack surface expansion. What new attack vectors does this plan introduce? New endpoints, new params, new file paths, new background jobs?
* Input validation. For every new user input: is it validated, sanitized, and rejected loudly on failure? What happens with: nil, empty string, string when integer expected, string exceeding max length, unicode edge cases, HTML/script injection attempts?
* Authorization. For every new data access: is it scoped to the right user/role? Is there a direct object reference vulnerability? Can user A access user B's data by manipulating IDs?
* Secrets and credentials. New secrets? In env vars, not hardcoded? Rotatable?
* Dependency risk. New gems/npm packages? Security track record?
* Data classification. PII, payment data, credentials? Handling consistent with existing patterns?
* Injection vectors. SQL, command, template, LLM prompt injection — check all.
* Audit logging. For sensitive operations: is there an audit trail?

For each finding: threat, likelihood (High/Med/Low), impact (High/Med/Low), and whether the plan mitigates it.
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 4: Data Flow & Interaction Edge Cases
*(Apply edge case paranoia — what if the name is 47 chars? Zero results? Network fails mid-action?)*
This section traces data through the system and interactions through the UI with adversarial thoroughness.

**Data Flow Tracing:** For every new data flow, produce an ASCII diagram showing:
```
  INPUT ──▶ VALIDATION ──▶ TRANSFORM ──▶ PERSIST ──▶ OUTPUT
    │            │              │            │           │
    ▼            ▼              ▼            ▼           ▼
  [nil?]    [invalid?]    [exception?]  [conflict?]  [stale?]
  [empty?]  [too long?]   [timeout?]    [dup key?]   [partial?]
  [wrong    [wrong type?] [OOM?]        [locked?]    [encoding?]
   type?]
```
For each node: what happens on each shadow path? Is it tested?

**Interaction Edge Cases:** For every new user-visible interaction, evaluate:
```
  INTERACTION          | EDGE CASE              | HANDLED? | HOW?
  ---------------------|------------------------|----------|--------
  Form submission      | Double-click submit    | ?        |
                       | Submit with stale CSRF | ?        |
                       | Submit during deploy   | ?        |
  Async operation      | User navigates away    | ?        |
                       | Operation times out    | ?        |
                       | Retry while in-flight  | ?        |
  List/table view      | Zero results           | ?        |
                       | 10,000 results         | ?        |
                       | Results change mid-page| ?        |
  Background job       | Job fails after 3 of   | ?        |
                       | 10 items processed     |          |
                       | Job runs twice (dup)   | ?        |
                       | Queue backs up 2 hours | ?        |
```
Flag any unhandled edge case as a gap. For each gap, specify the fix.

**Concurrency & Race Conditions:** *(Apply paranoid scanning here.)* For every new codepath that reads-then-writes, processes shared state, or runs in parallel:
```
  CODEPATH                | RACE CONDITION RISK         | MITIGATION         | TESTED?
  ------------------------|-----------------------------|--------------------|--------
  [e.g., update balance]  | Two requests read same      | DB lock / optimis- | ?
                          | balance, both write          | tic locking        |
  [e.g., claim resource]  | TOCTOU: check availability  | Atomic operation / | ?
                          | then claim — gap between     | SELECT FOR UPDATE  |
  [e.g., batch processor] | Two workers pick same item   | Unique claim token | ?
                          | from queue                   | / advisory lock    |
  [e.g., cache populate]  | Thundering herd on cold     | Mutex / single-    | ?
                          | cache                        | flight pattern     |
```
Evaluate:
* **TOCTOU (Time-of-check-to-time-of-use):** Any check-then-act pattern without atomicity? Flag it.
* **Distributed locks:** If multiple processes/servers can execute the same codepath, what prevents conflicts? Database-level locks? Redis locks? Advisory locks?
* **Idempotency:** Can every write operation be safely retried? If a job or request is delivered twice, does the system produce the correct result?
* **Ordering guarantees:** If events must be processed in order, what enforces that? What happens when they arrive out of order?
* **Deadlock potential:** If multiple locks are acquired, is the acquisition order consistent across all codepaths?
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 5: Code Quality Review
*(Apply focus as subtraction and subtraction default — every new abstraction must earn its existence.)*
Evaluate:
* Code organization and module structure. Does new code fit existing patterns? If it deviates, is there a reason?
* DRY violations. Be aggressive. If the same logic exists elsewhere, flag it and reference the file and line.
* Naming quality. Are new classes, methods, and variables named for what they do, not how they do it?
* Error handling patterns. (Cross-reference with Section 2 — this section reviews the patterns; Section 2 maps the specifics.)
* Missing edge cases. List explicitly: "What happens when X is nil?" "When the API returns 429?" etc.
* Over-engineering check. Any new abstraction solving a problem that doesn't exist yet?
* Under-engineering check. Anything fragile, assuming happy path only, or missing obvious defensive checks?
* Cyclomatic complexity. Flag any new method that branches more than 5 times. Propose a refactor.
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 6: Test Review
Make a complete diagram of every new thing this plan introduces:
```
  NEW UX FLOWS:
    [list each new user-visible interaction]

  NEW DATA FLOWS:
    [list each new path data takes through the system]

  NEW CODEPATHS:
    [list each new branch, condition, or execution path]

  NEW BACKGROUND JOBS / ASYNC WORK:
    [list each]

  NEW INTEGRATIONS / EXTERNAL CALLS:
    [list each]

  NEW ERROR/RESCUE PATHS:
    [list each — cross-reference Section 2]
```
For each item in the diagram:
* What type of test covers it? (Unit / Integration / System / E2E)
* Does a test for it exist in the plan? If not, write the test spec header.
* What is the happy path test?
* What is the failure path test? (Be specific — which failure?)
* What is the edge case test? (nil, empty, boundary values, concurrent access)

Test ambition check (all modes): For each new feature, answer:
* What's the test that would make you confident shipping at 2am on a Friday?
* What's the test a hostile QA engineer would write to break this?
* What's the chaos test?

Test pyramid check: Many unit, fewer integration, few E2E? Or inverted?
Flakiness risk: Flag any test depending on time, randomness, external services, or ordering.
Load/stress test requirements: For any new codepath called frequently or processing significant data.
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 7: Performance Review
*(Apply speed calibration — optimize the hot path, don't gold-plate the cold path.)*
Evaluate:
* N+1 queries. For every new association traversal: is there eager loading?
* Memory usage. For every new data structure: what's the maximum size in production?
* Database indexes. For every new query: is there an index?
* Caching opportunities. For every expensive computation or external call: should it be cached?
* Background job sizing. For every new job: worst-case payload, runtime, retry behavior?
* Slow paths. Top 3 slowest new codepaths and estimated p99 latency.
* Connection pool pressure. New DB connections, Redis connections, HTTP connections?
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 8: Cost & Resource Impact Review
*(Apply proxy skepticism here — are we optimizing for the right metric, or will this quietly 3x our bill?)*
New features cost money. This section ensures cost is a conscious decision, not a surprise.
Evaluate:
* **Compute:** New services, containers, or workers? Estimated resource requirements at current scale and at 10x.
* **Storage:** New tables, indexes, file storage, or caches? Growth rate estimate — what does this look like in 6 months?
* **Third-party APIs:** New external service calls? Per-call pricing? Volume estimate? Rate limits that could become bottlenecks?
* **Data transfer:** Cross-region, cross-service, or client-download costs? Large payloads?
* **Background job cost:** New jobs that run on a schedule or in response to events? What's the steady-state cost vs. burst cost?
* **Cost scaling characteristics:** Does cost scale linearly with users, or is there a multiplier (e.g., per-user-per-day, per-event-per-integration)?
* **Cost monitoring:** Will you know when costs spike? New budget alerts or dashboards needed?

For each finding, classify: **NEGLIGIBLE** (no action) / **NOTABLE** (monitor) / **SIGNIFICANT** (needs budget approval or architectural mitigation).

**EXPANSION and SELECTIVE EXPANSION addition:**
* What would make this feature cost-efficient at 100x scale? Is there an architectural choice now that prevents expensive rework later?
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 9: Observability & Debuggability Review
New systems break. This section ensures you can see why.
Evaluate:
* Logging. For every new codepath: structured log lines at entry, exit, and each significant branch?
* Metrics. For every new feature: what metric tells you it's working? What tells you it's broken?
* Tracing. For new cross-service or cross-job flows: trace IDs propagated?
* Alerting. What new alerts should exist?
* Dashboards. What new dashboard panels do you want on day 1?
* Debuggability. If a bug is reported 3 weeks post-ship, can you reconstruct what happened from logs alone?
* Admin tooling. New operational tasks that need admin UI or rake tasks?
* Runbooks. For each new failure mode: what's the operational response?

**EXPANSION and SELECTIVE EXPANSION addition:**
* What observability would make this feature a joy to operate? (For SELECTIVE EXPANSION, include observability for any accepted cherry-picks.)
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 10: Deployment & Rollout Review
Evaluate:
* Migration safety. For every new DB migration: backward-compatible? Zero-downtime? Table locks?
* Feature flags. Should any part be behind a feature flag?
* Rollout order. Correct sequence: migrate first, deploy second?
* Rollback plan. Explicit step-by-step.
* Deploy-time risk window. Old code and new code running simultaneously — what breaks?
* Environment parity. Tested in staging?
* Post-deploy verification checklist. First 5 minutes? First hour?
* Smoke tests. What automated checks should run immediately post-deploy?

**EXPANSION and SELECTIVE EXPANSION addition:**
* What deploy infrastructure would make shipping this feature routine? (For SELECTIVE EXPANSION, assess whether accepted cherry-picks change the deployment risk profile.)
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 11: Long-Term Trajectory Review
*(Apply temporal depth — think in 5-10 year arcs. Apply classification instinct — which decisions here are one-way doors?)*
Evaluate:
* Technical debt introduced. Code debt, operational debt, testing debt, documentation debt.
* Path dependency. Does this make future changes harder?
* Knowledge concentration. Documentation sufficient for a new engineer?
* Reversibility. Rate 1-5: 1 = one-way door, 5 = easily reversible.
* Ecosystem fit. Aligns with ecosystem direction?
* The 1-year question. Read this plan as a new engineer in 12 months — obvious?

**EXPANSION and SELECTIVE EXPANSION additions:**
* What comes after this ships? Phase 2? Phase 3? Does the architecture support that trajectory?
* Platform potential. Does this create capabilities other features can leverage?
* (SELECTIVE EXPANSION only) Retrospective: Were the right cherry-picks accepted? Did any rejected expansions turn out to be load-bearing for the accepted ones?
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

### Section 12: Design & UX Review (skip if no UI scope detected)
*(Apply subtraction default — "as little design as possible." Apply design for trust — every interface decision builds or erodes user trust.)*
This is ensuring the plan has design intentionality, not a pixel-level audit.

Evaluate:
* Information architecture — what does the user see first, second, third?
* Interaction state coverage map:
  FEATURE | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL
* User journey coherence — storyboard the emotional arc
* Responsive intention — is mobile mentioned or afterthought?
* Accessibility basics — keyboard nav, screen readers, contrast, touch targets

**EXPANSION and SELECTIVE EXPANSION additions:**
* What would make this UI feel *inevitable*?
* What 30-minute UI touches would make users think "oh nice, they thought of that"?

Required ASCII diagram: user flow showing screens/states and transitions.
**STOP (Standard mode).** AskUserQuestion once per issue. Recommend + WHY. If no issues or fix is obvious, state what you'll do and move on — don't waste a question. Do NOT proceed until user responds. *(In Batched mode, accumulate findings and continue to the next section in the batch — present all questions at batch boundary. Break early on CRITICAL GAP.)*

## CRITICAL RULE — How to ask questions
* **One issue = one AskUserQuestion call.** Never combine multiple issues into one question.
* Describe the problem concretely, with file and line references.
* Present 2-3 options, including "do nothing" where reasonable.
* For each option: effort, risk, and maintenance burden in one line.
* **Map the reasoning to engineering preferences above.** One sentence connecting your recommendation to a specific preference.
* Label with issue NUMBER + option LETTER (e.g., "3A", "3B").
* **Escape hatch:** If a section has no issues, say so and move on. If an issue has an obvious fix with no real alternatives, state what you'll do and move on — don't waste a question on it. Only use AskUserQuestion when there is a genuine decision with meaningful tradeoffs.

**Anti-shortcut clause:** The Completion Summary, Readiness Verdict, and registries are the OUTPUT of an interactive review, not a substitute for one. Writing every finding into one big summary dump and calling ExitPlanMode without firing AskUserQuestion is the precise failure mode this workflow exists to prevent — the model explores all 12 sections, accumulates findings, and dumps them into a deliverable rather than walking the user through scope, mode, and tradeoffs. If you have ANY non-trivial finding in any section, the path from finding to ExitPlanMode goes THROUGH AskUserQuestion. Zero findings in every section is the only path that bypasses it. The same rule applies to scope expansion proposals (Step 0D): each opportunity is its own AskUserQuestion — never batched into a "here are the things I'd add" list. If you find yourself wanting to write the verdict and exit before asking, stop and call AskUserQuestion now — that's the bug, recognize it.

## Required Outputs

### "NOT in scope" section
List work considered and explicitly deferred, with one-line rationale each.

### "What already exists" section
List existing code/flows that partially solve sub-problems and whether the plan reuses them.

### "Dream state delta" section
Where this plan leaves us relative to the 12-month ideal.

### Error & Rescue Registry (from Section 2)
Complete table of every method that can fail, every exception class, rescued status, rescue action, user impact.

### Failure Modes Registry
```
  CODEPATH | FAILURE MODE   | RESCUED? | TEST? | USER SEES?     | LOGGED?
  ---------|----------------|----------|-------|----------------|--------
```
Any row with RESCUED=N, TEST=N, USER SEES=Silent → **CRITICAL GAP**.

### TODOS.md updates
Present each potential TODO as its own individual AskUserQuestion. Never batch TODOs — one per question. Never silently skip this step.

For each TODO, describe:
* **What:** One-line description of the work.
* **Why:** The concrete problem it solves or value it unlocks.
* **Context:** Enough detail that someone picking this up in 3 months understands the motivation, the current state, and where to start.
* **Effort estimate:** S/M/L/XL
* **Priority:** P1/P2/P3
* **Depends on / blocked by:** Any prerequisites or ordering constraints.

Then present options: **A)** Add to TODOS.md **B)** Skip — not valuable enough **C)** Build it now in this PR instead of deferring.

### Scope Expansion Decisions (EXPANSION and SELECTIVE EXPANSION only)
Expansion opportunities and delight items were surfaced and decided in Step 0D (opt-in/cherry-pick ceremony). Reference the decisions. Do not re-surface them here — list for completeness:
* Accepted: {list items added to scope}
* Deferred: {list items sent to TODOS.md}
* Skipped: {list items rejected}

### Diagrams (mandatory, produce all that apply)
1. System architecture
2. Data flow (including shadow paths)
3. State machine
4. Error flow
5. Deployment sequence
6. Rollback flowchart

### Stale Diagram Audit
List every ASCII diagram in files this plan touches. Still accurate?

### Completion Summary
```
  +====================================================================+
  |            DEEP PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | Mode selected        | EXPANSION / SELECTIVE / HOLD / REDUCTION     |
  | Pacing mode          | Standard / Batched                          |
  | Review context       | Git/PR / Plan document / Hybrid             |
  | System Audit         | [key findings]                              |
  | Step 0               | [mode + key decisions]                      |
  | Section 1  (Arch)    | ___ issues found                            |
  | Section 2  (Errors)  | ___ error paths mapped, ___ GAPS            |
  | Section 3  (Security)| ___ issues found, ___ High severity         |
  | Section 4  (Data/UX) | ___ edge cases mapped, ___ unhandled        |
  | Section 5  (Quality) | ___ issues found                            |
  | Section 6  (Tests)   | Diagram produced, ___ gaps                  |
  | Section 7  (Perf)    | ___ issues found                            |
  | Section 8  (Cost)    | ___ NEGLIGIBLE, ___ NOTABLE, ___ SIGNIFICANT|
  | Section 9  (Observ)  | ___ gaps found                              |
  | Section 10 (Deploy)  | ___ risks flagged                           |
  | Section 11 (Future)  | Reversibility: _/5, debt items: ___         |
  | Section 12 (Design)  | ___ issues / SKIPPED (no UI scope)          |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (___ items)                          |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| ___ methods, ___ CRITICAL GAPS              |
  | Failure modes        | ___ total, ___ CRITICAL GAPS                |
  | TODOS.md updates     | ___ items proposed                          |
  | Scope proposals      | ___ proposed, ___ accepted (EXP + SEL)      |
  | Diagrams produced    | ___ (list types)                            |
  | Stale diagrams found | ___                                         |
  | Unresolved decisions | ___ (listed below)                          |
  +====================================================================+
```

### Readiness Verdict

After completing the summary, issue one of:

* **READY TO IMPLEMENT** — No CRITICAL GAPs remain. All blocking questions resolved. Ship it.
* **READY WITH CONDITIONS** — No CRITICAL GAPs, but ___ non-blocking items should be addressed during implementation. List them as a numbered checklist.
* **NEEDS REWORK** — ___ CRITICAL GAPs remain. List each with: what's broken, what's needed to unblock. Do NOT proceed to implementation until these are resolved.

The verdict must be consistent with the data: if any row in the Failure Modes Registry shows `RESCUED=N, TEST=N, USER SEES=Silent`, the verdict cannot be READY TO IMPLEMENT.

### Unresolved Decisions
If any AskUserQuestion goes unanswered, note it here. Never silently default.

## Formatting Rules
* NUMBER issues (1, 2, 3...) and LETTERS for options (A, B, C...).
* Label with NUMBER + LETTER (e.g., "3A", "3B").
* One sentence max per option.
* After each section, pause and wait for feedback.
* Use **CRITICAL GAP** / **WARNING** / **OK** for scannability.
