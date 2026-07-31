#!/usr/bin/env bash
# Codex notify hook installed by dispatch.sh:
#   codex -c 'notify=["bash","<here>/notify-turn-ended.sh","<handoff>",<orig...>]'
# Codex invokes the configured argv with a JSON event payload appended as the
# LAST argument. Argv layout as received here:
#   $1        handoff path
#   $2..$n-1  the user's original notify program + its fixed args (may be empty)
#   $n        JSON payload from codex
#
# On agent-turn-complete we touch "<handoff>.turn-ended" — the deterministic
# "builder stopped and is waiting for input" signal the wait bridge watches
# (wait-for-ready.sh exits 6 / WAITER: builder-awaiting-input on it, unless the
# handoff already says results-ready). Then we chain to the original notify so
# installing this hook never disables what the user configured. Always exits 0:
# a notify failure must never disturb the builder.
set -u

handoff="${1:-}"
shift 2>/dev/null || true

# No payload at all (codex appends one; a bare call is a misconfiguration): noop.
if [ -z "$handoff" ] || [ "$#" -lt 1 ]; then
  exit 0
fi

json="${*: -1}"

case "$json" in
  *agent-turn-complete*)
    touch "$handoff.turn-ended" 2>/dev/null || true
    ;;
esac

# Chain to the original notify program (everything between handoff and payload).
if [ "$#" -gt 1 ]; then
  "${@: 1:$#-1}" "$json" 2>/dev/null || true
fi

exit 0
