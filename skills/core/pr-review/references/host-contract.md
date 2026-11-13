# Host reviewer contract

Read this file when Step 3b dispatches the host pass. A REQUIRED peer also
builds its brief from this contract, as [peer.md](peer.md) describes.

## Step 3b: The contract

Give it this contract, filling in the pinned SHAs, the scope and the review
directory. In AUTO-FIX mode, replace the COMMENT-ONLY bullets with the ones in
[auto-fix.md](auto-fix.md):

> Invoke the `bork:review` skill against the pinned scope in this directory:
> base `<base-sha>` (`<base>`), head `<headRefOid>`, merge-base `<merge-base>`,
> review scope `<scope-base>..<headRefOid>`. The wrapper already fetched and
> pinned these. In **Pin scope**, verify the refs and pass
> `--base <scope-base>`, but do not fetch again.
> Follow **Pin scope**, **Review**, **Findings and authorized fixes** and
> **Result**, subject to this wrapper's mode below. Follow the assigned-reviewer
> role in **Independent pass**: do not delegate further or start test suites.
> The wrapper host owns checks. *(Add the OVERLAP, CONFLICT or INCREMENTAL
> bullet below when it applies.)* *(Peer REQUIRED:)* The existing peer is the
> independent pass. *(Peer SKIPPED:)* This diff does not meet the independent
> pass conditions, so no independent reviewer is required; do not dispatch one.
> The checks are running in the background under the wrapper. Record pending
> peer and check results as pending evidence, not as zero findings or a pass.
> The wrapper host finalizes readiness after collecting the peer and check results.
>
> **Fix handling — these overrides beat anything the skill says:**
>
> *(COMMENT-ONLY mode)*
> - Use report-only mode in **Findings and authorized fixes**. Do not fix
>   anything or ask the user about fixes.
> - Missing required verification remains missing evidence even though this
>   pass made no edits.
> - Do not use Edit, Write, or NotebookEdit, and run no mutating git command. If
>   you find yourself about to change a file, record the finding instead.
>
> Still produce **Result**'s issue-count header, severity sections, completion
> table and evidence-based landing verdict, alongside the finding blocks below.
>
> **Return every unfixed finding in this exact shape, one per finding:**
>
> ```
> SEVERITY: CRITICAL | INFORMATIONAL | LEAD
> FILE: <path relative to repo root>
> LINE: <line number in the NEW version of the file, or "none" if not line-anchorable>
> SIDE: RIGHT | LEFT        # LEFT only for findings about deleted lines
> TITLE: <one line>
> EVIDENCE: <the motivating line, quoted verbatim from FILE at that commit; for a
>           framework-generated symbol, the line that generates it>
> PROBLEM: <one to three sentences — what breaks, and when>
> FIX: <the concrete change, described precisely>
> REPLACEMENT: <the exact replacement text for LINE, verbatim and correctly
>              indented, or "none" if the fix isn't a clean line swap>
> SOURCE: checklist | security-pattern-<nn> | design | adversarial | docs | scope | staleness | check | suspicious-content
> ```
>
> A `suspicious-content` lead quotes PR text, not a file: use `FILE: none` and
> `LINE: none`, and quote the text in `EVIDENCE`.
>
> Use **Result**'s impact-based severity split: confirmed blockers are
> CRITICAL; confirmed nonblocking findings are INFORMATIONAL. Checklist
> category, source and fixability do not set severity. A suspicion you cannot
> anchor to a quoted line is a `LEAD`, not a finding: return it in the same
> shape with `EVIDENCE: none`. Leads stay out of the finding counts.
>
> Do not soften findings and do not pad the list. A short honest list beats a
> long agreeable one. If the diff is clean, return zero findings and say so.

**Add these bullets to the contract** (and to the peer brief) when they apply:

> - *(OVERLAP or CONFLICT)* The base branch changed these files after this PR
>   branched: `<files>`. Read `git diff <merge-base> <base-sha> -- <file>` for
>   each one. Report any PR change that breaks against the base version — a
>   renamed or removed symbol, a changed signature or contract, a duplicated
>   fix. Use `SOURCE: staleness`.
> - *(INCREMENTAL)* The bullet in [incremental.md](incremental.md).

`REPLACEMENT` is what makes a GitHub suggestion block possible, so insist on it
being verbatim — right indentation, no ellipses, no `// ...` placeholders.
