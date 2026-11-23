# Briefs

A brief carries a step's inputs to an agent. Handoffs are fast because briefs are short and point to files: no transcript, no pasted diff, no restated history. Every brief fits on one screen.

## Every brief

- **Goal**: one sentence, plus the endpoint.
- **Where**: absolute worktree path, branch, base..head.
- **Owns**: paths the agent may change. Reviewers may write only their explicitly designated report outside the reviewed checkouts; they own no feature files. The spec reviewer also writes the run directory's `repo-rules-<slice>/` (see Spec reviewer).
- **Frozen**: gates with exact commands, and contracts nobody may edit.
- **Resources**: relevant gate resources, isolation evidence and owner, recorded here or in the linked run notes ([test-resources.md](test-resources.md)). Shared or unknown resources serialize affected gates.
- **Inputs**: paths to the spec, prior findings, `decisions.md`, and the absolute `repo-rules-<slice>/` path once the spec reviewer has recorded it ([repo-rules.md](repo-rules.md)).
- **Return**: the output format below, written to an absolute result path under the run directory.
- **Probes**: an agent that runs a probe or hostile test input writes it to a file in its scratch directory with the file-write tool, never as a shell heredoc, because a data line that matches the delimiter ends the heredoc and the shell runs the rest. It runs probes from that scratch directory, never from the user's checkout, and sends no request to a real external host.
- **Waits**: a subagent never ends its turn to wait and never starts a background waiter, because its own background task does not wake it once its turn ends. When it needs CI or a shared resource, it writes the need where the host watches (`waiting.md` in **land batch**, with `ci <n>` for the nth CI run on a head) and returns. A message from the host wakes it.

## Reviewer

Independent, read-only, and never writes feature code. Reviews the pinned diff against the spec, gates and repo instructions using the `review` skill. Does not run suites; the parent owns gates and passes their results in as inputs. When the builder reported a `Safety fact:` line, the reviewer attacks that fact first. Use `review`'s **Independent pass** artifact contract: the assigned absolute result path is the sole report write, the completion returns only that path and scope, and the parent reads and validates the full report before the verdict. Missing shared storage or missing, unreadable or incomplete reports remain missing evidence. When given a `repo-rules-<slice>/` path (or `rule:` paths in its criteria), it reads that frozen copy and never the live rule store, even when the copy is empty.

Returns:
- a numbered findings list: severity, file:line, the evidence, and the smallest fix;
- a verdict: SAFE TO LAND, LAND WITH CAUTION, or DO NOT LAND;
- on an acceptance review (the brief hands it frozen criteria), one line per frozen criterion ID after the findings, the ID first: `C5: MET | UNMET | NOT CHECKED — <file:line or command>`. `UNMET` cites the finding number. `NOT CHECKED` names what the reviewer could not see.

Diff the test files for removed, skipped or loosened assertions, expectations, fixtures and golden files. Each must appear on the builder's `Loosened tests:` line with a source of truth; one that does not is a class 13 blocker (review criteria, below).

For a delta re-review, send only: the diff since the last review, the finding IDs claimed fixed, and new gate results. Ask the reviewer to confirm each fix, check the delta for regressions, and keep the same numbering.

## Spec reviewer

Independent, read-only, runs before gates are frozen and concurrently with worktree setup. Reads the slice spec, the plan and the repo instructions with the `review` skill's checklist and the review criteria (the classes past reviewers rejected on after green gates) in hand. The review criteria are the user's private `~/.borkweb-skills/review-criteria.md` when it exists, otherwise the public seed [review-criteria.md](review-criteria.md). It answers one question: what would make me return DO NOT LAND on a correct implementation of this spec? For every class in the review criteria the slice can exhibit, it writes one criterion. Classes 3, 5 and 6 are the ones spec reviews most often left out, so write each whenever its trigger is present, even if the spec is silent. Classes 3 and 15 apply when the slice adds or changes a test; the repo's own test guidance (a test skill under `.agents/skills/` or `.claude/skills/`, the test section of `AGENTS.md`), when present, decides how many tests, and its checker becomes a criterion. Class 5 applies when it adds or changes an entry point a user or caller invokes. Class 6 applies when the slice meets an external runtime, version, service or real data shape. Does not review code and does not propose designs.

