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

Optional, Claude Code only: `desk-board` adds a live board of `desk` runs (press a run to switch herdr to its tab). It is a separate plugin in the same marketplace.
```bash
/plugin install desk-board@skills
```

Choose one installation route per runtime. Installing the same skills both as a
plugin and in `.agents/skills` can produce duplicate entries. The Codex marketplace
is `.agents/plugins/marketplace.json`; this repository does not mirror the plugin
under `.agents/skills`.

Session-start hooks are silent when no handoffs are saved. When needed, they load a
pending session handoff after `/clear` or `/compact` (a new or resumed session only
gets its name) or list saved runs; helper paths are resolved when the
skill is invoked. After updating the plugin, start a fresh session to drop older
startup instructions already in the conversation.

## Quick Start

1. Run `/plan-session` — describe what you're building. It will reframe the problem before you write a line of code.
2. Run `/plan-deep-review` on any feature idea
3. Run `/plan-eng-review` on any plan
4. Run `/review` on any branch with changes
5. Run `/qa` on your staging URL

## Original and collected skills (`skills/core/`)

| Skill | Description |
|-------|-------------|
| **agents-md-lint** | Audits AI agent instruction files (AGENTS.md, CLAUDE.md, etc.) and removes facts discoverable from code alone to save context tokens. |
| **auto-scope** | Proactively scopes a coding task before implementation — names the handful of relevant files (read/edit these), the areas to leave alone, and open scope questions, so work doesn't start by reading the whole repo. Tool-agnostic discovery (grepika / graphify / grep); self-skips trivial or single-file work. |
| **caveman** | Ultra-compressed response mode that drops articles, filler, and hedging to cut tokens ~75% while preserving technical accuracy. Intensity levels: lite / full / ultra (and wenyan variants). |
| **complete** | Drives a goal with two or more slices to **merge-ready** through delegated builders, with frozen gates, an independent review per slice, a persistent ledger and a final integration review. Works from Claude Code (builders through `offload`) or Codex (native subagents). One slice goes to `offload`. Merges only when explicitly authorized. |
| **council** | Runs structured adversarial assessment of ideas, plans, and proposals through selected lenses, debate rounds, risk mapping, and a verdict. |
| **desk** | The run desk: a provider-agnostic coordinator for bork `do` runs. `runs.mjs` keeps a durable run record, needs-me questions, a claim/wait/ack run signal and a herdr launcher (`start`), so a Claude session (in a herdr tab or over Remote Control) can do the whole loop: start runs, wait without polling, relay each question to you verbatim and answer it. A Codex session inside its sandbox can `wait`, `show` and `ack`, and can `answer` only where it can write the runs home; it cannot `start` runs, and its `answer` cannot send the architect its pane line, so tell the user to continue in the architect's tab. Codex architects cannot be launched yet. State lives in `~/.agent-handoffs/runs/<run>/run.json`; `matt:orchestrator` keeps the backlog and Crew. An optional `desk-board` Claude Code plugin (`skills/core/desk/board`) shows runs live and takes you to a run's herdr tab. |
| **do** | Runs a coding task through the matching pipeline: land an existing change, ship a new goal, review a batch of PRs, or build a plan through `complete`. Steps run concurrently, handoffs stay lean and design questions go to `council`. |
| **dream** | Reads past `do`, `complete` and `offload` runs out-of-band and proposes add, merge, split or retire changes to the private review criteria, plus per-repo rules. It also rebuilds the Claude Code memory store of each repo those runs touched in a staged copy. Each pass builds an interactive report page in an ignored `output/dream/` (newest five kept) where you keep, revert or change every row; nothing applies by itself. |
| **discernment** | Assesses the evidence, uncertainty and failure conditions of a decision or claim. For calibration and high-stakes judgment checks. |
| **full-review** | Runs `review`, `review-security` and the running harness's own code review as three independent agents on one pinned scope, then merges them into one report with one landing verdict and risk tier. Report-only, and only when you ask for it. |
| **handoff** | Writes a handoff document so another agent or a fresh session can continue the work, preserving explicit overrides, authorization and pointers to live slice state. |
| **humanize** | Detects and removes AI writing patterns (inflated language, em dash overuse, rule of three, hollow rhythm punches, etc.) on inline text or a file path; rewrites files in place. |
| **layman** | Restates something in plain, succinct, jargon-free English — user-invoked only, never automatic. Bare `/layman` rewrites the assistant's previous message; also takes inline text or a file path. Returns just the plain version, always shorter than the source, with code, caveats, and numeric values preserved (big numbers abbreviated, never rounded). Optional sticky mode keeps every reply plain until told to stop. |
| **offload** | Architect-mode builder orchestration — the builder harness comes from an ordered, quota-aware failover chain in `~/.borkweb-skills/config.json` (codex/claude/opencode/pi/grok or a custom command). Reads session-keyed handoffs from `~/.agent-handoffs/offload/`, arbitrates builder disagreements, judges gate results against frozen criteria plus an independent `review` pass on each slice, specs the next one-PR slice, and dispatches a builder block into a new herdr tab (falls back to tmux, then Terminal, then headless). Every builder launch goes through `dispatch.sh`, and the ledger refuses a pane that did not come from it. The architect never writes implementation code; the human is the final judge. |
| **pr-review** | Comment-first wrapper around `review` for a GitHub PR — runs only when asked: `/pr-review <PR URL>`, or `do` with two or more PRs to review, which runs one lane per PR and confirms every post together. Adds an independent second pass in the other harness (Claude ↔ Codex) when the diff meets `review`'s independent-pass conditions, reuses CI results instead of rerunning tests, checks staleness against the base, and reviews only new commits on a re-run. Posts confirmed IMPORTANT findings, plus the NIT ones you pick, as one COMMENT review with line-anchored `suggestion` blocks in ASD-STE100 plain English. Never commits, pushes, approves, or requests changes. |
| **prototype** | Scaffolds a frontend prototype or a backend prototype with a disposable state machine to test an idea. |
| **red-pen** | Strict editorial reviewer applying Orwell's rules and Practical Typography. Catches passive voice, dead metaphors, straight quotes, wrong dashes, and other prose drift. |
| **review-security** | Deep security review grounded in 20 CVE-based pattern libraries (Heartbleed, Log4Shell, Next.js bypass, runc escape, xz backdoor, etc.). Callable standalone, as a reference from `review`, or as one of `full-review`'s three passes. |
| **session-budget** | X-rays context composition (stale vs. load-bearing), gives a compact/clear/leave-it verdict, and — only when a handoff would carry state not recoverable from disk/git — writes a reinit-ready handoff to a consume-once `~/.agent-handoffs/` mailbox. |
| **writing-commits** | Analyzes staged changes and generates conventional commit messages matching repository style. |
| **writing-plan-documents** (`skills/core/writing-plans/`) | Writes plan documents and product specs in ASD-STE100 Simplified Technical English — strips filler, bans inflated adjectives, requires structured decisions. Its `ste100.md` rules also govern `review` reports and PR bodies and comments. |
| **writing-sql** | Enforces strict vertical SQL formatting conventions for raw files, inline PHP, migrations, and framework query builders. |

