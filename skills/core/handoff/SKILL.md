---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
model: sonnet
effort: low
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Create the target path with `f=$(mktemp -t handoff) && mv "$f" "$f.md" && echo "$f.md"` so it ends in `.md` on both macOS and Linux (read the file before you write to it).

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## Document structure

The handoff is read by another agent, so its shape is fixed. Produce exactly these eight sections, in this order, with these headings verbatim. Lead with intent and next steps, not narrative history — a fresh agent should scan top to bottom and start working.

1. `# Handoff: <short title>` — one line naming the work.
2. `## Goal` — what the next session is trying to accomplish, in 1–2 sentences. If args were passed, this reflects them.
3. `## Current state` — what's done and working right now. Bullets, past tense.
4. `## Next steps` — the concrete actions to take next, ordered, each an imperative ("Wire up X", "Run Y"). The most important section: make it actionable from a cold start.
5. `## Open questions / blockers` — unresolved decisions, things waiting on someone, known risks.
6. `## Key context` — the non-obvious things: decisions made and why, gotchas, dead ends already ruled out. Skip anything a fresh agent could read straight from the code or the linked artifacts.
7. `## Pointers` — paths and URLs to the artifacts that hold the detail: PRDs, plans, ADRs, issues, branches, key files (`path:line`). Reference them; don't copy their contents in.
8. `## Suggested skills` — which skills the next session should use, if any, and for what.

## Rules

- Don't duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead — that's what **Pointers** is for.
- Before writing the file, validate the draft against the structure above: all eight headings present, named exactly, in order, and **Next steps** genuinely actionable from a cold start. Fix anything that doesn't conform rather than shipping a malformed doc.
- If a section has no real content, write `None.` under it rather than padding with filler or inventing items to fill space. An empty **Open questions** is fine; a fabricated one is not.
- Keep it tight. A handoff is a launchpad, not a transcript.
