# Builder replay eval

Measures whether a change to `skills/core/offload/builder-template.md` makes a builder less likely to miss a criterion that a past run missed. A **case** is a past slice: a repo at a base commit, the frozen criteria and gates, and the criterion ID(s) the builder missed. The runner replays each case under two skill revisions (**current** and **revised**), grades the builder's diff, and reports the named-miss rate per arm.

This slice (S3a) ships the format, the case builder, the runner and a deterministic fake builder and grader. It makes no model calls. Real adapters come later and must pass `--spend`.

Everything here is Python standard library. Run the tests with `python3 -m unittest discover -s evals -p 'test_*.py'`.

> Name note: run dirs hold unrelated `replay-S<n>.md` files and `replay-S<n>-artifacts/` directories (architect mutation replays). They are not cases. The case builder never reads them, and the case store is named `replay-cases/`.

## Case format

One JSON file per case, `<case id>.json`.

| Field | Meaning |
| --- | --- |
| `id` | case id; `[A-Za-z0-9._-]+`, also the file stem. The case builder never puts a criterion ID in it |
| `repo` | `{"identity": ..., "path": ...}`: a name for the repo (normalized origin URL, else the directory name) and its local path, which must be an existing git repo |
| `base_commit` | base commit: a full hex object ID. A ref name (`HEAD`, `main`) or a short ID makes the replay non-reproducible and is rejected |
| `goal` | one line; fills the brief's `Execute ...` line. It and `owned_files` must not name a missed ID |
| `owned_files` | one line; fills the brief's `Owned files:` line |
| `criteria` | the frozen criteria, verbatim. A criterion is a line whose first token is a single ID (`C5`, `C5a`, `C1.1`) after an optional list marker, pipe, `**` or backtick |
| `gates_text` | the frozen gates, verbatim |
| `gate_commands` | the executable commands, a list. Each must appear in `gates_text`. The runner runs only these, and only when `gate_commands_reviewed` is `true`; it refuses otherwise, under `--fake` too |
| `gate_commands_reviewed` | `true` once a human has read `gate_commands`. The case builder never sets it |
| `gate_command_candidates` | optional. The backticked spans of `gates_text` that the case builder proposes. Read them, copy the ones you trust into `gate_commands` and set `gate_commands_reviewed` |
| `missed_ids` | missed criterion ID(s). Each must lead a line of `criteria` (so `C1` never matches inside `C10`) |
| `provenance` | where the case came from: run dir or session citation, and which source supplied the base commit |
| `setup_commands` | optional list, run in the worktree before the builder starts. A failure gives the trial outcome `env-unavailable` |

`fixtures/synthetic-case.json` is the one committed case. `fixture.py` builds its tiny repo and a tiny skills repo at test time; no repo or archive is committed.

Real cases are private. They live outside this repo in `~/.agent-handoffs/replay-cases/` (mode 700; `$AGENT_HANDOFFS_DIR/replay-cases/` when that variable is set). Write no case content into the repo.

## Case builder

```sh
python3 evals/replay/build_cases.py [--ledgers DIR] [--out DIR]
```

Read-only on every source. It never calls a handoff CLI subcommand that deletes files; it reads the offload ledger JSON files on disk (default `<store>/offload/*.ledger.json`, where `<store>` is `$AGENT_HANDOFFS_DIR` or `~/.agent-handoffs`).

A candidate is a rejected verdict containing `named C<n>` (also `(named C2)`, `named C5a)`, `named C3, C5`). `unnamed`, untagged verdicts, `CP-01` and a `C1` inside `C10` never match. The verdict's `r<N>` is the review round (default 1). For each candidate the ledger's `run_dir` and the slice's handoff doc supply:

- **Frozen criteria**: the ID-led lines (plus indented continuation lines) of `spec-review-S<id>.md`; else the `## Frozen gates` section of the slice's handoff doc.
- **Gates**: the `Gates` block of `brief-S<id>.md` or `block-S<id>.md`, up to the first blank line.
- **Base commit**, first hit in this order, resolved to a full ID in the ledger's repo: a `base` field on the ledger row, the ledger or `run.json`; `base: <sha>` or `@ <sha>` in `brief-S<id>.md` or `block-S<id>.md`; a `notes.md` line with `base: <sha>` or `@ <sha>` that also names the slice tag or the word `base` (notes cover every slice of a run); and, only for a verdict on review round 2 or later, the `HEAD before this round:` line of the previous round's corrective file. At round 1 that line names the output the review rejected, not the base the builder started from, so it is not accepted. Placeholders such as `BASE_REF` never resolve. `provenance` quotes the line the base came from.

