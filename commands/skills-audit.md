---
name: skills-audit
description: "Audit skills for conflicting instructions, runtime compatibility, invocation, repeated work and selective loading. Recommendations only unless changes are explicitly requested."

allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---

# Skill Audit

Review the requested skill, subtree or manifest-listed library for accuracy, efficiency and runtime compatibility. Default to recommendations only; `--apply` or an explicit request to make changes authorizes scoped edits. Do not commit, push or install changes unless requested.

Locate the package using the loaded command path or its Claude/Codex manifests. Verify both manifest skill lists and resolve aliases so duplicates are not counted as authored copies. Preserve unrelated dirt and read the prior audit when available.

Inventory each entrypoint's name, description, invocation/model metadata, size, references and helper callers. Distinguish discovery metadata, invoked context, tool/retry cost and output cost. File bytes are not tokens or per-turn context.

Check these areas:
- Contradictions between rules, examples, modes and output contracts; invented facts and fake precision.
- Invocation on intended and adjacent prompts. Claude and Codex metadata have different semantics. Do not hide a skill solely because it can edit files; action authorization and discovery are separate. Frontmatter changes affect behavior.
- Model/effort inheritance and runtime-specific tools, session IDs and helper paths.
- Repeated questions, obsolete approval gates, duplicated checks and unclear stopping conditions.
- Selective references and deterministic helpers where they reduce actual repeated work. Do not replace one large entrypoint with a shared prompt every skill loads in full.
- Preservation of user conventions, owned paths, frozen criteria, independent acceptance and accurate reporting of missing evidence.

Ground recommendations in surrounding instructions and actual callers. For each, state what to keep, the concrete change, evidence and a realistic validation case. Credit existing wins; zero findings is valid.

Write the requested audit artifact, or `SKILL-AUDIT.md` if none was specified, preserving a prior untracked report rather than overwriting unrelated work. Separate applied changes from proposals. If applying, validate manifest/frontmatter/reference integrity, run changed helper tests and add behavior evals for material changes. Compare no-skill/current/revised behavior on matched tasks when claiming model improvements; measure accuracy, latency, tools, interruptions and cache-aware token use. A text validator is not a model benchmark.
