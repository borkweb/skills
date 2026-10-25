#!/usr/bin/env bash
# dispatch-slice.sh — one call from a written builder block to a running builder.
#
# Dispatching a slice used to take the architect eight to eleven separate tool
# calls (key, init, worktree, Next slice, ledger add, dispatch.sh, status,
# ledger set --pane, path, bridge), each a full model round trip and each one a
# step that could be skipped. This script does all of them in order, stops at
# the first failure with the slice still readable as `specced`, and prints the
# one command that still has to run in the architect's background: the wait
# bridge, whose exit is what wakes the session.
#
# Usage:
#   dispatch-slice.sh <repo_root> <worktree> <branch> <block_file>
#                     [--id <slice-id>] [--title <title>] [--base <ref>]
#                     [--harness harness[:model[:effort]]] [--corrective [--verdict V]] [--unattended]
#
#   repo_root   the checkout the ledger belongs to ($PWD for the architect)
#   worktree    the slice's worktree; created from <branch> (and --base, default
#               HEAD) when absent, reused untouched when present (pre-warm it
#               there: install dependencies, run the baseline suite)
#   block_file  the filled builder brief (builder-template.md)
#   --id        register/update this row in the session's ledger when one exists
#   --corrective  the slice already has a handoff and a verdict; put the new
#               block under Next slice and send it into the warm builder's pane
#               when that builder is still alive, else re-dispatch cold
#   --verdict   with --corrective: why the results went back. A slice still at
#               results-ready or dispatched is recorded as rejected with it
#               first, so the run report can count and classify the rejection;
#               a follow-up after acceptance is not a rejection
#   --unattended  instead of printing the bridge command, start a detached
#               bridge + architect-wake.sh chain that resumes this architect
#               session headlessly when the bridge fires, so the run continues
#               after the interactive session is closed (Claude architects only)
#
# Output: dispatch.sh's own lines, a worktree line, a slice line and finally
#   NEXT (background): WFR_BOARD_CWD="<repo>" bash "<core>/complete/wait-for-ready.sh" "<doc>" builder
#   or, with --unattended:
#   UNATTENDED: bridge and architect wake armed (pid <n>); log <doc>.wake.log
# Exit: 0 dispatched · 2 usage · dispatch.sh's code when the launch failed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HANDOFF_MJS="$SCRIPT_DIR/handoff.mjs"
DISPATCH="$SCRIPT_DIR/dispatch.sh"
BRIDGE="$(cd "$SCRIPT_DIR/../complete" 2>/dev/null && pwd)/wait-for-ready.sh"
WAKE="$(cd "$SCRIPT_DIR/../complete" 2>/dev/null && pwd)/architect-wake.sh"

usage() {
  printf '%s\n' \
    'Usage: dispatch-slice.sh <repo_root> <worktree> <branch> <block_file> [--id ID] [--title T] [--base REF] [--harness SPEC] [--corrective [--verdict V]] [--unattended]' >&2
}
die() { echo "dispatch-slice: $*" >&2; exit 1; }

POS=()
ID=""; TITLE=""; BASE=""; HARNESS=""; VERDICT=""; CORRECTIVE=0; UNATTENDED=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id) ID="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --harness) HARNESS="${2:-}"; shift 2 ;;
    --corrective) CORRECTIVE=1; shift ;;
    --verdict) VERDICT="${2:-}"; shift 2 ;;
    --unattended) UNATTENDED=1; shift ;;
    -h|--help) usage; exit 2 ;;
    -*) echo "dispatch-slice: unknown flag $1" >&2; usage; exit 2 ;;
    *) POS+=("$1"); shift ;;
  esac
done
[ "${#POS[@]}" -eq 4 ] || { usage; exit 2; }
REPO="${POS[0]}"; WT="${POS[1]}"; BRANCH="${POS[2]}"; BLOCK="${POS[3]}"

[ -d "$REPO" ] || die "repo root not found: $REPO"
[ -s "$BLOCK" ] || die "block file missing or empty: $BLOCK"
[ -f "$HANDOFF_MJS" ] || die "handoff.mjs not found beside this script"
[ -f "$DISPATCH" ] || die "dispatch.sh not found beside this script"
# Keep the paths as the caller spelled them (made absolute, not canonicalized):
# the handoff and ledger paths are keyed on the exact cwd string, and the
# architect will pass the same strings to handoff.mjs later.
absolute() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$PWD" "$1" ;; esac; }
REPO=$(absolute "$REPO"); WT=$(absolute "$WT")

