---
name: complete
description: "Drive a coding goal to merge-ready through delegated slices, frozen gates and independent review. Use for complete, run the whole loop or take this to merge-ready; merging requires explicit authorization."
---

# Complete

Drive the stated goal to merge-ready with delegated implementation and independent review. Keep the parent model unchanged. Merge only when explicitly authorized; carry existing authorization forward.

## Route before loading

- **Codex native delegation:** read [codex-orchestration.md](codex-orchestration.md) and [roles.json](roles.json). Resolve worker/reviewer models from that file, overridden by explicit user instructions. Record the resolved values in the run ledger. If a requested model or native tool is unavailable, report it; do not silently switch routes.
- **External sessions requested, or Claude Code:** read [external-orchestration.md](external-orchestration.md), then the `offload` entrypoint. The configured external harness selects its model. This path requires a real Claude session key; do not invent one on another runtime.

Load only the selected route. Both routes preserve owned worktrees, frozen gates, raw evidence, explicit worker identities and independent acceptance. Scale preliminary plan reviews to the changed surface. Reuse valid evidence for unchanged code; repeat affected checks after edits and run integration gates over the final result.
