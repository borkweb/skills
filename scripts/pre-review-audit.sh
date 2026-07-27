#!/usr/bin/env bash
# Standard pre-review system audit: recent commits, diff stat, stash state,
# and recently-touched files. Prints a single block to stdout that all the
# plan-* and review-style skills can ingest.
# Usage: pre-review-audit.sh [base-branch]
#
# Used by: plan-deep-review, plan-eng-review, plan-design-review,
# plan-devex-review, review.

set -u

base="${1:-}"
if [ -z "$base" ]; then
    here="$(cd "$(dirname "$0")" && pwd)"
    base="$("$here/detect-base-branch.sh")"
fi

echo "=== Base branch ==="
echo "$base"
echo

echo "=== Recent history (last 30) ==="
git log --oneline -30 2>/dev/null || echo "(no history)"
echo

echo "=== Diff against base ($base) ==="
git diff "$base" --stat 2>/dev/null || echo "(no diff)"
echo

echo "=== Stashed work ==="
if git stash list 2>/dev/null | head -10 | grep -q .; then
    git stash list | head -10
else
    echo "(none)"
fi
echo

echo "=== Recently touched files (last 30 days, top 20) ==="
git log --since=30.days --name-only --format= 2>/dev/null \
    | grep -v '^$' \
    | sort \
    | uniq -c \
    | sort -rn \
    | head -20
