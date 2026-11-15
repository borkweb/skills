#!/usr/bin/env bash
# One command that runs every check in this repo and prints one summary line per group:
#
#   validate     ruby scripts/validate-skills.rb
#   py-scripts   python3 -m unittest discover -s scripts -p 'test_*.py'
#   py-evals     python3 -m unittest discover -s evals -p 'test_*.py'
#   node         node --test over every test_*.mjs and *.test.mjs under hooks, skills and evals (found by glob)
#   shell        bash over every skills/**/test-*.sh
#
# A group fails when anything in it fails or when it ran zero tests. A skipped test is counted and its
# line (which names what was missing) is printed. Exit 0 only when every group passes and the sentinel
# check below is clean.
#
# Sentinels (K1): every child runs with an allowlisted environment, never this shell's own. The live run
# and handoff pointers the child sees all lead into a fresh sentinel tree (a `running` run.json, a runs
# home, a handoff file, the handoffs, orchestrator and repo-rules homes), and TMPDIR is a fresh directory.
# After the groups, any added, removed or changed file in the sentinel tree (content hashes, not mtimes)
# fails the run and is printed, as does any file left in that TMPDIR that names a sentinel path. HOME stays
# real: git and the toolchains need it.
#
#   bash scripts/test-all.sh                      every group under the sentinel guard
#   bash scripts/test-all.sh --guard -- <cmd>...  only <cmd>, under the same guard (the checker's self-test uses this)
#
# TEST_ALL_SENTINEL_STATE (default running) exists for that self-test only: a sentinel that is not
# `running` must be refused at setup. Written for macOS /bin/bash 3.2: no bash 4 features.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT" || exit 1

BASE=$(mktemp -d "${TMPDIR:-/tmp}/test-all.XXXXXX") || { echo "test-all: cannot create a temp dir" >&2; exit 1; }
BASE=$(cd "$BASE" && pwd -P)
SENT="$BASE/sentinel"
SUITE_TMP="$BASE/tmp"
OUT="$BASE/out"
mkdir -p "$SENT" "$SUITE_TMP" "$OUT"

# ---- sentinels ---------------------------------------------------------------------------------------------

make_sentinels() {
  local state="${TEST_ALL_SENTINEL_STATE:-running}"
  # Only these three words are ever written into the run.json template, so a crafted value cannot add a key.
  case "$state" in
    running|done|failed) ;;
    *) echo "test-all: TEST_ALL_SENTINEL_STATE must be running, done or failed (self-test only); refusing to run" >&2; return 1 ;;
  esac
  mkdir -p "$SENT/runs-home" "$SENT/handoffs" "$SENT/agent-handoffs" "$SENT/orchestrator" "$SENT/repo-rules" "$SENT/sentinel-run"
  printf 'sentinel handoff\n' > "$SENT/handoffs/h.md"
  cat > "$SENT/sentinel-run/run.json" <<EOF
{
  "schema": 1,
  "id": "sentinel-run",
  "run_dir": "$SENT/sentinel-run",
  "repo": null,
  "goal": "sentinel: no test may touch this run",
  "task": null,
  "state": "$state",
  "summary": "",
  "delivery": null,
  "questions": [],
  "messages": [],
  "architect": { "harness": null, "session_id": null, "frontend": null, "tab": null, "pane": null },
  "launched_by": "self",
  "revision": 1,
  "signal_revision": 0,
  "orchestrator_ack": 0,
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "history": [{ "at": "2026-01-01T00:00:00.000Z", "state": "$state", "note": "created" }]
}
EOF
  # A sentinel that is not live proves nothing: the liveness checks skip a done or failed run.
  # Parsed, not grepped: the check reads the same value a child that parses run.json will see.
  if ! node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(r.schema === 1 && r.state === "running" ? 0 : 1)' "$SENT/sentinel-run/run.json" 2> /dev/null; then
    echo "test-all: the sentinel run.json state is '$state', not running; refusing to run, the guard would prove nothing" >&2
    return 1
  fi
  return 0
}

# One "<sha256>  <relative path>" line per file, "d/l  <path>" per directory or link, sorted. Content, not mtime.
snapshot() {
  ( cd "$SENT" && find . -print | LC_ALL=C sort | while IFS= read -r f; do
      if [ -f "$f" ] && [ ! -L "$f" ]; then
        printf '%s  %s\n' "$(shasum -a 256 < "$f" | cut -d' ' -f1)" "$f"
      else
        printf 'd/l  %s\n' "$f"
      fi
    done ) > "$1"
}

