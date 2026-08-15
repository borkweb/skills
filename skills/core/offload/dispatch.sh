#!/usr/bin/env bash
# Launch a builder session seeded with a builder-block file, full-auto and
# launched from the repo dir. The builder HARNESS comes from the borkweb-skills
# config via harness.mjs (ordered failover chain, quota-aware); a candidate that
# cannot be launched falls through to the next. Frontend priority per candidate:
# herdr tab (inside a herdr TUI) -> tmux window -> Terminal.app (macOS) -> headless.
# Inside herdr the chain does NOT continue: a herdr tab is the only correct
# frontend there, so a failed `tab create` exits non-zero rather than quietly
# relocating the builder outside the tab model (set OFFLOAD_ALLOW_NON_HERDR=1 to
# restore the old fall-through).
# Interactive frontends run a generated launch script so no env/prompt has to be
# escaped through the frontend's quoting layers.
# Usage: dispatch.sh <repo_dir> <block_file> <handoff_path> <session_id> [<profile-spec>]
#   profile-spec (optional): harness[:model[:effort]] — bypasses config resolution.
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: dispatch.sh <repo_dir> <block_file> <handoff_path> <session_id> [<profile-spec>]' \
    '  profile-spec (optional): harness[:model[:effort]] — bypasses config resolution.' >&2
}

validation_error() {
  echo "$1" >&2
  usage
  exit 2
}

resolve_existing_path() {
  local path="$1" dir base link
  while [ -L "$path" ]; do
    link=$(readlink "$path")
    if [[ "$link" = /* ]]; then
      path="$link"
    else
      case "$path" in
        */*) path="${path%/*}/$link" ;;
        *) path="$link" ;;
      esac
    fi
  done
  case "$path" in
    */*)
      dir="${path%/*}"
      base="${path##*/}"
      [ -n "$dir" ] || dir="/"
      ;;
    *)
      dir="."
      base="$path"
      ;;
  esac
  dir=$(cd -P -- "$dir" 2>/dev/null && pwd) || return 1
  printf '%s/%s\n' "${dir%/}" "$base"
}

validate_args() {
  local arg handoff_parent

  for arg in "$@"; do
    case "$arg" in
      -*)
        validation_error "dispatch: '$arg' looks like a flag; dispatch.sh takes positional args only"
        ;;
    esac
  done

  if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    validation_error "dispatch: expected 4 or 5 positional arguments; got $#"
  fi

  REPO="$1"
  BLOCK="$2"
  HANDOFF="$3"
  SID="$4"
  OVERRIDE="${5:-}"

  [ -d "$REPO" ] ||
    validation_error "dispatch: repo directory not found: $REPO"
  [ -f "$BLOCK" ] ||
    validation_error "dispatch: block file not found or not a regular file: $BLOCK"
  [ -r "$BLOCK" ] ||
    validation_error "dispatch: block file not readable: $BLOCK"
  [ -s "$BLOCK" ] ||
    validation_error "dispatch: block file is empty: $BLOCK"
  [ -f "$HANDOFF" ] ||
    validation_error "dispatch: handoff file not found or not a regular file: $HANDOFF"

  case "$HANDOFF" in
    */*)
      handoff_parent="${HANDOFF%/*}"
      [ -n "$handoff_parent" ] || handoff_parent="/"
      ;;
    *) handoff_parent="." ;;
  esac
  [ -d "$handoff_parent" ] && [ -w "$handoff_parent" ] ||
    validation_error "dispatch: handoff parent directory not writable: $handoff_parent"

  RESOLVED_REPO=$(cd -P -- "$REPO" 2>/dev/null && pwd) ||
    validation_error "dispatch: could not resolve repo directory: $REPO"
  RESOLVED_BLOCK=$(resolve_existing_path "$BLOCK") ||
    validation_error "dispatch: could not resolve block file: $BLOCK"
  RESOLVED_HANDOFF=$(resolve_existing_path "$HANDOFF") ||
    validation_error "dispatch: could not resolve handoff file: $HANDOFF"

  [ "$RESOLVED_BLOCK" != "$RESOLVED_HANDOFF" ] ||
    validation_error "dispatch: block file and handoff file must be different paths"
  [ -n "$SID" ] ||
    validation_error "dispatch: session id must not be empty"
  case "$SID" in
    */*) validation_error "dispatch: session id must not contain '/': $SID" ;;
  esac
}

validate_args "$@"

