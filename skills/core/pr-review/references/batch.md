# Batch lane (`--prepare-only`)

Read this file when Step 0 finds `--prepare-only <dir>`. `bork:do` passes it
when it reviews several PRs at once: it runs this skill once per PR in a
subagent, then shows the user every planned review together and posts the ones
the user confirms. This run is one of those lanes. It prepares one review and
stops before Step 5b.

A lane never posts, never asks the user anything, and never removes its
worktree. `do` owns all three.

## What changes

| Step | In a lane |
|---|---|
| 0, item 1 (harness) | The brief names the host and the peer. Use them. Don't infer the harness from your tool list: a subagent never has `AskUserQuestion`. Still confirm the peer CLI with `command -v`. |
| 0, item 4 (repo) | The brief names the checkout that matches the PR's repo. Work from it. If it doesn't match the PR URL, stop and report; don't clone. |
| 0, item 6 (prefetch) | Skip the `git fetch` line. `do` fetched every base and head once per repo, so parallel lanes don't race on the same remote refs. Still run the `gh api` comments fetch. If `git cat-file -e <headRefOid>` fails, stop and report. |
| 1 | Skip it. The brief passes `--comment-only` or `--auto-fix`, `--worktree`, and `--run-fork` when the user allowed it. A fork PR without `--run-fork` means **No**. |
| 2 | Always a worktree, at `<dir>/worktree`. Every scratch file this skill puts under `<scratchpad>` goes under `<dir>` instead. |
| 3a | Read CI exactly as Step 3a says, but start no local check. Lanes share one machine and `do` runs one suite at a time. List each check that needs a local run under **Checks pending** in `result.md`, with its command, its reason and `pre-fix`, and record it as `PENDING (local, deferred)`. |
| 3c (AUTO-FIX) | The post-fix reruns that [auto-fix.md](auto-fix.md) asks for are deferred too. List each under **Checks pending** as `post-fix`. |
| 4 | If tracked files changed in COMMENT-ONLY mode, stop and report the `git diff`. Don't ask, and don't revert. |
| 5a | Unchanged. |
| 5b, 5c | Don't run them. Write the files below, then stop. |
| 6 | Write it to `result.md`, not chat. |
| 7 | Write the summary box to `result.md`. If any check is pending, label the verdict `provisional`. Skip the cleanup. In AUTO-FIX mode, write the patch to `<dir>/fixes.patch`, as [auto-fix.md](auto-fix.md) describes. |

AUTO-FIX in a lane always means a worktree plus a patch. Don't raise the
AUTO-FIX + worktree warning; `do` stated it when it asked.

[incremental.md](incremental.md) asks whether to stop when nothing new was
pushed. A lane stops, and says so in `result.md`.

## What the lane writes

All in `<dir>`:

- `payload.json`: the Step 5c payload with the critical comments only. Build
  it exactly as Step 5c describes, with the marker, `commit_id` and
  `"event": "COMMENT"`. Don't post it.
- `informational.json`: the INFORMATIONAL findings, numbered as Step 5b would
  number them, each body already in Step 5c's `**INFORMATIONAL — <title>**`
  form:

  ```json
  {
    "recommended": [1, 4],
    "reason": "<one line: why these and not the rest>",
    "findings": [
      { "n": 1, "path": "app/jobs/import.rb", "line": 31, "side": "RIGHT", "body": "..." }
    ]
  }
  ```

- `preview.md`: exactly what Step 5b would print, critical comments,
  out-of-diff findings, staleness note and informational list, followed by
  one line naming the recommended informational findings and why.
- `result.md`: the Step 6 report, the Step 7 box, **Checks pending** (or
  `None.`), the worktree path and the patch path (or `none`).

Then return one line:

```
<PR URL> — <verdict>[ provisional] — <n> critical, <m> informational, <k> checks pending — <dir>
```
