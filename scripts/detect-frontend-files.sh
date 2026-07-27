#!/usr/bin/env bash
# List frontend files changed against the base branch.
# Usage: detect-frontend-files.sh [base-branch]
# If no base branch is given, calls detect-base-branch.sh.
# Prints up to 50 filenames (one per line). Empty output = no frontend changes.
#
# Used by: review, design-review.

set -u

base="${1:-}"
if [ -z "$base" ]; then
    here="$(cd "$(dirname "$0")" && pwd)"
    base="$("$here/detect-base-branch.sh")"
fi

git fetch origin "$base" --quiet 2>/dev/null || true
git diff "origin/$base" --name-only 2>/dev/null \
    | grep -E '\.(css|scss|less|tsx|jsx|vue|svelte|html|astro|mdx|blade\.php|twig|erb|hbs)$' \
    | head -50
