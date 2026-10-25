# AUTO-FIX mode

Read this file as soon as the mode is **AUTO-FIX**, from a Step 1 answer or the
`--auto-fix` flag. Each section names the
step it belongs to. Nothing here applies in COMMENT-ONLY mode.

## Step 1: AUTO-FIX with a worktree

If the answers come back AUTO-FIX + worktree, flag it before proceeding: fixes
applied in a throwaway worktree get thrown away with it. State the honest
options — run in place instead, or keep the worktree at the end and hand back a
patch — and go with what they pick. Silently losing the fixes is the failure
mode here, and it looks like success right up until it doesn't.

## Step 2: Recommend in place

In AUTO-FIX mode, recommend **in place** even when the worktree rules would
otherwise apply, because the current checkout is where the fixes are useful.

## Step 3b: Contract bullets for the host reviewer

The host reviewer never reads this file. **Paste these bullets into the 3b
contract** in place of the COMMENT-ONLY bullets:

> *(AUTO-FIX mode)*
> - In **Findings and authorized fixes**, apply only scoped mechanical
>   corrections authorized by the chosen mode and report each as
>   `[AUTO-FIXED] file:line problem → what you did`. A mechanical correction
>   requires no design, security or user-visible behavior decision.
> - Do not ask the user anything. Every judgment call (ASK), including every
>   CRITICAL finding, is returned unfixed. The user already chose the fix policy.
> - The wrapper host reruns every check affected by a fix on the final files.
>   Report `git diff --stat`; retain failed regression tests and re-review the
>   changed scope, including the existing peer when required.
> - Never commit, push, or create a PR. Never touch files outside this diff.

## Step 3c: Rerun checks after the host pass

Every check result from 3a is a **pre-fix** result: CI ran on `<headRefOid>`,
and a local suite may have run while the host pass edited files. After the 3c
join, the files are final:

- A local suite that was still running when a fix landed is void. Rerun it in
  full.
- Rerun every other check that a fix could affect. A CI result can't cover a
  fixed file, because CI never saw the fix, so these reruns are local. Follow
  [checks.md](checks.md) for them, including the fork rule.
- Only post-fix results go in the Verification row for the checks you reran.

## Step 3d: Drop findings the host already fixed

Drop peer findings the host already fixed. Re-read the current file, not the
original diff, before keeping any peer finding.

## Step 4: Every change needs a fix behind it

Every changed tracked file must correspond to a reported `[AUTO-FIXED]` line.
**If a file changed that no finding accounts for**, stop, show the user exactly
what changed with `git diff`, and ask how they want to proceed. Do not post to
the PR, and do not revert on your own. Report the post-fix check results. If a
fix broke a test, say which fix and offer to revert that specific change.

## Step 7: End with what is uncommitted

State what is sitting uncommitted in the working tree, and that committing it is
the user's call — this skill doesn't commit (`bork:writing-commits` does).

A worktree with fixes in it is not clean, so the Step 7 cleanup leaves it in
place. Write the changes out as a patch the user can apply to their real
checkout, and tell them where both live:

```bash
git -C <worktree> diff > <scratchpad>/pr-review-<number>-fixes.patch
```
