#!/usr/bin/env bash
# unattended.sh — hand a running fleet to detached wakes before leaving.
#
# For every slice on this session's board that is dispatched (or blocked), stop
# its in-session wait bridge and start a detached architect-wake.sh chain, so the
# run keeps judging, correcting and dispatching after the architect's interactive
# session is closed. Prints one line per slice. Run it as the last thing before
# closing the session; while the session is still open the detached wake's
# `--resume` is refused and logged, and the in-session bridge (now stopped) will
# not fire, so do not keep working interactively after running it.
#
# Usage: unattended.sh <repo_root>
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HANDOFF_MJS="$(cd "$HERE/../offload" && pwd)/handoff.mjs"
WAKE="$HERE/architect-wake.sh"

REPO="${1:-}"
[ -n "$REPO" ] && [ -d "$REPO" ] || { echo "usage: unattended.sh <repo_root>" >&2; exit 2; }
SID=$(node "$HANDOFF_MJS" key) || { echo "unattended: no session key" >&2; exit 1; }
case "$SID" in codex:*) echo "unattended: needs a Claude architect session to resume; got $SID" >&2; exit 2 ;; esac

stop_bridges_for() {
  local doc="$1" pid cmd
  while read -r pid cmd; do
    case "$cmd" in
      *wait-for-ready.sh\ "$doc"*|*wait-for-ready.sh\ "$doc") kill "$pid" 2>/dev/null && echo "unattended: stopped in-session bridge pid $pid" ;;
    esac
  done < <(ps -axo pid=,command= 2>/dev/null)
}

arm() {
  local doc="$1"
  node -e '
    const { spawn } = require("node:child_process");
    const p = spawn("bash", process.argv.slice(1), { detached: true, stdio: "ignore" });
    p.unref(); console.log(p.pid);
  ' "$WAKE" "$REPO" "$doc" "$SID"
}

n=0
while IFS=$'\t' read -r id state doc; do
  [ -n "$doc" ] || continue
  case "$state" in dispatched|blocked) ;; *) continue ;; esac
  stop_bridges_for "$doc"
  pid=$(arm "$doc") || { echo "unattended: could not arm wake for slice $id" >&2; continue; }
  echo "unattended: slice $id ($state) → detached bridge+wake pid $pid, log $doc.wake.log"
  n=$((n + 1))
done < <(node "$HANDOFF_MJS" board "$REPO" --json --no-git --no-pane | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const b = JSON.parse(s);
    for (const r of b.slices || []) console.log([r.id, r.state, r.handoff || ""].join("\t"));
  });
')
echo "unattended: $n slice(s) handed to detached wakes; you can close this session"
