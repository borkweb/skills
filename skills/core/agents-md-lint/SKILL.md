---
name: agents-md-lint
description: Audit and trim AI agent instruction files (AGENTS.md, CLAUDE.md, CONVENTIONS.md, .cursorrules, etc.) by testing which facts an AI agent can discover from code alone. Use when asked to lint, audit, optimize, prune, or trim any agent instruction file in a repository. Removes redundant documentation that wastes context tokens. Supports a dry-run mode that reports findings without modifying files.
model: sonnet
effort: medium
---

# agents-md-lint

Audit AI agent instruction files by spawning a blind sub-agent that tries to rediscover each documented fact from code search alone. Facts it finds easily → remove. Facts it can't → keep.

This works on any file whose purpose is to give an AI agent context about a codebase: AGENTS.md, CLAUDE.md, CONVENTIONS.md, .cursorrules, or similar. The workflow refers to these collectively as "instruction files."

## Modes

**Default (rewrite):** Produces a report and rewrites the instruction files with only the surviving facts.

**Dry-run:** Produces the report but does not modify any files. Use this when the user wants to see what would change before committing, or says things like "just show me," "report only," or "what's redundant." Ask which mode the user wants if it's ambiguous.

## Workflow

### 1. Discover and normalize instruction files

Scan the repo for instruction files. Common names: `AGENTS.md`, `CLAUDE.md`, `CONVENTIONS.md`, `.cursorrules`, `.github/copilot-instructions.md`. Ask the user if there are others, or if any should be excluded.

**CLAUDE.md → AGENTS.md normalization:** If a `CLAUDE.md` exists but no `AGENTS.md`, rename `CLAUDE.md` to `AGENTS.md` and create a symlink `CLAUDE.md → AGENTS.md`. This keeps `AGENTS.md` as the canonical name while preserving compatibility with tools that look for `CLAUDE.md`. If both files already exist as separate files, leave them as-is and audit each independently. Skip this normalization in dry-run mode.

### 2. Extract facts

Read each instruction file. List every distinct fact as a numbered item, grouped by file. A "fact" is any single claim, convention, instruction, or piece of context — e.g., "tests use vitest," "branch names follow feature/JIRA-123 format," "never mock the database in integration tests."

### 3. Chunk facts for testing

Sub-agents get unreliable when asked too many questions at once. If a file contains more than 25 facts, split them into batches of 20–25 and spawn a separate sub-agent for each batch. Each batch should be self-contained — include enough context in the prompt so the sub-agent understands the domain without needing to see the other batches.

### 4. Spawn blind reviewer(s)

For each batch of facts, spawn a sub-agent with this task template. The key insight here is that the sub-agent must not have access to the instruction files — it should rely only on what it can find by searching the code. Rather than renaming or moving files (which risks data loss if something goes wrong), tell the sub-agent explicitly which files to ignore:

```
You are reviewing the codebase at <REPO_PATH> to test what facts are easily
discoverable from code alone — without any documentation.

IMPORTANT: Do NOT read or search inside these files, as they are the
documentation being audited:
<list of instruction file paths to exclude>

For EACH question below, try to answer using code searches (grep, glob,
reading config/source files). Use up to 3-4 searches per question — check
multiple locations if the first search doesn't find it (e.g., config files,
source code, test files, CI configs). Answer briefly and rate your confidence:

- HIGH: Found clear, unambiguous evidence
- MEDIUM: Found partial or indirect evidence (e.g., an example exists but
  the convention isn't stated, or the fact is buried in a non-obvious place)
- LOW: Could not find evidence, or only found it after extensive digging

For MEDIUM answers, note WHERE you found the evidence and how many searches
it took. This helps distinguish "technically findable but practically buried"
from "right there in the config."

QUESTIONS:
<numbered list of questions, one per extracted fact>
```

Use Sonnet or equivalent for reliable results without defaulting to the highest-cost model.

### 5. Score results

Compare each sub-agent's answers against the original facts. The scoring accounts for both correctness and practical discoverability — a fact that's technically in the code but requires insider knowledge to find is still worth documenting.

| Agent confidence | Agent correct? | Verdict |
|-----------------|----------------|---------|
| HIGH | Yes | **Remove** — easily discoverable |
| HIGH | Partially | **Keep** the missing detail only |
| MEDIUM | Yes | **Keep** — findable but buried; an agent without docs would likely miss it or waste time searching |
| MEDIUM | Partially | **Keep** — not reliably found |
| LOW | — | **Keep** — not discoverable |

### 6. Present results

Show a summary table:

```
| # | Fact | Confidence | Correct? | Verdict |
|---|------|-----------|----------|---------|
| 1 | Uses vitest for testing | HIGH | Yes | Remove |
| 2 | Branch naming: feature/JIRA-### | LOW | No | Keep |
| 3 | Auth middleware in src/middleware/auth.ts | MEDIUM | Yes | Keep (buried) |
```

Report: total facts, removed count, kept count, line reduction percentage.

**If dry-run mode:** Stop here. Do not modify any files.

### 7. Rewrite the files (default mode only)

Rewrite each instruction file with only the surviving facts. Principles:

- Every line must earn its tokens
- No headers or sections with a single bullet (inline it)
- Don't repeat what's in CONTRIBUTING.md, README.md, or config files
- Group related facts naturally
- Preserve the original file's voice and structure where possible — this is a trim, not a rewrite from scratch

## Tips

- For monorepos with multiple instruction files, test each file separately — a fact might be discoverable in one subproject's context but not another's
- Facts about *conventions* (naming rules, branch patterns) are usually NOT discoverable even if examples exist in git history — keep them
- Facts about *auth mechanisms* are often buried in middleware — usually worth keeping
- Facts about *known gotchas* (e.g., "use --forceExit," "don't mock the DB") are almost never discoverable — keep them
- Facts about *file locations* ("tests live in __tests__/") are often easily discoverable from directory structure — good candidates for removal
- When in doubt, keep the fact. The cost of a missing instruction (agent does the wrong thing) is higher than the cost of a few extra context tokens
