#!/usr/bin/env bash
# Launch a builder session seeded with a builder-block file, full-auto and
# launched from the repo dir. The builder HARNESS comes from the borkweb-skills
# config via harness.mjs (ordered failover chain, quota-aware); a candidate that
# cannot be launched falls through to the next. Frontend priority per candidate:
# herdr tab (inside a herdr TUI) -> tmux window -> Terminal.app (macOS) -> headless.
# Interactive frontends run a generated launch script so no env/prompt has to be
# escaped through the frontend's quoting layers.
# Usage: dispatch.sh <repo_dir> <block_file> <handoff_path> <session_id> [<profile-spec>]
#   profile-spec (optional): harness[:model[:effort]] — bypasses config resolution.
set -euo pipefail

REPO="$1"; BLOCK="$2"; HANDOFF="${3:-}"; SID="${4:-}"; OVERRIDE="${5:-}"
[ -f "$BLOCK" ] || { echo "dispatch: block file not found: $BLOCK" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Candidate lines: harness<TAB>model<TAB>effort<TAB>permissionMode<TAB>command
# ('-' = unset), best-first — the harness.mjs `select --plain` contract.
if [ -n "$OVERRIDE" ]; then
  IFS=: read -r o_h o_m o_e <<< "$OVERRIDE"
  CANDIDATES=$(printf '%s\t%s\t%s\t-\t-\n' "$o_h" "${o_m:--}" "${o_e:--}")
else
  CANDIDATES=$(node "$SCRIPT_DIR/harness.mjs" select --plain)
fi

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
      printf 'codex %s%s--dangerously-bypass-approvals-and-sandbox "$(cat %s)"' \
        "${m:+-m $(printf %q "$m") }" \
        "${e:+--config model_reasoning_effort=$(printf %q "$e") }" \
        "$(printf %q "$BLOCK")" ;;
    claude)
      printf 'claude --permission-mode %s %s"$(cat %s)"' \
        "$(printf %q "$pm")" "${m:+--model $(printf %q "$m") }" "$(printf %q "$BLOCK")" ;;
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
    local workspace="${HERDR_WORKSPACE_ID:-}" pane
    [ -z "$workspace" ] && workspace=$(herdr pane current --current 2>/dev/null | parse_workspace_id)
    pane=$(herdr tab create ${workspace:+--workspace "$workspace"} --cwd "$REPO" --label builder --no-focus 2>/dev/null | parse_pane_id)
    if [ -n "$pane" ]; then
      herdr pane run "$pane" "bash $(printf %q "$launch")" >/dev/null 2>&1
      echo "dispatch: launched $h in new herdr tab 'builder' (pane $pane) — switch with your herdr tab navigation."
      return 0
    fi
    echo "dispatch: herdr detected but 'tab create' failed; falling back to tmux/Terminal/headless." >&2
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
  LAUNCH=$(make_launch "$CMD")
  if launch_interactive "$LAUNCH" "$h"; then LAUNCHED="$h"; break; fi
  if run_headless "$h" "$m" "$e" "${custom:--}"; then LAUNCHED="$h"; break; fi
  echo "dispatch: $h could not be launched headless; trying next candidate" >&2
done <<< "$CANDIDATES"

[ -n "$LAUNCHED" ] || { echo "dispatch: no configured harness could be launched" >&2; exit 1; }
