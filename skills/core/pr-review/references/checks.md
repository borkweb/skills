# Failed and local checks

Read this file when a CI check failed, or when a check has to run on this
machine. A local run happens when CI has no usable result for the check, when CI
is still pending at the join, when a baseline comparison needs per-test results,
or when AUTO-FIX reruns a check on fixed files.

## A CI check failed

CI reports pass or fail per job, not per test, and a PR can add new failures to
a job that was already red. `pr.json` covers only the head commit, so read the
same check at `<merge-base>` from the REST API. Quote the paths in zsh:

```bash
gh api --paginate "repos/<owner>/<repo>/commits/<merge-base>/check-runs?per_page=100" \
  --jq '.check_runs[] | [.name, .status, (.conclusion // "-"), .html_url] | @tsv'
gh api "repos/<owner>/<repo>/commits/<merge-base>/status" \
  --jq '.statuses[] | [.context, .state, (.target_url // "-")] | @tsv'
```

The REST values are lowercase. The combined status reports `pending` when a
commit has no statuses at all, so read the `statuses` list, not the combined
state. Then:

- **Base passed** → the PR caused the failure. It is a regression, and it is
  CRITICAL.
- **Base failed too** → compare the failing test names. For GitHub Actions,
  `gh run view --job <job-id> --log-failed` gives them for both commits. The
  job ID is the number after `/job/` in the head check's `detailsUrl`, and the
  `id` field of the base check run. Same names →
  `FAIL (baseline)`. New names → a regression. No per-test logs (external CI
  often reports only a status) → use the local baseline comparison below. If
  that can't run, record `FAIL (base also red, new failures not ruled out)`.
  That is unverified readiness, not a confirmed defect.
- **No base result** → use the local baseline comparison, or record the failure
  as unverified.

## A CI check is still pending at the ceiling

Run it locally as described below. If a local run isn't allowed, record
`PENDING (CI)` as missing evidence.

**Fork PRs:** if the user answered **No** to Step 1's fork question, run
nothing locally. Record each check that needed a local run as `NOT RUN (fork)`.

## Run a check

1. **Use the repo's own command.** Step 3a already found it in `package.json`
   scripts, `composer.json` scripts, the `Makefile`, `bin/`, or the repo's
   `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`. Never call a guessed `jest` or
   `phpunit` directly. Skip any command with external effects (deploys, network
   writes, shared databases) and record it as `NOT RUN` with the reason.
2. **Prepare a worktree first.** A fresh worktree has no dependencies and no
   local config. Copy the gitignored local config and fixtures the checks read
   (for example `.env`) from the main checkout. Never copy build directories. In
   a scratchpad clone there is no main checkout: a check that needs local config
   is `NOT RUN`. **In place, install and copy nothing** — use the checkout as it
   is.

   **Clone dependencies when the lockfile matches.** For each dependency
   directory (`node_modules` for `package-lock.json`, `vendor` for
   `composer.lock`, and so on), compare the lockfile in the worktree with the
   one in the main checkout. If they are identical and the main checkout has
   the directory, clone it with APFS copy-on-write. That is near-instant and
   uses no extra disk until a file changes:

   ```bash
   cmp -s <main>/package-lock.json <worktree>/package-lock.json \
     && [ -d <main>/node_modules ] && [ ! -e <worktree>/node_modules ] \
     && cp -cR <main>/node_modules <worktree>/node_modules
   ```

   If the directory already exists (a reused worktree can have it, because it's
   gitignored), keep it when the lockfile matches. Otherwise install with the
   lockfile's tool (`npm ci`, `composer install`, and
   so on). If a check fails to load a module after a clone (a native module
   that recorded its absolute path, for example), delete the cloned directory,
   install it, and rerun that check once. `cp -c` needs APFS; on any other file
   system, install.
3. **Snapshot the tree after setup.** Save `git status --porcelain` to
   `<scratchpad>/status-after-setup.txt`. An install can create files (a
   `composer.lock` the repo doesn't track, for example). This snapshot, not
   `status-before.txt`, is Step 4's baseline.
4. **Launch in the background, with full output to files.** Set `CI=true` for
   every check, and pass `--ci` to jest, so snapshot tools fail on a missing
   snapshot instead of writing one into a tracked path. Run one test suite at a
   time, because suites share ports, databases and fixtures. Start lint, type
   checks and static analysis alongside it, because they share nothing. Write
   each command's full output to `<scratchpad>/check-<name>.log`, and never
   pipe it through `tail`.

Run steps 2–4 as one background job — install, snapshot, then the suite — so the
host pass doesn't wait for a dependency install. Read each log when its job
reports completion; don't poll it.

A check passes on a runner summary that shows tests ran, never on exit `0`
alone. Zero tests run (jest "No tests found", pytest "no tests ran", phpunit "No
tests executed") is FAIL. Record a local result as `PASS (local)` or
`FAIL (local)`.

## Local baseline comparison

Use this when a check failed and CI can't say whether the same tests fail on the
base (no base result, or no per-test logs to compare). Run the **same failing
tests** at `<merge-base>` in a second detached worktree, prepared the same way:

```bash
git worktree add --detach <scratchpad>/pr-review-<number>-base <merge-base>
```

- A test that fails at both commits is a baseline failure: `FAIL (baseline)`.
- A test that passes at the merge-base and fails at the head is a regression.
  It is CRITICAL.

Remove the base worktree when done, under the artifact rules below.

## Check artifacts (Steps 4 and 7)

Checks write untracked files, such as `.phpunit.result.cache` or `coverage/`.
When local checks ran, Step 4 compares against `status-after-setup.txt` and
splits any difference in two:

- **Check artifacts** are new *untracked* files that the checks wrote. List them
  in one line. They are not a contract violation. In place, report them and
  leave them for the user.
- **Everything else** is any change to a *tracked* file, from any source,
  including a check. Step 4's mode rules apply to it.

`git worktree remove` refuses any untracked file, check artifacts included. In
Step 7, if the only untracked paths in a worktree are the artifacts listed in
Step 4, delete exactly those paths, then remove the worktree. Delete nothing
that Step 4 did not list. Never `--force` the removal.
