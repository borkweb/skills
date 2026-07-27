#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAITER="$SCRIPT_DIR/wait-for-ready.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/wait-for-ready-test.XXXXXX")
TEST_SHELL_PID="${BASHPID:-$$}"
PIDS=()
PASSED=0
FAILED=0
CASE_ERROR=""

track_pid() {
  PIDS+=("$1")
}

stop_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local pid
  [ "${BASHPID:-$$}" = "$TEST_SHELL_PID" ] || return 0
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

new_handoff() {
  local name="$1" handoff="$TEST_ROOT/$name.md"
  printf '%s\n' '---' 'status: dispatched' '---' > "$handoff"
  printf '%s\n' "$handoff"
}

start_sleep_builder() {
  sleep 999 &
  BUILDER_PID=$!
  track_pid "$BUILDER_PID"
}

start_busy_builder() {
  ( while :; do :; done ) &
  BUILDER_PID=$!
  track_pid "$BUILDER_PID"
}

start_noisy_sidecar_builder() {
  local sidecar="$TEST_ROOT/SkyComputerUseClient"
  printf '%s\n' '#!/bin/sh' 'while :; do :; done' > "$sidecar"
  chmod +x "$sidecar"
  (
    sleep 999 &
    idle_child=$!
    "$sidecar" &
    sidecar_child=$!
    trap 'kill "$idle_child" "$sidecar_child" 2>/dev/null || true; wait "$idle_child" "$sidecar_child" 2>/dev/null || true' EXIT
    trap 'exit 0' TERM INT
    wait "$idle_child"
  ) &
  BUILDER_PID=$!
  track_pid "$BUILDER_PID"
}

start_light_work_builder() {
  (
    trap 'exit 0' TERM INT
    while :; do
      i=0
      while [ "$i" -lt 20000 ]; do
        i=$(( i + 1 ))
      done
      sleep 1
    done
  ) &
  BUILDER_PID=$!
  track_pid "$BUILDER_PID"
}

run_waiter_capped() {
  local output="$1" cap="$2" waiter_pid watchdog_pid watchdog_flag rc
  shift 2
  env -u TMUX "$@" > "$output" 2>&1 &
  waiter_pid=$!
  track_pid "$waiter_pid"
  watchdog_flag="$TEST_ROOT/watchdog.$waiter_pid"
  (
    sleeper=""
    trap '[ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null; exit 0' TERM INT
    sleep "$cap" &
    sleeper=$!
    wait "$sleeper"
    : > "$watchdog_flag"
    kill "$waiter_pid" 2>/dev/null || true
  ) &
  watchdog_pid=$!
  track_pid "$watchdog_pid"

  wait "$waiter_pid"
  rc=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  [ ! -f "$watchdog_flag" ] || return 124
  return "$rc"
}

fail_case() {
  CASE_ERROR="$1"
  return 1
}

case_ready() {
  local handoff output updater rc
  handoff=$(new_handoff ready)
  output="$TEST_ROOT/ready.out"
  start_sleep_builder
  printf '%s\n' "$BUILDER_PID" > "$handoff.builder"
  (
    sleep 2
    printf '%s\n' '---' 'status: results-ready' '---' > "$handoff"
  ) &
  updater=$!
  track_pid "$updater"

  run_waiter_capped "$output" 10 \
    WFR_GRACE=3 WFR_POLL=1 \
    "$WAITER" "$handoff" builder 20 15
  rc=$?
  stop_pid "$BUILDER_PID"
  [ "$rc" -eq 0 ] || { fail_case "exit=$rc expected=0"; return 1; }
  grep -q '^WAITER: ready$' "$output" ||
    fail_case "missing WAITER: ready"
}

case_dead_pid() {
  local handoff output dead_pid rc
  handoff=$(new_handoff dead-pid)
  output="$TEST_ROOT/dead-pid.out"
  ( : ) &
  dead_pid=$!
  wait "$dead_pid" 2>/dev/null || true
  printf '%s\n' "$dead_pid" > "$handoff.builder"

  run_waiter_capped "$output" 5 \
    WFR_GRACE=3 WFR_POLL=1 \
    "$WAITER" "$handoff" builder 20 15
  rc=$?
  [ "$rc" -eq 3 ] || { fail_case "exit=$rc expected=3"; return 1; }
  grep -q 'WAITER: builder-exited-without-ready' "$output" ||
    fail_case "missing builder-exited-without-ready"
}

case_never_started() {
  local handoff output rc
  handoff=$(new_handoff never-started)
  output="$TEST_ROOT/never-started.out"

  run_waiter_capped "$output" 10 \
    WFR_GRACE=5 WFR_POLL=1 \
    "$WAITER" "$handoff" builder 20 15
  rc=$?
  [ "$rc" -eq 3 ] || { fail_case "exit=$rc expected=3"; return 1; }
  grep -q 'WAITER: never-started after 5s' "$output" ||
    fail_case "missing never-started"
}

case_idle() {
  local handoff output started elapsed rc
  handoff=$(new_handoff idle)
  output="$TEST_ROOT/idle.out"
  start_sleep_builder
  printf '%s\n' "$BUILDER_PID" > "$handoff.builder"
  started=$(date +%s)

  run_waiter_capped "$output" 20 \
    WFR_GRACE=3 WFR_POLL=1 WFR_IDLE_CPU_CENTIS=200 \
    "$WAITER" "$handoff" builder 30 8
  rc=$?
  elapsed=$(( $(date +%s) - started ))
  stop_pid "$BUILDER_PID"
  [ "$rc" -eq 5 ] || { fail_case "exit=$rc expected=5"; return 1; }
  [ "$elapsed" -le 20 ] ||
    { fail_case "elapsed=${elapsed}s expected<=20s"; return 1; }
  grep -q 'WAITER: builder-idle' "$output" ||
    fail_case "missing builder-idle"
}

