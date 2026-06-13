# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This repository contains custom Claude Code extensions including agents, skills, hooks, and commands for enhancing Claude Code workflows. It is designed as a plugin library to be installed and used across different projects.

## Architecture Overview

### Directory Structure

- **agents/**: Specialized agent configurations that handle domain-specific tasks
  - Each agent is defined in a markdown file with YAML frontmatter
  - Agents can be launched via the Task tool to handle complex workflows
  - Include descriptions, tool access, and specialized prompts

- **skills/**: Reusable skill packages invoked via the Skill tool
  - Skills are lightweight, focused capabilities
  - Located in individual subdirectories with SKILL.md files
  - Currently includes: writing-commits

- **hooks/**: Event-driven shell commands (currently placeholder)

- **commands/**: Custom slash commands that route to plugin skills and compound workflows

- **.claude-plugin/**: Plugin metadata and configuration
  - Contains plugin.json with package information

## Agents Architecture

Agents are markdown files with YAML frontmatter defining:
- `name`: Agent identifier
- `description`: Detailed description including auto-invocation triggers
- `tools`: Available tools (Bash, Read, Grep, Glob, etc.)
- `proactive`: Whether agent should be auto-invoked
- `color`: UI color coding
- `model`: Optional model override (e.g., opus)

### Available Agents

1. **triage** (proactive)
   - Emergency incident response for production issues and urgent bugs
   - Auto-invoked on: "production is broken", "urgent fix", "hotfix", "incident"
   - Fast-tracks triage → root cause → minimal fix → emergency PR
   - Coordinates `/investigate`, `/review`, `/ship` in emergency mode

## Skills Architecture

Skills are invoked via the Skill tool with just the skill name (no arguments). When invoked, the skill's SKILL.md prompt expands into the conversation.

### Available Skills (bork plugin)

Skills are organized into two buckets under `skills/`:

**`skills/core/`** (my Original) — skills I wrote or substantially extended:
- **writing-commits** — Crafts conventional commit messages by analyzing git diffs and history. Follows Conventional Commits, adapts to repo style, suggests splitting commits across concerns.
- **writing-sql** — Enforces vertical SQL formatting for raw files, inline PHP, migrations, and framework query builders. No exceptions for short queries.
- **writing-plans** — Concise writing style for plan documents. Strips filler, bans inflated adjectives, requires structured decisions.
- **agents-md-lint** — Audits AI agent instruction files and removes facts discoverable from code.
- **auto-scope** — Proactively scopes a coding task before implementation: names the relevant files, the areas to leave alone, and open scope questions. Tool-agnostic discovery (grepika/graphify/grep); self-skips trivial or single-file work.
- **caveman** — Ultra-compressed response mode. Drops articles, filler, and hedging to cut tokens ~75%; intensity levels lite/full/ultra (plus wenyan variants).
- **council** — Structured adversarial assessment with lenses, debate rounds, risk mapping, verdict.
- **handoff** — Writes handoff documentation for picking up where you left off.
- **humanize** — Detects and removes AI writing patterns (inflated language, em dash overuse, hollow rhythm punches, etc.) on text or files in place.
- **prototype** — Scaffolds a frontend prototype or a backend prototype with a disposable state machine.
- **red-pen** — Strict editorial reviewer applying Orwell's rules and Practical Typography.
- **review-security** — Deep security review grounded in 20 CVE-based pattern libraries (Heartbleed, Log4Shell, Next.js bypass, runc escape, xz backdoor, etc.). Callable standalone or as a reference from `/review`.
- **session-budget** — X-rays context composition (stale vs. load-bearing), gives a compact/clear/leave-it verdict, and — only when a handoff would carry state not recoverable from disk/git — writes a reinit-ready handoff to a consume-once `~/.agent-handoffs/` mailbox that the next session auto-loads after `/clear`. Node-based and zero-config: ships plugin hooks (`hooks/hooks.json`) — a SessionStart hook that auto-loads pending handoffs and advertises the mailbox CLI, plus a UserPromptSubmit hook for proactive budget nudges — that activate on install with no setup step. (Claude Code; Codex hook support TBD.)
- **offload** — Architect-mode codex orchestration. Reads session-keyed handoffs from `~/.agent-handoffs/offload/`, arbitrates builder disagreements, judges gate results against frozen criteria, specs the next one-PR slice, and dispatches a builder block into a new tmux window (falls back to Terminal, then headless). The architect never writes implementation code; the human is the final judge.

**`skills/gstack/`** (Collected) — workflow stack ported from gstack:

See [README.md](README.md) for the full list: plan-session, plan-deep-review, plan-eng-review, plan-design-review, plan-devex-review, autoplan, design-consultation, review, investigate, design-review, qa, qa-only, ship, document-release.

### Available Commands (bork plugin)

Skill entrypoints: commit, handoff, humanize, offload, prototype, session-budget, plan-session, plan-deep-review, plan-eng-review, plan-design-review, plan-devex-review, autoplan, review, review-security, qa, qa-only.

Compound workflows: full-review (review → design-review → qa, with optional --security stage), preflight (fast pre-merge safety check), status (branch progress report).

### Available Agents (bork plugin)

- **triage** (proactive) — Emergency incident response, fast-tracks investigation → fix → ship

### Available Hooks (bork plugin)

- **pre-push** — Critical-only review gate before pushes (SQL injection, auth gaps, race conditions)
- **post-merge** — Non-blocking reminders after merging to default branch (doc updates, missed VERSION bumps, open TODOS)
- **offload-reinit** (SessionStart) — surfaces persistent codex-builder handoffs from `~/.agent-handoffs/offload/` for reattach

## Development Workflow

### Installing the Plugin

```bash
# The setup.sh script is currently empty, so manual installation is required
# Copy or symlink this directory to your Claude Code plugins directory
```

### Creating New Agents

1. Create a new markdown file in `agents/`
2. Add YAML frontmatter with required fields
3. Write the agent prompt defining expertise and behavior
4. Test by invoking with Task tool

### Creating New Skills

1. Create a subdirectory in `skills/`
2. Add SKILL.md with YAML frontmatter
3. Define allowed tools and skill behavior
4. Document usage patterns and examples

## Key Design Patterns

### Agent Invocation
Agents are context-aware and can auto-invoke based on user intent. For proactive agents, Claude Code should detect trigger phrases and automatically launch the appropriate agent.

### Tool Access
Agents specify which tools they can use (Bash, Read, Grep, Glob, WebFetch, Task, etc.). This ensures agents have appropriate capabilities for their domain.

### Separation of Concerns
- Agents handle complex, multi-step workflows
- Skills provide focused, reusable capabilities
- Hooks respond to specific events
- Commands provide custom slash command behavior

## Plugin Metadata

- **Name**: claude-utilities
- **Version**: 1.0.0
- **License**: MIT
- **Repository**: https://github.com/borkweb/claude-utilities
