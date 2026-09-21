# Recovery and interrupted work

Read before retry, correction, invalidation, replan, cancellation, reconciliation, adoption or lock recovery. For a material choice, use [decisions.md](decisions.md).

| Command | Payload | Rule |
| --- | --- | --- |
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
