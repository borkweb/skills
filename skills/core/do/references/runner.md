# Runner and host protocol

The local Node state machine validates contracts, authority, dependencies, snapshots, ownership and budgets. It returns assignments; the host launches tools under actual runtime permissions. It is not a daemon, sandbox or intent classifier. Resolve `../../../scripts/do/cli.mjs` from the loaded skill; `CLI` below means that absolute path. Honor repository command wrappers. Leave `complete`, `offload`, their ledgers and harness configuration untouched.

## Start and inspect

Read [contract.md](contract.md) to create a contract outside the source snapshot. Run `help` once per loaded helper version, then:

```sh
node CLI plan --input /private/path/contract.json
node CLI start --input /private/path/contract.json --owner do-controller-UNIQUE
```

Default storage is `~/.bork/do/runs`; `BORK_DO_STATE_DIR` or `start --root` selects another private persistent directory outside the repository. Use canonical paths, including resolved platform temp symlinks. Report the absolute run path. A controller label is valid; it is not a fabricated native session ID. No Claude session variable is required.

`show --run DIR` returns full journal-derived state. `status --run DIR` (alias `next`) checks current snapshots/evidence and returns active attempts, failures, budgets and eligible work. Use both on resume; otherwise use `show` only for needed contract/history details.

Mutations require `--run DIR --owner ID --revision INTEGER --input PAYLOAD.json`. Use the latest receipt's revision and owner; refresh after conflicts or external changes. Receipts include the event, affected attempt, `state`, eligible `next`, and attention details when blocked. Consume these rather than immediately requesting the same status again. They describe that instant, not a lease on later filesystem state; claims/results still validate freshness. `inspection-required` means the mutation was saved but follow-up inspection failed: inspect and recover, do not replay it. Use a final `status` before reporting completion.

## Execute a node

1. **Claim before work.** Only eligible `next` nodes may start. For host execution, use `claim-host` with `{"node":"...","worker":{"runtime":"host","id":"STABLE_CONTROLLER_ACTOR","model":"KNOWN_ACTIVE_MODEL"}}`. It atomically records launch intent and attachment, consuming one attempt. Keep the same real host identity across assignments; a builder cannot become its reviewer by renaming itself. Delegation uses `claim` with `{"node":"..."}` instead. Keep the returned `attempt.id` and `attempt.snapshot`.
2. **Delegate only when needed.** Read [handoffs.md](handoffs.md), generate/review a packet, retain it using `brief` **before** launch, then attach the actual returned identity using `attach`: `{"node":"...","attempt":"...","worker":{"runtime":"codex-native","id":"ACTUAL_RETURNED_ID","model":"ACTUAL_RESOLVED_MODEL"}}`. Runtimes are `host`, `codex-native`, `claude-native`, `external`. Do not use `claim-host` for another worker. The original host `claim` → `attach` sequence remains supported. A launch intent without attachment may already have launched after a crash; read [recovery.md](recovery.md) before replacement.
3. **Execute and retain evidence.** Save raw commands, exits, counts, observations or artifacts privately outside source scope, without secrets. General verification consumes accepted explicit check results from `next[].inputs`, checks coverage, and runs remaining checks. Reuse only relevant evidence from the assigned snapshot; preserve each gate result and reviewer identity. New writes, failures or a concrete unresolved concern justify fresh checks. Review evidence never becomes a builder's self-approval.
4. **Submit `result`.** Evidence is copied and hashed. Use the original assigned snapshot, including for writing attempts; the runner captures authorized output changes itself.

```json
{
  "node": "g1-o1-work",
  "attempt": "ACTUAL_ATTEMPT_ID",
  "snapshot": "ASSIGNED_SNAPSHOT_DIGEST",
  "status": "pass",
  "summary": "What the actual evidence establishes, including reused check results.",
  "evidence": ["/absolute/private/result.md"]
}
```

Result statuses are `pass`, `fail`, `blocked`, `waiting`. Non-pass terminal results require `category`: `defect`, `evidence`, `environment`, `contract`, `authority`, or `decision`. Required missing coverage is `blocked`, never a pass. `waiting` is only for monitor observations; it does not relaunch or consume another attempt. Use a real host wait facility; do not promise unsupported monitoring.

For a standalone review, `pass` means the assessment was performed, even with DO NOT LAND findings. For an implementation gate, `pass` means the gate passed without blockers. A builder's prose or process exit alone is insufficient. Join all active checks before correction; use [recovery.md](recovery.md) for failure, cancellation or uncertain liveness, and [decisions.md](decisions.md) for a within-contract choice.

Report completion only after all required nodes are accepted, retained evidence is intact, and the final snapshot matches. Hashes are not attestations against a writer of the private state directory. The host remains responsible for omitted dependencies, external-state checks and runtime permissions. Automated external launch, multi-builder scheduling, resource reservation, unattended monitoring and journal repair remain deferred.
