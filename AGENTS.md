@/Users/matt/.codex/RTK.md

# Bork skill library

This repository ships skills for Codex and Claude Code. Use `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` for the canonical skill inventory; keep their skill lists and release versions synchronized. `skills/core/` contains original workflows and `skills/gstack/` contains adapted workflows. Supporting commands, hooks and scripts live in their named root directories.

Keep skills focused on non-obvious decisions and real workflow invariants. Inherit the user's active model unless an explicit orchestration role configuration applies. Load conditional references only when relevant. Runtime-specific metadata, tools and session IDs are not interchangeable.

Preserve intentional formatting rules, frozen acceptance criteria, ownership checks and independent review evidence. Report missing verification honestly. Recommendation-only work must not mutate skills; authorized changes must preserve unrelated dirt. Do not commit or push unless requested.

For validation, use `ruby scripts/validate-skills.rb` and the relevant helper tests. `python3 -m unittest discover -s scripts -p 'test_*.py'` covers Python helpers; Node helper tests are colocated with their implementations. Prompt eval cases live under `evals/` and measure behavior separately from structural validation.
