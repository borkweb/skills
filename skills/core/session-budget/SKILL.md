---
name: session-budget
description: >
  Assess whether compacting or clearing the current session is worth it right now,
  then prepare a reinit-ready handoff that survives /clear. Not a threshold nag — it
  X-rays context composition (how much is stale vs. still load-bearing), which only
  the agent can see. Use when the user says "session budget", "should I compact",
  "should I clear", "is this session getting heavy", "token budget", invokes
  /session-budget, or when the budget hook requests a proactive assessment.
allowed-tools: [Bash, Read, Write]
---

# Session Budget

Decide whether this session should be compacted or cleared, and if so, hand the
next session a clean briefing. Size alone is never the reason — a large session
mid-thought should be left alone. The real question is **composition**: how much of
what you are carrying is dead weight.

## 1. X-ray the context

You already hold this whole conversation, so assess by introspection — do **not**
re-read the transcript. Report three things, briefly:

- **Reclaimable vs. load-bearing.** Roughly what fraction of current context is
  stale — finished sub-tasks, abandoned exploration, superseded tool output, large
  dumps no longer referenced — versus still live for the work ahead.
- **Seam.** Are you at a natural breakpoint, or mid-thought with interdependent
  state a lossy handoff would damage?
- **Size signal.** One cheap absolute measurement to ground the estimate, if a
  transcript path is available:

  ```bash
  wc -c "${CLAUDE_TRANSCRIPT_PATH:-/dev/null}" 2>/dev/null
  ```

  If unavailable, say so and rely on the composition estimate alone.

## 2. Give a verdict

Be honest, not agreeable. The user usually runs this *hoping* the answer is "yes,
compact" — don't reward that hope. **NOT YET is a common and correct answer**; give
it plainly when the context is still load-bearing. Skip filler ("good call",
"makes sense"). Commit to exactly one verdict and name the one thing that would
change it.

Pick one, with one sentence of reasoning:

- **NOT YET** — mostly load-bearing, or mid-thought. Stop; do not write a handoff.
- **COMPACT + REINIT** — large and substantially stale, at a seam; work continues.
- **CLEAR + REINIT** — next work is independent enough that even a compact carries
  dead weight; a full reset is cleaner. CLEAR is the most destructive option, so
  hold it to a higher bar than COMPACT — only when the next work is genuinely
  disjoint from the current thread.

## 3. On a REINIT verdict: write the handoff

Compose a handoff using the eight sections from the `handoff` skill, in this order
and with these exact headings: `# Handoff: <title>`, `## Goal`, `## Current state`,
`## Next steps`, `## Open questions / blockers`, `## Key context`, `## Pointers`,
`## Suggested skills`. Lead with intent and next steps; reference artifacts rather
than copying them; write `None.` for empty sections.

Prepend a YAML frontmatter summary so the reinit step can build its menu without
parsing the body. This frontmatter is a **strict, machine-read contract** —
`mailbox.mjs` parses it field-by-field. Emit exactly these four keys, each a single
non-empty line, and nothing else in the block. Stamp `written_at` with
`date '+%Y-%m-%d %H:%M'` and read the branch with `git branch --show-current || echo none`:

```
---
title: <same as the # Handoff: line — one line>
goal: <one line, same intent as ## Goal>
written_at: <date output>
branch: <git branch output, or "none" if detached>
---
```

Validate before writing: four keys, exact names, no blank or multi-line values.
Shorten a value rather than wrapping it, or the menu parser breaks.

All mailbox file operations live in the bundled `mailbox.mjs` (Node). **Run it;
never reimplement its logic here.** You don't need to know where it is: the
session-budget SessionStart hook injects a ready-to-use command into your context
at session start — a line beginning `[session-budget] Handoff mailbox CLI is` that
contains the exact `node "…/mailbox.mjs"` command. **Copy that `node "…"` fragment
verbatim and append your subcommand** — don't rebuild the path yourself.

Pick a writable temp path ending in `.md` — the helper **moves** it into the mailbox, so nothing is left behind. A cross-platform way to get one (works on Windows too, unlike `mktemp`):

```bash
node -e "const o=require('os'),p=require('path');process.stdout.write(p.join(o.tmpdir(),'handoff-'+Date.now()+'.md'))"
```

Write the full doc to that path with the Write tool, then store it by taking the
injected `node "…/mailbox.mjs"` command and appending `write "<temp path>"` (cwd
defaults to the project dir, so it is omitted):

```bash
# injected fragment + your args, e.g.:
node "/abs/path/to/mailbox.mjs" write "/tmp/handoff-1234567890.md"
```

## Modes

**Manual** (invoked by the user or `/session-budget`): give the verdict, and on a
REINIT verdict get an explicit go-ahead **before** writing the handoff. Then tell
the user it is staged and they can run `/clear` (CLEAR) or `/compact` (COMPACT).

**Proactive** (the budget hook injected a request to assess — the turn context will
say so): run the X-ray silently. If the verdict is **NOT YET, produce no output at
all** — stay invisible. Only on COMPACT + REINIT or CLEAR + REINIT: pre-write the
handoff immediately (no confirmation gate — the write is harmless and reversible),
then surface a short note — the verdict, one line of why, and "handoff staged; run
/clear (or /compact) when ready."

## Guardrails

- **You never run `/clear` or `/compact` yourself** — in either mode. You prepare;
  the user pulls the destructive trigger.
- Never write a handoff on a NOT YET verdict.
- In manual mode, never write without an explicit go-ahead. In proactive mode,
  pre-staging the handoff without confirmation is the expected behavior.
- Do not re-read the transcript to assess; introspect what you already hold.
- Don't read `mailbox.mjs`'s source unless it errors — it exists to be run.
