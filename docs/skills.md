# Skill Deep Dives

Detailed guides for every team skill — philosophy, workflow, and examples.

| Skill | Your specialist | What they do |
|-------|----------------|--------------|
| [`/plan-session`](#plan-session) | **Product Owner** | Start here. Forcing questions that reframe your product before you write code. Challenges premises, generates alternatives. Design doc feeds into every downstream skill. |
| [`/plan-deep-review`](#plan-deep-review) | **Product Owner** | Rethink the problem. Find the 10-star product hiding inside the request. Four modes: Expansion, Selective Expansion, Hold Scope, Reduction. |
| [`/plan-eng-review`](#plan-eng-review) | **Eng Manager** | Lock in architecture, data flow, diagrams, edge cases, and tests. Forces hidden assumptions into the open. |
| [`/plan-design-review`](#plan-design-review) | **Senior Designer** | Interactive plan-mode design review. Rates each dimension 0-10, explains what a 10 looks like, fixes the plan. |
| [`/design-consultation`](#design-consultation) | **Design Partner** | Build a complete design system from scratch. Knows the landscape, proposes creative risks, generates realistic product mockups. |
| [`/review`](#review) | **Staff Engineer** | Find the bugs that pass CI but blow up in production. Auto-fixes the obvious ones. Flags completeness gaps. |
| [`/investigate`](#investigate) | **Debugger** | Systematic root-cause debugging. Iron Law: no fixes without investigation. Traces data flow, tests hypotheses, stops after 3 failed fixes. |
| [`/design-review`](#design-review) | **Designer Who Codes** | Live-site visual audit + fix loop. 80-item audit, then fixes what it finds. Atomic commits, before/after screenshots. |
| [`/qa`](#qa) | **QA Lead** | Test your app, find bugs, fix them with atomic commits, re-verify. Auto-generates regression tests for every fix. |
| [`/qa-only`](#qa-only) | **QA Reporter** | Same methodology as /qa but report only. Use when you want a pure bug report without code changes. |

### Commands

| Command | What it does |
|---------|-------------|
| [`/full-review`](#full-review) | Chains `/review` → `/design-review` → `/qa` with context passing. Combined ship-readiness verdict. |
| [`/preflight`](#preflight) | Fast pre-merge safety check. Critical-only review + smoke test. Under 2 minutes. |
| [`/status`](#status) | Read-only progress report. Where you are, what's done, what's next. |

### Agents

| Agent | What it does |
|-------|-------------|
| [workflow-orchestrator](#workflow-orchestrator) | Proactive pipeline navigator. Detects your stage and suggests next steps. |
| [triage](#triage) | Emergency incident responder. Fast-tracks investigation → fix → ship for production issues. |

### Hooks

| Hook | What it does |
|------|-------------|
| [pre-push](#pre-push) | Critical-only review gate before every push. Catches catastrophic bugs in under 30 seconds. |

---

## `/plan-session`

This is where every project should start.

Before you plan, before you review, before you write code — sit down and think about what you're actually building. Not what you think you're building. What you're *actually* building.

### The reframe

Here's what can happen. You say: "I want to build a daily briefing app for my calendar." Reasonable request. Then it asks about the pain — specific examples, not hypotheticals. You describe calendar items across multiple accounts with stale info, prep docs that are AI slop, events with wrong locations.

It comes back with: *"I'm going to push back on the framing. You said 'daily briefing app.' But what you actually described is a personal chief of staff AI."*

Then it extracts capabilities you didn't realize you were describing — watching calendars for stale info, generating real prep work, managing your CRM, prioritizing your time.

That reframe changes the entire project. You were about to build a calendar app. Now you're building something ten times more valuable — because the skill listened to your pain instead of your feature request.

### Premise challenge

After the reframe, it presents premises for you to validate. Not "does this sound good?" — actual falsifiable claims about the product. You agree, disagree, or adjust. Every premise you accept becomes load-bearing in the design doc.

### Implementation alternatives

Then it generates 2-3 concrete implementation approaches with honest effort estimates. Recommends the narrowest wedge because you learn from real usage.

### The design doc

The session ends with a design doc — and that doc feeds directly into `/plan-deep-review` and `/plan-eng-review`. The full lifecycle is: `plan-session → plan → implement → review → QA → ship`.

---

## `/plan-deep-review`

This is **founder mode**.

The point is not to implement the obvious ticket. The point is to rethink the problem from the user's point of view and find the version that feels inevitable, delightful, and maybe even a little magical.

### Example

Say you're building a listing app and you say:

> "Let sellers upload a photo for their item."

A weak assistant will add a file picker and save an image. That is not the real product.

In `/plan-deep-review`, the model asks whether "photo upload" is even the feature. Maybe the real feature is helping someone create a listing that actually sells.

Now it asks: Can we identify the product from the photo? Infer the SKU? Draft the title and description automatically? Pull specs and pricing comps? Suggest the best hero image? Detect when the photo is ugly or low-trust?

It does not just ask, "how do I add this feature?"
It asks, **"what is the 10-star product hiding inside this request?"**

### Four modes

- **SCOPE EXPANSION** — dream big. Every expansion is presented as an individual decision you opt into. Recommends enthusiastically.
- **SELECTIVE EXPANSION** — hold your current scope as the baseline, but see what else is possible. Neutral recommendations — you cherry-pick.
- **HOLD SCOPE** — maximum rigor on the existing plan. No expansions surfaced.
- **SCOPE REDUCTION** — find the minimum viable version. Cut everything else.

---

## `/plan-eng-review`

This is **eng manager mode**.

Once the product direction is right, you need a different kind of intelligence. Not more ideation. The model becomes your best technical lead — nailing architecture, system boundaries, data flow, state transitions, failure modes, edge cases, trust boundaries, and test coverage.

One surprisingly big unlock: **diagrams**. LLMs get way more complete when you force them to draw the system. Diagrams force hidden assumptions into the open. They make hand-wavy planning much harder.

### Example

Take the listing app example. `/plan-deep-review` already decided the real feature is a smart listing flow that uploads photos, identifies the product, enriches from the web, drafts title/description, and suggests the best hero image.

Now `/plan-eng-review` asks:

* What is the architecture for upload, classification, enrichment, and draft generation?
* Which steps happen synchronously, and which go to background jobs?
* What happens if upload succeeds but enrichment fails?
* How do retries work? How do we prevent duplicate jobs?
* What gets persisted when, and what can be safely recomputed?

Not "make the idea smaller." **Make the idea buildable.**

---

## `/plan-design-review`

This is your **senior designer reviewing the plan** — before you write a single line of code.

Most plans describe what the backend does but never specify what the user actually sees. Empty states? Error states? Loading states? Mobile layout? AI slop risk? These decisions get deferred to "figure it out during implementation" — and then an engineer ships "No items found." as the empty state because nobody specified anything better.

`/plan-design-review` catches all of this during planning, when it's cheap to fix.

It rates each design dimension 0-10, explains what a 10 looks like, then edits the plan to get there. Seven passes: information architecture, interaction state coverage, user journey, AI slop risk, design system alignment, responsive/accessibility, and unresolved design decisions.

### Example

```
You:   /plan-design-review

Claude: Initial Design Rating: 4/10

        "This plan describes a user dashboard but never specifies
         what the user sees first. It says 'cards with icons' —
         which looks like every SaaS template."

        Pass 1 (Info Architecture): 3/10
        → Added information hierarchy section to plan

        Pass 2 (Interaction States): 2/10
        "The plan has 4 UI features but specifies 0 out of 20
         interaction states (4 features × 5 states each)."
        → Added interaction state table to plan

        Pass 4 (AI Slop): 4/10
        → Rewrote UI descriptions with specific, intentional alternatives

        Overall: 4/10 → 8/10 after fixes
```

---

## `/design-consultation`

This is **design partner mode**.

`/plan-design-review` audits a plan that already exists. `/design-consultation` is for when you have nothing yet — no design system, no font choices, no color palette. You are starting from zero and you want a senior designer to build the whole visual identity with you.

It's a conversation, not a form. The agent asks about your product, your users, and your audience. It proposes a complete, coherent design system: aesthetic direction, typography (3+ fonts with specific roles), color palette with hex values, spacing scale, layout approach, and motion strategy. Every recommendation comes with a rationale.

But coherence is table stakes. The difference between a product that looks "nice" and one people actually recognize is the **deliberate creative risks**: the unexpected serif for headings, the bold accent nobody else in your category uses. `/design-consultation` proposes safe choices AND risks — and tells you which is which.

After you agree, it generates an interactive HTML preview page — realistic product pages rendered in your design system with light/dark mode. Then it writes `DESIGN.md` to your repo root.

### Example

```
You:   /design-consultation

Claude: From the README, this looks like a developer analytics dashboard.
        Sound right? Want me to look at what's out there first?

You:    Yes, it's for eng managers. Show me what's out there.

Claude: Here's the landscape. They all converge on clean sans-serifs
        and muted blue-gray palettes. The rest feel interchangeable.

        AESTHETIC: Industrial/Utilitarian — data-first
        TYPOGRAPHY: Geist (body), Instrument Serif (display), JetBrains Mono (data)
        COLOR: Restrained — slate neutrals, single teal accent (#0D9488)

        SAFE CHOICES: Geist for body, slate neutrals, grid-disciplined layout
        RISKS: Instrument Serif for display (nobody in dev tools uses a serif),
               single teal accent instead of blue, 4px compact density

You:    Love the serif risk. Let's see it.

Claude: Preview opened in your browser.
        [Realistic dashboard with sidebar, stat cards, data table]

You:    Ship it.

Claude: Wrote DESIGN.md. All future sessions will respect these choices.
```

---

## `/design-review`

This is **designer who codes mode**.

`/plan-design-review` reviews your plan before implementation. `/design-review` audits and fixes the live site after.

It runs an 80-item visual audit, then enters a fix loop: for each finding, it locates the source file, makes the minimal CSS/styling change, commits atomically, re-navigates to verify, and takes before/after screenshots. One commit per fix, fully bisectable.

### Example

```
You:   /design-review https://myapp.com

Claude: Design Score: C  |  AI Slop Score: D
        12 findings (4 high, 5 medium, 3 polish)

        Fixing 9 design issues...
        style(design): FINDING-001 — replace 3-column icon grid
        style(design): FINDING-002 — add heading scale
        style(design): FINDING-003 — remove gradient hero
        ...

        Final: Design Score: C → B+  |  AI Slop Score: D → A
        9 fixes applied (8 verified, 1 best-effort). 3 deferred.
```

---

## `/review`

This is **paranoid staff engineer mode**.

Passing tests do not mean the branch is safe. `/review` exists because there is a whole class of bugs that can survive CI and still punch you in production:

* N+1 queries, stale reads, race conditions
* Bad trust boundaries, missing indexes, escaping bugs
* Broken invariants, bad retry logic
* Tests that pass while missing the real failure mode
* Forgotten enum handlers — add a new status constant, and `/review` traces it through every switch statement and allowlist in your codebase

### Fix-First

Findings get action, not just listed. Obvious mechanical fixes (dead code, stale comments, N+1 queries) are applied automatically. Genuinely ambiguous issues (security, race conditions, design decisions) get surfaced for your call.

### Example

Suppose the smart listing flow is implemented and tests are green. `/review` should still ask:

* Did I introduce an N+1 query when rendering listing photos?
* Am I trusting client-provided file metadata instead of validating the file?
* Can two tabs race and overwrite cover-photo selection?
* Do failed uploads leave orphaned files in storage?
* If enrichment APIs partially fail, do I degrade gracefully or save garbage?

---

## `/investigate`

When something is broken and you don't know why, `/investigate` is your systematic debugger. It follows the Iron Law: **no fixes without root cause investigation first.**

Instead of guessing and patching, it traces data flow, matches against known bug patterns, and tests hypotheses one at a time. If three fix attempts fail, it stops and questions the architecture instead of thrashing.

---

## `/qa`

This is **QA lead mode**.

The most common use case: you're on a feature branch, you just finished coding, and you want to verify everything works. Just say `/qa` — it reads your git diff, identifies which pages and routes your changes affect, and tests each one. No URL required. No manual test plan.

Four modes:

- **Diff-aware** (automatic on feature branches) — reads the diff, identifies affected pages, tests them
- **Full** — systematic exploration of the entire app
- **Quick** (`--quick`) — 30-second smoke test
- **Regression** (`--regression`) — diff against a previous baseline

### Example

```
You:   /qa https://staging.myapp.com

Claude: [Explores 12 pages, fills 3 forms, tests 2 flows]

        QA Report: staging.myapp.com — Health Score: 72/100

        Top 3 Issues:
        1. CRITICAL: Checkout form submits with empty required fields
        2. HIGH: Mobile nav menu doesn't close after selecting an item
        3. MEDIUM: Dashboard chart overlaps sidebar below 1024px
```

---

## `/qa-only`

Same methodology as `/qa` but report-only — finds and documents bugs with screenshots and health scores but never fixes anything or touches source code. Use when you want a pure bug report without code changes.

---

## `/full-review`

The complete review pipeline in one command.

Instead of running `/review`, then `/design-review`, then `/qa` manually, `/full-review` chains all three with context passing between stages. Code review findings inform what to look for in design review. Design review findings inform QA testing priorities.

```
You:    /full-review http://localhost:3000

Claude: [runs code review — 2 auto-fixed, 1 asked]
        [runs design review on affected pages — grade B+]
        [runs QA on affected pages — 1 bug found and fixed]

        FULL REVIEW PIPELINE — SUMMARY
        ═══════════════════════════════
        Code Review:    3 issues (2 auto, 1 user)  — SAFE TO LAND
        Design Review:  4 issues, 3 fixed           — Grade B+
        QA:             1 bug found and fixed        — Health 92
        Ship readiness: READY
```

Accepts `--quick` and `--exhaustive` for QA tier, `--skip-design` and `--skip-qa` to omit stages.

---

## `/preflight`

The fast lane for small PRs.

`/full-review` is thorough but takes time. `/preflight` is the 2-minute version: critical-only code review (SQL injection, auth gaps, race conditions), a quick smoke test if a browser is available, and a test suite run.

It auto-escalates — if the diff is over 200 lines or touches sensitive files, it recommends `/full-review` instead.

```
You:    /preflight

Claude: PREFLIGHT CHECK
        ═══════════════
        Diff:              3 files, +22 -8
        Critical Review:   CLEAN
        Smoke Test:        CLEAN (3 pages checked)
        Tests:             PASS (142 tests)
        Verdict:           GO
```

---

## `/status`

Situational awareness in 10 seconds.

Read-only. Checks your branch state, PR status, which workflow skills have been run (detected from commit messages and project artifacts), and what's left before the work is shippable. Ends with specific next-step recommendations.

```
You:    /status

Claude: STATUS REPORT
        ═════════════
        Branch: feature/auth-flow → main (8 commits, +340 -120)
        PR:     #42 (draft, review pending, CI passing)

        WORKFLOW PROGRESS
        [✓] Plan session     [✓] Eng review
        [✓] Code review      [ ] QA
        [ ] Design review

        Next up: /qa — code is reviewed, time to test
```

---

## Workflow Orchestrator (agent)

A proactive agent that detects where you are in the pipeline and suggests the next step. It understands the full dependency graph between skills — that `/plan-session` feeds into `/plan-eng-review`, and that `/review` should come before `/qa`.

It triggers automatically when you complete a skill, finish writing code, or ask "what's next?" It never runs skills itself — it recommends.

---

## Triage (agent)

Emergency incident response. Activates when you say "production is broken," "urgent fix," or "hotfix."

Runs a structured triage: severity classification, blast radius assessment, timeline check. Then fast-tracks root cause investigation (checking recent deploys first — that's the cause 80% of the time). Creates the minimal fix on a hotfix branch, runs critical-only review, ships via emergency PR.

After the fix lands, outputs a monitoring checklist and recommends follow-up actions to prevent recurrence.

---

## Pre-Push Hook

A silent safety net. Runs the critical-only review checklist before every `git push` — SQL injection, auth bypasses, race conditions, API contract breaks. Under 30 seconds.

Smart enough to skip docs-only and test-only changes. Blocks the push if it finds something catastrophic. One line of output when clean.
