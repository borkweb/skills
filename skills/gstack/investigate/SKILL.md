---
name: investigate
description: "Investigate an error or unexpected behavior, establish its cause and apply a verified fix when requested. Uses focused paths for performance, environment and regression problems."

allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
---

# Investigate

Establish causal evidence before fixing a bug. For diagnosis-only requests, report the cause and correction without editing source.

## Start with the symptom

Read the error, failing test, issue or observed behavior. Establish expected versus actual behavior and reproduce the failure in the relevant environment. Inspect the implicated code, callers and data. Reuse a supplied verified root cause rather than repeating discovery.

Use quick mode for a direct, verifiable cause. If its first hypothesis fails, broaden the investigation. For performance, environment or regression problems read only the corresponding section of [specialized.md](specialized.md).

## Investigate

Keep a concise evidence log: observation, hypothesis, disconfirming check, result and next action. For an obvious bug this can be a few notes; for a long investigation save it in a temporary artifact. Avoid repeatedly rereading whole logs.

Follow data through the failure boundary. Check partial updates, stale state, permissions, encoding, time/locale, dependencies, concurrency and external contracts only as implicated by the evidence. Verify installed APIs before assuming a framework behavior. Use sanitized generic errors and primary sources for outside research; do not upload private logs or customer data.

Test a specific causal hypothesis with a reproduction, assertion, trace or controlled experiment. Seek evidence that could disprove it. Several failed hypotheses are a reason to reassess the model and evidence, not proof that the architecture is wrong. Continue useful checks; ask when unavailable information or a material scope decision blocks progress.

## Fix and verify

When a fix is authorized and the cause is supported, change the responsible code without adjacent cleanup. Preserve frozen contracts and unrelated dirt. For a logic/contract bug, add a meaningful regression test where the project supports it and show it fails without the fix and passes with it; retain explicitly required RED chronology.

Reproduce the original scenario against the final files, then run appropriate tests/lint once. Broaden coverage when the affected callers or failure evidence warrant it, and rerun affected checks after edits. Save raw logs and summarize results rather than pasting a full suite twice. File count alone does not require a new approval.

If a fix cannot be fully verified, label it unverified and do not ship it as proven. Do not weaken a test or delete it to manufacture green. Check related paths when the same cause plausibly affects them; propose broader architecture work separately.

## Result

Report symptom, supported cause, changed files, reproduction/test evidence, remaining uncertainty and delivery state. **DONE** requires the requested fix and required verification; **DONE_WITH_CONCERNS** identifies incomplete nonblocking coverage; **BLOCKED** names missing information or authority. Commit/push/merge only within existing task authorization.
