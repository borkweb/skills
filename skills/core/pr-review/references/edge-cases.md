# Edge cases

Read only the section that matches what happened.

## Step 0: No PR

Say so and offer the two honest options: run the analysis anyway and report
everything in chat (nothing to post to), or stop so the user can open the PR
first. Do not invent a PR.

## Step 0: The PR's repo isn't the current checkout

`bork:review` reads real files from a real checkout, so it needs one that
matches the PR URL's `<owner>/<repo>`.

- **A local clone exists elsewhere** → say which repo the PR belongs to and ask
  for the checkout path (or confirm one you found).
- **No local clone** → offer to clone it shallowly into the scratchpad for this
  review and delete it afterwards. Say that's what you're doing and roughly how
  big it is; don't clone a large repo silently. That clone is the isolation, so
  skip Step 1's worktree question and say why.

Never review a PR against the wrong repository's files. If you can't get a
matching checkout, stop and say so.

## Step 1: Fork PR question

Most checks come from CI, but a check without a usable CI result runs on this
machine: install scripts (`npm ci`, `composer install`) and tests. For a fork,
an outside author wrote that code. Ask this in the same Step 1 call:

> **This PR comes from a fork. If a check needs a local run, run the fork's install scripts and tests on this machine?**
> - **No — CI results only (Recommended)** — a check that needs a local run is recorded `NOT RUN (fork)`, and the verdict reports it as missing evidence.
> - **Yes — run them locally** — install and test the fork's code in the review directory when CI can't answer.

`--run-fork` answers this question with yes.

## Step 2: Fork PR worktree

For a cross-repository PR, `origin` doesn't have the head branch, so the Step 0
prefetch fetches `pull/<number>/head` instead. Before `git worktree add`, confirm
`git cat-file -e <headRefOid>` succeeds. If it fails, the author pushed after
Step 0: rerun `gh pr view`, and start again from Step 0 with the new
`headRefOid`.

## Step 3c: The peer fails

The peer fails when its CLI is missing or not authenticated, it exits non-zero,
it times out, or its output doesn't parse. Retry once at most, and don't stall
the review. Say plainly in one line that the peer pass didn't run and why, then
continue with the host findings alone. Every downstream step works with one
reviewer; the summary just has to be honest that it was one.

If Step 2b found the peer **required** (bork:review's independent-pass
conditions), a failed peer is missing evidence. The verdict reports it that way.

**On timeout:** don't kill the review over it. Note the timeout, proceed with the
host findings, and mention that a peer result may land in `peer.out` afterwards.

## Step 5c: The API returns 422

A 422 almost always means an anchor is outside the diff. Report which comment
was rejected, move that finding to the summary body, and retry once. If it fails
again, stop and show the user the payload and the error. Never retry blind in a
loop.
