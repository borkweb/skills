#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCH="$SCRIPT_DIR/dispatch.sh"
PARENT_TMPDIR="${TMPDIR:-/tmp}"
SUITE_ROOT=$(mktemp -d "$PARENT_TMPDIR/test-dispatch-args.XXXXXX") || exit 1

cleanup() {
  rm -rf "$SUITE_ROOT"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export TMPDIR="$SUITE_ROOT/tmp"
WORK="$SUITE_ROOT/work"
REPO="$SUITE_ROOT/repo"
BLOCK="$SUITE_ROOT/block.md"
HANDOFF="$SUITE_ROOT/handoff.md"
EMPTY_BLOCK="$SUITE_ROOT/empty-block.md"
BLOCK_DIR="$SUITE_ROOT/block-dir"
UNREADABLE_BLOCK="$SUITE_ROOT/unreadable-block.md"
OUTPUT="$SUITE_ROOT/output"
mkdir -p "$TMPDIR" "$WORK" "$REPO" "$BLOCK_DIR"
printf 'builder block\n' > "$BLOCK"
printf 'handoff\n' > "$HANDOFF"
: > "$EMPTY_BLOCK"
printf 'unreadable\n' > "$UNREADABLE_BLOCK"
chmod 000 "$UNREADABLE_BLOCK"
cd "$WORK" || exit 1

passed=0
failed=0
LAST_STATUS=0
LAST_OUTPUT=""
LAST_SIDE_EFFECT=0

count_launches() {
  find "$TMPDIR" -name 'offload-launch.*' -print | wc -l | tr -d '[:space:]'
}

count_markers() {
  find "$SUITE_ROOT" -name '*.builder' -print | wc -l | tr -d '[:space:]'
}

run_dispatch() {
  local before_launches before_markers after_launches after_markers
  before_launches=$(count_launches)
  before_markers=$(count_markers)
  OFFLOAD_DRY_RUN=1 bash "$DISPATCH" "$@" > "$OUTPUT" 2>&1
  LAST_STATUS=$?
  LAST_OUTPUT=$(cat "$OUTPUT")
  after_launches=$(count_launches)
  after_markers=$(count_markers)
  LAST_SIDE_EFFECT=0
  if [ "$after_launches" -ne "$before_launches" ] ||
     [ "$after_markers" -ne "$before_markers" ]; then
    LAST_SIDE_EFFECT=1
  fi
}

record() {
  local name="$1" ok="$2"
  if [ "$ok" -eq 0 ]; then
    echo "ok $name"
    passed=$((passed + 1))
  else
    echo "not ok $name"
    failed=$((failed + 1))
  fi
}

case_flag_shaped_arg() {
  run_dispatch --handoff "$HANDOFF" --block "$BLOCK"
  [ "$LAST_STATUS" -eq 2 ] &&
    [ "$LAST_SIDE_EFFECT" -eq 0 ] &&
    [[ "$LAST_OUTPUT" == *"dispatch: '--handoff' looks like a flag; dispatch.sh takes positional args only"* ]] &&
    [[ "$LAST_OUTPUT" == *"Usage: dispatch.sh"* ]]
}

case_too_few_args() {
  run_dispatch
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ] ||
    return 1
  run_dispatch "$REPO"
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ]
}

case_too_many_args() {
  run_dispatch "$REPO" "$BLOCK" "$HANDOFF" session extra sixth
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ]
}

case_bad_repo() {
  run_dispatch "$SUITE_ROOT/missing-repo" "$BLOCK" "$HANDOFF" session
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ]
}

case_bad_block() {
  run_dispatch "$REPO" "$SUITE_ROOT/missing-block.md" "$HANDOFF" session
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ] ||
    return 1
  run_dispatch "$REPO" "$BLOCK_DIR" "$HANDOFF" session
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ] ||
    return 1
  run_dispatch "$REPO" "$EMPTY_BLOCK" "$HANDOFF" session
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ] ||
    return 1
  if [ ! -r "$UNREADABLE_BLOCK" ]; then
    run_dispatch "$REPO" "$UNREADABLE_BLOCK" "$HANDOFF" session
    [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ] ||
      return 1
  fi
}

case_block_equals_handoff() {
  run_dispatch "$REPO" "$HANDOFF" "$HANDOFF" session
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ]
}

case_sid_is_a_path() {
  run_dispatch "$REPO" "$BLOCK" "$HANDOFF" path/to/session
  [ "$LAST_STATUS" -eq 2 ] && [ "$LAST_SIDE_EFFECT" -eq 0 ]
}

case_dry_run_happy_path() {
  local expected_repo expected_block expected_handoff
  expected_repo=$(cd -P "$REPO" && pwd)
  expected_block="$(cd -P "${BLOCK%/*}" && pwd)/${BLOCK##*/}"
  expected_handoff="$(cd -P "${HANDOFF%/*}" && pwd)/${HANDOFF##*/}"
  run_dispatch "$REPO" "$BLOCK" "$HANDOFF" session
  [ "$LAST_STATUS" -eq 0 ] &&
    [ "$LAST_SIDE_EFFECT" -eq 0 ] &&
    [[ "$LAST_OUTPUT" == *"REPO=$expected_repo"* ]] &&
    [[ "$LAST_OUTPUT" == *"BLOCK=$expected_block"* ]] &&
    [[ "$LAST_OUTPUT" == *"HANDOFF=$expected_handoff"* ]] &&
    [[ "$LAST_OUTPUT" == *"SID=session"* ]]
}

case_flag_shaped_arg
record flag-shaped-arg "$?"
case_too_few_args
record too-few-args "$?"
case_too_many_args
record too-many-args "$?"
case_bad_repo
record bad-repo "$?"
case_bad_block
record bad-block "$?"
case_block_equals_handoff
record block-equals-handoff "$?"
case_sid_is_a_path
record sid-is-a-path "$?"
case_dry_run_happy_path
record dry-run-happy-path "$?"

echo "TESTS: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
