#!/usr/bin/env bash
# architect-wake.sh — one unattended architect wake for one slice.
#
# The in-session wait bridge only works while the architect's Claude Code
# session is open: it is a background task of that session, and its exit is what
# re-invokes the model. This script is the detached form for runs that must
# outlive the session (the user closes the laptop, clears, or walks away). It runs
# the same bridge, then resumes the architect's own session headlessly with the
# bridge's output as the prompt, so the ledger and handoffs stay owned by the same
# session id and the complete loop continues from disk.
#
# Usage: architect-wake.sh <repo_root> <handoff_path> <architect_session_id>
#   Started detached by `dispatch-slice.sh --unattended` or `unattended.sh`.
#   Appends everything to "$HANDOFF.wake.log".
# Env:
#   OFFLOAD_ARCHITECT_MCP   none (default) | inherit | <path>, as for builders.
#   OFFLOAD_WAKE_PERMISSIONS auto (default): the resumed turn runs under
#     --permission-mode auto, so routine work proceeds and anything the
#     classifier gates is denied rather than waited on; the architect records
#     the denial and stops. bypass: --dangerously-skip-permissions, the same
#     posture builders run with. Choose bypass only for a repo where every
#     command the architect may run is one you would approve unseen.
# Exit: the bridge's code when `claude --resume` could not run; else claude's.
# Limits: a Codex architect cannot be resumed this way (exit 2). If the
#   architect's interactive session is still open, `--resume` is refused by
#   Claude Code and the failure is logged; the in-session bridge, if armed, still
#   wakes that session.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$HERE/wait-for-ready.sh"
SLICE="$(cd "$HERE/../offload" 2>/dev/null && pwd)/dispatch-slice.sh"

REPO="${1:-}"; DOC="${2:-}"; SID="${3:-}"
if [ -z "$REPO" ] || [ -z "$DOC" ] || [ -z "$SID" ]; then
  echo "usage: architect-wake.sh <repo_root> <handoff_path> <architect_session_id>" >&2
  exit 2
fi
case "$SID" in
  codex:*) echo "architect-wake: unattended wakes need a Claude architect session to resume; got $SID" >&2; exit 2 ;;
esac
LOG="$DOC.wake.log"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

log "bridge armed for $DOC (architect $SID)"
OUT=$(WFR_BOARD_CWD="$REPO" bash "$BRIDGE" "$DOC" builder 2>&1)
RC=$?
log "bridge exited $RC"
printf '%s\n' "$OUT" >> "$LOG"

MCP=()
case "${OFFLOAD_ARCHITECT_MCP:-none}" in
  inherit) ;;
  none) MCP=(--strict-mcp-config --mcp-config '{"mcpServers":{}}') ;;
  *) MCP=(--strict-mcp-config --mcp-config "$OFFLOAD_ARCHITECT_MCP") ;;
esac
PERMS=(--permission-mode auto)
[ "${OFFLOAD_WAKE_PERMISSIONS:-auto}" = "bypass" ] && PERMS=(--dangerously-skip-permissions)

PROMPT="[unattended wake] The wait bridge for $DOC exited $RC with:
$OUT

You are the architect for $REPO, running unattended: no human is watching this turn. Load the complete skill and follow its 'Each wake' procedure for this slice, reading the board above. Rules for this mode: every dispatch or corrective goes through \"$SLICE\" with --unattended, which arms the next wake itself; never start a background Bash bridge and never ScheduleWakeup. Write every terminal state you decide before ending. If a human ruling is genuinely required, or a command you need is denied, append the question to the handoff's 'Open disagreements' section, say so in your final message, and stop."

log "resuming architect session $SID (${PERMS[*]})"
( cd "$REPO" && env -u CLAUDE_CODE_SESSION_ID claude -p --resume "$SID" "${PERMS[@]}" \
    ${MCP[@]+"${MCP[@]}"} --output-format text "$PROMPT" ) >> "$LOG" 2>&1
RC2=$?
if [ "$RC2" -ne 0 ]; then
  log "claude --resume $SID failed (exit $RC2). If the interactive architect session is still open, close it or let its own bridge handle this wake."
  exit "$RC2"
fi
log "architect turn finished"
exit 0
