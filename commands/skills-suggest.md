---
name: skills-suggest
description: Audit recent sessions for repeated tasks and AI-output-then-manual-verification patterns. Produces a ranked list of skill candidates and a drafted SKILL.md for the top pick. Use when asked to "what should I turn into a skill", "suggest skills", "audit my prompts", or run periodically (weekly/monthly).
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Agent
---

# /skills-suggest — what should be a skill?

You are running the `/skills-suggest` command. The job is to read recent session transcripts and surface two kinds of skill candidates:

- **Repetition candidates** — tasks the user does over and over with a stable shape.
- **Generate-and-verify candidates** — tasks where the user reliably runs a manual check, lookup, or verification after an AI output. The skill replaces both steps: it generates the answer AND verifies it before returning.

Then draft a real SKILL.md for the strongest pick.

This is **read-only**. Never write a skill into the user's plugin directory. The drafted SKILL.md goes into chat for the user to decide.

---

## Step 0: Scope window

Default window: **last 30 days**. If `$ARGUMENTS` contains a window override (`--days N`, `--weeks N`, `--since YYYY-MM-DD`), parse and use it. Print the resolved window so the user knows what was scanned.

---

## Step 1: Discover transcripts

```bash
find ~/.claude/projects -name "*.jsonl" -mtime -30 2>/dev/null
```

Group by parent directory (each = one project). Count files per project. If the total is large (>500), keep only the top 15 projects by file count to keep the scan tractable.

If the result is empty, stop with: "No session transcripts found in the window."

---

## Step 2: Dispatch parallel scanners

Partition project buckets into at most three balanced groups. Dispatch one Agent subagent per group (`subagent_type: "general-purpose"`); each scans its assigned buckets sequentially and returns separate per-project sections.

> Scan the JSONL transcript files in `<project-dir>` modified after `<since-date>`. Each line is a JSON message; `role: "user"` lines are the user's prompts.
>
> Find two things:
>
> **A. Repetition clusters** — groups of user prompts that ask for the same kind of task. Treat near-duplicates (different wording, same intent) as the same cluster. Only report clusters with **3+ occurrences**. For each cluster: short label, count, 1-2 representative prompt excerpts (truncated to 100 chars), and the typical inputs/outputs.
>
> **B. Generate-and-verify pairs** — sequences where the assistant produced an answer (code, query, command, recommendation) and the user immediately responded with a manual check ("does this exist?", "run that", "let me grep", "I tested it, doesn't work"), a correction, or a re-prompt for verification. Report each pair with: what was generated, what the user verified, why the verification was needed (what could go wrong if skipped).
>
> Skip noise: greetings, status checks, single-word follow-ups, conversations under 3 messages.
>
> Output as compact markdown — one section per cluster/pair. Cap total output at 2KB per project. No commentary, no preamble.

Run the three or fewer subagents in parallel.

---

## Step 3: Aggregate and de-duplicate

When all subagents return, merge:

- **Repetition clusters across projects:** if the same task pattern appears in 3+ projects, weight it higher — it's a cross-cutting workflow, not a project-specific quirk.
- **Generate-and-verify pairs:** group by the *kind* of verification (existence check, type check, behavior check, security check, etc.). Pairs that recur across sessions point to a stable skill shape.

Drop candidates that are already covered by an existing skill. Read `~/.claude/plugins/cache/*/skills/*/SKILL.md` and `~/.claude/plugins/cache/*/skills/*/*/SKILL.md` and compare candidate intents against existing skill descriptions. If a candidate matches an existing skill's trigger description, mark it `[already covered]` and exclude it from the final picks.

---

## Step 4: Rank

Score each candidate 0-10 on:

| Dimension | What earns points |
|---|---|
| **Frequency** | More occurrences = higher. 3 occurrences = baseline; 10+ = max. |
| **Stability of shape** | Same inputs/outputs across runs = higher. Highly variable = lower. |
| **Judgment-to-mechanics ratio** | Mechanical steps wrapped in light judgment = ideal. Pure judgment = poor skill candidate (better as memory). Pure mechanics = better as a script. |
| **Pain delta** | How much manual work disappears? Verification skills score high here. |
| **Cross-project reuse** | Appears in 2+ projects = higher. |

Final score = average. Drop anything below 6/10. Surface the top 5-7.

---

## Step 5: Output

Produce a single report with the sections below, in order. Treat the templates as the literal shape — fill in real content, don't print the angle-bracket placeholders.

### Header
`# Skill Candidates — <date range>` followed by a line stating how many transcripts across how many projects were scanned.

### Repetition candidates section
One entry per candidate, ordered by score descending. Each entry includes: label and score (N/10), one-line pattern description, occurrence count and project count, 1-2 sample prompt excerpts, one-line "why a skill", one-line "skip if" describing what would disqualify it.

### Generate-and-verify candidates section
Same shape, but each entry includes: what the assistant generates, what the user verifies manually after, the failure mode that the verification catches, and occurrence count.

### Top pick
One-paragraph reasoning for why this is the pick. Then a **Drafted SKILL.md** subsection containing a real, ready-to-save SKILL.md file: YAML frontmatter (name, description with 3-5 trigger phrases, allowed-tools), a 2-3 sentence framing, a "When to trigger" bullet list with example prompts, a "Workflow" section with explicit Generate / Report steps, and an "Important rules" list. Present it inside a fenced code block so the user can copy-paste.

### Tool gap analysis
For the top pick, list:

- **CLIs that would help** — e.g., `ripgrep` for fast scanning, `gh` for GitHub, `jq` for JSON
- **MCP servers worth installing** — e.g., a database MCP if the verification is "check what's in the DB", `playwright` if it's "click through and confirm"
- **Scripts to add to `scripts/`** — if a deterministic helper would clean up the SKILL.md prose
- **Memory shapes** — facts the skill should read or write (per the auto-memory convention)

If a needed tool isn't installed, state plainly: "This skill needs X. Without it, the verification step falls back to <degraded mode>."

---

## Important rules

- **Read-only.** Never write into `~/.claude/plugins/`, never `git commit`, never create a skill file. The drafted SKILL.md goes in chat.
- **Parallel scanning is mandatory.** With hundreds of transcripts, sequential reads will blow context. Dispatch subagents in parallel.
- **Honest scoring.** If nothing scores 6+, say so. Don't manufacture skill candidates to fill the report. "Nothing surfaced this week" is a valid output.
- **Exclude already-covered.** A candidate that duplicates an existing skill is noise. Cite the existing skill by name when filtering.
- **One drafted SKILL.md per run.** Only the top pick gets a full draft. Listing 7 fully-drafted skills creates analysis paralysis. The user can re-run for the next one.
- **Tool gaps are part of the answer.** A skill that needs an uninstalled MCP server is still a valid suggestion — just flag it. Don't silently assume the user has every tool.
