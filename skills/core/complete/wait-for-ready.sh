#!/usr/bin/env bash
# Bridge builder completion -> a single harness wake-up for the /complete loop.
# The builder ends its run with `handoff.mjs ready`, flipping the offload handoff to
# status: results-ready. This script blocks OUTSIDE Claude's context until that
# happens (or the builder dies without reporting, or a backstop timeout fires), then
# exits with a final `WAITER:` line. Run it BACKGROUNDED from Claude
# (Bash run_in_background); the harness re-invokes the session when it exits, so
# the Claude side never polls and burns no tokens while waiting.
#
# CLI contracts:
#   wait-for-ready.sh <handoff_path> [tmux_window] [timeout_seconds] [idle_seconds]
#   wait-for-ready.sh --reap
#   tmux_window is accepted and ignored for caller compatibility.
#   Defaults: timeout 7200s, idle 600s, WFR_GRACE=90s, WFR_POLL=5s,
#   WFR_IDLE_CPU_CENTIS=200. Marker path is always "$HANDOFF.builder".
#   WFR_CPU_EXCLUDE defaults to SkyComputerUseClient|node_repl|mcp-context-a8c.
#
# Exit codes: 0 ready/reap · 2 usage · 3 builder unavailable/handoff deleted ·
#   4 timeout · 5 builder idle.
#
# WAITER output contracts:
#   WAITER: ready
#   WAITER: never-started after <n>s (status=<status>)
#   WAITER: builder-exited-without-ready (status=<status>)
#   WAITER: handoff-deleted (status=<status>)
#   WAITER: timeout after <n>s (status=<status>)
#   WAITER: builder-idle after <n>s (pid=<pid> cpu=<sec>s status=<status>)
#   WAITER: reaped pid=<pid> handoff=<path>
#   WAITER: usage: wait-for-ready.sh <handoff_path> [tmux_window] [timeout_seconds] [idle_seconds]
set -uo pipefail

usage() {
  echo "WAITER: usage: wait-for-ready.sh <handoff_path> [tmux_window] [timeout_seconds] [idle_seconds]"
}

waiter_handoff_from_command() {
  local command="$1" first second
  local -a argv=()
  read -r -a argv <<< "$command"
  [ "${#argv[@]}" -gt 0 ] || return 1
  first="${argv[0]##*/}"
  second="${argv[1]:-}"
  case "$first" in
    wait-for-ready.sh)
      [ "${#argv[@]}" -gt 1 ] && printf '%s\n' "${argv[1]}"
      ;;
    bash|sh|zsh)
      [ "${second##*/}" = "wait-for-ready.sh" ] &&
        [ "${#argv[@]}" -gt 2 ] &&
        printf '%s\n' "${argv[2]}"
      ;;
  esac
}

reap_stale_waiters() {
  local candidate_pid command handoff marker_pid stale
  while read -r candidate_pid command; do
    [ -n "${candidate_pid:-}" ] || continue
    [ "$candidate_pid" != "$$" ] || continue
    handoff=$(waiter_handoff_from_command "$command")
    [ -n "${handoff:-}" ] || continue
    [ "${handoff#--}" = "$handoff" ] || continue

    stale=false
    if [ ! -f "$handoff" ]; then
      stale=true
    elif [ -f "$handoff.builder" ]; then
      marker_pid=$(cat "$handoff.builder" 2>/dev/null || true)
      case "$marker_pid" in
        ''|*[!0-9]*) stale=true ;;
        *) kill -0 "$marker_pid" 2>/dev/null || stale=true ;;
      esac
    fi

    if $stale && kill "$candidate_pid" 2>/dev/null; then
      echo "WAITER: reaped pid=$candidate_pid handoff=$handoff"
    fi
  done < <(ps -axo pid=,command= 2>/dev/null)
}

if [ "${1:-}" = "--reap" ]; then
  reap_stale_waiters
  exit 0
fi

HANDOFF="${1:-}"
[ -n "$HANDOFF" ] || { usage; exit 2; }
# Positional argument 2 remains accepted for caller compatibility.
: "${2:-builder}"
TIMEOUT="${3:-7200}"
IDLE_SECONDS=${4:-600}
GRACE="${WFR_GRACE:-90}"
POLL="${WFR_POLL:-5}"
IDLE_CPU_CENTIS="${WFR_IDLE_CPU_CENTIS:-200}"
MARKER="$HANDOFF.builder"

