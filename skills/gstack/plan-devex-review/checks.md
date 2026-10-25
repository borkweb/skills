# Developer experience checks

Read only the passes selected by the mode in SKILL.md. Use actual supported environments and consumers, not an imagined universal developer persona. For comparative examples, read only the matching pass in `dx-hall-of-fame.md`; verify current product behavior before relying on it.

## Pass 1: Getting started
Trace prerequisites, install, credentials, first command and a meaningful successful result. Verify command syntax and expected output. Surface setup failures and the path to recovery. A playground or free tier is an option when it fits the product, not a mandatory feature. Time actual runs and record environment; do not invent onboarding times or adoption multipliers.

## Pass 2: Interface design
Check naming, defaults, discoverability, consistency, complete input/output contracts, idempotency, sync/async behavior and escape hatches. For CLIs, inspect help, exit codes, stdout/stderr and scripting behavior. For SDKs/APIs, inspect error types, auth, pagination, limits and compatibility where applicable.

## Pass 3: Errors and debugging
Agents hit most errors first, read them literally and cannot ask what was meant. Trace realistic error paths in the selected journey, including one unexpected failure (a crash or dependency failure), and check each against the agent-ready contract in `dx-hall-of-fame.md`: what failed with the actual values; a fix or precise escalation on the first or last line, safe and authorized; recovery (retry unchanged, fix and retry, do X first, ask a human) with side effects and a retry bound; a stable code with a doc anchor; context without secret values; a trace for unexpected failures only; redaction everywhere; and a native machine channel that signals failure as failure, never exit 0, HTTP 200 or `isError: false`. A usage error rejected before any work needs only what, fix, code, redaction and channel. An applicable item the plan never specifies for a path it introduces is a gap. Four conditions are blocking findings in every mode, triage included: a path leaks a secret, signals failure as success, gives an unsafe fix, or blocks waiting for a terminal without naming a non-interactive alternative such as `--yes`. Distinguish an observed command failure from a simulated newcomer hypothesis.

## Pass 4: Documentation
Check a complete example against the installed version, expected output, concept introduction and the route from quick start to reference. Do not demand exhaustive documentation for interfaces outside scope.

## Pass 5: Upgrade and migration
Check compatibility, version policy, deprecations and recovery. Trace a real prior-version consumer where available. Migration tooling is justified by actual migration burden.

## Pass 6: Environment and tooling
Check supported platforms, reproducibility, dependency setup, local feedback and test/debug loops. Avoid adding editor integrations or hosted tools just to fill a checklist.

## Pass 7: Support and ecosystem
When relevant, inspect support paths, issue reporting and maintained examples. Community activity is evidence to check, not something inferred from a brand name.

## Pass 8: Measurement
Define observable success and failure, feedback collection and what would change the decision. Distinguish measured duration and completion from predictions. Do not treat heuristic ratings as calibrated adoption probabilities.
