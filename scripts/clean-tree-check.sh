#!/usr/bin/env bash
# Check whether the working tree is clean.
# Exits 0 (clean) or 1 (dirty). On dirty, prints the short status to stdout.
# Used by: qa, design-review.

set -u

status=$(git status --porcelain 2>/dev/null)
if [ -z "$status" ]; then
    exit 0
fi

printf '%s\n' "$status"
exit 1
