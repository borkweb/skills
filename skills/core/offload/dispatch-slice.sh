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
#                     [--id <slice-id>] [--title <title>] [--base <ref>] [--run-dir <abs>]
#                     [--harness harness[:model[:effort]]] [--corrective [--verdict V]] [--unattended]
#
#   repo_root   the checkout the ledger belongs to ($PWD for the architect)
#   worktree    the slice's worktree; created from <branch> (and --base, default
#               HEAD) when absent, reused untouched when present (pre-warm it
#               there: install dependencies, run the baseline suite)
#   block_file  the filled builder brief (builder-template.md)
#   --id        register/update this row in the session's ledger. Without it the
#               script picks the row: a fresh dispatch reuses the newest
#               non-terminal row for this handoff, else takes max(integer ids)+1
#               (non-integer ids ignored); a corrective takes the most recently
#               updated row for this handoff, adding one from the doc status when
#               a pre-ledger slice has none. A session with no ledger gets one
#               (goal: --title, else the block's heading).
#   --run-dir   absolute run directory to link to a ledger this call creates;
#               BORK_RUN_DIR is the fallback when that directory exists. Never
#               relinks a ledger that already exists. A relative path exits 2.
#   --corrective  the slice already has a handoff and a verdict; put the new
#               block under Next slice and send it into the warm builder's pane
#               when that builder is still alive, else re-dispatch cold
#   --verdict   with --corrective: why the results went back. A slice still at
#               results-ready or dispatched is recorded as rejected with it
#               first, so the run report can count and classify the rejection;
#               a follow-up after acceptance is not a rejection. Required in
#               that case; a review-only verdict needs "named C<n>" or "unnamed".
#               On a row already rejected the verdict is kept as a ledger note
#               (no second rejection). In any other state --verdict exits 2
#               (naming the state) and sends nothing: drop it for a follow-up
#   --past-cap  with --corrective: the user's ruling to continue a slice already
#               rejected more than OFFLOAD_ROUND_CAP (default 3) times; recorded
#               as the slice's ledger note. Without it the corrective is refused
#   --unattended  instead of printing the bridge command, start a detached
#               bridge + architect-wake.sh chain that resumes this architect
#               session headlessly when the bridge fires, so the run continues
#               after the interactive session is closed (Claude architects only)
#
# Frozen gates: on a fresh dispatch, before the builder launches, every line of
# the block whose first token is a criterion ID (`C1: x`, `- C2: x`, `| C3 | x |`,
# `**C4 x.**`, a backticked ID, `1. C6: x`; leading whitespace allowed, one
# criterion per line) is copied verbatim into the handoff's `## Frozen gates`, so
# the builder's `ready` is checked against them (handoff.mjs coverage). It never
# runs on --corrective. A section that already holds IDs is never rewritten: the
# same IDs in the block leave it as it is, different IDs refuse the dispatch
# (use a new worktree or end the old handoff). A block with no criterion IDs
# prints one warning line and the dispatch continues. When the freeze or the
# launch fails the section is put back as it was. The ID and comment rules are a
# copy of handoff.mjs's; test_dispatch_slice.mjs asserts the two agree.
#
# Known limitations: two calls without --id at the same time can pick the same
# id (complete always passes --id), and a second run in the same session shares
# the first run's ledger.
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
    'Usage: dispatch-slice.sh <repo_root> <worktree> <branch> <block_file> [--id ID] [--title T] [--base REF] [--run-dir ABS] [--harness SPEC] [--corrective [--verdict V] [--past-cap RULING]] [--unattended]' >&2
}
die() { echo "dispatch-slice: $*" >&2; exit 1; }

# A value flag as the last argument has nothing to shift: `shift 2` would fail
# without shifting and the loop below would never end.
need_value() { [ "$#" -ge 2 ] || { echo "dispatch-slice: $1 needs a value" >&2; usage; exit 2; }; }

POS=()
VERDICT_NOTED=""
ID=""; TITLE=""; BASE=""; RUN_DIR=""; HARNESS=""; VERDICT=""; PAST_CAP=""; CORRECTIVE=0; UNATTENDED=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id) need_value "$@"; ID="$2"; shift 2 ;;
    --title) need_value "$@"; TITLE="$2"; shift 2 ;;
    --base) need_value "$@"; BASE="$2"; shift 2 ;;
    --run-dir) need_value "$@"; RUN_DIR="$2"; shift 2 ;;
    --harness) need_value "$@"; HARNESS="$2"; shift 2 ;;
    --corrective) CORRECTIVE=1; shift ;;
    --verdict) need_value "$@"; VERDICT="$2"; shift 2 ;;
    --past-cap) need_value "$@"; PAST_CAP="$2"; shift 2 ;;
    --unattended) UNATTENDED=1; shift ;;
    -h|--help) usage; exit 2 ;;
    -*) echo "dispatch-slice: unknown flag $1" >&2; usage; exit 2 ;;
    *) POS+=("$1"); shift ;;
  esac
