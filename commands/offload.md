---
description: Architect mode — offload implementation to a watchable builder harness (config-driven), judge results against frozen gates
---

You are running the `/offload` command.

## Process

1. Invoke the `bork:offload` skill with the Skill tool, unless it is already loaded in this turn. Do not read or search for its SKILL.md file; the Skill tool loads the installed version.
2. Execute that skill's workflow in full for one architect turn.

## Notes

- You are the ARCHITECT; you never write implementation code.
- Always produce the paste-ready builder block; dispatching the builder is opt-in and
  runs full-auto in the repo — confirm before launching.
- The session handoff is never committed.