# The child environment: an allowlist from this shell, then the sentinel pointers and a fresh TMPDIR.
CHILD_ENV=()
build_child_env() {
  local name
  CHILD_ENV=(env -i)
  for name in $(compgen -e); do
    case "$name" in
      PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TERM|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|\
      HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|http_proxy|https_proxy|no_proxy|all_proxy|LC_*)
        CHILD_ENV+=("$name=${!name}") ;;
    esac
  done
  # With no LANG (a stripped or CI environment) python 3.9 coerces the C locale and adds LC_CTYPE to the
  # environment its tests inspect, and ruby reads Markdown as US-ASCII. Default to UTF-8 when none is set.
  [ -z "${LANG:-}" ] && CHILD_ENV+=("LANG=en_US.UTF-8")
  CHILD_ENV+=(
    "BORK_RUN_DIR=$SENT/sentinel-run" "BORK_RUN_ID=sentinel-run" "BORK_RUNS_HOME=$SENT/runs-home"
    "OFFLOAD_HANDOFF=$SENT/handoffs/h.md" "OFFLOAD_SESSION_ID=sentinel-session"
    "AGENT_HANDOFFS_DIR=$SENT/agent-handoffs" "ORCHESTRATOR_HOME=$SENT/orchestrator" "BORK_REPO_RULES_DIR=$SENT/repo-rules"
    "TMPDIR=$SUITE_TMP" "PYTHONDONTWRITEBYTECODE=1"
  )
}

# Prints every sentinel violation; returns 1 when there is one.
check_sentinels() {
  local bad=0 line rel hit
  snapshot "$BASE/after.snap"
  if ! diff "$BASE/before.snap" "$BASE/after.snap" > "$BASE/snap.diff"; then
    bad=1
    sed -n 's/^[<>] [^ ]*  //p' "$BASE/snap.diff" | LC_ALL=C sort -u | while IFS= read -r rel; do
      echo "SENTINEL CHANGED: $SENT/${rel#./}"
    done
  fi
  # Backstop: a file the suite left in its TMPDIR that names a sentinel path. Tests delete their own boxes,
  # so a clean scan is not proof that nothing leaked, but a hit is a failure.
  grep -rlF -e "$SENT" -e "${SENT#/private}" "$SUITE_TMP" 2> /dev/null | while IFS= read -r hit; do
    echo "SENTINEL LEAK: $hit names a sentinel path"
  done > "$BASE/leaks.txt"
  if [ -s "$BASE/leaks.txt" ]; then bad=1; cat "$BASE/leaks.txt"; fi
  return "$bad"
}

# ---- groups --------------------------------------------------------------------------------------------------

FAILED_GROUPS=0
report() { # label tests failed skipped
  local verdict=PASS
  if [ "$3" -gt 0 ]; then verdict=FAIL; fi
  if [ "$2" -eq 0 ]; then verdict=FAIL; fi
  [ "$verdict" = FAIL ] && FAILED_GROUPS=$((FAILED_GROUPS + 1))
  local note=""
  if [ "$2" -eq 0 ]; then note="  (ran zero tests)"; fi
  printf '%-10s %s  tests=%s failed=%s skipped=%s%s\n' "$1" "$verdict" "$2" "$3" "$4" "$note"
}
show_skips() { grep -E ' \.\.\. skipped ' "$1" | head -50; }
show_failures() { # output file
  echo "  full output: $1"
  grep -E -B1 -A20 '^[[:space:]]*not ok|^(FAIL|ERROR):' "$1" | head -150
}
num() { # file, regex with one capture group -> the LAST match or 0: the runner's summary comes last, so a test's own output cannot set it
  local v
  v=$(sed -n -E "s/$2/\\1/p" "$1" | tail -1)
  echo "${v:-0}"
}

group_validate() {
  # -Eutf-8: with no LANG (a stripped or CI environment) ruby reads the Markdown as US-ASCII and the validator crashes.
  "${CHILD_ENV[@]}" ruby -Eutf-8 scripts/validate-skills.rb > "$OUT/validate.out" 2>&1
  local rc=$? f=0
  [ "$rc" -ne 0 ] && f=1
  report validate 1 "$f" 0
  [ "$f" -ne 0 ] && show_failures "$OUT/validate.out"
  return 0
}

