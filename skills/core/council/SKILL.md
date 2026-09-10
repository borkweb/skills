---
name: council
description: "Assess a proposal from multiple perspectives when the user requests a council, debate or adversarial assessment."
---

# Council

Assess a proposal from several useful perspectives and return a reasoned verdict. Default to simulated seats in one response; these are not independent evidence or actual expert experience. Delegate read-only seats only when the user requests parallel agents and the runtime supports them.

## Frame and select

Identify the idea, decision, constraints and stakes from the request. Ask only for a consequential missing input. Use only the seats that add a distinct lens: Visionary (opportunity), Devil's Advocate (failure/falsifier), Pragmatist (feasibility), Ethicist (values/impact), Jester (reframing), or a requested domain, steward or user lens.

Options: `-q` gives openings and verdict only; `-r N` selects 1–4 rounds (default 2 for a full council); `-f X` selects a focus. Use quick mode for a small decision unless a full debate was requested. A single-seat request stays single-seat.

## Assess

Each seat gives its strongest evidence-based case without pre-answering another. Separate facts, inference and speculation. In full mode, challenge a specific claim per round, record meaningful position changes and preserve real unresolved disagreements. No disagreement is a valid outcome; do not manufacture tension or pretend convergence proves correctness.

Load [seat formats](references/seat-formats.md) or [roles](references/roles.md) only when a requested seat needs detail. For a full multi-round council, use relevant [debate protocol](references/debate-protocol.md) guidance and optionally the [output example](references/output-example.md). The task's scope and evidence rules here take precedence over templates; they do not require invented disagreement, quantitative confidence or distant consequences for a short-lived decision.

## Verdict

State the recommendation, strongest counterargument, material risks/mitigations and the next useful decision or test. Use PROCEED, PROCEED WITH CONDITIONS, RECONSIDER or DO NOT PROCEED. Calibrate confidence to evidence; do not invent probabilities. Keep quick-mode output brief and omit empty sections. Do not modify project files or start implementation unless separately requested.