A candidate with no base commit or no frozen criteria builds no case, and the summary line names the source and the reason (`no base commit`, `no frozen criteria`, `no gates`, or a validation message). It prints `summary: seen=N built=B skipped=S` plus `skipped[<reason>]=N` (a source counts once, under its first reason). The case id is `<run>-<slice>-r<round>-<hash>`: it carries no criterion ID. `gate_commands` is left empty and the backticked spans go to `gate_command_candidates`. It never overwrites a case file, and it refuses an output directory inside a git work tree. The output directory is created mode 700; an existing group- or world-readable one is tightened to 700 first.

### Real run

Date 2026-11-10, re-run after the round 2 changes, once over the real ledgers and run dirs with the default output dir `~/.agent-handoffs/replay-cases/`:

| Result | Count |
| --- | --- |
| candidates seen (`named C<n>` verdicts) | 2 |
| cases built | 0 |
| skipped: no base commit | 1 |
| skipped: no gates | 1 |

The first candidate has a placeholder base in its brief and is a round 1 verdict. The review of that round does record its merge base, but a review file is not an accepted base source, so it builds nothing. Accepting `merge base = <sha>` in review files would likely give 1 case. The second candidate, in a run that appeared after the first run (the first run saw 1 candidate), has no `Gates` block in any brief or block file.

### Transcript-derived corpus (manual)

Builder subagent transcripts under `~/.claude/projects/<proj>/<session>/subagents/` hold builds that no ledger records. To turn one into a case:

1. Find a `subagents/` transcript whose parent session rejected the work and named a criterion ID.
2. Copy the frozen criteria and the gates from the brief in the transcript's first message. Keep them verbatim.
3. Take the base commit from the repo history: the commit the builder started from. Use the full ID.
4. Write `<case id>.json` by hand in `~/.agent-handoffs/replay-cases/` (mode 700), with `provenance` set to the session and subagent IDs.
5. Check it: `python3 evals/replay/run_replay.py --check --cases ~/.agent-handoffs/replay-cases`.

## Runner

```sh
python3 evals/replay/run_replay.py --cases DIR --output NEW_DIR --current-ref REF --revised-ref REF [--trials N] \
  (--fake | --fake-builder | --builder-adapter EXE) (--fake | --fake-grader | --grader-adapter EXE) [--spend]
```

Per case, trial and arm it:

1. Skips the case, with the reason, when its base commit is missing from the repo (it never fetches) or when a gate or setup command names a live path: the repo or any of its worktrees, literally, through `~` or `$HOME`, or by a path that resolves into one.
2. Creates a throwaway worktree at the base commit on a uniquely named trial branch under `replay/`, and removes both on every exit: success, adapter failure, a crash, a timeout during the `worktree add` itself, SIGINT, SIGTERM and SIGHUP. The cleanup is idempotent and uses `worktree remove --force --force`, so a locked worktree goes too. Every runner git call runs with `core.hooksPath=/dev/null`, so the case repo's hooks never run.
3. Runs `setup_commands`, then renders the arm's `builder-template.md` (`git show <resolved sha>:skills/core/offload/builder-template.md` in the arm's skills repo) and calls the builder adapter in the worktree.
4. Checks that the builder committed (`no-commit` otherwise) and left no uncommitted changes (`dirty-tree` error, no stash), then runs the case's `gate_commands` in the worktree only, each as a `sh -c` command line. It runs nothing that is not in `gates_text`, and never executes criteria text. It refuses cases whose `gate_commands` are not marked `gate_commands_reviewed`.
5. Captures the diff, removes the worktree, then calls the grader adapter with the sealed input.

Both adapters are exec'd directly, never through a shell, with one JSON object on stdin and one on stdout (the `evals/run.py` protocol). Each adapter call, setup command and gate has a timeout (`--timeout`, default 600 s); a timeout gives the trial outcome `error` with reason `timeout`. The builder's brief holds the criteria but never says which ID was missed: every name the builder can see (branch, trial directory, result path, request, environment) uses an opaque per-trial token (`t` plus 12 hex digits from a hash of case id, arm and trial) instead of the case id or the arm, and the per-case JSON maps the token back (`token`). The builder's environment points `AGENT_HANDOFFS_DIR` at the trial directory.