if [ "${OFFLOAD_DRY_RUN:-}" = "1" ]; then
  printf 'REPO=%s\nBLOCK=%s\nHANDOFF=%s\nSID=%s\n' \
    "$RESOLVED_REPO" "$RESOLVED_BLOCK" "$RESOLVED_HANDOFF" "$SID"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Candidate lines: harness<TAB>model<TAB>effort<TAB>permissionMode<TAB>command
# ('-' = unset), best-first — the harness.mjs `select --plain` contract.
if [ -n "$OVERRIDE" ]; then
  IFS=: read -r o_h o_m o_e <<< "$OVERRIDE"
  CANDIDATES=$(printf '%s\t%s\t%s\t-\t-\n' "$o_h" "${o_m:--}" "${o_e:--}")
else
  CANDIDATES=$(node "$SCRIPT_DIR"/harness.mjs select --plain)
fi

# --- deterministic turn-end wiring ------------------------------------------
# The builder harness itself reports the moment it stops and waits for input, so
# a blocked builder wakes the architect in seconds instead of relying on anyone
# noticing. Codex: its `notify` hook fires on agent-turn-complete; we install a
# wrapper that touches "$HANDOFF.turn-ended" (watched by wait-for-ready.sh) and
# chains to whatever notify the user already configured. Claude: Stop and
# Notification hooks via --settings do the same. Other harnesses fall back to
# the bridge's idle/timeout backstops.

# The user's own codex notify argv (config.toml `notify = [...]`), one element
# per line, so installing our hook chains rather than replaces it.
codex_user_notify() {
  local cfg="${CODEX_HOME:-$HOME/.codex}/config.toml" line
  [ -f "$cfg" ] || return 0
  line=$(grep -m1 -E '^[[:space:]]*notify[[:space:]]*=' "$cfg" 2>/dev/null) || return 0
  printf '%s\n' "$line" | grep -oE '"[^"]*"' | sed 's/^"//;s/"$//'
}

# TOML override value for `codex -c`: our wrapper first, then the user's argv.
codex_notify_toml() {
  local arr el
  arr=$(printf '"%s","%s","%s"' bash "$SCRIPT_DIR/notify-turn-ended.sh" "$HANDOFF")
  while IFS= read -r el; do
    [ -n "$el" ] || continue
    arr="$arr,\"$el\""
  done < <(codex_user_notify)
  printf 'notify=[%s]' "$arr"
}

# Claude settings JSON: Stop (turn over) and Notification (permission prompt)
# both mean "builder stopped and needs input" — touch the same marker.
claude_hook_settings() {
  local hook
  hook=$(printf '[{"hooks":[{"type":"command","command":"touch %s.turn-ended"}]}]' "$HANDOFF")
  printf '{"hooks":{"Stop":%s,"Notification":%s}}' "$hook" "$hook"
}

# Activity sidecar for the wait bridge's idle detector: the harness's session-log
# dir grows whenever the builder streams model output, which distinguishes
# "working but CPU-quiet" from "stopped". No known dir -> no sidecar (the bridge
# falls back to its CPU heuristic).
write_activity_sidecar() {
  local h="$1" dir=""
  case "$h" in
    codex)  dir="${CODEX_HOME:-$HOME/.codex}/sessions" ;;
    claude) dir="$HOME/.claude/projects" ;;
  esac
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    printf '%s\n' "$dir" > "$HANDOFF.activity"
  else
    rm -f "$HANDOFF.activity"
  fi
}