Before writing criteria, it names the slice's runtime surface: `ui` (rendered screens), `cli`, `api`, `job`, or `none` (a library or internal change that no user or caller runs directly). Classes 5 and 6 cover `cli`, `api` and `job`. A `ui` surface also gets one criterion that drives the changed flow in a real browser and asserts what the user sees, because a green unit suite cannot show rendered behavior. Its check names the repo's own verification skill or script when one exists, and otherwise a `qa-only` pass scoped to the changed flow. The evidence (the assertion transcript plus a screenshot or recording) goes to the run directory, and the architect runs it like any other real-runtime check. A `none` surface gets no runtime criterion. Each `ui`, `cli` or `api` runtime criterion states these proof rules: check each entry point separately, and never report a skipped entry point as verified through another path; use the real user path, never test-only setters; give a mutation a read-only second view of the stored value; for a bug fix, name the correct and the broken final state; never weaken the journey to make it pass. Not run for a corrective: its criteria are the confirmed blockers.

Before writing criteria, it also runs `git log -S` and `git blame` on the guards and contracts the slice touches, and reads the commit or PR bodies that introduced them. A guard a past change added on purpose is something to preserve, not to tidy away.

It also applies the repo's rules ([repo-rules.md](repo-rules.md)). It runs `node "<do skill base>/repo-rules-key.mjs" --dir <slice repo path>` (the script defaults to the current directory, so pass the slice's repo path), reads each `*.md` in the printed store directory, and matches each rule's `applies_when` against the slice's files and behavior. Each match becomes one criterion that cites `rule: <absolute path>`, naming the copy in the run directory's `repo-rules-<slice>/`, never the live store. It copies only the matched rule files there. Unmatched rules are neither copied nor passed on. It creates `repo-rules-<slice>/` even when nothing matched and records its absolute path in its result. Besides its result file, that directory is its only write; it stays read-only on code and on the store. A malformed rule file, a rule whose `retire_when` holds, or a failed key resolution is a numbered gap, never a silent "no rules matched". A missing store directory means no rules and is not a gap.

A mutation criterion names one test, never a file or a suite, because the architect runs it with `mutate.mjs` and a whole suite per mutation is the slow part.
It carries: the file, the target (function or guard), the intent of the edit ("drop the `state !== 'running'` check"), the exact test name the builder must use, and a command that runs only that test.
It cannot carry the exact edit: the code does not exist yet, so the `find` text cannot match.
At judge time the architect writes the exact edit (`find` and `replace`, or a `patch`) against the slice head into `mutations.json` in the run directory, checks it against the intent, and runs `mutate.mjs` (offload SKILL.md step 3).
The builder may propose the literal on its evidence line; the architect still checks it.
One-test commands, one per runner:
- Node: `node --test --test-name-pattern='^exact test name$' path/test_x.mjs`. The pattern is a regular expression, so escape `(`, `)`, `.` and every other metacharacter in the test name. A test inside `describe` matches on its own name.
- PHPUnit: `phpunit --filter '/::testName$/' path/FooTest.php`.
- Python: `python3 -m unittest module.Class.test_name`.

Returns:
- one line `Runtime surface: <ui|cli|api|job|none> — <reason>`;
- a short Preserve/Avoid list from that history: what the slice must keep and what it must not repeat. Each item becomes a criterion or a numbered gap;
- a numbered list of acceptance criteria, each testable, each tied to a checklist item or repo rule, with the smallest check that proves it. Each criterion states one checkable condition. When one behavior needs several conditions (refuses on missing input, logs once, keeps the old value), give each its own sub-number (C5a, C5b, C5c) with its own check, so the builder reports evidence per condition and cannot meet part of a criterion and call it met. Give one deliberate mutation to each gate or pin the slice adds, not one per sub-condition, unless the sub-condition has its own code path. Keep qualifiers such as "only when" and "unless" with the condition they limit. Give a command wherever one can exist (a test run, a deliberate mutation that must turn a test red, a run against the real runtime or CI version); keep a test name or file:line condition for what no command can show. A criterion for new or changed behavior needs a check that fails at the slice's base commit, because the architect runs every command there before freezing and returns any that pass. Never require a test an existing one already gives; the builder cites it. A criterion that only another slice's work can satisfy is a gap, not a criterion;
- gaps in the spec that no criterion can cover, numbered G1, G2 and so on, one line each, or `None.`

The architect folds the criteria into the frozen gates and the builder brief, so the builder works to the same bar the later reviewer applies. Before dispatch the architect rules on every gap: fold it into the spec as a criterion, record it as out of scope in `decisions.md`, or ask the user when the ruling changes scope. No gap reaches the builder unresolved.

## Builder (lane)

A Local-tier subagent builder follows [builder-template.md](../../offload/builder-template.md): the brief you send it is that template, filled for the slice. It has no `$OFFLOAD_HANDOFF`, so it writes the template's Returns to its result file under the run directory.

## Compression

Agent-to-agent prose may use `caveman` compression. Keep code, commands, error strings, gate lines, acceptance criteria, spec-review output, commit messages and user-facing reports in normal prose.
