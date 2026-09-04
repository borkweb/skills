---
description: Drive a goal to merge-ready with Codex orchestrating gpt-5.6-luna workers and independent reviews
---

You are running the `/complete` command. The user's goal follows the command (e.g.
`/complete ship the auth refactor and merge to main`).

## Process

1. Read `skills/core/complete/SKILL.md`.
2. Execute that skill's loop in full for the given goal.

## Notes

- Codex is the ARCHITECT/ORCHESTRATOR; `gpt-5.6-luna` subagents implement and
  independently review slices. Select the worker model explicitly; keep the
  parent model unchanged.
- Follow the skill's route selection. Native workers use native notifications
  and a file ledger; external sessions use `offload` and its wait bridge.
- Preserve existing dispatch and merge authorization across turns.
- Default endpoint is merge-ready: drive right up to the edge of merge and STOP,
  handing the branch to the human. Merge only when the goal text explicitly
  authorized it ("merge into main", "and merge", "land it").
- The session handoff is never committed.
