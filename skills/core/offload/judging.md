# Judging freshness and rulings

Read this before you judge a slice's results (One architect turn, step 3) and before you rule on a disagreement that changes what the work must say or do (step 2).

## The evidence describes the head

`ready` and `coverage` refuse with `stale:` (exit 5) when the doc names a worktree and its Gate results have no `Head: <sha>` line, or name a commit other than that worktree's HEAD. Treat it like a missing criterion line: `ledger set … --state returned`, then send a corrective without `--verdict` that asks for every gate to be rerun at HEAD. It records no rejection and costs no round.

The `Head:` line is the builder's claim. A gate evidence file that records its own commit (a pin line, an `at <sha>`) and names a different commit is stale in the same way, even when the `Head:` line matches. Read the commit each evidence file names before you grade it.

## The head still merges onto its base

Before any review, and again before each corrective's review, check that the slice still merges onto its base as the base is now:

1. Fetch the base, then run `git merge-tree --write-tree <base remote ref> HEAD` in the worktree. It needs git 2.38 or later; with older git, use `git merge --no-commit` in a throwaway worktree.
2. For a stacked slice, also check against the current head of the branch it stacks on.

A conflict, or a change to a file that the base deleted, means the gates tested a tree that cannot land. Send it back as `returned` with a corrective to rebase and rerun the gates: no verdict and no round. A base you cannot fetch leaves the merge check `NOT RUN`, which is a recorded caveat.

## Rulings that change the bar

A ruling that changes what the work must say or do (required text, behavior or a check) cannot stay as prose in *Decisions + why* or in a message to the builder's pane.

- Before you send any text the ruling dictates (a description, message or prompt), check it against the code path it describes, in every state where it must hold.
- While the slice is in flight, append the ruling to *Frozen gates* as a new ID-first criterion with `section append`, naming any ID it replaces (`C34g: replaces C34f. …`). Never rewrite a frozen line. `coverage` then requires a line for the new ID, and the builder answers the replaced one with `C34f: replaced by C34g`.
- After results exist, the ruling goes into the corrective spec as a numbered blocker.
