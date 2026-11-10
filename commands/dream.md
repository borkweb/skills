---
name: dream
description: Read past do/complete/offload runs out-of-band and propose add, merge, split or retire changes to review-criteria.md, plus per-repo rules and checks for one repo's tooling, each with run citations and counts. Per-row approval; nothing auto-applies. Use when asked to "dream", "consolidate review criteria", "learn from past runs" or "propose repo rules".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - Skill
---

# /dream — consolidate review criteria, repo rules and checks from past runs

Invoke the `do` skill with `dream $ARGUMENTS`. Its route table sends this to `references/dreaming.md`, resolved from the skill's own base directory, which owns the inputs, the fan-out, the proposal format and the approval step.

`$ARGUMENTS` — optional. A `YYYY-MM-DD` cutoff that overrides the `Last dreamed:` date in `review-criteria.md`.

Never run this inside another `do`, `complete` or `offload` run. Never apply a change the user did not approve row by row.
