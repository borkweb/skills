---
name: dream
description: Read past do/complete/offload runs out-of-band and propose add, merge, split or retire changes to the private review criteria (~/.borkweb-skills/review-criteria.md), plus per-repo rules and checks for one repo's tooling, each with run citations and counts. Also curates the Claude Code memory store of each repo those runs touched (merge duplicates, replace stale notes, add missed lessons) in a staged copy. Builds an interactive report page where the user keeps, reverts or changes each row; nothing auto-applies. Use when asked to "dream", "consolidate review criteria", "learn from past runs", "propose repo rules" or "clean up memory".
argument-hint: "[YYYY-MM-DD cutoff] [memory focus]"
disable-model-invocation: true
---

# Dream

Read [dreaming.md](../do/references/dreaming.md) and follow it. Resolve the path from this skill's own base directory. That file owns the inputs, the fan-out, the proposal format and the approval step. Where it says `<do skill base>`, use the `do` skill directory next to this one (`../do`).

The pass also finds what escaped after merge (reverts, fix-forwards, review defects and failing post-merge checks) and proposes each as an escape row. An approved row records it with `runs.mjs escape`, one row at a time; nothing else in a run directory is written.

The pass also curates the Claude Code auto memory of each repo with a run in scope: [dream-memory.md](../do/references/dream-memory.md) owns that step. It builds a new copy of the store in the dream run directory and never edits the live store in place. The copy replaces the store only with the changes the user kept.

Every pass ends in a report page: [report.md](report.md) owns it. The user decides each row there (Keep, Revert, or Change it with a comment), and the page is rebuilt with the outcomes and opened when the pass ends. Reports stay in the invoking repo's ignored `output/dream/`, newest five only, and are never committed.

The offload SessionStart hook reminds the user when a pass is due (over 14 days since `Last dreamed:`, or five runs changed since); it never starts one.

The optional argument is a `YYYY-MM-DD` cutoff. It overrides the `Last dreamed:` date in `~/.borkweb-skills/review-criteria.md`. Any text after it is a focus for the memory step, such as "focus on review preferences; keep the project notes unchanged".

This is maintenance, not delivery. Never run it inside a `do`, `complete` or `offload` run, and never start one from here. Never apply a change the user did not approve row by row.
