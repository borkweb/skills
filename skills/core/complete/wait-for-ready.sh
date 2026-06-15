#!/usr/bin/env bash
# Bridge codex completion -> a single harness wake-up for the /complete loop.
# Codex ends its run with `handoff.mjs ready`, flipping the offload handoff to
# status: results-ready. This script blocks OUTSIDE Claude's context until that
# happens (or codex dies without reporting, or a backstop timeout fires), then
# exits with a final `WAITER:` line. Run it BACKGROUNDED from Claude
# (Bash run_in_background); the harness re-invokes the session when it exits, so
# the Claude side never polls and burns no tokens while waiting.
#
# Usage: wait-for-ready.sh <handoff_path> [tmux_window] [timeout_seconds]
#   tmux_window      liveness target when inside tmux (default: codex-build)
#   timeout_seconds  backstop so a wedged builder can't hang the loop (default 7200)
#
# Exit codes: 0 ready · 3 codex exited without ready · 4 timeout · 2 usage.
set -uo pipefail

HANDOFF="${1:-}"
[ -n "$HANDOFF" ] || { echo "WAITER: usage: wait-for-ready.sh <handoff_path> [tmux_window] [timeout_seconds]"; exit 2; }
WINDOW="${2:-codex-build}"
TIMEOUT="${3:-7200}"
POLL=5

status() {
  [ -f "$HANDOFF" ] || return 0
  grep -m1 '^status:' "$HANDOFF" 2>/dev/null | sed 's/^status:[[:space:]]*//;s/[[:space:]]*$//'
}

in_tmux() { [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; }

window_present() {
  in_tmux || return 1
  tmux list-windows -F '#{window_name}' 2>/dev/null | grep -qx "$WINDOW"
}

# Only trust "window vanished == codex done" once we've actually seen the window
# appear; outside tmux we can't observe liveness, so the timeout is the safety net.
saw_window=false
window_present && saw_window=true

deadline=$(( $(date +%s) + TIMEOUT ))

check() {
  local s; s=$(status)
  if [ "$s" = "results-ready" ]; then echo "WAITER: ready"; exit 0; fi
  if $saw_window && ! window_present; then
    s=$(status)
    if [ "$s" = "results-ready" ]; then echo "WAITER: ready"; exit 0; fi
    echo "WAITER: codex-exited-without-ready (status=${s:-none})"; exit 3
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "WAITER: timeout after ${TIMEOUT}s (status=$(status))"; exit 4
  fi
}

# Pick a timeout wrapper so the fast-path fswatch can't block past a re-check.
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD=timeout
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD=gtimeout; fi

check  # in case results are already in before we ever block

if command -v fswatch >/dev/null 2>&1 && [ -n "$TIMEOUT_CMD" ]; then
  # Event-driven fast path: wake on a filesystem event, bounded by POLL so the
  # liveness/timeout backstops still fire during silence.
  while true; do
    "$TIMEOUT_CMD" "$POLL" fswatch -1 "$HANDOFF" >/dev/null 2>&1 || true
    check
  done
else
  # Portable fallback: a detached sleep-poll. Still zero cost to the Claude side.
  while true; do
    sleep "$POLL"
    check
  done
fi