hoff() { node "$HANDOFF_MJS" "$@"; }
SID=$(hoff key) || die "could not resolve the session key (CLAUDE_CODE_SESSION_ID / CODEX_SESSION_ID)"
if [ "$UNATTENDED" -eq 1 ]; then
  case "$SID" in codex:*) die "--unattended resumes the architect with claude --resume; a Codex architect ($SID) cannot be resumed that way" ;; esac
  [ -f "$WAKE" ] || die "architect-wake.sh not found at $WAKE"
fi

LEDGER=$(hoff ledger path "$REPO" 2>/dev/null || true)
HAS_LEDGER=0
[ -n "$LEDGER" ] && [ -f "$LEDGER" ] && HAS_LEDGER=1

ledger_has() { hoff ledger show "$REPO" 2>/dev/null | grep -q "\"id\": \"$1\""; }

# Record the row as specced with everything known so far; add or update.
ledger_spec() {
  [ "$HAS_LEDGER" -eq 1 ] && [ -n "$ID" ] || return 0
  local -a f=(--branch "$BRANCH" --slice-cwd "$WT" --handoff "$DOC" --state specced)
  [ -n "$TITLE" ] && f+=(--title "$TITLE")
  if ledger_has "$ID"; then hoff ledger set "$REPO" "$ID" "${f[@]}" >/dev/null
  else hoff ledger add "$REPO" --id "$ID" "${f[@]}" >/dev/null; fi
}

ledger_dispatched() {
  [ "$HAS_LEDGER" -eq 1 ] && [ -n "$ID" ] || return 0
  local -a f=(--state dispatched)
  [ -n "${1:-}" ] && f+=(--pane "$1")
  hoff ledger set "$REPO" "$ID" "${f[@]}" >/dev/null
}

# A corrective sends results back: record that as a rejection (with the
# verdict, when given) unless the slice was already judged. A follow-up after
# acceptance, or a second corrective after a recorded rejection, adds nothing.
ledger_reject_results() {
  [ "$HAS_LEDGER" -eq 1 ] && [ -n "$ID" ] || return 0
  local state
  state=$(hoff ledger show "$REPO" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=(JSON.parse(s).slices||[]).find(x=>x.id===process.argv[1]);process.stdout.write(r?r.state:"")})' "$ID" 2>/dev/null || true)
  case "$state" in
    results-ready|dispatched)
      local -a f=(--state rejected)
      [ -n "$VERDICT" ] && f+=(--verdict "$VERDICT")
      hoff ledger set "$REPO" "$ID" "${f[@]}" >/dev/null
      ;;
  esac
}

sidecar() { grep -m1 "^$1=" "$DOC.pane" 2>/dev/null | cut -d= -f2- || true; }

