# Judging freshness and rulings

Read this before you judge a slice's results (One architect turn, step 3) and before you rule on a disagreement that changes what the work must say or do (step 2).

## The evidence describes the head

`ready` and `coverage` refuse with `stale:` (exit 5) when the doc names a worktree and its Gate results have no `Head: <sha>` line, or name a commit other than that worktree's HEAD, except in the two cases below. Treat a refusal like a missing criterion line: `ledger set … --state returned`, then send a corrective without `--verdict` that asks for every gate to be rerun at HEAD. It records no rejection and costs no round.

The `Head:` line is the builder's claim. A gate evidence file that records its own commit (a pin line, an `at <sha>`) and names a different commit is stale in the same way, even when the `Head:` line matches. Read the commit each evidence file names before you grade it.

**A pure rebase keeps gate evidence.** A recorded `Head:` that is not HEAD is accepted when all four conditions hold, and for gate evidence only (`ready` and `coverage`):

1. The handoff records the slice's base: `base: <sha>` and `base_ref: <full ref>`. `dispatch-slice.sh` writes both on a fresh dispatch. Pass `--base <ref>` on a slice's first dispatch, because without a recorded base the carry-over never applies. A reused worktree dispatched without `--base` records none.
2. `git patch-id --verbatim` of `base..<recorded head>` equals that of `<merge-base of HEAD and the current tip of base_ref>..HEAD`. Verbatim, not `--stable`: `--stable` ignores whitespace, which changes meaning inside a string or a Python indent. A binary or mode change counts.
3. That patch is not empty.
4. `git merge-tree --write-tree` of the base's current tip and HEAD is clean.

Anything unknown refuses with a `stale:` message that names the condition: a missing `base:` or `base_ref:`, an unknown head, an empty patch, a patch-id mismatch, a merge conflict, or a git error (an old git without `--verbatim` or `--write-tree` is a git error). Handle it as a stale head above.

A review verdict never carries over a rebase. A rebase gives new shas and possibly new merged code, so review the rebased HEAD again before you accept.

**A corrective may carry gates the diff cannot reach.** Gate results may list them on one `Carried: <sha> — <gate names>` line, naming the earlier head they ran at. Every gate you ask the builder to rerun and every criterion check still names HEAD on a `Head:` line. `ready` and `coverage` treat a `Carried:` line as not a `Head:` line, so it never trips `stale:`; whether the diff really cannot reach those gates is your call.

## The head still merges onto its base

Before any review, and again before each corrective's review, check that the slice still merges onto its base as the base is now:

1. Fetch the base, then run `git merge-tree --write-tree <base remote ref> HEAD` in the worktree. It needs git 2.38 or later; with older git, use `git merge --no-commit` in a throwaway worktree.
2. For a stacked slice, also check against the current head of the branch it stacks on.

A conflict, or a change to a file that the base deleted, means the gates tested a tree that cannot land. Send it back as `returned` with a corrective to rebase and rerun the gates: no verdict and no round. A base you cannot fetch leaves the merge check `NOT RUN`, which is a recorded caveat.

## Rulings that change the bar

A ruling that changes what the work must say or do (required text, behavior or a check) cannot stay as prose in *Decisions + why* or in a message to the builder's pane.

- Before you send any text the ruling dictates (a description, message or prompt), check it against the code path it describes, in every state where it must hold.
- While the slice is in flight, append the ruling to *Frozen gates* as a new ID-first criterion with `section append`, naming any ID it replaces (`C34g: replaces C34f. …`). Never rewrite a frozen line. `coverage` then requires a line for the new ID, and the builder answers the replaced one with `C34f: replaced by C34g`.
- In the run's `decisions.md`, mark the ruling with the exact line `Changes the bar (slice <id>): <IDs>`, a comma-separated list of the criterion IDs that carry it. `node handoff.mjs rulings <decisions.md> <block.md> --slice <id>` checks that each ID leads a line of the block's `Acceptance:` lines (a parent ID such as `C2` is backed by a `C2a` line). The dispatcher refuses a fresh dispatch (exit 6, nothing launched) while the run's `decisions.md` holds an unbacked ruling for that slice, and it prints each offending marker line. A corrective is not checked.
- After results exist, the ruling goes into the corrective spec as a numbered blocker.
