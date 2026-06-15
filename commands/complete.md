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
- Default endpoint is merge-ready: drive right up to the edge of merge and STOP,
  handing the branch to the human. Merge only when the goal text explicitly
  authorized it ("merge into main", "and merge", "land it").
- The session handoff is never committed.