group_python() { # label dir
  "${CHILD_ENV[@]}" python3 -m unittest discover -v -s "$2" -p 'test_*.py' > "$OUT/$1.out" 2>&1
  local rc=$? n f=0 e=0 s=0 res
  n=$(num "$OUT/$1.out" '^Ran ([0-9]+) tests? in .*')
  # The runner's own result is the LAST OK or FAILED line; read every count from that one line only.
  res=$(grep -E '^(OK|FAILED)( |$)' "$OUT/$1.out" | tail -1)
  case "$res" in
    *failures=*) f=$(echo "$res" | sed -n -E 's/.*failures=([0-9]+).*/\1/p') ;;
  esac
  case "$res" in
    *errors=*) e=$(echo "$res" | sed -n -E 's/.*errors=([0-9]+).*/\1/p') ;;
  esac
  case "$res" in
    *skipped=*) s=$(echo "$res" | sed -n -E 's/.*skipped=([0-9]+).*/\1/p') ;;
  esac
  f=$((f + e))
  if [ "$rc" -ne 0 ] && [ "$f" -eq 0 ]; then f=1; fi
  report "$1" "$n" "$f" "$s"
  show_skips "$OUT/$1.out"
  [ "$f" -gt 0 ] && show_failures "$OUT/$1.out"
  return 0
}

group_node() {
  local files=() f
  while IFS= read -r f; do files+=("$f"); done < <(find hooks skills evals -path '*/node_modules' -prune -o \( -name 'test_*.mjs' -o -name '*.test.mjs' \) -print 2> /dev/null | LC_ALL=C sort)
  if [ "${#files[@]}" -eq 0 ]; then : > "$OUT/node.out"; report node 0 0 0; return 0; fi
  "${CHILD_ENV[@]}" node --test --test-reporter=tap "${files[@]}" > "$OUT/node.out" 2>&1
  local rc=$? n fl c s
  n=$(num "$OUT/node.out" '^# tests ([0-9]+)')
  fl=$(num "$OUT/node.out" '^# fail ([0-9]+)')
  c=$(num "$OUT/node.out" '^# cancelled ([0-9]+)')
  s=$(num "$OUT/node.out" '^# skipped ([0-9]+)')
  fl=$((fl + c))
  if [ "$rc" -ne 0 ] && [ "$fl" -eq 0 ]; then fl=1; fi
  report node "$n" "$fl" "$s"
  grep -E '# SKIP' "$OUT/node.out" | head -50
  [ "$fl" -gt 0 ] && show_failures "$OUT/node.out"
  return 0
}

group_shell() {
  local n=0 f=0 s=0 script
  : > "$OUT/shell.out"
  while IFS= read -r script; do
    n=$((n + 1))
    echo "== $script" >> "$OUT/shell.out"
    if ! "${CHILD_ENV[@]}" bash "$script" >> "$OUT/shell.out" 2>&1; then
      f=$((f + 1))
      echo "FAIL $script" >> "$OUT/shell.out"
    fi
  done < <(find skills -name 'test-*.sh' 2> /dev/null | LC_ALL=C sort)
  s=$(grep -ciE '^SKIP' "$OUT/shell.out")
  report shell "$n" "$f" "${s:-0}"
  grep -iE '^SKIP' "$OUT/shell.out" | head -50
  [ "$f" -gt 0 ] && show_failures "$OUT/shell.out"
  return 0
}

# ---- main ------------------------------------------------------------------------------------------------------

GUARD_CMD=()
if [ "${1:-}" = "--guard" ]; then
  shift
  [ "${1:-}" = "--" ] && shift
  if [ "$#" -eq 0 ]; then echo "usage: test-all.sh [--guard -- <cmd>...]" >&2; rm -rf "$BASE"; exit 2; fi
  GUARD_CMD=("$@")
elif [ "$#" -gt 0 ]; then
  echo "usage: test-all.sh [--guard -- <cmd>...]" >&2; rm -rf "$BASE"; exit 2
fi

if ! make_sentinels; then rm -rf "$BASE"; exit 1; fi
# An interrupt leaves the sentinel tree and the outputs in place, so say where, as a failure does.
trap 'echo "test-all: interrupted; kept for inspection: $BASE" >&2; exit 130' INT TERM HUP
snapshot "$BASE/before.snap"
build_child_env

STATUS=0
if [ "${#GUARD_CMD[@]}" -gt 0 ]; then
  "${CHILD_ENV[@]}" "${GUARD_CMD[@]}" || STATUS=1
else
  group_validate
  group_python py-scripts scripts
  group_python py-evals evals
  group_node
  group_shell
  [ "$FAILED_GROUPS" -gt 0 ] && STATUS=1
fi

if check_sentinels; then
  [ "${#GUARD_CMD[@]}" -eq 0 ] && echo "sentinels unchanged, no sentinel path left in the suite TMPDIR"
else
  STATUS=1
fi

trap - INT TERM HUP
if [ "$STATUS" -eq 0 ]; then
  rm -rf "$BASE"
else
  echo "test-all: FAILED; kept for inspection: $BASE" >&2
fi
exit "$STATUS"
