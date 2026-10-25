# Wait signals

Read this when a background bridge returns a `WAITER:` line. The line is the
builder's state; the board printed under it (the bridge runs `board` for you
when `WFR_BOARD_CWD` is set) is the fleet's state. Act on both.

## Branch on the line

| `WAITER:` line | Meaning | Action |
| --- | --- | --- |
| `ready` | Builder ran `handoff.mjs ready`. | Run `offload` for one architect turn on that slice: it judges raw gates, runs the acceptance review, writes the verdict. Then set the terminal state. |
| `builder-blocked …` | Builder flipped the handoff to `blocked` and is waiting for a ruling. | Arbitrate now (below). |
| `builder-awaiting-input …` | The harness's turn-end hook fired and the builder stayed quiet past the settle window: stopped without flipping the handoff, hit a permission prompt, or finished without `ready`. | Arbitrate now (below). |
| `builder-idle …` | No handoff flip, no turn end, no session-log writes, no CPU for the idle window. The builder is not thinking, streaming or writing. | Arbitrate now (below). Do not relaunch the bridge on a hunch. |
| `builder-exited-without-ready …` | Builder process gone, no report. | BLOCKER: pause, ask the human. |
| `timeout …` | Deadline passed. | BLOCKER: pause, ask the human. |
| `never-started …` | No builder marker ever appeared. | Read the dispatch output for a launch failure, fix the cause, re-dispatch through `offload`. BLOCKER if it repeats. |
| `handoff-deleted …` | The handoff vanished mid-wait. | STOP. Resolve the handoff path first, then ask the human. Do not re-dispatch blindly. |

A `WAITER:` line means resume the loop at that slice, not start the run over.

## Arbitrate a stopped builder

For `builder-blocked`, `builder-awaiting-input` and `builder-idle`, in order:

1. Read the builder pane (`herdr pane read <pane>` / `tmux capture-pane`) and the
   handoff's *Open disagreements*
   (`handoff.mjs section get "$HANDOFF" "Open disagreements"`).
2. Rule on every open item (accept / reject / modify, one-line reasons) and record
   the rulings with
   `handoff.mjs section append "$HANDOFF" "Decisions + why" --text '<rulings>'`.
   Genuine judgment calls go through `council` first. Use the `section`
   subcommands, never hand-splice the markdown.
3. Resume the builder: send the ruling into its pane. If it finished the slice but
   never ran `handoff.mjs ready`, tell it to report and stop.
4. Re-arm the bridge (same command as after a dispatch) and end your turn.

If step 1 finds nothing to rule on (no disagreement, no question, no prompt, pane
mid-stream), re-arm the bridge once and say so in your status line. If the same
signal fires again, surface it as a BLOCKER and ask the human. Never re-arm more
than once without new evidence.

## Bridge tuning

- The turn-end hook fires on every sub-turn, so a fresh marker is a candidate stop
  confirmed only after `WFR_TURN_SETTLE` seconds (default 45) with no CPU growth and
  no session-log writes. Writes in the first `WFR_TURN_EPILOGUE` seconds (default 5)
  are the harness's own end-of-turn records and do not count. If a bridge wakes you
  too often, raise `WFR_TURN_SETTLE`; do not disable the signal.
- Idle means less than `WFR_IDLE_CPU_CENTIS` (default 200) of CPU in every
  `WFR_IDLE_CPU_WINDOW` (default 60s) for the whole idle period, with no session-log
  writes. A long idle period no longer hides a stopped builder.
- Never `rm` the `.turn-ended` marker by hand. The bridge baselines it at start;
  deleting it races with `dispatch.sh` and a running bridge and eats real wakes.
- Defaults: timeout 7200s, idle 600s. Both are backstops, not the primary signal.
