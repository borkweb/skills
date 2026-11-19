# Review evaluation

The runner compares review skills on frozen case pointers. A case names a local
repository identity, base and head commits, and expected findings. Register the
local checkouts through `repos.py`; the runner fetches only from those checkouts.
It does not fetch from a network remote. All Python dependencies are stdlib or
modules in this repository.

Inspect both commands without making a model call:

```sh
python3 evals/review/run_review_eval.py --help
python3 evals/review/regrade_run.py --help
```

`run_review_eval.py --matrix FILE --output NEW_DIR` prints the number of configs,
review, match and extras calls, estimated cost and budget. A matrix with any real
harness stops there unless you add `--spend`. An all-fake matrix runs without
`--spend`. Fake reviews and grades are deterministic and start no process.

The runner flags are `--matrix FILE`, `--output NEW_DIR`, `--spend`,
`--resume RUN_DIR [--matrix FILE]`, `--retry-errors`, `--jobs N` (default 4),
`--case ID` (repeatable), and `--budget-usd X`. Explicit cases override both the
matrix filter and case limit. The budget flag overrides the stored budget on
resume and records the override. Changing only the budget in a supplied matrix
is not matrix drift; use `--budget-usd` to change the active resume budget.

The output directory must be new, outside a git work tree and outside the
read-denied case store, token directory and `~/git/skills-private`. Run, cases,
trial and raw directories are mode 700. Work lives separately in
`~/.borkweb-skills/eval-work/<run id>/`, mode 700: skills export, one live case
snapshot, trial copies and temporary harness homes. Work paths and refs do not
name the case or config. The runner deletes the work root after completion or
interruption, through the descriptor-relative `snapshot.remove_tree` helper.

The run holds a `.lock` created with `O_EXCL`, containing its pid. A live holder
refuses another runner; a dead holder is replaced with a stderr notice. Frozen
case bytes, resolved matrix, skill commit and selected-case hash are in the run.
Resume refuses matrix, skills, case-set or grader drift before appending records.
The ledger has a single writer and strictly increasing attempts. Review files
and metadata are under `trials/<token>/`; raw streams stay under `raw/<token>/`.
`stderr-tail.txt` is the scrubbed last 8192 bytes of raw stderr. Secrets are
scrubbed before storage. Unknown prices use the highest listed price; invalid
usage becomes null, usage magnitude is capped to the report's 1e15 limit, and
individual costs are finite floats capped at 1e6. Costs are estimates.

Resume policy (Q4): keep graded reviews, errors, model or effort fallbacks and
plugin-loading failures. Rerun missing reviews, budget skips, rate limits and
snapshot failures. Grade an existing ok review again only when its match is
missing, ungraded or stale. Rebuild stale or missing extras after all current
matches have been written. `--retry-errors` adds error reviews to that set.
It does not retry other environment failures. A rate limit stops new review
and grade calls on that harness for this invocation; other harnesses continue.
The global `--jobs` limit and each harness's `max_parallel` include grade calls.
Reservations cover a review, its match and a share of extras; resume counts
costs from every attempt, including failed calls.
Claude review argv caps each call at `min(10, budget_usd)`; grade argv keeps
slice C's fixed `--max-budget-usd 2` cap.

M3 stop and resume: start the authorized smoke run with `--spend`, then send
SIGINT to the runner pid while the match is in flight, after its review record
has been flushed. SIGINT, SIGTERM and SIGHUP stop admission and kill registered
process groups, including their descendants. Interrupted calls are not recorded
as errors. Resume that directory with `--resume RUN_DIR --spend`; it grades the
stored ok review without paying for a second review. Inspect `trials.jsonl`,
`results.json` and `report.html` after completion. This paid smoke is an
architect-run check, not part of the local stub suite.

`regrade_run.py RUN_DIR --grader HARNESS:MODEL:EFFORT --output NEW_DIR` makes a
new run with no review calls. Use `-` for null effort. Optional flags are
`--spend`, `--current-cases`, `--jobs N` and `--budget-usd X`. A non-fake grader
requires `--spend`; otherwise it prints the plan and creates nothing. Timeout
and other settings come from the source manifest. The regrade budget covers
new grading calls; copied source review costs
are retained in results and do not consume that budget. Default cases are the frozen
copies; `--current-cases` uses the current files but refuses missing finding IDs.
The new run has a new id, the source start time and `regraded_from`; copied
review files are byte-identical. The source is never locked or written. Extras
use a fresh snapshot rebuilt at head, rather than any review's modified copy.

Both commands exit 0 on success or a plan-only run, 2 on a refusal or invalid
CLI arguments, and nonzero (normally 1) on interruption or execution/report
failure. A reporting failure leaves the trial ledger intact.

Until the selected cases include a non-blocking expected verdict, v1 verdict
accuracy is **block sensitivity only**: a reviewer that always blocks scores
100%. The report carries this note and the no-independent-pass delegation limit.
The drill-down records Independent review and verdict basis, and case tags
include `diff_over_200` when the snapshot diff has more than 200 changed lines.

Local checks use temporary HOME directories and stub executables only:

```sh
python3 -m unittest discover -s evals/review -p 'test_runner.py'
python3 -m unittest discover -s evals/review -p 'test_regrade.py'
python3 -m unittest discover -s evals/replay -p 'test_snapshot.py'
```