case_busy_not_idle() {
  local handoff output updater rc
  handoff=$(new_handoff busy-not-idle)
  output="$TEST_ROOT/busy-not-idle.out"
  start_busy_builder
  printf '%s\n' "$BUILDER_PID" > "$handoff.builder"
  (
    sleep 11
    printf '%s\n' '---' 'status: results-ready' '---' > "$handoff"
  ) &
  updater=$!
  track_pid "$updater"

  run_waiter_capped "$output" 18 \
    WFR_GRACE=3 WFR_POLL=1 WFR_IDLE_CPU_CENTIS=200 \
    "$WAITER" "$handoff" builder 25 8
  rc=$?
  stop_pid "$BUILDER_PID"
  [ "$rc" -eq 0 ] || { fail_case "exit=$rc expected=0"; return 1; }
  ! grep -q 'WAITER: builder-idle' "$output" ||
    { fail_case "busy builder reported idle"; return 1; }
  grep -q '^WAITER: ready$' "$output" ||
    fail_case "missing WAITER: ready"
}

case_handoff_deleted() {
  local handoff output deleter rc
  handoff=$(new_handoff handoff-deleted)
  output="$TEST_ROOT/handoff-deleted.out"
  start_sleep_builder
  printf '%s\n' "$BUILDER_PID" > "$handoff.builder"
  (
    sleep 2
    rm -f "$handoff"
  ) &
  deleter=$!
  track_pid "$deleter"

  run_waiter_capped "$output" 10 \
    WFR_GRACE=3 WFR_POLL=1 \
    "$WAITER" "$handoff" builder 20 15
  rc=$?
  stop_pid "$BUILDER_PID"
  [ "$rc" -eq 3 ] || { fail_case "exit=$rc expected=3"; return 1; }
  grep -q 'WAITER: handoff-deleted' "$output" ||
    fail_case "missing handoff-deleted"
}

case_idle_with_noisy_sidecar() {
  local handoff output started elapsed rc
  handoff=$(new_handoff idle-with-noisy-sidecar)
  output="$TEST_ROOT/idle-with-noisy-sidecar.out"
  start_noisy_sidecar_builder
  printf '%s\n' "$BUILDER_PID" > "$handoff.builder"
  started=$(date +%s)

  run_waiter_capped "$output" 12 \
    WFR_GRACE=3 WFR_POLL=1 WFR_IDLE_CPU_CENTIS=200 \
    "$WAITER" "$handoff" builder 30 8
  rc=$?
  elapsed=$(( $(date +%s) - started ))
  stop_pid "$BUILDER_PID"
  [ "$rc" -eq 5 ] || { fail_case "exit=$rc expected=5"; return 1; }
  [ "$elapsed" -le 20 ] ||
    { fail_case "elapsed=${elapsed}s expected<=20s"; return 1; }
  grep -q 'WAITER: builder-idle' "$output" ||
    fail_case "missing builder-idle"
}

case_production_ratio() {
  local handoff output updater rc

  handoff=$(new_handoff production-ratio-idle)
  output="$TEST_ROOT/production-ratio-idle.out"
  start_sleep_builder
  printf '%s\n' "$BUILDER_PID" > "$handoff.builder"
  run_waiter_capped "$output" 12 \
    WFR_GRACE=3 WFR_POLL=1 WFR_IDLE_CPU_CENTIS=3 \
    "$WAITER" "$handoff" builder 20 8
  rc=$?
  stop_pid "$BUILDER_PID"
  [ "$rc" -eq 5 ] ||
    { fail_case "idle sub-case exit=$rc expected=5"; return 1; }
  grep -q 'WAITER: builder-idle' "$output" ||
    { fail_case "idle sub-case missing builder-idle"; return 1; }

  handoff=$(new_handoff production-ratio-working)
  output="$TEST_ROOT/production-ratio-working.out"
  start_light_work_builder
  printf '%s\n' "$BUILDER_PID" > "$handoff.builder"
  (
    sleep 9
    printf '%s\n' '---' 'status: results-ready' '---' > "$handoff"
  ) &
  updater=$!
  track_pid "$updater"

  run_waiter_capped "$output" 15 \
    WFR_GRACE=3 WFR_POLL=1 WFR_IDLE_CPU_CENTIS=3 \
    "$WAITER" "$handoff" builder 20 8
  rc=$?
  stop_pid "$BUILDER_PID"
  [ "$rc" -eq 0 ] ||
    { fail_case "working sub-case exit=$rc expected=0"; return 1; }
  ! grep -q 'WAITER: builder-idle' "$output" ||
    { fail_case "working sub-case reported idle"; return 1; }
  grep -q '^WAITER: ready$' "$output" ||
    fail_case "working sub-case missing WAITER: ready"
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

run_case ready case_ready
run_case dead-pid case_dead_pid
run_case never-started case_never_started
run_case idle case_idle
run_case busy-not-idle case_busy_not_idle
run_case handoff-deleted case_handoff_deleted
run_case idle-with-noisy-sidecar case_idle_with_noisy_sidecar
run_case production-ratio case_production_ratio

echo "TESTS: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
