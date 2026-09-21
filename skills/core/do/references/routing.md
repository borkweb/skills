# Task selection

Select an ordered sequence of outcomes from the user's request, not from incidental words in source files. A later outcome must depend on the preceding outcome's report. For example, “find and fix” is `diagnose → implement`; “review” is only `review`. Authority is recorded separately with the user's actual instruction as provenance.

An outcome is a requested endpoint, not a work breakdown. “Update parser, tests and docs” normally belongs to one `implement` outcome with several acceptance criteria. Split only when the user requests distinct reports/acceptance boundaries or genuinely dependent endpoints, such as diagnosis before an authorized fix. Do not split by file, worker, or ordinary implementation step: every later writer revalidates earlier implementation gates. Preserve explicitly requested staged acceptance; do not merge stages merely to reduce checks. The entrypoint’s fast-path gate decides whether trivial edits need any durable graph at all.

| Kind | Work and endpoint | Relevant skill when available |
| --- | --- | --- |
| `answer`, `research` | Gather needed evidence, give a supported answer; no source edits | Topic-specific research or documentation |
| `diagnose` | Establish a cause and report a correction; no source fix | [investigate](../../../gstack/investigate/SKILL.md) |
| `review` | Pin scope, investigate, return findings and coverage; no fixes or PR comments | [review](../../../gstack/review/SKILL.md), [qa-only](../../../gstack/qa-only/SKILL.md) for browser assessment |
| `plan` | Produce the requested proposal, plan or design artifact; no implementation | [writing-plans](../../writing-plans/SKILL.md) and relevant plan review |
| `prototype` | Build an isolated experiment, evaluate the learning question, report learning | [prototype](../../prototype/SKILL.md) |
| `implement` | Scope, change, freeze, verify, independently review when required, report | [auto-scope](../../auto-scope/SKILL.md), relevant implementation methods, [review](../../../gstack/review/SKILL.md) |
| `deliver`, `operate` | Preflight, exact authorized action, observed postflight, report | Applicable delivery or service tool guidance |
| `monitor` | Observe and wait until the requested condition or stop rule; no implied corrective action | Runtime-supported waiting or monitoring facilities |

All durable routes have a final report. `plan` may have no source-write effect when the proposal is conversational or prepares private workflow artifacts (contracts, evidence, handoff packets) outside the repository. These coordination artifacts do not authorize source edits. Name `write` and scoped artifact paths when creating project files. `prototype` and `implement` require `write`. A dry-run operation has no effects. `deliver` must name its authorized effects. For writing a finished project document, use `implement` with artifact-specific verification rather than code-test boilerplate.

Use `light` for low-impact reversible work, `standard` for normal implementation, and `sensitive` for significant trust, data or operational consequences. Classify from impact, not line count. An auth change stays sensitive even when it changes one line. Risk classification never removes a mandatory specialist check.

Surface flags attach checks to implementation: `ui` adds browser verification, `data` adds data-contract checks, `security` adds an independent security assessment, and `api` adds interface-contract checks. Standard/sensitive implementation requires an independent review. Light implementation still needs one if security/data surfaces or applicable instructions require it. Add explicit `checks` for project gates and any mandatory review not already selected. All supplied checks are required; there is no optional “passed by omission” state.

Record frozen acceptance in outcome goals and check instructions. For automated gates, include exact commands and expected outcomes when known. An empty check list does not waive the built-in behavior-verification node. For frontend review-only work add a browser check explicitly. Expand discovery when evidence contradicts the working hypothesis; do not run all plan reviews for every task.

Give each explicit check a distinct coverage responsibility. The built-in behavior verifier waits for explicit non-review gates, consolidates their accepted evidence and checks remaining behavior; it does not rerun those commands by default. Independent review stays separate. Integration copies retain these dependencies on the later snapshot, so historical results cannot satisfy current verification.

Read-only checks can run concurrently only when their environments do not interfere. Browser profiles, databases, services, fixtures and ports are shared resources unless explicitly isolated. The current runner permits read-only fan-out and serializes mutating assignments. Multi-builder scheduling and automatic resource reservation are deferred.

Changing scope, acceptance or routing requires a recorded replan. A replan can narrow authority, but cannot enlarge permissions or reset budgets. If new user instructions authorize a wider task, reconcile the old run, create a new scoped contract/run, and include the prior run path in its rationale. Never infer expanded authority from “keep going” alone.