# The verified interactive launch command per harness (prompt = block contents).
# claude defaults to --permission-mode auto: routine work auto-approves, genuinely
# risky commands still gate, and the builder tab is watchable so a rare prompt is
# answerable (the wait bridge's timeout is the backstop). permissionMode in the
# config profile overrides it.
interactive_cmd() {
  # shellcheck disable=SC2016  # single quotes are deliberate: $(cat ...) expands in the builder pane, not here
  local h="$1" model="$2" effort="$3" pmode="$4" m="" e="" pm="auto"
  [ "$model" != "-" ] && m="$model"
  [ "$effort" != "-" ] && e="$effort"
  [ "$pmode" != "-" ] && pm="$pmode"
  case "$h" in
    codex)
      printf 'codex %s%s--config %s --dangerously-bypass-approvals-and-sandbox "$(cat %s)"' \
        "${m:+-m $(printf %q "$m") }" \
        "${e:+--config model_reasoning_effort=$(printf %q "$e") }" \
        "$(printf %q "$(codex_notify_toml)")" \
        "$(printf %q "$BLOCK")" ;;
    claude)
      printf 'claude --permission-mode %s %s--settings %s "$(cat %s)"' \
        "$(printf %q "$pm")" "${m:+--model $(printf %q "$m") }" \
        "$(printf %q "$(claude_hook_settings)")" "$(printf %q "$BLOCK")" ;;
    opencode)
      printf 'OPENCODE_CONFIG_CONTENT=%s opencode %s--prompt "$(cat %s)"' \
        "$(printf %q '{"permission":{"*":"allow"}}')" \
        "${m:+--model $(printf %q "$m") }" "$(printf %q "$BLOCK")" ;;
    pi)
      printf 'pi %s"$(cat %s)"' "${m:+--model $(printf %q "$m") }" "$(printf %q "$BLOCK")" ;;
    grok)
      printf 'grok --always-approve %s"$(cat %s)"' \
        "${m:+--model $(printf %q "$m") }" "$(printf %q "$BLOCK")" ;;
    *) return 1 ;;
  esac
}

# Substitute the block path into a raw `command` template from the config.
build_custom() {
  local template="$1"
  printf '%s' "${template//__PROMPT_FILE__/$(printf %q "$BLOCK")}"
}

# Headless form per harness; fails for interactive-only harnesses (pi, grok)
# unless the profile carries a raw command. claude -p cannot answer permission
# prompts, so auto mode would strand the run — headless claude keeps full bypass.
run_headless() {
  local h="$1" model="$2" effort="$3" custom="$4" out m="" e=""
  [ "$model" != "-" ] && m="$model"
  [ "$effort" != "-" ] && e="$effort"
  # Register this run as the live builder for the handoff; clear on exit so a
  # later dispatch's guard sees it finish (parity with the interactive path).
  [ -n "$MARKER" ] && { echo $$ > "$MARKER"; trap 'rm -f "$MARKER"' EXIT; }
  out=$(mktemp -t offload-result.XXXXXX) && mv "$out" "$out.md" && out="$out.md"
  case "$h" in
    codex)
      ( cd "$REPO" && OFFLOAD_HANDOFF="$HANDOFF" CLAUDE_CODE_SESSION_ID="$SID" \
          codex exec ${m:+-m "$m"} ${e:+--config "model_reasoning_effort=$e"} \
            --dangerously-bypass-approvals-and-sandbox -C "$REPO" \
            --output-last-message "$out" - < "$BLOCK" ) ;;
    claude)
      ( cd "$REPO" && OFFLOAD_HANDOFF="$HANDOFF" CLAUDE_CODE_SESSION_ID="$SID" \
          claude -p --dangerously-skip-permissions ${m:+--model "$m"} \
            "$(cat "$BLOCK")" > "$out" ) ;;
    opencode)
      ( cd "$REPO" && OFFLOAD_HANDOFF="$HANDOFF" CLAUDE_CODE_SESSION_ID="$SID" \
          opencode run ${m:+--model "$m"} "$(cat "$BLOCK")" > "$out" ) ;;
    *)
      [ "$custom" = "-" ] && return 1
      ( cd "$REPO" && OFFLOAD_HANDOFF="$HANDOFF" CLAUDE_CODE_SESSION_ID="$SID" \
          bash -c "$(build_custom "$custom")" > "$out" ) ;;
  esac && echo "dispatch: ran $h headless; builder's final message at $out"
}

# Write a self-contained launch script (cd + env + harness command). Everything
# is escaped once here; the frontends only ever run `bash <launch>`.
# When a builder MARKER is set, the script records its own pid to the marker and
# clears it on exit (so a later dispatch can tell a live builder from a finished
# one) — which requires NOT exec'ing the harness, so the EXIT trap survives to
# clean up. With no marker it exec's as before.
make_launch() {
  local cmd="$1" f
  f=$(mktemp -t offload-launch.XXXXXX) && mv "$f" "$f.sh" && f="$f.sh"
  {
    echo '#!/usr/bin/env bash'
    echo "cd $(printf %q "$REPO")"
    echo "export OFFLOAD_HANDOFF=$(printf %q "$HANDOFF")"
    echo "export CLAUDE_CODE_SESSION_ID=$(printf %q "$SID")"
    if [ -n "$MARKER" ]; then
      printf 'echo $$ > %s\n' "$(printf %q "$MARKER")"
      printf 'trap %s EXIT\n' "$(printf %q "rm -f $MARKER")"
      echo "$cmd"
    else
      echo "exec $cmd"
    fi
  } > "$f"
  echo "$f"
}

