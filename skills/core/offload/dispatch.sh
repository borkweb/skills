#!/usr/bin/env bash
# Launch a codex builder session seeded with a builder-block file, full-auto and
# scoped to the repo. Priority: herdr tab (when inside a herdr TUI) -> tmux window
# -> Terminal.app (macOS) -> headless. Interactive frontends run a generated launch
# script so no env/prompt has to be escaped through the frontend's quoting layers.
# Usage: dispatch.sh <repo_dir> <block_file> <handoff_path> <session_id>
set -euo pipefail

REPO="$1"; BLOCK="$2"; HANDOFF="${3:-}"; SID="${4:-}"
[ -f "$BLOCK" ] || { echo "dispatch: block file not found: $BLOCK" >&2; exit 1; }

# Write a self-contained launch script (cd + env + codex). Everything is escaped
# once here with printf %q; the frontends only ever run `bash <launch>`.
make_launch() {
  local f; f=$(mktemp -t offload-launch.XXXXXX) && mv "$f" "$f.sh" && f="$f.sh"
  {
    echo '#!/usr/bin/env bash'
    echo "cd $(printf %q "$REPO")"
    echo "export OFFLOAD_HANDOFF=$(printf %q "$HANDOFF")"
    echo "export CLAUDE_CODE_SESSION_ID=$(printf %q "$SID")"
    echo "exec codex --dangerously-bypass-approvals-and-sandbox \"\$(cat $(printf %q "$BLOCK"))\""
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

LAUNCHED=""

# herdr TUI: create a dedicated tab and run the launch script in its pane. Only
# taken when actually inside a herdr session (HERDR_ENV) with the CLI available.
if [ -n "${HERDR_ENV:-}" ] && command -v herdr >/dev/null 2>&1; then
  LAUNCH=$(make_launch)
  PANE=$(herdr tab create --cwd "$REPO" --label codex-build --no-focus 2>/dev/null | parse_pane_id)
  if [ -n "$PANE" ]; then
    herdr pane run "$PANE" "bash $(printf %q "$LAUNCH")" >/dev/null 2>&1
    echo "dispatch: launched codex in new herdr tab 'codex-build' (pane $PANE) — switch with your herdr tab navigation."
    LAUNCHED=1
  else
    echo "dispatch: herdr detected but 'tab create' failed; falling back to tmux/Terminal/headless." >&2
  fi
fi

if [ -z "$LAUNCHED" ]; then
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    LAUNCH=$(make_launch)
    tmux new-window -c "$REPO" -n codex-build "bash $(printf %q "$LAUNCH")"
    echo "dispatch: launched codex in new tmux window 'codex-build' — switch with your tmux prefix + window number."
  elif [ "$(uname)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    LAUNCH=$(make_launch)
    # LAUNCH is an mktemp path (no spaces/quotes), safe to embed in the AppleScript string.
    osascript -e "tell application \"Terminal\" to do script \"bash ${LAUNCH}\""
    echo "dispatch: launched codex in a new Terminal.app window."
  else
    OUT=$(mktemp -t offload-result.XXXXXX) && mv "$OUT" "$OUT.md" && OUT="$OUT.md"
    ( cd "$REPO" && OFFLOAD_HANDOFF="$HANDOFF" CLAUDE_CODE_SESSION_ID="$SID" \
        codex exec --dangerously-bypass-approvals-and-sandbox -C "$REPO" \
          --output-last-message "$OUT" - < "$BLOCK" )
    echo "dispatch: ran codex headless; builder's final message at $OUT"
  fi
fi