## Gstack ports (`skills/gstack/`)

Workflow stack ported from gstack and adapted. Together the skills cover a full sprint:

Think → Plan → Build → Review → Test → Ship

Each skill feeds into the next. `plan-session` writes a design doc that `plan-deep-review` reads. `plan-eng-review` writes a test plan that `qa` picks up. `review` catches bugs before they land. Nothing falls through the cracks because every step knows what came before it.

| Skill | Specialist | Description |
|-------|------------|-------------|
| **design-consultation** | Design Partner | Design system consultation — proposes aesthetic, typography, color, layout, spacing, and motion as a coherent package. Generates font+color preview pages and writes DESIGN.md. |
| **design-review** | Designer Who Codes | Designer's eye QA on live sites. 10-category audit (~80 items), letter grades, AI slop detection. Fixes issues in source code with atomic commits and before/after verification. |
| **investigate** | Debugger | Systematic debugging with root cause investigation. Five phases: collect symptoms, pattern analysis, hypothesis testing, implementation, verification. Iron Law: no fixes without root cause. |
| **plan-deep-review** | Product Owner | Deep plan review with four modes (Scope Expansion, Selective Expansion, Hold Scope, Scope Reduction). Challenges premises, maps failure modes, reviews architecture/security/performance/deployment. |
| **plan-design-review** | Senior Designer | Designer's eye plan review. Rates design dimensions 0-10, explains what would make each a 10, then fixes the plan to get there. Covers info architecture, interaction states, user journey, AI slop risk, responsive, and accessibility. |
| **plan-devex-review** | Developer Advocate | DX plan review for developer-facing products (APIs, CLIs, SDKs, libraries, platforms, docs). Investigates persona, benchmarks competitors, designs magical moment, traces friction points, scores 8 DX dimensions 0-10. Three modes: DX EXPANSION / DX POLISH / DX TRIAGE. |
| **plan-eng-review** | Eng Manager | Eng manager-mode plan review. Locks in execution plan — architecture, data flow, diagrams, edge cases, test coverage, performance. Interactive with opinionated recommendations. |
| **plan-session** | Product Owner | Structured product design session — forces hard questions about demand, status quo, and narrowest wedge before proposing solutions. Produces a design doc, not code. |
| **qa** | QA Lead | Systematic QA testing with fix loop. Three tiers (Quick/Standard/Exhaustive), diff-aware mode, health scoring, framework-specific guidance. Fixes bugs atomically with before/after evidence. |
| **qa-only** | QA Reporter | Report-only QA testing — finds and documents bugs with screenshots and health scores but never fixes anything. Same modes and rubric as qa. |
| **review** | Staff Engineer | Pre-landing PR review. Findings rated important, nit or pre-existing for SQL safety, race conditions, LLM trust boundaries, enum completeness, and more. Reports a LOW, MEDIUM or HIGH risk tier with the human approvals it needs. Report-only by default; applies fixes only when asked or already authorized. |

