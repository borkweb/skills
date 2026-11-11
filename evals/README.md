# Skill behavior evaluations

`cases.json` contains regression requests and observable criteria. They are not tests of exact prompt wording. Cases include successful inputs that need no edits, adjacent prompts that must not activate a skill, explicit authorization, missing evidence and realistic failure paths.

Compare **no-skill**, **current** and **revised** on the same fixture and model. For each run record runtime/version, actual model ID, effort, source revision, permissions, available tools, initial fixture state and repetitions. Use isolated disposable checkouts for mutation cases; never run commit fixtures in the real repository. A baseline checkout can be created from the reviewed revision without modifying the working tree.

Run through a local adapter:

```sh
python3 evals/run.py --cases evals/cases.json --variant revised \
  --skill-root /absolute/skills-checkout --runtime codex --runtime-version VERSION \
  --model MODEL --effort EFFORT --revision REVISION --output /tmp/skill-run.json \
  --runner /absolute/model-adapter
```

The runner executes the adapter directly (no shell). For every case the adapter receives JSON on stdin with `case`, `skill_file` (null for no-skill), `variant` and run metadata. It must set up the described fixture, expose the candidate skill through normal runtime discovery (do not force-load it for negative-trigger cases), invoke the specified model/runtime, preserve a tool trace and return JSON with `output`, `trace`, `usage` and any `artifacts`. Use isolated runtime profiles so no-skill runs cannot discover another installed copy. Record permissions and tool availability with the result. Usage should include input/output tokens and cached input where exposed. An unavailable metric is null, not zero. Do not give the adapter's model the expected criteria; the driver strips them from its input.

The driver records elapsed time, adapter failures and raw results. It does not judge its own output or certify a model from text matching. Compare results blind against the criteria: facts and literals preserved, correct actions/verdicts, actual fixture state, missed/false findings, redundant questions/checks, tools, latency and cache-aware token use. Deterministic fixture assertions should check commits, diffs and exit codes where applicable. For subjective prose, use independent paired judgment.

Start with the core preservation and authorization cases. Expand each pilot skill to 10–20 realistic cases and repeat them before drawing broad conclusions. Small forward tests establish regression evidence, not a cross-model speedup. Keep required contracts when a shorter variant performs worse.

The builder replay eval has its own format, case builder and runner: see [replay/README.md](replay/README.md). Record the source revision of each arm in a replay result as a full SHA, not a ref name.

## Real builder replay run (paid)

The replay runner can drive a real builder and a real grader, `claude` or `codex`, headless. **Every real call is a paid model call.** No real run was made in the slice that added these adapters; the commands below have only been exercised against stub executables. Each real call needs an API key in the environment (`ANTHROPIC_API_KEY` for `claude`; `OPENAI_API_KEY` or `CODEX_API_KEY` for `codex`), because the model process gets a temp HOME and no keychain, config or auth file is copied. Without `--spend` the runner prints the planned call counts and stops.

The case store holds no cases today (`~/.agent-handoffs/replay-cases/` is empty), so the commands need cases first: build them with `python3 evals/replay/build_cases.py` or write one by hand (see the manual corpus steps in [replay/README.md](replay/README.md)), read each case's gate commands, and set `gate_commands_reviewed` to `true`; the runner refuses a case otherwise. Check them with `python3 evals/replay/run_replay.py --check --cases "$CASES"`. For a dry run that costs nothing, `python3 evals/replay/fixture.py "$DIR/fx"` builds a synthetic case dir (`$DIR/fx/cases`) and `--demo` replays it with the built-in fakes.

Run one case for one trial as a smoke step. It checks the real CLI envelope, your credentials and the sandbox before you pay for the full run:

```sh
python3 evals/replay/run_replay.py --cases "$CASES/ONE-CASE.json" --output "$OUT/smoke" --current-ref "$A" --revised-ref "$B" --builder-harness claude --grader-harness claude --trials 1 --spend
```

Read `$OUT/smoke/summary.json` and `$OUT/smoke/cases/*.json`. If the trial is `error` or `ungraded`, read its reason before going on. Then the full run:

```sh
python3 evals/replay/run_replay.py --cases "$CASES" --output "$OUT/run-1" --current-ref "$A" --revised-ref "$B" --builder-harness claude --grader-harness claude --trials 5 --spend
```

`$CASES` is `~/.agent-handoffs/replay-cases`, `$OUT` is a new directory outside any git work tree, and `$A` and `$B` are the two skills revisions (`--skills-repo` defaults to this repo). Use `codex` for either harness if you prefer. Details, limits and the cost cap are in [replay/README.md](replay/README.md#real-adapters).