done
[ "${#POS[@]}" -eq 4 ] || { usage; exit 2; }
REPO="${POS[0]}"; WT="${POS[1]}"; BRANCH="${POS[2]}"; BLOCK="${POS[3]}"
case "$RUN_DIR" in ''|/*) ;; *) echo "dispatch-slice: --run-dir needs an absolute path, got: $RUN_DIR" >&2; usage; exit 2 ;; esac
# BORK_RUN_DIR is the fallback only while it names a live run: an existing dir
# whose run.json (when there is one) is not done or failed. --run-dir is trusted.
env_run_dir_live() {
  [ -n "${BORK_RUN_DIR:-}" ] && [ -d "$BORK_RUN_DIR" ] || return 1
  node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1]+"/run.json","utf8")).state;process.exit(s==="done"||s==="failed"?1:0)}catch{}' "$BORK_RUN_DIR"
}
[ -n "$RUN_DIR" ] || { env_run_dir_live && RUN_DIR="$BORK_RUN_DIR"; }

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
# The user's halt beats every dispatch, attended or not.
if halt_reason=$(hoff halted "$REPO" 2>/dev/null); then
  die "the run in $REPO is halted ($halt_reason); nothing was dispatched. The user clears it with: node $HANDOFF_MJS unhalt \"$REPO\""
fi
SID=$(hoff key) || die "could not resolve the session key (CLAUDE_CODE_SESSION_ID / CODEX_SESSION_ID)"
if [ "$UNATTENDED" -eq 1 ]; then
  case "$SID" in codex:*) die "--unattended resumes the architect with claude --resume; a Codex architect ($SID) cannot be resumed that way" ;; esac
  [ -f "$WAKE" ] || die "architect-wake.sh not found at $WAKE"
fi

HAS_LEDGER=0
detect_ledger() {
  local p
  p=$(hoff ledger path "$REPO" 2>/dev/null || true)
  [ -n "$p" ] && [ -f "$p" ] && HAS_LEDGER=1
  return 0
}
detect_ledger

# The ledger goal when the caller gave no --title: the block's first heading,
# else its first non-empty line, else the branch.
block_heading() {
  local h
  h=$(grep -m1 -E '^#+[[:space:]]+' "$BLOCK" | sed -E 's/^#+[[:space:]]+//')
  [ -n "$h" ] || h=$(grep -m1 -v '^[[:space:]]*$' "$BLOCK")
  printf '%s' "${h:-$BRANCH}"
}

# A session with no ledger gets one, so a one-slice run has a row to judge.
# HAS_LEDGER is re-evaluated: every ledger_* helper below keys on it.
ensure_ledger() {
  [ "$HAS_LEDGER" -eq 1 ] && return 0
  local -a f=("$REPO" "${TITLE:-$(block_heading)}")
  [ -n "$RUN_DIR" ] && f+=(--run-dir "$RUN_DIR")
  hoff ledger init "${f[@]}" >/dev/null || die "could not create the ledger for $REPO"
  detect_ledger
  [ "$HAS_LEDGER" -eq 1 ] || die "ledger for $REPO was not created"
}

# Pick a row id when the caller gave no --id. Modes: open = newest non-terminal
# row whose handoff is this doc; recent = most recently updated row with this
# doc, terminal or not; next = max(integer ids) + 1, non-integer ids ignored.
pick_row() {
  hoff ledger show "$REPO" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const [mode,doc]=process.argv.slice(1);
      const rows=JSON.parse(s).slices||[];
      if(mode==="next"){const n=rows.map(r=>r.id).filter(i=>/^\d+$/.test(i)).map(Number);process.stdout.write(String(Math.max(0,...n)+1));return}
      const T=["accepted","rejected","merged","abandoned"];
      const hit=rows.filter(r=>r.handoff===doc&&(mode==="recent"||!T.includes(r.state)))
        .reduce((b,r)=>b&&String(b.updated)>String(r.updated)?b:r,null);
      process.stdout.write(hit?hit.id:"")})' "$1" "$DOC" 2>/dev/null || true
}

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

# A corrective sends results back. With --verdict it records a rejection from
# results-ready or dispatched, keeps the verdict as a note on a row already
# rejected, and exits 2 in any other state. Without --verdict a judged row is
# left as it is (a follow-up after acceptance, or a second corrective after a
# recorded rejection, adds nothing).
ledger_state() {
  [ "$HAS_LEDGER" -eq 1 ] && [ -n "$ID" ] || return 0
  hoff ledger show "$REPO" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=(JSON.parse(s).slices||[]).find(x=>x.id===process.argv[1]);process.stdout.write(r?r.state:"")})' "$ID" 2>/dev/null || true
}

# Rejected rounds this slice has had. A slice that fails on a new blocker each
# round never trips the per-criterion two-miss stop, so the dispatcher caps the
# rounds itself: past OFFLOAD_ROUND_CAP (default 3) a corrective needs the
# user's ruling, passed as --past-cap and kept in the ledger.
ledger_rejections() {
  [ "$HAS_LEDGER" -eq 1 ] && [ -n "$ID" ] || { echo 0; return 0; }
  hoff ledger show "$REPO" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=(JSON.parse(s).slices||[]).find(x=>x.id===process.argv[1]);process.stdout.write(String(r?(r.history||[]).filter(h=>h.state==="rejected").length:0))})' "$ID" 2>/dev/null || echo 0
}

round_cap() {
  local cap="${OFFLOAD_ROUND_CAP:-3}" n
  n=$(ledger_rejections)
  [ "$n" -gt "$cap" ] || return 0
  # Only a human grants this. An unattended wake (architect-wake.sh sets the
  # marker on the resumed architect) has nobody to ask, so it must stop instead.
  if [ -n "$PAST_CAP" ] && [ "${OFFLOAD_UNATTENDED_TURN:-}" = 1 ]; then
    die "slice $ID has been rejected $n times (cap $cap) and this is an unattended wake: --past-cap needs the user's own ruling. Append the question to the handoff's Open disagreements and stop. Nothing was sent."
  fi
  [ -n "$PAST_CAP" ] || die "slice $ID has been rejected $n times (cap $cap). Ask the user whether to continue, re-scope or abandon; if they say continue, re-run with --past-cap \"<their ruling>\". Nothing was sent."
  # One note field: when the verdict was already kept there, keep both.
  hoff ledger set "$REPO" "$ID" --note "past round cap ($n > $cap): $PAST_CAP${VERDICT_NOTED:+; corrective verdict: $VERDICT}" >/dev/null
}

ledger_reject_results() {
  local st
  st=$(ledger_state)
  case "$st" in
    results-ready|dispatched)
      hoff ledger set "$REPO" "$ID" --state rejected --verdict "$VERDICT" >/dev/null ||
        die "--corrective from unjudged results needs a --verdict the ledger accepts (see the refusal above); nothing was sent"
      ;;
    rejected)
      # Already judged (complete sets `rejected` before it sends the corrective,
      # and a refused round-cap call has rejected the row): keep the verdict as a
      # note, never a second rejection (decisions.md 10).
      [ -z "$VERDICT" ] || hoff ledger set "$REPO" "$ID" --note "corrective verdict: $VERDICT" >/dev/null ||
        die "could not record the verdict note on slice $ID; nothing was sent"
      [ -z "$VERDICT" ] || VERDICT_NOTED=1
      ;;
    '') ;;
    *)
      [ -z "$VERDICT" ] || {
        echo "dispatch-slice: --verdict records a rejection, but slice $ID is $st (only results-ready, dispatched or rejected take a verdict); drop --verdict for a follow-up. Nothing was sent." >&2
        exit 2
      }
      ;;
  esac
}

# A corrective with no row for this handoff (no ledger yet, or no --id and no
# match) is a slice from before the ledger covered one-slice runs: add its row,
# under --id when given, from the doc's own status.
backfill_row() {
  local st
  st=$(grep -m1 '^status:' "$DOC" | sed -E 's/^status:[[:space:]]*//')
  [ -n "$ID" ] || ID=$(pick_row next)
  hoff ledger add "$REPO" --id "$ID" --title "${TITLE:-$BRANCH}" --branch "$BRANCH" --slice-cwd "$WT" --handoff "$DOC" --state "${st:-specced}" >/dev/null ||
    die "could not add a ledger row for $DOC (doc status ${st:-unknown}); nothing was sent"
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
  FREEZE_DONE=0 # the builder is running: its criteria stay frozen
  printf '%s\n' "$out"
  pane=$(sidecar pane); frontend=$(sidecar frontend)
  hoff status "$DOC" dispatched >/dev/null
  ledger_dispatched "$pane"
  [ -n "$pane" ] || echo "dispatch-slice: no pane recorded for frontend ${frontend:-unknown}; correctives will re-dispatch cold"
}
FORCE_ENV=()

