# skills

My Original and Collected skills, agents, commands, and hooks for Claude Code, Codex, and Gemini. Writing, reviewing, planning, QA, and shipping across the development cycle.

Skills are organized into two buckets:
- **`skills/core/`** — skills I wrote (or substantially extended from a small starting point)
- **`skills/gstack/`** — skills ported from upstream sources like [gstack](https://github.com/garrytan/gstack), then trimmed of upstream-specific infrastructure and adapted to local conventions

Personal voice and other private things live separately at [borkweb/skills-private](https://github.com/borkweb/skills-private).

## Install

Add via [skills.sh](https://skills.sh)
```bash
npx skills add borkweb/skills
```

Or as a Claude Code [plugin](https://code.claude.com/docs/en/plugins)
```bash
/plugin marketplace add https://github.com/borkweb/skills
/plugin install bork
```

## Quick Start

1. Run `/plan-session` — describe what you're building. It will reframe the problem before you write a line of code.
2. Run `/plan-deep-review` on any feature idea
3. Run `/plan-eng-review` on any plan
4. Run `/review` on any branch with changes
5. Run `/qa` on your staging URL
6. Run `/ship` to merge, run tests, and open the PR

## Original and collected skills (`skills/core/`)

| Skill | Description |
|-------|-------------|
| **agents-md-lint** | Audits AI agent instruction files (AGENTS.md, CLAUDE.md, etc.) and removes facts discoverable from code alone to save context tokens. |
| **auto-scope** | Proactively scopes a coding task before implementation — names the handful of relevant files (read/edit these), the areas to leave alone, and open scope questions, so work doesn't start by reading the whole repo. Tool-agnostic discovery (grepika / graphify / grep); self-skips trivial or single-file work. |
| **caveman** | Ultra-compressed response mode that drops articles, filler, and hedging to cut tokens ~75% while preserving technical accuracy. Intensity levels: lite / full / ultra (and wenyan variants). |
| **council** | Runs structured adversarial assessment of ideas, plans, and proposals through selected lenses, debate rounds, risk mapping, and a verdict. |
| **handoff** | Writes handoff documentation so agents can communicate with relevant context and pick up from an optimal place. |
| **humanize** | Detects and removes AI writing patterns (inflated language, em dash overuse, rule of three, hollow rhythm punches, etc.) on inline text or a file path; rewrites files in place. |
| **prototype** | Scaffolds a frontend prototype or a backend prototype with a disposable state machine to test an idea. |
| **red-pen** | Strict editorial reviewer applying Orwell's rules and Practical Typography. Catches passive voice, dead metaphors, straight quotes, wrong dashes, and other prose drift. |
| **review-security** | Deep security review grounded in 20 CVE-based pattern libraries (Heartbleed, Log4Shell, Next.js bypass, runc escape, xz backdoor, etc.). Callable standalone or as a reference from `review`. |
| **session-budget** | X-rays context composition (stale vs. load-bearing), gives a compact/clear/leave-it verdict, and — only when a handoff would carry state not recoverable from disk/git — writes a reinit-ready handoff to a consume-once `~/.agent-handoffs/` mailbox. |
| **writing-commits** | Analyzes staged changes and generates conventional commit messages matching repository style. |
| **writing-plans** | Applies concise writing style to plan documents — strips filler, bans inflated adjectives, requires structured decisions. |
| **writing-sql** | Enforces strict vertical SQL formatting conventions for raw files, inline PHP, migrations, and framework query builders. |

## Gstack ports (`skills/gstack/`)

Workflow stack ported from gstack and adapted. Together the skills cover a full sprint:

Think → Plan → Build → Review → Test → Ship

Each skill feeds into the next. `plan-session` writes a design doc that `plan-deep-review` reads. `plan-eng-review` writes a test plan that `qa` picks up. `review` catches bugs that `ship` verifies are fixed. Nothing falls through the cracks because every step knows what came before it.

| Skill | Specialist | Description |
|-------|------------|-------------|
| **autoplan** | Plan Pipeline | Auto-review pipeline. Chains plan-deep-review → plan-design-review → plan-eng-review → plan-devex-review at full depth, auto-deciding intermediate AskUserQuestion calls via 6 principles. Surfaces taste decisions and user challenges at one Final Approval Gate. |
| **design-consultation** | Design Partner | Design system consultation — proposes aesthetic, typography, color, layout, spacing, and motion as a coherent package. Generates font+color preview pages and writes DESIGN.md. |
| **design-review** | Designer Who Codes | Designer's eye QA on live sites. 10-category audit (~80 items), letter grades, AI slop detection. Fixes issues in source code with atomic commits and before/after verification. |
| **document-release** | Doc Editor | Post-ship documentation sync. Reads all project docs, cross-references the diff, auto-updates factual content, polishes CHANGELOG voice, cleans up TODOS, and optionally bumps VERSION. |
| **investigate** | Debugger | Systematic debugging with root cause investigation. Five phases: collect symptoms, pattern analysis, hypothesis testing, implementation, verification. Iron Law: no fixes without root cause. |
| **plan-deep-review** | Product Owner | Deep plan review with four modes (Scope Expansion, Selective Expansion, Hold Scope, Scope Reduction). Challenges premises, maps failure modes, reviews architecture/security/performance/deployment. |
| **plan-design-review** | Senior Designer | Designer's eye plan review. Rates design dimensions 0-10, explains what would make each a 10, then fixes the plan to get there. Covers info architecture, interaction states, user journey, AI slop risk, responsive, and accessibility. |
| **plan-devex-review** | Developer Advocate | DX plan review for developer-facing products (APIs, CLIs, SDKs, libraries, platforms, docs). Investigates persona, benchmarks competitors, designs magical moment, traces friction points, scores 8 DX dimensions 0-10. Three modes: DX EXPANSION / DX POLISH / DX TRIAGE. |
| **plan-eng-review** | Eng Manager | Eng manager-mode plan review. Locks in execution plan — architecture, data flow, diagrams, edge cases, test coverage, performance. Interactive with opinionated recommendations. |
| **plan-session** | Product Owner | Structured product design session — forces hard questions about demand, status quo, and narrowest wedge before proposing solutions. Produces a design doc, not code. |
| **qa** | QA Lead | Systematic QA testing with fix loop. Three tiers (Quick/Standard/Exhaustive), diff-aware mode, health scoring, framework-specific guidance. Fixes bugs atomically with before/after evidence. |
| **qa-only** | QA Reporter | Report-only QA testing — finds and documents bugs with screenshots and health scores but never fixes anything. Same modes and rubric as qa. |
| **review** | Staff Engineer | Pre-landing PR review. Two-pass analysis (critical + informational) for SQL safety, race conditions, LLM trust boundaries, enum completeness, and more. Fix-first: auto-fixes mechanical issues, asks about ambiguous ones. |
| **ship** | Release Engineer | Fully automated ship workflow: merge base, run tests, pre-landing review, plan completion audit, version bump, CHANGELOG, bisectable commits, push, create PR. |

## Commands

Skills get an auto-generated invocation from the host agent — these commands are the extras: aliases and compound workflows that don't map one-to-one to a single skill.

| Command | Description |
|---------|-------------|
| `/commit` | Alias for `writing-commits`. Checks for unstaged changes, optionally stages them, then crafts the message. |
| `/full-review` | Chains `review` → `design-review` → `qa` into one pipeline. Passes context forward between stages. Produces a combined ship-readiness verdict. `review-security` auto-inserts as Stage 2 when the diff touches security-sensitive code; force on with `--security` or off with `--no-security`. |
| `/preflight` | Fast pre-merge safety check. Critical-only code review + smoke test + quick test run. Under 2 minutes. For small PRs where `/full-review` is overkill. |
| `/status` | Read-only branch status and workflow progress report. Shows what's been done, what's left, and suggests the next step. |

## Agents

| Agent | Trigger | Description |
|-------|---------|-------------|
| **triage** | "production is broken", "urgent fix", "hotfix", "incident" | Emergency incident response. Triages severity, fast-tracks root cause investigation, creates minimal hotfix, ships via emergency PR. |

## Hooks

| Hook | Event | Description |
|------|-------|-------------|
| **pre-push** | Before `git push` | Runs critical-only review (SQL injection, auth gaps, race conditions) before any push. Blocks on critical issues. Under 30 seconds. |
| **post-merge** | After `git merge` on default branch | Non-blocking reminders: nudges about `/document-release` when API/config/schema files changed. Also flags missed VERSION bumps and open TODOS items. |

## Credits

- The Collected workflow stack is ported from [garrytan/gstack](https://github.com/garrytan/gstack) with YCombinator-specific bits genericized and then iterated on locally.
- `council` is based on @Devattom's [workflow-debate](https://github.com/Devattom/.claude/tree/main/skills/workflow-debate) skill.
- `handoff` and `prototype` are from @mattpocock.
- `humanize` originated from @blader's humanizer skill, with substantial extensions for the hand-cover diagnostic, hollow rhythm punches, and rewrite constraints.

## License

MIT
