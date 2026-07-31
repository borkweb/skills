#!/usr/bin/env bash
# Tests for notify-turn-ended.sh — the codex notify hook that records turn-end
# for the wait bridge and chains to the user's original notify program.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOTIFY="$SCRIPT_DIR/notify-turn-ended.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/notify-turn-ended-test.XXXXXX")
PASSED=0
FAILED=0
CASE_ERROR=""

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT INT TERM

fail_case() {
  CASE_ERROR="$1"
  return 1
}

TURN_JSON='{"type":"agent-turn-complete","turn-id":"t1","last-assistant-message":"done"}'
OTHER_JSON='{"type":"some-future-event"}'

case_touches_marker_on_turn_complete() {
  local handoff="$TEST_ROOT/h1.md"
  : > "$handoff"
  bash "$NOTIFY" "$handoff" "$TURN_JSON" ||
    { fail_case "nonzero exit"; return 1; }
  [ -f "$handoff.turn-ended" ] ||
    fail_case "marker not touched"
}

case_ignores_other_event_types() {
  local handoff="$TEST_ROOT/h2.md"
  : > "$handoff"
  bash "$NOTIFY" "$handoff" "$OTHER_JSON" ||
    { fail_case "nonzero exit"; return 1; }
  [ ! -f "$handoff.turn-ended" ] ||
    fail_case "marker touched for a non-turn-complete event"
}

case_chains_to_original_notify() {
  local handoff="$TEST_ROOT/h3.md" chain_log="$TEST_ROOT/chain.log" chain="$TEST_ROOT/orig-notify"
  : > "$handoff"
  printf '%s\n' '#!/usr/bin/env bash' "printf '%s\n' \"\$@\" > '$chain_log'" > "$chain"
  chmod +x "$chain"
  bash "$NOTIFY" "$handoff" "$chain" turn-ended "$TURN_JSON" ||
    { fail_case "nonzero exit"; return 1; }
  [ -f "$handoff.turn-ended" ] ||
    { fail_case "marker not touched when chaining"; return 1; }
  [ -f "$chain_log" ] ||
    { fail_case "original notify not invoked"; return 1; }
  grep -q 'turn-ended' "$chain_log" ||
    { fail_case "original notify missing its own fixed args"; return 1; }
  grep -q 'agent-turn-complete' "$chain_log" ||
    fail_case "original notify did not receive the JSON payload"
}

case_broken_chain_still_exits_zero() {
  local handoff="$TEST_ROOT/h4.md"
  : > "$handoff"
  bash "$NOTIFY" "$handoff" "$TEST_ROOT/does-not-exist" "$TURN_JSON" ||
    { fail_case "nonzero exit with broken chain"; return 1; }
  [ -f "$handoff.turn-ended" ] ||
    fail_case "marker not touched despite broken chain"
}

case_no_json_is_a_quiet_noop() {
  local handoff="$TEST_ROOT/h5.md"
  : > "$handoff"
  bash "$NOTIFY" "$handoff" ||
    { fail_case "nonzero exit with no payload"; return 1; }
  [ ! -f "$handoff.turn-ended" ] ||
    fail_case "marker touched with no payload"
}

run_case() {
  local name="$1" function_name="$2"
  CASE_ERROR=""
  if "$function_name"; then
    echo "ok $name"
    PASSED=$(( PASSED + 1 ))
  else
    echo "not ok $name - $CASE_ERROR"
    FAILED=$(( FAILED + 1 ))
  fi
}

run_case touches-marker-on-turn-complete case_touches_marker_on_turn_complete
run_case ignores-other-event-types case_ignores_other_event_types
run_case chains-to-original-notify case_chains_to_original_notify
run_case broken-chain-still-exits-zero case_broken_chain_still_exits_zero
run_case no-json-is-a-quiet-noop case_no_json_is_a_quiet_noop

echo "TESTS: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
