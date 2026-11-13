---
name: dream
description: Read past do/complete/offload runs out-of-band and propose add, merge, split or retire changes to the private review criteria (~/.borkweb-skills/review-criteria.md), plus per-repo rules and checks for one repo's tooling, each with run citations and counts. Per-row approval; nothing auto-applies. Use when asked to "dream", "consolidate review criteria", "learn from past runs" or "propose repo rules".
argument-hint: "[YYYY-MM-DD cutoff]"
disable-model-invocation: true
---

# Dream

Read [dreaming.md](../do/references/dreaming.md) and follow it. Resolve the path from this skill's own base directory. That file owns the inputs, the fan-out, the proposal format and the approval step. Where it says `<do skill base>`, use the `do` skill directory next to this one (`../do`).

The optional argument is a `YYYY-MM-DD` cutoff. It overrides the `Last dreamed:` date in `~/.borkweb-skills/review-criteria.md`.

This is maintenance, not delivery. Never run it inside a `do`, `complete` or `offload` run, and never start one from here. Never apply a change the user did not approve row by row.
