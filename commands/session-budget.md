---
description: Assess whether to compact/clear this session and prepare a reinit-ready handoff
---

You are running the `/session-budget` command.

## Process

1. Invoke the `bork:session-budget` skill with the Skill tool, unless it is already loaded in this turn. Do not read or search for its SKILL.md file; the Skill tool loads the installed version.
2. Execute that skill's workflow in full.

## Notes

- This is an assessment first. If the verdict is NOT YET, stop without writing a handoff.
- Never compact or clear on the user's behalf — prepare the handoff and let the user run `/clear` or `/compact`.