## Commands

Skills get an auto-generated invocation from the host agent — these commands are the extras: aliases and compound workflows that don't map one-to-one to a single skill.

| Command | Description |
|---------|-------------|
| `/commit` | Alias for `writing-commits`. Checks for unstaged changes, optionally stages them, then crafts the message. |
| `/layman` | Alias for `layman`. Restates the previous message — or supplied text/file — in plain English. `/layman on` makes it stick until you say stop. |
| `/status` | Read-only branch status and workflow progress report. Shows what's been done, what's left, and suggests the next step. |
| `/pre-push` | Important-only review of the diff a push would send. Runs on request and reports SQL injection, auth gaps, race conditions, contract breaks and weakened gates. It never stops a push. |
| `/session-budget` | Alias for `session-budget`. Assesses whether to compact or clear and prepares a handoff only when one is worth it. |
| `/skills-audit` | Audits the installed skills for overlap, dead weight and stale instructions. |
| `/skills-refine` | Refines one skill from how it was actually used. |
| `/skills-suggest` | Audits recent sessions for repeated tasks and proposes skill candidates. |

## Agents

| Agent | Trigger | Description |
|-------|---------|-------------|
| **triage** | "production is broken", "urgent fix", "hotfix", "incident" | Emergency incident response. Triages severity, fast-tracks root cause investigation and builds a minimal hotfix in a new worktree. Stops at a verified local fix; commit, push and PR each need your word. |

## Hooks

The plugin wires four events in [`hooks/hooks.json`](hooks/hooks.json): `SessionStart` (session-budget and offload reinit notices, and a dream-pass reminder), `Stop` (offload refuses to stop while a judgment is owed), `PreToolUse` (a local skill-usage log) and `UserPromptSubmit` (throttled session-budget nudges and the same usage log).

## Credits

The repositories, articles and talks behind these skills are listed in [docs/inspirations.md](docs/inspirations.md).

## License

MIT