### Brief rendering

Only the lines inside the template's single ```` ```text ```` fence are used, and exactly five lines change; every other line is byte-identical. The runner refuses a template with zero or two `text` fences, or with a label missing or repeated:

| Line | Filled with |
| --- | --- |
| `Execute <slice goal> in <absolute worktree> on <branch>.` | case `goal`, the trial worktree, the trial branch |
| `Owned files: <paths>.` | case `owned_files` (`Protected paths: <paths>` stays) |
| `Acceptance:` | the label alone, then the case criteria verbatim, one per line |
| `Gates:` | the label alone, then `gates_text` verbatim |
| `Result file: <path>` | the trial's result path replaces `<path>`; the rest of the line (for example `. Handoff: $OFFLOAD_HANDOFF.`) is kept |

Everything after `Acceptance:` and `Gates:` on those two lines is replaced. A template that puts a placeholder on the next line keeps it.

### Sealed grader input

Exactly `{id, diff, criteria, gate_output}`: `diff` is `git diff <base>..<head>`, `criteria` is the case text, `gate_output` is each gate command, its exit code and its output, and `id` is the opaque trial token. There are no commit messages, no result file or handoff text, and no arm name. The trial's result file and handoff live in the trial directory, outside the worktree.

The grader process is sealed too, not only its stdin. It runs after the worktree is gone, in a fresh empty temporary directory, with `OFFLOAD_*`, `REPLAY_*` and `AGENT_HANDOFFS_DIR` removed from its environment. The built-in fake grader gets its capture path, grade table entry, seed and token through dedicated `REPLAY_FAKE_GRADER_*` variables that the runner sets only for it; none holds an arm name.

A builder that leaves HEAD at the base commit (edits without committing) is recorded as `error` with reason `no-commit`; only commits are graded.

### Spend guard

`--fake` selects the built-in fake builder and grader. Any other adapter is refused unless `--spend` is given, decided per role by the flag, never by the file name. The runner first prints `planned: N builder calls, N grader calls (cases x 2 arms x trials)`, before any adapter call, then refuses (exit 2). `--trials` must be at least 1.

### Output

`--output` must not exist, must not be inside a git work tree (it holds briefs, diffs and criteria of real cases) and is created mode 700; nothing is overwritten. It holds `summary.json`, `cases/<case id>.json` and `trials/<case id>/<arm>-<n>/` (brief, result file, handoff, builder record, grader input).

Each trial record has: case id, arm, skills ref and its resolved full SHA, trial index, trial token, base commit, gates with exit codes and output, per-criterion grades, outcome and reason. Outcomes:

| Outcome | Meaning | In the denominator |
| --- | --- | --- |
| `graded` | the grader gave MET or NOT MET for every missed ID | yes |
| `ungraded` | the grader reply lacked a valid grade for a missed ID (never read as MET) | no |
| `error` | adapter failure, non-JSON reply, timeout, no-commit | no |
| `skipped` | the case was skipped (missing commit, live-path command) | no |
| `env-unavailable` | a setup command failed | no |

A trial is a **named miss** when any missed ID is graded NOT MET. Per arm, the rate is named-miss trials divided by graded trials, `null` (printed `n/a`) when no trial was graded. `per_id` gives the same rate for each `<case>:<ID>`. The not-graded counts are reported apart. Exit status is 1 when any trial ended in `error`.

### Fake adapters

`--fake-builder-mode` is `commit` (default), `fail`, `no-commit`, `dirty` (commits, then leaves an untracked file), `lock` (locks its own worktree), `sleep` or `garbage`. `--fake-grades FILE` maps `<case>/<arm>/<trial>` to fixed grades, `"ungraded"` or `"exit1"`; unlisted criteria are graded from `--seed`, so a seed reproduces its grades. `--inject-fault after-worktree` raises inside the runner, for cleanup tests.

### Try it

One command, from the repository root, builds the synthetic fixture and runs both arms twice (current is `94bdb26` in this repo, revised is the fixture's own template repo):

```sh
DIR=$(mktemp -d); python3 evals/replay/run_replay.py --demo "$DIR/fx" --fake --trials 2 --current-ref 94bdb26 --output "$DIR/out"
```

Do not run a spend trial from here. The real builder and grader adapters are a later slice.
