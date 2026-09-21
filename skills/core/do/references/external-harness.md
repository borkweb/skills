# External harness selection

Read only when an external builder is requested.

When an external builder is requested, use the existing configuration and resolver rather than inventing another harness preference list. Resolve [harness.mjs](../../offload/harness.mjs) from the loaded package and check it exists. `node <absolute-helper> select --rule N` reads the configured chain; `N` is zero-based and defaults to `0`. Select only a rule whose purpose applies to this task/role (the existing default is implementation builder dispatch, not arbitrary research or review). It reports `chosen`, `candidates`, and skip/demotion notes; show the choice and notes. Explicit user harness/model choices take precedence and must not silently fall through to a different profile.

The resolver honors `BORKWEB_SKILLS_CONFIG` or `~/.borkweb-skills/config.json`. Missing config, no applicable rule, an unavailable required model, or a missing observable launcher needs a user decision or a paste-ready handoff—not `init`, a fabricated session identity, or an implicit harness switch. Do not modify the shared config without authorization. A selected permission mode is not authorization to weaken sandbox/approval controls.

Do not call legacy `dispatch.sh` directly from `do`: it couples launch to an owned Claude-session mailbox and can relax runtime permissions. An explicitly requested existing `offload` workflow should use `offload` itself with its real session identity and ownership checks, rather than having two controllers schedule the same worker. Any supplied legacy mailbox is read-only context unless that separate workflow has explicitly assigned ownership. Never hand-edit it or bypass an ownership refusal.