# Pull the new pane's id out of `herdr tab create` JSON. Prefer jq; fall back to a
# sed scrape of the root_pane object so a missing jq doesn't break dispatch.
parse_pane_id() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.result.root_pane.pane_id // empty'
  else
    sed -n 's/.*"root_pane":{[^}]*"pane_id":"\([^"]*\)".*/\1/p'
  fi
}

# Pull the new TAB's id out of `herdr tab create` JSON. A response carrying a pane
# but no tab id is not a new tab — reporting it as one is how a builder ends up
# somewhere other than where the dispatch line claims.
parse_tab_id() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.result.tab.tab_id // .result.root_pane.tab_id // empty'
  else
    sed -n 's/.*"tab":{[^}]*"tab_id":"\([^"]*\)".*/\1/p'
  fi
}

# Scrape the workspace_id out of `herdr pane current` JSON (socket fallback used only
# when the injected env var is absent). Same jq-then-sed shape as parse_pane_id.
parse_workspace_id() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.result.pane.workspace_id // empty'
  else
    sed -n 's/.*"workspace_id":"\([^"]*\)".*/\1/p'
  fi
}

# Try the interactive frontends for one candidate's launch script.
# Returns 0 when a frontend accepted the launch, 1 when none is available.
launch_interactive() {
  local launch="$1" h="$2"
  # herdr TUI: create a dedicated tab and run the launch script in its pane. Only
  # taken when actually inside a herdr session (HERDR_ENV) with the CLI available.
  if [ -n "${HERDR_ENV:-}" ] && command -v herdr >/dev/null 2>&1; then
    # Land the builder tab in THIS session's workspace, not herdr's active/default
    # one. herdr injects HERDR_WORKSPACE_ID into every pane; fall back to the
    # current pane's workspace over the socket if it is somehow unset.
    local workspace="${HERDR_WORKSPACE_ID:-}" pane tab out err rc
    [ -z "$workspace" ] && workspace=$(herdr pane current --current 2>/dev/null | parse_workspace_id)
    err=$(mktemp -t herdr-tab-err 2>/dev/null) || err=""
    out=$(herdr tab create ${workspace:+--workspace "$workspace"} --cwd "$REPO" \
      --label builder --no-focus 2>"${err:-/dev/null}")
    rc=$?
    pane=$(printf '%s' "$out" | parse_pane_id)
    tab=$(printf '%s' "$out" | parse_tab_id)
    # Require a tab id, not just a pane: a pane without a new tab means the
    # builder did NOT get its own tab, however the call exited.
    if [ "$rc" -eq 0 ] && [ -n "$pane" ] && [ -n "$tab" ]; then
      if herdr pane run "$pane" "bash $(printf %q "$launch")" >/dev/null 2>>"${err:-/dev/null}"; then
        [ -n "$err" ] && rm -f "$err"
        echo "dispatch: launched $h in new herdr tab $tab (workspace ${workspace:-?}, root pane $pane) — switch with your herdr tab navigation."
        return 0
      fi
      echo "dispatch: herdr tab $tab was created but 'pane run' failed — the tab is open and empty." >&2
    fi
    # Inside a herdr session a herdr tab is the ONLY correct frontend. The old
    # code fell through to `tmux new-window` here, which puts the builder outside
    # herdr's tab model entirely — it surfaces as a stray pane in the active
    # workspace view — while still printing a cheerful launch line. Silent
    # relocation is worse than a failed dispatch: the architect then watches the
    # wrong place and the bridge reports never-started. Fail loudly instead.
    echo "dispatch: FAILED to open a herdr tab in workspace ${workspace:-<unresolved>} (herdr exit $rc, tab='${tab:-none}', pane='${pane:-none}')." >&2
    [ -n "$err" ] && [ -s "$err" ] && sed 's/^/dispatch:   herdr: /' "$err" >&2
    [ -n "$err" ] && rm -f "$err"
    if [ -z "${OFFLOAD_ALLOW_NON_HERDR:-}" ]; then
      echo "dispatch:   refusing to fall back to tmux/Terminal/headless from inside herdr — the builder would land outside your tabs." >&2
      echo "dispatch:   fix the herdr error above and re-dispatch, or set OFFLOAD_ALLOW_NON_HERDR=1 to allow the old fallback chain." >&2
      exit 1
    fi
    echo "dispatch:   OFFLOAD_ALLOW_NON_HERDR set — falling back to tmux/Terminal/headless." >&2
  fi
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    tmux new-window -c "$REPO" -n builder "bash $(printf %q "$launch")"
    echo "dispatch: launched $h in new tmux window 'builder' — switch with your tmux prefix + window number."
    return 0
  fi
  if [ "$(uname)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    # launch is an mktemp path (no spaces/quotes), safe to embed in the AppleScript string.
    osascript -e "tell application \"Terminal\" to do script \"bash ${launch}\""
    echo "dispatch: launched $h in a new Terminal.app window."
    return 0
  fi
  return 1
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
      [ "${#argv[@]}" -gt 1 ] || return 1
      printf '%s\n' "${argv[1]}"
      return 0
      ;;
    bash|sh|zsh)
      [ "${second##*/}" = "wait-for-ready.sh" ] || return 1
      [ "${#argv[@]}" -gt 2 ] || return 1
      printf '%s\n' "${argv[2]}"
      return 0
      ;;
  esac
  return 1
}

