# Debate Protocol

Use this reference when the council request calls for a rigorous assessment, multiple rounds, a focus domain, or a final proceed/reconsider verdict.

## Platform-Neutral Execution

Run this protocol without assuming any specific agent orchestration feature.

- Claude: delegate seats as read-only analysis only when the user requests parallel agents and Task/Agent Teams are available; otherwise simulate seats internally.
- Codex: only use subagents when the user explicitly asks for parallel agent work; otherwise simulate seats internally.
- Gemini: use the same internal council structure unless its runtime provides an equivalent explicit delegation mechanism.
- Any platform: do not require direct seat-to-seat messages. Cross-examination can be represented as structured challenges and responses in one transcript.
- Any platform: if reference files cannot be loaded, continue using `SKILL.md` and skip only the extra detail.

Optional Claude Code Agent Teams setup:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

This enables true delegated council seats in Claude Code environments that support Agent Teams. Without it, run the same protocol internally.

## State To Track

- `topic`: idea or plan being evaluated
- `rounds`: debate rounds, default 2, clamp 1-4
- `focus`: optional domain from `-f`
- `quick`: true when `-q` is present
- `seats`: active council seats
- `opening_positions`: independent opening views
- `position_evolution`: how each seat changed across rounds
- `open_questions`: questions the council could not resolve

## Opening Positions

Each active seat gives:
- Position
- 2-4 specific arguments
- Confidence level from `references/roles.md`
- One question for another seat

Reject openings that are generic, placating, or detached from the topic.

## Cross-Examination

Each round:
1. Share the current positions.
2. Each seat challenges at least one specific claim from another seat.
3. Each challenged seat answers directly.
4. Track whether the response changed, narrowed, or hardened the seat's view.

If delegation is unavailable, write the challenge and response pairs yourself while keeping each seat's perspective separate.

Challenge format:

```text
Challenge to {seat}: Your claim that "{specific claim}" is weak because {reason}.
Question: {specific question they must answer}
```

Response format:

```text
Response to {seat}: On "{specific point}", {agree/disagree/modify} because {reason}.
Position update: {unchanged/changed} - {why}
```

## Moderator Interventions

Use these only when needed:

Groupthink:
- If seats converge too fast, ask what would make the opposite verdict right.
- Require the strongest seat for the majority view to steelman the minority view.

Evasion:
- Restate the unanswered challenge.
- Demand agreement, disagreement, or position modification with a reason.
- Mark the point unresolved if the seat still evades.

Stale debate:
- Ask a reframing question: shorter timeline, smaller budget, hostile competitor, public scrutiny, personal accountability, or failure of the key assumption.

## Verdict Rules

Allowed verdicts:
- `PROCEED`: strong support, low unresolved risk
- `PROCEED WITH CONDITIONS`: support depends on named guardrails, evidence, or sequencing
- `RECONSIDER`: the goal may be valid, but the approach or assumptions need revision
- `DO NOT PROCEED`: fatal flaw, unacceptable risk, or values conflict

Confidence:
- `HIGH`: broad agreement and stable positions
- `MEDIUM`: majority agreement with meaningful dissent
- `LOW`: divided council, major uncertainty, or late position changes

## Risk Matrix

Use this shape:

```text
| Risk | Likelihood | Impact | Raised By | Mitigation |
|------|------------|--------|-----------|------------|
| ...  | Low/Med/High | Low/Med/High/Critical | Seat | ... |
```

Treat `High likelihood + High/Critical impact` as a blocker unless a concrete mitigation exists.

## Final Synthesis

Include:
- Consensus points
- Dissensus points
- Position evolution
- Risk matrix
- Strongest counterargument, steelmanned
- Conditions if proceeding
- Open questions
- Next move

The verdict must reflect the debate record, not the moderator's private preference.