status() {
  [ -f "$HANDOFF" ] || return 0
  grep -m1 '^status:' "$HANDOFF" 2>/dev/null |
    sed 's/^status:[[:space:]]*//;s/[[:space:]]*$//' || true
}

status_label() {
  local value
  value=$(status)
  printf '%s\n' "${value:-none}"
}

builder_alive() {
  local pid
  [ -f "$MARKER" ] || return 1
  pid=$(cat "$MARKER" 2>/dev/null || true)
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

cpu_centis() {
  local root_pid="$1" exclude="${WFR_CPU_EXCLUDE:-SkyComputerUseClient|node_repl|mcp-context-a8c}"
  ps -ww -axo pid=,ppid=,time=,command= 2>/dev/null |
    awk -v root="$root_pid" -v exclude="$exclude" '
      {
        pid[NR] = $1
        ppid[NR] = $2
        cpu[NR] = $3
        command[NR] = ""
        for (field = 4; field <= NF; field++) {
          command[NR] = command[NR] (field == 4 ? "" : " ") $field
        }
        if ($1 == root) selected[$1] = 1
      }
      END {
        changed = 1
        while (changed) {
          changed = 0
          for (i = 1; i <= NR; i++) {
            if (selected[pid[i]] || excluded[pid[i]]) continue
            if (excluded[ppid[i]]) {
              excluded[pid[i]] = 1
              changed = 1
            } else if (selected[ppid[i]]) {
              if (command[i] ~ exclude) {
                excluded[pid[i]] = 1
              } else {
                selected[pid[i]] = 1
              }
              changed = 1
            }
          }
        }
        total = 0
        for (i = 1; i <= NR; i++) {
          if (!selected[pid[i]]) continue
          fields = split(cpu[i], part, ":")
          if (fields == 2) {
            seconds = (part[1] * 60) + part[2]
          } else if (fields == 3) {
            seconds = (part[1] * 3600) + (part[2] * 60) + part[3]
          } else {
            seconds = part[1]
          }
          total += seconds
        }
        printf "%.0f\n", total * 100
      }
    '
}

cpu_seconds() {
  awk -v centis="$1" 'BEGIN { printf "%.2f", centis / 100 }'
}

started_at=$(date +%s)
deadline=$(( started_at + TIMEOUT ))
saw_marker=false
[ -f "$MARKER" ] && saw_marker=true
idle_pid=""
idle_started=0
idle_cpu_base=0

check() {
  local now current_status pid cpu delta
  now=$(date +%s)

  if [ ! -f "$HANDOFF" ]; then
    echo "WAITER: handoff-deleted (status=none)"
    exit 3
  fi

  current_status=$(status)
  if [ "$current_status" = "results-ready" ]; then
    echo "WAITER: ready"
    exit 0
  fi

  [ -f "$MARKER" ] && saw_marker=true
  if $saw_marker; then
    if ! pid=$(builder_alive); then
      current_status=$(status)
      if [ "$current_status" = "results-ready" ]; then
        echo "WAITER: ready"
        exit 0
      fi
      echo "WAITER: builder-exited-without-ready (status=${current_status:-none})"
      exit 3
    fi

    cpu=$(cpu_centis "$pid")
    cpu="${cpu:-0}"
    if [ "$idle_pid" != "$pid" ]; then
      idle_pid="$pid"
      idle_started="$now"
      idle_cpu_base="$cpu"
    else
      delta=$(( cpu - idle_cpu_base ))
      if [ "$delta" -gt "$IDLE_CPU_CENTIS" ]; then
        idle_started="$now"
        idle_cpu_base="$cpu"
      elif [ $(( now - idle_started )) -ge "$IDLE_SECONDS" ]; then
        echo "WAITER: builder-idle after $(( now - idle_started ))s (pid=$pid cpu=$(cpu_seconds "$cpu")s status=${current_status:-none})"
        exit 5
      fi
    fi
  elif [ $(( now - started_at )) -ge "$GRACE" ]; then
    echo "WAITER: never-started after $(( now - started_at ))s (status=${current_status:-none})"
    exit 3
  fi

  if [ "$now" -ge "$deadline" ]; then
    echo "WAITER: timeout after ${TIMEOUT}s (status=$(status_label))"
    exit 4
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
