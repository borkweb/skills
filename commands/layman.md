---
description: Restate something in plain, succinct, jargon-free English
---

You are running the `/layman` command.

## Arguments

- `$ARGUMENTS` — optional. Text to restate, a file path to read and restate, `on` to enter sticky plain-language mode, or `off`/`stop` to leave it. Empty means restate your immediately preceding message.

## Process

1. Invoke the `bork:layman` skill with the Skill tool, unless it is already loaded in this turn. Do not read or search for its SKILL.md file; the Skill tool loads the installed version.
2. Execute that skill's workflow in full.
3. Resolve `$ARGUMENTS` per that skill's "Resolving the Input" section.

## Notes

- Return the plain version only — no preamble, no side-by-side, no glossary.
- The result is always shorter than the source.
- This command never edits files. For rewriting a document in place, use `/humanize` or `/red-pen`.