# --- frozen gates -------------------------------------------------------------
# Copy of handoff.mjs's first-token ID rule and comment rule (see the comment
# above ID_FIRST there). Mode `ids` prints the distinct IDs, `lines` the lines
# that lead with one, with comments blanked (not removed) so the lines keep their
# numbers and what is copied is what the parser reads.
read -r -d '' CRITERIA_JS <<'JS' || true
const ID = /^\s*(?:(?:[-*]|\d+[.)])\s+)?(?:\|\s*)?(?:\*\*|`)?(C\d+[a-z]?)(?![A-Za-z0-9_])(?!(?:\s*(?:[-–—/,;&+]|and\b|or\b|to\b|through\b)\s*|\s+)C\d)/;
const COMMENT = /^[ \t]*<!--(?:[\s\S]*?-->|[^\n]*(?:\n(?![ \t]*(?:\n|$))[^\n]*)*)/gm;
const text = require("fs").readFileSync(0, "utf8").replace(/\r\n?/g, "\n");
const bare = text.replace(COMMENT, (m) => m.replace(/[^\n]/g, "")).split("\n");
const hit = bare.map((l, i) => (ID.test(l) ? i : -1)).filter((i) => i >= 0);
const out = process.argv[1] === "lines" ? hit.map((i) => bare[i]) : [...new Set(hit.map((i) => ID.exec(bare[i])[1]))].sort();
if (out.length) process.stdout.write(out.join("\n") + "\n");
JS
criteria() { node -e "$CRITERIA_JS" "$1"; }

FREEZE_DONE=0; FREEZE_PRIOR=""
restore_frozen() {
  [ "$FREEZE_DONE" -eq 1 ] || return 0
  FREEZE_DONE=0
  local tmp
  tmp=$(mktemp) || return 0
  printf '%s\n' "$FREEZE_PRIOR" > "$tmp"
  if hoff section set "$DOC" "Frozen gates" --file "$tmp" >/dev/null 2>&1; then
    echo "dispatch-slice: restored Frozen gates after the failed dispatch" >&2
  else
    echo "dispatch-slice: could not restore Frozen gates in $DOC; check them before dispatching again" >&2
  fi
  rm -f "$tmp"
}
trap restore_frozen EXIT

freeze_gates() {
  local cur have want tmp
  cur=$(hoff section get "$DOC" "Frozen gates") || die "could not read Frozen gates from $DOC; nothing was launched"
  have=$(printf '%s\n' "$cur" | criteria ids) || die "could not read the criteria in Frozen gates; nothing was launched"
  want=$(criteria ids < "$BLOCK") || die "could not read the criteria in $BLOCK; nothing was launched"
  if [ -n "$have" ]; then
    [ "$have" = "$want" ] && return 0
    die "Frozen gates in $DOC already hold criteria that this block does not match. Frozen gates are never rewritten: use a new worktree for this slice or end the old handoff (node $HANDOFF_MJS end \"$DOC\"). Nothing was launched."
  fi
  if [ -z "$want" ]; then
    echo "dispatch-slice: warning: the block has no criterion IDs (lines that start with C1:, - C2:, **C3 ...), so nothing was frozen and ready will not check coverage"
    return 0
  fi
  tmp=$(mktemp) || die "could not create a temp file for the freeze"
  { printf '%s\n' "$cur"; criteria lines < "$BLOCK"; } > "$tmp"
  FREEZE_PRIOR=$cur
  FREEZE_DONE=1
  hoff section set "$DOC" "Frozen gates" --file "$tmp" >/dev/null || { rm -f "$tmp"; die "could not freeze the criteria into $DOC; nothing was launched"; }
  rm -f "$tmp"
}

if [ "$CORRECTIVE" -eq 1 ]; then
  DOC=$(hoff path "$WT" "$SID")
  [ -f "$DOC" ] || die "no handoff for $WT under session $SID; a corrective needs the slice's existing handoff (dispatch the slice first)"
  # No ledger (a slice from before one-slice runs had one): open it and add the
  # row, so a --verdict is recorded and never dropped, with or without --id.
  if [ "$HAS_LEDGER" -ne 1 ]; then
    ensure_ledger
    backfill_row
  elif [ -z "$ID" ]; then
    ID=$(pick_row recent)
    [ -n "$ID" ] || backfill_row
  fi
  # Record the rejection before touching the doc: the ledger refuses one with no
  # verdict (or a review-only one with no provenance tag), and a refused
  # corrective must leave the builder's brief as it was.
  ledger_reject_results
  round_cap
  hoff section set "$DOC" "Next slice" --file "$BLOCK" >/dev/null || die "could not write Next slice into $DOC"
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
freeze_gates
hoff section set "$DOC" "Next slice" --file "$BLOCK" >/dev/null || die "could not write Next slice into $DOC"
ensure_ledger
if [ -z "$ID" ]; then
  ID=$(pick_row open)
  [ -n "$ID" ] || ID=$(pick_row next)
fi
ledger_spec
launch
print_next