stop_existing_bridges() {
  local candidate_pid command bridge_handoff
  [ -n "$HANDOFF" ] || return 0
  while read -r candidate_pid command; do
    [ -n "${candidate_pid:-}" ] || continue
    if ! bridge_handoff=$(waiter_handoff_from_command "$command"); then
      continue
    fi
    [ "$bridge_handoff" = "$HANDOFF" ] || continue
    if kill "$candidate_pid" 2>/dev/null; then
      echo "dispatch: stopped existing wait bridge for this handoff (pid $candidate_pid)"
    fi
  done < <(ps -axo pid=,command= 2>/dev/null)
}

# One handoff owns at most one builder. Refuse to launch a duplicate while a
# prior builder for this handoff is still alive — the failure mode where a
# second builder races the first and corrupts a freeze. The marker holds the
# live builder's pid; a stale marker (dead pid) is cleared and we proceed.
# OFFLOAD_FORCE=1 replaces a running builder instead of refusing.
MARKER=""
if [ -n "$HANDOFF" ]; then
  MARKER="$HANDOFF.builder"
  if [ -f "$MARKER" ]; then
    OLD_PID=$(cat "$MARKER" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      if [ "${OFFLOAD_FORCE:-}" = "1" ]; then
        echo "dispatch: OFFLOAD_FORCE=1 — replacing running builder (pid $OLD_PID)" >&2
        kill "$OLD_PID" 2>/dev/null || true
        sleep 1
        kill -9 "$OLD_PID" 2>/dev/null || true
        rm -f "$MARKER"
      else
        echo "dispatch: a builder is already running for this handoff (pid $OLD_PID)." >&2
        echo "dispatch: stop it first, or set OFFLOAD_FORCE=1 to replace it — refusing to launch a duplicate." >&2
        exit 2
      fi
    else
      rm -f "$MARKER"  # stale marker from a builder that already exited
    fi
  fi
fi

stop_existing_bridges

# A turn-end marker left by the previous slice's builder is stale — the wake it
# signaled was already delivered. Clear it so the new slice starts clean.
[ -n "$HANDOFF" ] && rm -f "$HANDOFF.turn-ended"

LAUNCHED=""
while IFS=$'\t' read -r h m e pm custom; do
  [ -n "$h" ] || continue
  if [ "${custom:--}" != "-" ]; then
    CMD=$(build_custom "$custom")
  elif ! command -v "$h" >/dev/null 2>&1; then
    echo "dispatch: $h not on PATH; trying next candidate" >&2
    continue
  elif ! CMD=$(interactive_cmd "$h" "$m" "$e" "${pm:--}"); then
    echo "dispatch: no launch template for '$h'; trying next candidate" >&2
    continue
  fi
  write_activity_sidecar "$h"
  LAUNCH=$(make_launch "$CMD")
  if launch_interactive "$LAUNCH" "$h"; then LAUNCHED="$h"; break; fi
  if run_headless "$h" "$m" "$e" "${custom:--}"; then LAUNCHED="$h"; break; fi
  echo "dispatch: $h could not be launched headless; trying next candidate" >&2
done <<< "$CANDIDATES"

[ -n "$LAUNCHED" ] || { echo "dispatch: no configured harness could be launched" >&2; exit 1; }
