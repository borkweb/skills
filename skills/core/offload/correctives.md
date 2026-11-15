# Correctives

Read this before you spec or dispatch a corrective, or before you judge a rejection. [SKILL.md](SKILL.md) step 3 judges a slice; this file holds what follows a rejection.

## Judge a rejection

- **A blocker needs proof.** A DO NOT LAND verdict fails the slice only for a blocker that carries a red command, or quotes a shipped line (doc, description, error text) that the change made false ([review](../../gstack/review/SKILL.md) *Result*). The independent reviewer may name a command it did not run. The architect is the primary review owner and runs it before giving the verdict. A command that does not go red demotes its finding to LAND WITH CAUTION plus a follow-up. These stay blockers without a red command: missing required evidence, a merge conflict onto the base, security findings, data loss and uncapped spend.
- **Two-miss stop.** When the same criterion or blocker fails a second round, do not spec a third corrective. Rework the criterion (it is usually ambiguous or unbuildable as written) or ask the user, and record which under *Decisions + why*.
- **Round cap.** `dispatch-slice.sh` refuses a corrective once the slice has more than 3 rejected rounds (`OFFLOAD_ROUND_CAP`), even when each round failed on a different blocker. Ask the user whether to continue, re-scope or abandon, and pass a continue ruling as `--past-cap "<ruling>"`; the ledger keeps it. Only the user grants that ruling; an unattended wake cannot pass `--past-cap` and stops to ask instead.
- **Send-backs with no verdict against the work** (a ruling, a restamp, a scope change) are `ledger set … --state returned`, never `rejected`. A slice the user's change of direction made moot is `abandoned`. A missing `Safety fact:` line is bookkeeping, like a missing criterion line: `--state returned`, then a corrective without `--verdict` that names the line.
- **Informational findings only.** Spend a corrective round only on a confirmed defect: each round costs a builder turn, a rerun and a delta review. Accept a slice whose review leaves only informational findings, and carry the fixes you want into the next slice that owns those files or into one polish slice at the end of the run.

## Spec the corrective

The spec is the confirmed blockers with the mechanism behind each (see [review-criteria.md](../do/references/review-criteria.md) §7) and, for each blocker, one command that goes red on it. Run each command once in a throwaway detached worktree at the rejected HEAD and record its red output in the spec. A behavioral blocker you cannot turn red is restated until it can, or goes back to the reviewer for a reproduction; a blocker no command can show (docs, wording, a missing file) keeps its file:line condition instead. Skip the spec reviewer and the plan reviews and go straight to dispatch. The block keeps the same owned files and gates, and a corrective never touches *Frozen gates*. The builder reports each blocker's command red before the fix and green after, and re-reports the full criteria evidence for the slice, not only the blockers, so the delta review can see a fix that broke a criterion that used to pass.

## Reruns and the delta review

A corrective reruns the gates its diff can reach plus every criterion's evidence, not the full frozen set. The builder decides what its diff can reach ([builder-template.md](builder-template.md) says how) and lists the gates it did not rerun on one `Carried: <earlier head sha> — <gate names>` line, naming the head whose evidence they keep. Check each carried gate: its evidence must be at the head the line names, and the diff must not reach it.

Scope the delta review to the change: give the reviewer the prior blockers and the corrective's own range (previously reviewed commit..new HEAD), confirm each blocker is resolved, and check for regressions against the slice's original range where the corrective touched shared code.

A corrective whose diff changes only strings, comments or docs skips the delta review. It still reruns the gates that read those strings; the frozen-phrase validator is one. You confirm each blocker's file:line condition yourself before you accept. A corrective whose blockers include class 12 or class 13 never skips the delta review.

When any corrective round of a slice used scoped reruns, you run the full frozen gate set once on the head it accepts, before you mark it accepted. In a fleet, the final integration gate counts as that run.

## Dispatch a corrective

After a rejection, write the corrective block and run
`dispatch-slice.sh … "<fix>.md" --id <n> --corrective --verdict "<why>"`. The
verdict lands on the ledger's rejected entry, so `ledger report` can count it as
review-only or gate-failed. A one-slice run needs no `--id`: the corrective
applies to the row for this handoff. From an unjudged state (`results-ready` or
`dispatched`) it needs `--verdict`, which records the rejection. On a row you
already set `rejected` (the usual path after a judged rejection, or a `--past-cap` retry) the same
`--verdict` is a ledger note, not a second rejection. On `accepted` work a
later review sends back, it records the rejection. In any other state
(`merged`, `abandoned`, `returned`, `blocked`, `specced`) it exits 2, prints
the state, sends nothing; drop it for a follow-up. Run one call without
`--id` at a time. When the builder that just
reported is still at its prompt, the brief goes into its pane and it continues
with the code already in context: no boot, no re-reading the plan. When the
builder is gone, the script says so and re-dispatches cold. Either way, run the
printed `NEXT` line again.
