# Runner and host protocol

The Node runner is a local state machine. It validates contracts and proposes eligible assignments; the current Claude/Codex host executes those assignments using real tools. It is not a daemon, autonomous shell executor, runtime sandbox, or LLM intent classifier. No provider dependency, secret, or network call is required by the runner.

Resolve the helper from the loaded package: `../../../scripts/do/cli.mjs` relative to `skills/core/do/`. The examples use `CLI` as a descriptive placeholder; substitute the absolute helper path. Honor any repository command wrappers. Do not initialize or mutate `complete`, `offload`, their ledgers, or harness configuration.

## Contract

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

`decisionPolicy` defaults as shown; see [decisions.md](decisions.md) for involvement modes, council triggers and exact question/ruling payloads. Pending decisions block scheduling and completion. The host must identify and record material choices; the engine cannot infer them from task prose.

Implementation acceptance remains required after later writes. Each later writing outcome includes integration copies of earlier implementation gates (including outcome-specific checks and independent reviews), pinned to its new snapshot before that outcome's report releases successors. `revalidates` links each copy to its original gate. Historical diagnosis and earlier builders are not replayed. These checks consume the ordinary attempt budget; inspect `plan` for sufficient capacity. A failure belongs to the current writing outcome's correction cycle. Old graphs without integration nodes cannot report completion from stale verification; replan/invalidate within existing budgets when safe, never rewrite their saved graph or replay external effects.

## Lifecycle

```sh
node CLI help
node CLI plan --input /private/path/contract.json
node CLI start --input /private/path/contract.json --owner do-controller-UNIQUE
node CLI status --run /absolute/run-directory
node CLI show --run /absolute/run-directory
```

Default storage is `~/.bork/do/runs`; `BORK_DO_STATE_DIR` or `start --root` can select another private persistent directory. It must be outside the task repository and use canonical paths (resolve platform symlinks such as `/tmp` first). Report the returned absolute run path. Creating a workflow controller label is valid; it is not a fabricated native worker/session identity. `do` does not require `CLAUDE_CODE_SESSION_ID`.

`show` reads the full authoritative journal-derived state. `status`/`next` return revision, current owner, eligible nodes, active attempts, failures, snapshot changes, invalid retained evidence, and exhausted budgets. Mutating commands return a compact receipt: run path, owner, revision, recorded event, and the affected `attempt` when present. A claim's launch identity is `attempt.id` and its assigned digest is `attempt.snapshot`. Preserve the full contract and history in the run, not in every chat message.

Every mutation requires `--run`, `--owner`, `--revision` from the latest state, and `--input` with the documented payload. A stale revision or owner fails; reread before acting. The runner never retries commands for you.

1. **Claim before launch.** `claim` payload: `{"node":"g1-o1-work"}`. Persist the returned attempt ID. Only `status.next` nodes are eligible. A claim is a launch intent, not proof of a running worker.
2. **Prepare the handoff and execute through the host.** For native/external delegation, follow [handoffs.md](handoffs.md): use the existing `handoff` skill, then `brief` with `{"node":"...","attempt":"...","path":"/absolute/temp/handoff.md"}` before launching. Pass the retained `attempt.handoff.path` to the worker. It contains the scoped contract, assigned snapshot, identities, boundaries, frozen criteria and result path. Use host execution for ordinary checks and simple work; use actual native delegation for independent review. External selection reuses applicable existing harness configuration; launch still requires an observable supported host adapter. Do not invoke the legacy offload lifecycle from `do`.
3. **Attach.** Payload: `{"node":"...","attempt":"...","worker":{"runtime":"codex-native","id":"ACTUAL_RETURNED_ID","model":"ACTUAL_RESOLVED_MODEL"}}`. Runtimes are `host`, `codex-native`, `claude-native`, `external`. For host-executed work, use a stable controller actor label and the known active model. External IDs need a verified launcher identity, not just a guessed PID. The same actor must keep the same runtime/ID across assignments. Never invent a different actor to pass the independent-review check.
4. **Collect evidence and submit.** Write raw test results, review response, observations or the requested artifact to private files outside source scope. `result` copies evidence into the private run directory and hashes it. Keep secrets out. Payload example below.
5. **Refresh status.** Inspect failures and eligible work. Join all active checks before requesting correction. Report completion only when all required nodes are accepted and the current snapshot still matches, with execution, findings and delivery status reported separately.

```json
{
  "node": "g1-o1-work",
  "attempt": "ACTUAL_ATTEMPT_ID",
  "snapshot": "ASSIGNED_SNAPSHOT_DIGEST",
  "status": "pass",
  "summary": "The diagnostic report establishes the cause; no source edits were made.",
  "evidence": ["/absolute/private/diagnosis.md"]
}
```

Result statuses: `pass`, `fail`, `blocked`, `waiting`. Non-pass terminal results require `category`: `defect`, `evidence`, `environment`, `contract`, `authority`, or `decision`. A `decision` pause is only a blocked non-external assignment awaiting a within-contract choice; link its node to `question` to resume after the ruling without consuming correction/replan budgets. Include raw commands, exit codes and relevant environment in check evidence; do not pass based only on a builder's prose. `waiting` is only for monitor nodes and records an observation without relaunching or consuming correction attempts. The host must use a real waiting facility and not promise monitoring beyond its capabilities.

