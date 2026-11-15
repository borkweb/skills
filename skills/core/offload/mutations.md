# Mutation checks

Read when [SKILL.md](SKILL.md) step 3 asks you to run a criterion's mutation. `mutate.mjs` applies each edit to a detached worktree at one head, runs the mutation's one-test command, restores the worktree and prints one line per mutation. It uses only the Node standard library and never changes the main checkout.

## The mutations file

A JSON array. Each entry:

- `id`: unique, `[A-Za-z0-9._-]+`.
- `file`: path relative to the repo root, a regular file at the head.
- One edit: `find` and `replace` (literal text, `find` must occur exactly once in `file`), or `patch` (a unified diff that touches only `file`).
- `cmd`: the narrowest command that goes red, run with `sh -c` from the worktree root. The criterion's one-test command.
- `tests` (optional): the test files `cmd` depends on. Without it the runner uses the tokens of `cmd` that are tracked files. `--since` uses them to decide what can carry.

Bad input exits 2 before any worktree exists and names the entry.

## Running it

Run it from your own checkout, never the builder's worktree. Write each criterion's exact edit against the slice head into `mutations.json` in the run directory. The builder may propose the literal on its evidence line; you check it against the criterion's frozen intent. Then:

`node "<offload skill base>/mutate.mjs" <run dir>/mutations.json --head <slice head sha> --log-dir <run dir>/mutate-<short head>`

The evidence names the `Head:` line the runner prints. A corrective reruns with `--since` ([correctives.md](correctives.md) *Reruns and the delta review*).

## Routing the results

- `survived`, `error baseline-red` and `error no-tests` (the frozen test is missing or does not select a test at the head) send the slice back as a corrective without spending a review round.
- `edit-not-found`, `edit-ambiguous` and `patch-failed` are errors in your own `mutations.json`: fix it and rerun.
- `setup-failed`, `spawn-failed`, `timeout`, `signal` and `restore-failed` mean rerun, or record the check `NOT RUN`, never a send-back.
- A `killed ... timeout` line is not a full kill. A mutation run is limited to min(`--timeout`, max(10 s, 10 times its cmd's baseline time)), which is 10 s for a fast one-test cmd, so an edit that only slows a test past that limit is reported killed. Open the log of every such line and accept it only when a hang is the expected effect of the edit. Otherwise run that cmd by hand, outside the runner, and record what it shows.
- Exit 1 carries per-mutation results to route as above. Exit 2 (usage or input) and exit 3 (the runner could not run) are your own input or environment problem, never a send-back.

## Options

`--head <rev>` is required: resolve it to the slice head, because your own checkout is usually not on it. `--log-dir <dir>` must be new or empty and holds one log per command run plus `results.json`. `--jobs <n>` sets the pool size and `--serial` means one. `--timeout <seconds>` limits each command (default 300); a mutation that hangs after a green baseline counts as killed and its line says `timeout` (see *Routing the results*). `--setup <cmd>` runs once in each new worktree before any command there, for example to link `node_modules`. `--pass-env <NAME>` passes one more variable, such as `SSH_AUTH_SOCK`; the run, session and tool variables (`BORK_RUN_*`, `OFFLOAD_*`, `CLAUDE_*`, `CODEX_*`, `HERDR_*`, `GIT_*`) are refused. `--since <results.json>` carries unchanged kills ([correctives.md](correctives.md) *Reruns and the delta review*).

Every command gets an allowlisted environment (the names `scripts/test-all.sh` allows) and its own empty `TMPDIR` and state directories, so a mutation that disables a guard cannot reach live run state.

## Output

`Head:`, `Logs:` and `Pool:` come first. Then one line per mutation in input order: `killed`, `survived`, `error <token>` or `carried`. The last line counts them. Exit 0 means every mutation is killed or carried.

## Remote runtime

Use `--serial`. A remote `cmd` must sync the whole worktree, deletes included, before each run, because the runner restores only the local worktree. After the run, re-sync the sandbox to the clean head.

## Interrupted runs

SIGINT, SIGTERM and SIGHUP stop the running commands, remove every worktree the run made and exit 130, 143 or 129. SIGKILL cannot be handled and can leave `mutate-<pid>-<n>` worktrees; remove them with `git worktree remove --force <path>`.
