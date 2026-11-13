# Review worktree

Read the Step 2 section when Step 1 settles on a separate worktree. Read the
Step 7 section before you remove a worktree this run created.

## Step 2: Reuse or create the worktree

**If worktree:** reuse one that is already detached at `<headRefOid>`
(`git worktree list`), but only when `git -C <worktree> status --porcelain` is
empty. A dirty one may hold fixes from an earlier AUTO-FIX run, and reviewing
it would review those fixes too. Otherwise wait for the Step 0 prefetch, then
create one under the scratchpad, so nothing lands in the user's project. The
prefetch fetched `<headRefOid>`, for a fork PR too:

```bash
git worktree add --detach <scratchpad>/pr-review-<number> <headRefOid>
```

Run every subsequent step from the review directory, and note the path in your
output.

## Step 7: Cleanup

**Cleanup.** If you created a worktree in Step 2, check it before removing it:

```bash
git -C <worktree> status --porcelain
git worktree remove <worktree>          # only when the status output is empty
```

If local checks ran, delete the listed check artifacts first, as
[checks.md](checks.md) describes. That file also covers
the merge-base worktree. If the worktree still isn't clean, don't remove it. In
AUTO-FIX mode, [auto-fix.md](auto-fix.md) says what to hand back.
Leave a worktree you reused from `git worktree list` in place.