builder_pid() {
  local pid
  [ -f "$DOC.builder" ] || return 1
  pid=$(cat "$DOC.builder" 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

# Any bridge still watching this handoff from this session would double-wake.
stop_bridges_for() {
  local doc="$1" pid cmd
  while read -r pid cmd; do
    case "$cmd" in
      *wait-for-ready.sh\ "$doc"*) kill "$pid" 2>/dev/null && echo "dispatch-slice: stopped existing bridge pid $pid" ;;
    esac
  done < <(ps -axo pid=,command= 2>/dev/null)
}

# Detached: a new session so the chain survives this shell and the Claude
# Code process that spawned it. node is already a dependency; setsid is not
# on macOS.
arm_unattended() {
  stop_bridges_for "$DOC"
  node -e '
    const { spawn } = require("node:child_process");
    const p = spawn("bash", process.argv.slice(1), { detached: true, stdio: "ignore" });
    p.unref(); console.log(p.pid);
  ' "$WAKE" "$REPO" "$DOC" "$SID"
}

print_next() {
  echo "dispatch-slice: slice ${ID:--} ${TITLE:+\"$TITLE\" }handoff $DOC"
  if [ "$UNATTENDED" -eq 1 ]; then
    local pid
    pid=$(arm_unattended) || die "could not start the detached wake for $DOC"
    echo "UNATTENDED: bridge and architect wake armed (pid $pid); log $DOC.wake.log"
  else
    echo "NEXT (background): WFR_BOARD_CWD=\"$REPO\" bash \"$BRIDGE\" \"$DOC\" builder"
  fi
}

# Launch a fresh builder through dispatch.sh. Leaves status/ledger at specced
# on failure so the slice reads as not running.
launch() {
  local out rc pane frontend
  out=$("${FORCE_ENV[@]+"${FORCE_ENV[@]}"}" bash "$DISPATCH" "$WT" "$BLOCK" "$DOC" "$SID" ${HARNESS:+"$HARNESS"} 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$out" >&2
    echo "dispatch-slice: launch failed (exit $rc); slice stays specced, nothing is running" >&2
    exit "$rc"
  fi
  printf '%s\n' "$out"
  pane=$(sidecar pane); frontend=$(sidecar frontend)
  hoff status "$DOC" dispatched >/dev/null
  ledger_dispatched "$pane"
  [ -n "$pane" ] || echo "dispatch-slice: no pane recorded for frontend ${frontend:-unknown}; correctives will re-dispatch cold"
}
FORCE_ENV=()

if [ "$CORRECTIVE" -eq 1 ]; then
  DOC=$(hoff path "$WT" "$SID")
  [ -f "$DOC" ] || die "no handoff for $WT under session $SID; a corrective needs the slice's existing handoff (dispatch the slice first)"
  hoff section set "$DOC" "Next slice" --file "$BLOCK" >/dev/null || die "could not write Next slice into $DOC"
  ledger_reject_results
  pid=$(builder_pid || true)
  frontend=$(sidecar frontend); pane=$(sidecar pane)
  MSG="Corrective slice from the architect: the last results were rejected. Read the new brief with: node $HANDOFF_MJS section get \"$DOC\" \"Next slice\". Fix every listed blocker within the owned files, rerun the frozen gates, refresh Gate results and Work summary, then run: node $HANDOFF_MJS ready \"$DOC\""
  sent=0
  if [ -n "$pid" ] && [ -n "$pane" ]; then
    case "$frontend" in
      herdr) herdr pane run "$pane" "$MSG" >/dev/null 2>&1 && sent=1 ;;
      tmux) tmux send-keys -t "$pane" "$MSG" Enter >/dev/null 2>&1 && sent=1 ;;
    esac
  fi
  if [ "$sent" -eq 1 ]; then
    hoff status "$DOC" dispatched >/dev/null
    ledger_dispatched "$pane"
    echo "dispatch-slice: corrective sent into $frontend pane $pane (warm builder pid $pid)"
    print_next
    exit 0
  fi
  if [ -n "$pid" ]; then
    echo "dispatch-slice: builder pid $pid is alive but unreachable (frontend ${frontend:-unknown}, pane ${pane:-none}); replacing it and re-dispatching cold"
    FORCE_ENV=(env OFFLOAD_FORCE=1)
  else
    echo "dispatch-slice: builder gone (no live pid for $DOC); re-dispatching cold"
  fi
  launch
  print_next
  exit 0
fi

# --- fresh slice --------------------------------------------------------------

if [ -e "$WT" ]; then
  top=$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$top" ] && [ "$(cd -P -- "$top" && pwd)" = "$(cd -P -- "$WT" && pwd)" ] ||
    die "$WT exists but is not a git worktree root"
  echo "dispatch-slice: worktree $WT on $(git -C "$WT" rev-parse --abbrev-ref HEAD) (reused)"
else
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$REPO" worktree add -q "$WT" "$BRANCH" || die "git worktree add failed"
  else
    git -C "$REPO" worktree add -q -b "$BRANCH" "$WT" "${BASE:-HEAD}" || die "git worktree add -b failed"
  fi
  echo "dispatch-slice: worktree $WT on $BRANCH (created)"
fi

DOC=$(hoff init "$WT" "$SID" "${TITLE:-$BRANCH}") || die "could not create the handoff for $WT"
hoff section set "$DOC" "Next slice" --file "$BLOCK" >/dev/null || die "could not write Next slice into $DOC"
ledger_spec
launch
print_next
