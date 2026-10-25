# Incremental re-review

Read this file when Step 0 finds an earlier `/pr-review` review
(`<last-reviewed>`) and the user didn't pass `--full`.

## Step 2b: Choose the scope

Use **INCREMENTAL** only when both of these hold. Otherwise use **FULL**, with
`<scope-base>` set to `<merge-base>`.

- `git merge-base --is-ancestor <last-reviewed> <headRefOid>` succeeds. A
  rebase or force-push fails this.
- `git rev-list --merges <last-reviewed>..<headRefOid>` prints nothing. If the
  author merged the base into the branch, `<last-reviewed>..<headRefOid>`
  contains the base's changes, and the reviewers would review the base's code.

For INCREMENTAL, `<scope-base>` is `<last-reviewed>`. If `<last-reviewed>`
equals `<headRefOid>`, nothing new was pushed: say so, and ask whether to stop
or run with `--full`.

Checks, staleness and the verdict always cover the whole PR, whatever the scope.

## Step 3b: Add this bullet to the host contract and the peer brief

> - An earlier review covered the PR up to `<last-reviewed>`. Report only
>   problems in `<last-reviewed>..<headRefOid>`, including problems that the
>   new commits cause in older code. Use `git diff <merge-base> <headRefOid>`
>   for context only.

## Step 3b: Recheck the earlier CRITICAL comments

Do this yourself while the host pass runs. The incremental reviewers look only
at new commits, so they won't find an old problem again. Recheck two sources:

- each `/pr-review` comment in `existing-comments.jsonl` whose title starts
  with `**CRITICAL —`;
- each CRITICAL finding in the bodies in `earlier-reviews.jsonl`. These are the
  findings that couldn't go inline: lines outside the diff, and `FILE: none`
  check findings. Recheck a check finding against the current check result.

Read that code at `<headRefOid>` and mark each one:

- **RESOLVED** — the problem is gone.
- **STILL PRESENT** — the problem is still there. It counts as an unresolved
  CRITICAL finding for the verdict. Don't post it again.
- **OUTDATED** — the code it pointed at is gone. Check whether the problem moved
  with the code before you mark it.

Report the counts in Step 7's **Earlier CRITICAL** row.
