# Decisions and user involvement

The host identifies choices; the runner records their classification and enforces the resulting pause. It cannot detect an unreported dilemma or authenticate a claimed user message. Be truthful about stakes, uncertainty, user instructions and evidence. Do not downgrade a decision to avoid asking.

## Choose involvement at intake

Interpret explicit language such as “work with me on the choices,” “ask at checkpoints,” or “handle routine decisions without me.” State the chosen mode once. When unspecified, use **checkpointed**. Do not infer autonomous authority from “finish” or “keep going.”

| Mode | Decide without asking | Ask the user |
| --- | --- | --- |
| `collaborative` | Routine reversible choices within the request | Consequential choices and every hard boundary |
| `checkpointed` (default) | Routine choices and consequential choices outside the configured checkpoints | Consequential choices at configured checkpoints; every hard boundary |
| `autonomous` | Within-scope choices, with council where policy calls for it | Every hard boundary; no repeated approval for already-authorized routine work |

The contract's `decisionPolicy` is `{ "mode": "checkpointed", "checkpoints": ["approach", "delivery"], "council": "auto" }` by default. `checkpoints` may use the decision topics below. They govern **unresolved choices**, not a requirement to ask again before every action the user already specified. Clear requests and settled decisions do not need ceremonial questions.

Hard boundaries always require the user: expansion beyond agreed scope, changes to frozen acceptance, missing authority, and blockers needing a user ruling. “Fully automated” means decisions delegated **within the recorded contract**, not permission to deploy, spend, delete, change requirements, switch a mandated harness, or disable safeguards. Budget exhaustion remains a stopping condition.

`council` values: `auto` consults council for consequential uncertain tradeoffs; `requested` only when the user explicitly asks; `off` disables automatic consultation. A later explicit council request takes precedence and must be quoted in `councilRequested`. A named parallel council requires the user's explicit request; the default is simulated perspectives in one response, not separate agents or independent verification.

Mode/checkpoint changes are not silently inferred during a run. Record a new user instruction and use a linked, scoped continuation with its updated policy after resolving old ownership. Do not replay prior external effects or reset budgets just to get unstuck.

## Classify the choice

Use `routine` for low-impact reversible implementation details, `approach` for architectural/product tradeoffs, and `delivery` for choices about an already-authorized delivery. Use `scope`, `acceptance`, or `authority` only for a proposed change beyond the frozen boundary or missing permission—not ordinary discovery within scope. Use `blocker` when progress needs information or a ruling only the user can supply.

Separate consequential stakes from uncertainty. A high-impact decision already settled by the request does not need a debate. Missing facts should trigger investigation; missing permission should trigger a user question. Neither is solved by a council vote. Do not use council for formatting, routine fixes, naming, or every graph node.

At a settled checkpoint, record one focused `question` with 2–5 viable options and a recommendation. Routine choices need neither a ceremony nor a council. For an unresolved within-contract choice discovered mid-assignment, the worker returns `blocked` with category `decision` and evidence; settle or reconcile other workers, then open the question with optional `node` pointing to that paused node. The ruling requeues that node with the same scope and retained history. Resuming consumes an ordinary execution attempt, not a correction or replan. The new handoff includes the ruling and prior partial work.

Link only within-contract `routine`, `approach`, `delivery`, or `blocker` questions. Scope, acceptance and authority changes require an unlinked decision followed by the appropriate replan/new scope. External-effect nodes cannot use a decision pause or be resumed through a ruling: resolve their choices in preflight, or reconcile actual effects if interrupted. Unknown liveness remains unresolved—use the host conversation to request help if workers cannot be safely settled. Opening a decision pauses all new scheduling in this version, not just one branch. No automatic timeout selects the recommendation.

```json
{
  "topic": "approach",
  "stakes": "consequential",
  "uncertain": true,
  "question": "Which retry policy meets our latency and load constraints?",
  "options": ["Fixed delay", "Exponential backoff with jitter"],
  "recommendation": "Exponential backoff with jitter"
}
```

The receipt contains the decision ID, `requiresUser` and `requiresCouncil`; `status` reports `waiting-decision`, the pending record, and no eligible nodes. The question and policy survive controller handoff.

## Consult, rule, resume

When `requiresCouncil` is true, read and use [council](../../council/SKILL.md). Supply the narrow decision, live evidence, constraints, alternatives and uncertainty. Use quick mode unless the stakes or user request call for a fuller debate. Save the actual council response, recommendation, strongest counterargument and unresolved disagreement outside source scope. Its simulated seats are advisory, not independent review or proof of correctness. Do not modify council or launch parallel seats merely because the runner asks for an assessment.

If `requiresUser`, ask through the host's supported user-input tool or conversation. Present the recommendation and material tradeoff after assessment; the user can choose their own alternative. Remain paused without a reply. A direct user ruling may make council unnecessary; the runner records that council was skipped for that reason. Never fabricate a user answer or treat an agent/council response as `by: "user"`.

Otherwise, the controller selects an offered option using the evidence and policy and logs why. Submit `decide` with the actual ruling:

```json
{
  "decision": "ACTUAL_DECISION_ID",
  "choice": "Exponential backoff with jitter",
  "by": "controller",
  "source": "Within-scope choice delegated by the autonomous policy",
  "rationale": "Reduces synchronized retry load within the agreed latency budget.",
  "evidence": ["/absolute/private/decision-evidence.md"],
  "councilEvidence": ["/absolute/private/council-response.md"]
}
```

Use `by: "user"` only for a real user response, with its exact instruction in `source` and saved evidence. Controller resolutions require council evidence when requested by policy, and cannot resolve user-required questions. User resolutions may name a new alternative; the original options remain recorded. Evidence is copied and hashed. A ruling **does not** itself edit the task contract or grant an effect: apply the permitted versioned replan afterward, or obtain the newly authorized scoped continuation when authority expands.

If a decision's retained evidence is missing/corrupt, or the ruling genuinely needs reconsideration, use `reopen-decision` with `decision` and `reason` after workers settle. It retains the old resolution and pauses work under the same user/council requirements while fresh evidence is gathered. A new choice that affects completed work also needs appropriate invalidation/replanning; recording a different preference does not reverify old code. Include unresolved decisions and their IDs in every continuation handoff.
