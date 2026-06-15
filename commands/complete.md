---
description: Drive a goal to a merged endpoint — orchestrate the offload architect loop with contextual plan reviews, a push-based wait bridge, and gate-judged merge
---

You are running the `/complete` command. The user's goal follows the command (e.g.
`/complete ship the auth refactor and merge to main`).

## Process

1. Read `skills/core/complete/SKILL.md`.
2. Execute that skill's loop in full for the given goal.

## Notes

- You are the ARCHITECT/ORCHESTRATOR; you never write implementation code. `offload`
  is your single-turn engine, codex is the builder.
- Confirm the autonomy posture (dispatch + merge) ONCE up front, then honor it.
- The wait bridge wakes you when codex finishes — never poll or ScheduleWakeup for it.
- Merging to main is the one hard-to-reverse step; honor the posture from step 3.
- The session handoff is never committed.