In a standalone review route, `pass` means the requested assessment was performed, even if its report says DO NOT LAND. In implementation's verification branch, `pass` means that required gate passed with no blockers. Required missing coverage is `blocked`. Preserve this distinction in the summary and artifact.

The host remains responsible for truthful results, current external-state checks, omitted dependencies and actual runtime permissions. Hashes detect changed evidence; they are not security attestations against an actor able to rewrite the private state directory. The engine never executes a check instruction as a shell command.

## Corrections, recovery and user steering

| Command | Payload | Rule |
| --- | --- | --- |
| `question` | `topic`, `stakes`, `uncertain`, `question`, `options`, `recommendation`, optional `councilRequested`, `node` | At a settled checkpoint, record a choice; optionally link a decision-paused non-external node for resumption after a within-contract ruling |
| `decide` | `decision`, `choice`, `by`, `source`, `rationale`, `evidence`, optional `councilEvidence` | Require the user's ruling where policy says so; council is advice, not authority |
| `reopen-decision` | `decision`, `reason` | Preserve prior resolution and reopen under the same requirements, with workers settled |
| `retry` | `node`, `reason` | Retry failed/blocked read-only work for evidence/environment problems; at most three total attempts on that node |
| `correct` | failing `node`, `reason` | Reset that outcome's builder and descendants after all workers settle; two corrective cycles by default |
| `invalidate` | `reason` | After unexplained snapshot changes and ownership investigation, invalidate the graph conservatively; consumes replan budget |
| `replan` | `reason`, complete `contract` | New versioned graph; preserve prior history, same overall budgets, no authority expansion; at most two by default |
| `cancel` | `reason` | Stop scheduling; mark live workers cancellation-requested; host must actually request cancellation |
| `reconcile` | `node`, `attempt`, `presence`, `reason`, `evidence` | Record `alive`, `absent`, or `unknown` from runtime evidence. Unknown remains live; verified absent becomes blocked/cancelled |
| `recover-result` | Same payload as a passing `result` | Accept verified actual-target completion of an external-effect attempt blocked by absent-worker reconciliation; no live workers or cancellation, no replay, same attempt/snapshot and required evidence |
| `adopt` | `newOwner`, `reason` | Explicit controller handoff, with prior responsibility resolved; fences old-owner mutations and retains worker state |

Read `show` to recover attempt identities after a host interruption. A claimed attempt without a recorded worker may have launched before the crash. Search the actual runtime using the attempt ID and artifacts. Do not dispatch a replacement until absence is verified. If liveness is unknown, leave it unresolved. A bare process exit cannot satisfy a review or test gate.

For stale results, preserve the returned artifact privately, reconcile affected workers, identify the source writer, then invalidate or replan. Do not change the assigned snapshot in a result to make it fit. When expanding scope, preserve the original failed criteria and record the user's ruling rather than hiding the failure.

Recovery in a writing run cannot absorb protected or out-of-write-scope changes. Investigate ownership; restore only your own unauthorized changes when safe, or seek a new scoped decision. Never revert another writer's work to make the runner pass. Missing or changed retained evidence blocks dependency release and completion; invalidate and gather new evidence rather than changing its saved hash.

Attempt and replan counters never reset within a run. An exhausted budget needs an explicit report and user decision; do not create a new run just to evade it. Cancellation does not delete worktrees or artifacts. External actions may already have happened after a crash: retries/replans cannot replay a dispatched external-effect node. After `reconcile` records an absent worker, inspect actual target state. If completion is verified, submit `recover-result` with that evidence for the same attempt. This preserves the reconciliation event, consumes no new attempt, and releases the ordinary postflight check; it does not relaunch the action. Unknown or failed target state stays blocked and needs a separately authorized continuation. A cancelled run cannot be revived this way. A bare process exit or narrative is never completion evidence.

The writer lock is fail-closed. `recover-lock --run DIR` removes only a lock whose local PID is verified absent; unknown hosts, malformed locks and live PIDs need inspection. Do not delete lock files manually. A torn/corrupt journal is preserved and reported; automatic journal repair and legacy-ledger import are not implemented.

## Version-one boundaries

Implemented: all task families, ordered outcomes, deterministic route/effect validation, single-writer state with stale-owner/revision checks, launch intent, host/native/external worker records, read-only fan-out, required evidence, snapshots, bounded corrections/replans, cancellation and reconciliation.

Host-mediated: natural-language intake, real worker launch/liveness/cancellation, test execution, resource isolation, missing-capability handling, and current external-state verification. Runtime sandboxing must enforce permissions where possible; prompts and this ledger alone cannot prevent unauthorized tool calls.

Deferred: automated external launch adapters, multi-builder scheduling, automatic environment reservations, fine-grained cross-run evidence reuse, distributed controller leases, unattended monitoring services, corrupt-journal repair, and Jev. These are not prerequisites for using `do` interactively with the current host. `complete` and all legacy runs remain untouched.
