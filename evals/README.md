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
