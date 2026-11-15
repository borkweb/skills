# Inspirations

These are the outside repositories, articles, talks and references that shaped this skill library. They are only part of the story. Most of this library comes from my own iteration, tweaking and research, built on years of engineering and leadership experience.

## My own work

- **Iteration on real runs.** Most rules here exist because something went wrong in one of my runs. I fixed the skill, ran it again, and kept tweaking until the failure stopped. The repo's history holds well over a hundred of these fixes and features.
- **Reworking what I borrowed.** Every ported skill has been rewritten well past its starting point. Upstream infrastructure was removed, conflicting rules were dropped, and the skills were changed to fit how I work: report-only review, batched questions, frozen gates and plans that never get committed.
- **Research before adoption.** Each source below was read end to end and compared with this repo, line by line, before anything was taken. Most of what I read was left out on purpose, and the reasons are recorded in the commits that shipped the rest.
- **Measurement.** Run ledgers, eval cases and dreaming over past runs tell me whether a change helped, so the skills keep improving from evidence and not only from new sources.

When a source was read at a specific version, the entry names that version and the release that shipped what I took from it. Later upstream changes have not been reviewed unless noted.

## Skills that started from someone else's work

| Source | What came from it |
|--------|-------------------|
| Garry Tan's [gstack](https://github.com/garrytan/gstack) | The workflow stack under `skills/gstack/` (plan reviews, `review`, `investigate`, `qa`, design reviews). Ported with upstream-specific infrastructure removed, then reworked locally. Re-synced against upstream v1.91.186.0 on 2026-10-24: 17 of 71 candidate rules adopted in 3.19.0, including Gate Integrity, the sideways sweep, the test value bar, plan text as data, QA surface selection and the flake recipes. `plan-devex-review` uses upstream's [agent-ready error contract](https://github.com/garrytan/gstack/blob/main/docs/agent-ready-errors.md). |
| [Devattom/.claude `workflow-debate`](https://github.com/Devattom/.claude/tree/main/skills/workflow-debate) | The starting point for `council`. |
| [mattpocock/skills](https://github.com/mattpocock/skills) and the [AI Hero skill docs](https://aihero.dev/skills) | `handoff` and `prototype`. A later read (HEAD `4ae2317`, 2026-11-09) added the per-criterion base check before gates freeze in `offload`, and a red command for each corrective blocker plus the loop gate in `investigate`. |
| [blader/humanizer](https://github.com/blader/humanizer) | The starting point for `humanize`, since extended with the hand-cover diagnostic, hollow rhythm punches and rewrite constraints. |
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | The terse response mode in `caveman`, including its intensity levels. |

## Rules adopted from other agent toolkits

Each of these was read end to end and compared with this repo. Only the rules listed here were taken. The rest of each toolkit was left out on purpose, usually because it conflicted with report-only review, batched questions, or frozen gates.

| Source | Read at | What came from it | Shipped |
|--------|---------|-------------------|---------|
| Kun Chen's [firstmate](https://github.com/kunchenguid/firstmate) | July 2026 | Config-driven dispatch rules with an ordered failover chain of builder harnesses (`offload/harness.mjs`), and the interactive launch templates for codex, claude, opencode, pi and grok in `offload`'s dispatch script, ported from firstmate's verified adapters. | 2.14.0 |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | v5.3.2, `09c434a` | The smallest-complete-change ladder and the one-test-where-logic-needs-one rule in builder briefs, a `Not checked` line in builder reports, an assumed-load line in `review`, `writeSync` before exit in plugin hooks, and a frozen-phrase canary in `scripts/validate-skills.rb`. | 3.20.0 |
| [alibaba/open-code-review](https://github.com/alibaba/open-code-review) | `375f64c` | A per-file coverage ledger in `review` and `pr-review`, and the rule that a merged finding may be dropped only when the diff proves it wrong, with protected subjects that are demoted, never discarded. | 3.25.0 |
| [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) | `fb5548f` | Giving the author, not only the reviewer, the sharpest rules: the test bar and evidence line in the builder brief, four builder self-checks, frozen criteria reaching the builder intact, a builder replay eval from real rejections, and per-repo rule packs. | 3.37.0 |
| Lauren Tan's (poteto) [pstack](https://github.com/cursor/plugins/tree/main/pstack) | `cursor/plugins@3dbd22f` | Prose rules that keep failing escalate into checks with a named enforcer (from `/correct`). Re-verification scales with the size of the change, and a gate result survives a rebase when the `git patch-id` is unchanged. A lint checks every ruling against the frozen criteria. Builds do one unit first, then fan out (from the Orchestrate playbook). Review blocks only on what it can show, names the one fact a change is safe because of and proves it (from `blast-radius`), and follows stricter proof rules for runtime checks. Also a typed PR-state watcher, a fixed land order, and a spec reviewer that reads history first (from `/why`). | 3.42.0 |

## Articles and talks

| Source | What came from it | Shipped |
|--------|-------------------|---------|
| Thariq Shihipar, [Lessons from building Claude Code: How we use skills](https://claude.dev/blog/lessons-from-building-claude-code-how-we-use-skills) (2026-06-03) | Growing skills from gotchas found in real failures: per-skill `gotchas.md` fed by dreaming, a skill usage log that `skills-audit` reads, descriptions written as triggers, product verification in the spec review, on-demand hooks in `offload`, and eval cases before trimming large skills. | 3.38.0–3.39.1 |
| Lamis (Anthropic Applied AI), [Context Engineering, Memory Systems, and Dreaming](https://tessl.io/registry/ainativedev/aidevcon-2026-ldn/files/talk-lamis-context-engineering-dreaming/transcript.md), AI Native DevCon 2026 London | Memory as versioned files, compare-before-write updates, and out-of-band "dreaming" over past runs: the `dream` skill, per-class sources in review criteria, and ledger reports that cite the run they came from. | 3.31.0 |
| Simon Maple (Tessl), [Lessons From Running Tessl's Software Factory](https://www.youtube.com/watch?v=v-0JZTX7Kzg) | Run and round caps, a human halt that every loop obeys, operational authority, and the rule that tests need a source of truth: the `offload` round cap, `handoff.mjs halt`, and the builder's `Loosened tests:` line. | 3.31.0 |
| Lauren Tan (poteto), [All Code Is Slop (Except Mine)](https://www.youtube.com/watch?v=O_zcc6Xl12g), AI Engineer | Turning each correction into a deterministic check instead of another prose rule. Every review-only rejection records whether a check could have caught it. Dreaming accepts a cheap local check after one run and retires the prose rule it covers. Escapes found after merge are counted. This repo gained its own test-all script, a CI workflow and a property test for the ledger and handoff, and comments that justify a workaround became a review lead. | 3.42.0 |
| Lydia Hallie (Anthropic), [Rethinking Claude Code Best Practices](https://www.youtube.com/watch?v=vlfCjWuv4es), AI Engineer | Turning each step a human used to do into a guarantee somewhere else. `handoff.mjs ready` runs the fast local gates itself at HEAD and refuses on a red result, and Claude builders get a Stop hook that exits 2 so a failing gate sends them back to fix it. The always-loaded instructions were audited for current models: keep only what the code cannot show, drop the shouting, and trim the largest skills behind the replay eval. Auto mode's trusted environment is now scoped per project. | Next release |

## Standards and reference material

- **[ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/).** The writing rules in `skills/core/writing-plans/ste100.md`, also used for `review` findings and `pr-review` comments.
- **[Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)**, maintained by [WikiProject AI Cleanup](https://en.wikipedia.org/wiki/Wikipedia:WikiProject_AI_Cleanup). The pattern catalog behind `humanize`.
- **Public security audits and CVE research.** The 20 pattern files in `skills/core/review-security/patterns/` are built from published audits and fuzzing work, including [OSTIF](https://ostif.org/) audit reports, NCC Group and Trail of Bits audits, [OSS-Fuzz](https://github.com/google/oss-fuzz), [syzkaller](https://syzkaller.appspot.com/), [Rudra](https://github.com/sslab-gatech/Rudra) and Chromium's [IPC security tips](https://chromium.googlesource.com/chromium/src/+/main/docs/security/ipc-security-tips.md). Most pattern files cite the specific audits or CVEs they draw on.

## Studied, not adopted

These were read and compared, but nothing from them shipped.

- **[google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model)** (`3d0b348`). A context-rich author with zero-context reviewers. Its pipeline answers a different question from this repo's, and it publishes no efficacy data. A zero-context reviewer agent and an isolation probe remain open ideas.
