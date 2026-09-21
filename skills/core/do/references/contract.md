# Creating a durable contract

Read when creating or replanning a run. Defaults and authority are validated by the runner; the host verifies intent and provenance.

Create a JSON input file outside the source snapshot using the environment's file-edit tool. Use real absolute paths, the original request, a short routing rationale, and actual authorization provenance. The host must verify those facts; the runner cannot authenticate prose or infer permission from a classifier score.

```json
{
  "schemaVersion": 1,
  "request": "Fix the parser's empty-input failure; do not commit.",
  "repo": "/absolute/canonical/project",
  "rationale": "An explicit local fix with no delivery authority.",
  "outcomes": [
    {"kind": "diagnose", "goal": "Establish the empty-input failure's cause.", "effects": []},
    {"kind": "implement", "goal": "Reject empty input without changing valid-input behavior.", "effects": ["write"]}
  ],
  "risk": "standard",
  "decisionPolicy": {"mode": "checkpointed", "checkpoints": ["approach", "delivery"], "council": "auto"},
  "surfaces": [],
  "authority": {
    "grants": [{"effect": "write", "source": "User: Fix the parser's empty-input failure; do not commit."}],
    "writePaths": ["src/parser.js", "test/parser.test.js"],
    "protectedPaths": ["package-lock.json"]
  },
  "scope": ["src/parser.js", "test/parser.test.js"],
  "checks": [
    {"id": "parser-regression", "kind": "check", "instruction": "Run the project's verified parser test command; capture exit code and raw output, including the empty-input regression and valid-input cases."}
  ],
  "budgets": {"corrections": 2, "replans": 2, "attempts": 64}
}
```

Supported effects: `write`, `commit`, `push`, `pr`, `merge`, `deploy`, `operate`, `delete`. Every requested effect requires a matching grant with source. Filesystem paths are normalized, literal repository-relative files/directories; no glob expansion, parent traversal, `.git` paths, or traversed symlink parents. Literal brackets such as `app/[id]/page.tsx` are supported; `*` and `?` remain rejected. A write path must be inside snapshot scope and outside protected paths. Exact-file permission includes creating necessary missing parent directories, but not changing existing parent permissions or writing siblings. A broad write directory can contain protected children; they remain forbidden.

Scope controls snapshot coverage. Include relevant consumers, tests, configuration and protected paths. Snapshot hashes include file contents, modes, new/missing paths and symlink text, without following symlinks. They do not prove unchanged external services, omitted files or a symlink target's content. Do not use symlink targets as mutable source scope. The runner rejects more than 10000 paths or 64 MiB; narrow scope rather than silently omitting inputs. It scans explicitly selected directories, including ignored files, so avoid whole build/dependency trees.

`checks` are additional required checks: `id`, `kind` (`check`, `review`, `browser`) and `instruction`. Optional `outcomes` selects zero-based outcome indexes. Without it, checks apply to implementation outcomes if present, otherwise every outcome. This keeps a passing-regression gate out of a preceding diagnostic stage. Checks on delivery/operations run before the action. Surface checks are generated for implementation. The host must add all other required project checks before starting.

`decisionPolicy` defaults as shown. Routine and already-settled choices need no question. Read [decisions.md](decisions.md) only for a material choice or nondefault involvement policy; it contains council triggers and question/ruling payloads. Pending decisions block scheduling and completion. The host must identify and record material choices; the engine cannot infer them from task prose.

Implementation acceptance remains required after later writes. Each later writing outcome includes integration copies of earlier implementation gates (including outcome-specific checks and independent reviews), pinned to its new snapshot before that outcome's report releases successors. `revalidates` links each copy to its original gate. Historical diagnosis and earlier builders are not replayed. These checks consume the ordinary attempt budget; inspect `plan` for sufficient capacity. A failure belongs to the current writing outcome's correction cycle. Old graphs without integration nodes cannot report completion from stale verification; replan/invalidate within existing budgets when safe, never rewrite their saved graph or replay external effects.
