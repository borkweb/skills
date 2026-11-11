# Builder replay eval

Measures whether a change to `skills/core/offload/builder-template.md` makes a builder less likely to miss a criterion that a past run missed. A **case** is a past slice: a repo at a base commit, the frozen criteria and gates, and the criterion ID(s) the builder missed. The runner replays each case under two skill revisions (**current** and **revised**), grades the builder's diff, and reports the named-miss rate per arm.

The format, the case builder, the runner and a deterministic fake builder and grader make no model calls. The real builder and grader adapters (`claude` or `codex`, see [Real adapters](#real-adapters)) make paid calls and refuse without `--spend`.

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
| `setup_commands` | optional list, run in the trial clone before the builder starts. A failure gives the trial outcome `env-unavailable` |

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

A `notes.md` line that names a different slice tag (for example `S2 base @ <sha>`) does not count for this slice unless it also names this one.

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
4. Write `<case id>.json` by hand in `~/.agent-handoffs/replay-cases/` (mode 700), with `provenance` set to the session and subagent IDs. Put the commands you will run in `gate_commands` and set `gate_commands_reviewed` to `true` (the runner and `--check` refuse a case whose `gate_commands` or `gate_command_candidates` are not marked reviewed).
5. Check it: `python3 evals/replay/run_replay.py --check --cases ~/.agent-handoffs/replay-cases`.

## Runner

```sh
python3 evals/replay/run_replay.py --cases DIR --output NEW_DIR --current-ref REF --revised-ref REF [--trials N] \
  (--fake | --fake-builder | --builder-adapter EXE) (--fake | --fake-grader | --grader-adapter EXE) [--spend]
```

Per case, trial and arm it:

1. Skips the case, with the reason, when its base commit is missing from the repo (it never fetches) or when a gate or setup command, or the case's `goal`, `owned_files`, `criteria` or `gates_text`, names a live path: the repo or any of its worktrees, literally, through `~` or `$HOME`, or by a path that resolves into one. The skip reason names the field. The brief is rendered from those fields, so a live path in them would send the builder to the live repo.
2. Makes a disposable trial repo that holds exactly one ref and nothing after the base commit: `git init <dir>`, then `git fetch --no-tags <repo> <base sha>:refs/heads/<trial branch>`, then a checkout of that branch. The branch name is `replay/` plus the trial token and a random suffix. The trial repo has no other branch, no tag, no later commit (a builder cannot read the real fix), no remote, no reflog or `FETCH_HEAD` naming the live repo, no alternates, and no hardlink to the live object store. The live repo's worktree and branch lists are unchanged by construction. The directory is removed on every exit: success, adapter failure, a crash, a timeout during the fetch itself, SIGINT, SIGTERM and SIGHUP. The cleanup is idempotent and also removes a repo the builder left read-only. Every runner git call runs with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1` (a replace ref the builder makes cannot change the sealed diff) and `GIT_LFS_SKIP_SMUDGE=1`, so the case repo's hooks, fsmonitor and LFS never run and a partial clone never fetches. A local filter driver in the live repo's config never reaches the trial repo; a test proves this with a slow smudge filter.
3. Runs `setup_commands`, then renders the arm's `builder-template.md` (`git show <resolved sha>:skills/core/offload/builder-template.md` in the arm's skills repo) and calls the builder adapter in the clone. The request key for that directory is still `worktree`.
4. Refuses the trial (`error`) when the trial repo's `.git` is not a real directory, then restores `.git/config` to the copy taken before the builder ran (the builder controls that config). Every runner write after the builder (that config, `builder-reply.json`, `grader-reply.json`) removes a regular file first and creates its target exclusively with `O_NOFOLLOW`; a symlink or other non-regular file the builder planted there gives an `error` trial and nothing is written through it. The runner owns the trial repo's `.git`: it takes back write access the builder removed (`chmod 0700`) before the config restore, and any restore failure is an `error` trial. Two more defenses, each tested alone, cover a redirect to a config the builder wrote elsewhere: the trial is an `error` when `.git/commondir` or `.git/gitdir` exists after the builder (a real clone has neither; the check runs after the runner takes `.git` back, and a failure to look counts as present, so a builder that makes `.git` unsearchable cannot hide one), and every runner git call on the trial repo after the builder starts runs with `GIT_DIR` and `GIT_COMMON_DIR` set to the clone's own `.git` and `GIT_WORK_TREE` set to the clone, which overrides a planted `commondir` file. Calls on the live repo do not get those variables. So no runner git call reads a config the builder planted. `git status` runs with `--ignore-submodules=all`. It checks that the builder committed (`no-commit` otherwise) and left no uncommitted changes (`dirty-tree` error, no stash), then runs the case's `gate_commands` in the clone only, each as a `sh -c` command line. It runs nothing that is not in `gates_text`, and never executes criteria text. It refuses cases whose `gate_commands` or `gate_command_candidates` are not marked `gate_commands_reviewed`.
5. Captures the diff, removes the clone, then calls the grader adapter with the sealed input.

Both adapters are exec'd directly, never through a shell, with one JSON object on stdin and one on stdout (the `evals/run.py` protocol). Each adapter call, setup command and gate has a timeout (`--timeout`, default 600 s) and runs in its own process group; on a timeout, SIGINT, SIGTERM or SIGHUP the whole group is killed, so a gate that starts a server leaves nothing running. A timeout gives the trial outcome `error` with reason `timeout`. Every subprocess the runner starts (setup and gate commands, adapters, and its own git calls) gets an environment built only from an allowlist, never from the parent environment minus a denylist: `PATH`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ`, `TERM`, `TMPDIR`, proxy and CA variables (`real_adapter.PASS`), the per-trial `AGENT_HANDOFFS_DIR` and `BORK_REPO_RULES_DIR`, and a temp `HOME` under the trial directory (an empty directory; the builder adapter, setup and gates share the trial's `home/`; the grader adapter gets a separate fresh empty directory outside the trial directory, removed after the call, because the trial directory holds the builder's result file, handoff and reply; `--gates-real-home` changes only the gates and setup). A built-in real adapter also gets its own harness's credential variable and nothing else. Nothing else is inherited: no GitHub or OAuth token, no `*_SOCK` path, no session ID, no `CLAUDE_*`, `CODEX_*`, `BORK_*` or `HERDR_*` variable. The runner also scrubs credential values from the text it records. Setup and gate commands run code the builder wrote and their output reaches the grader. `--gate-env NAME` (repeatable) forwards one more variable to gates, setup and adapters; use it for a toolchain variable a gate needs, or a variable your own `--builder-adapter` reads. It weakens blinding, and the per-case JSON records the names in `gate_env`. `--gates-real-home` gives them the real `HOME` for toolchains that need it (gems, node, pnpm caches); it weakens blinding, because model-written code can then read the case store through `~`, and the per-case JSON records `gates_real_home`. The builder's brief holds the criteria but never says which ID was missed: every name the builder can see (branch, trial directory, result path, request, environment) uses an opaque per-trial token (`t` plus 12 hex digits from a hash of case id, arm and trial) instead of the case id or the arm, and the per-case JSON maps the token back (`token`). The builder's environment points `AGENT_HANDOFFS_DIR` at the trial directory.

### Brief rendering

Only the lines inside the template's single ```` ```text ```` fence are used, and exactly five lines change; every other line is byte-identical. The runner refuses a template with zero or two `text` fences, or with a label missing or repeated:

| Line | Filled with |
| --- | --- |
| `Execute <slice goal> in <absolute worktree> on <branch>.` | case `goal`, the trial clone, the trial branch |
| `Owned files: <paths>.` | case `owned_files` (`Protected paths: <paths>` stays) |
| `Acceptance:` | the label alone, then the case criteria verbatim, one per line |
| `Gates:` | the label alone, then `gates_text` verbatim |
| `Result file: <path>` | the trial's result path replaces `<path>`; the rest of the line (for example `. Handoff: $OFFLOAD_HANDOFF.`) is kept |

Everything after `Acceptance:` and `Gates:` on those two lines is replaced. A template that puts a placeholder on the next line keeps it.

### Sealed grader input

Exactly `{id, diff, criteria, gate_output}`: `diff` is `git diff --no-ext-diff --no-textconv --no-color --no-renames --no-relative -U3 --src-prefix=a/ --dst-prefix=b/ <base> <head>`, so a diff program, textconv or diff config planted in the trial repo cannot change it (the config restore is a second layer; a test skips it and plants the driver), `criteria` is the case text, `gate_output` is each gate command, its exit code and its output, and `id` is the opaque trial token. There are no commit messages, no result file or handoff text, and no arm name. The trial's result file and handoff live in the trial directory, outside the clone.

The grader process is sealed too, not only its stdin. It runs after the clone is gone, in a fresh empty temporary directory, with `OFFLOAD_*`, `REPLAY_*` and `AGENT_HANDOFFS_DIR` removed from its environment. The built-in fake grader gets its capture path, grade table entry, seed and token through dedicated `REPLAY_FAKE_GRADER_*` variables that the runner sets only for it; none holds an arm name.

A builder that leaves HEAD at the base commit (edits without committing) is recorded as `error` with reason `no-commit`; only commits are graded.

### Spend guard

`--fake` selects the built-in fake builder and grader. Any other adapter is refused unless `--spend` is given, decided per role by the flag, never by the file name. The runner first prints `planned: N builder calls, N grader calls (cases x 2 arms x trials)`, before any adapter call, then refuses (exit 2). `--trials` must be at least 1.

### Output

`--output` must not exist, must not be inside a git work tree (it holds briefs, diffs and criteria of real cases) and is created mode 700; nothing is overwritten. It holds `summary.json`, `cases/<case id>.json` and `trials/<token>/` (brief, result file, handoff, builder record, builder and grader replies, grader input). The trial directory is named by the opaque trial token, never by the case id or arm, so the builder and grader cannot read the missed ID from a path; `cases/<case id>.json` maps each token back (`token` on every trial record).

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

`--fake-builder-mode` is `commit` (default), `fail`, `no-commit`, `dirty` (commits, then leaves an untracked file), `readonly` (commits, then removes write permission from the trial repo), `plant` (plants a diff program, textconv and color in its config), `inspect` (records the trial repo's refs, whether `$FAKE_POST_BASE` is present, its hardlink counts, and whether anything in its `.git` names `$FAKE_LIVE_PATH`), `filter-readonly` (plants a clean filter, dirties a tracked file and removes write permission from `.git`), `symlink-config`, `symlink-reply`, `symlink-grader-reply` and `symlink-git` (plant a symlink to `$FAKE_VICTIM` where the runner writes next), `sleep` or `garbage`. `--fake-grades FILE` maps `<case>/<arm>/<trial>` to fixed grades, `"ungraded"` or `"exit1"`; unlisted criteria are graded from `--seed`, so a seed reproduces its grades. `--inject-fault after-worktree` raises inside the runner just after the trial repo is made, and `--inject-fault skip-config-restore` skips the config restore, for tests.

### Try it

One command, from the repository root, builds the synthetic fixture and runs both arms twice (current is `94bdb26` in this repo, revised is the fixture's own template repo):

```sh
DIR=$(mktemp -d); python3 evals/replay/run_replay.py --demo "$DIR/fx" --fake --trials 2 --current-ref 94bdb26 --output "$DIR/out"
```

Do not run a spend trial from here; the demo uses the built-in fakes only.

## Real adapters

`real_adapter.py builder|grader` is one paid, headless model call per request, for the harness `claude` or `codex` (`--builder-harness` and `--grader-harness`). The runner, not the adapter, decides which; every real path refuses without `--spend`. The command to run is in [../README.md](../README.md#real-builder-replay-run-paid). It starts with a one-case, one-trial smoke step.

**Refusals, in this order, before any process starts:** the request's `spend` is not exactly JSON `true` (absent, `false`, `"false"`, `"0"`, `"yes"`, `1` are all refused); the harness is not exactly `claude` or `codex` (`Claude`, `opencode` and the empty string are refused, with no default); the harness binary is not on PATH (the message names it; there is no fallback to another harness or a fake); the credential variable is unset (`ANTHROPIC_API_KEY` for `claude`; `OPENAI_API_KEY` or `CODEX_API_KEY` for `codex`; the message names it). The runner records a refusal as an adapter `error` and never calls the grader after a failed builder.

**Isolation.** The model process gets an allowlisted environment (`caselib.ENV_PASS`: PATH, shell and user names, locale, proxy and CA variables, and the one credential), a temp HOME under the trial directory, and, for the builder, `AGENT_HANDOFFS_DIR` and `BORK_REPO_RULES_DIR` under the trial directory and a git identity with signing off. It gets no `BORK_*` or `HERDR_*` variable, no session ID, no `OFFLOAD_*` or `REPLAY_*` variable and no token or agent socket. `codex` also gets a temp `CODEX_HOME`. No keychain, config or auth file is copied, so a real run needs the API key variable. `claude` runs with `--bare --no-session-persistence` (no CLAUDE.md, plugins, hooks, auto-memory or saved transcript); `codex` runs with `--ephemeral`. The arm is therefore **template only**: only the brief comes from the arm's ref, and the builder loads no installed bork plugin. Trials run in Local mode: the builder writes its Returns to the trial result file, with no `$OFFLOAD_HANDOFF` and no handoff CLI.

**Builder.** The rendered brief goes in on stdin, byte for byte. `claude -p --bare --output-format json --max-budget-usd N --permission-mode acceptEdits --settings <sandbox> --add-dir <trial dir>` with the clone as the working directory; the sandbox settings turn the sandbox on, allow sandboxed Bash and allow writes only under the trial directory. `codex exec -C <clone> --sandbox workspace-write --add-dir <trial dir> --ephemeral -`. The cap is `--max-budget-usd` (default 2) for `claude`; `codex` has no per-call cap, so only the wall-clock timeout bounds it.

**Grader.** A fresh call per trial, in an empty temp directory that is removed afterwards, with no worktree, result file or git log within reach. `claude -p --bare --tools '' --output-format json --json-schema ... --no-session-persistence`; `codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema ... -o <file>`. It gets only the sealed input. The reply must be `{"grades": {"<ID>": "MET" | "NOT MET"}}`, read from `claude`'s `.result` (or `.structured_output`) or from `codex`'s `-o` file; a fenced json block is parsed. Each frozen ID is recorded exactly as given, and anything else is `ungraded`: non-JSON text, a JSON array, an empty reply, a missing ID, `met`, `PARTIAL`, `true`, a nonzero exit, a timeout. An ID outside the frozen set is dropped. A failed or timed-out grader call gives all-`ungraded` with exit 0, so the trial counts as `ungraded` (never `error`, never MET) and the reason is recorded.

**Before the first call.** After the spend check, the runner checks every selected harness's binary and credential (builder and grader), so a mixed run such as a `codex` builder with no `ANTHROPIC_API_KEY` for a `claude` grader stops before any paid builder call. `--max-budget-usd` must be finite and greater than 0, in the runner and in the adapter.

**Timeouts and cost.** Every model call is killed, with its whole process group, after a wall-clock limit just under `--timeout`. A failed call is never retried. SIGINT kills the model process and the runner still removes the clone.

**Not verified without a real run.** The `claude` sandbox settings keys, `codex` authentication from an API key variable, and whether `codex`'s `workspace-write` sandbox lets the builder commit into the clone's `.git` (if it does not, every `codex` trial ends as `no-commit`). A temp HOME hides `~`, but a process running as the same user can still read an absolute path such as the case store; the brief, the environment and the clone never name it. The smoke step is where these show up.
