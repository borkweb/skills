# Builder brief

Fill this template for the slice. Save the brief and link it; print it in full only for manual handoff.

```text
Execute <slice goal> in <absolute worktree> on <branch>.
Owned files: <paths>. Protected paths: <paths>.
Authorization: <exact commit/push/merge permissions and prohibitions>.
Contracts: <existing frozen contracts; freeze new ones only if this slice requires it>.
Acceptance: <criteria frozen before results exist>.
Gates: <commands, expected results, evidence paths, required RED chronology>.
Result file: <path>. Handoff: $OFFLOAD_HANDOFF.

Before substantive edits, give a brief plan and every genuine disagreement with file evidence. No disagreement is a valid outcome. Report unresolved scope or contract conflicts before dependent work; proceed on settled instructions.

Use only the delegated lanes explicitly assigned by the architect and available runtime capacity. An independent reviewer must remain read-only and cannot be the builder. Do not grade your own work or change frozen gates.

Preserve the requested prose style; code, commands, errors, commit messages and PR text stay exact or normal as appropriate. Do not enable a persona implicitly.

Complete the authorized delivery steps, then update the handoff via its CLI:
- builder_session: actual session/resume ID.
- Gate results: pass/fail, exact counts, command, exit code and path to raw evidence.
- Work summary: changed paths, branch/commit state, remaining work and blockers.
Use `node "<resolved handoff.mjs>" section append|set "$OFFLOAD_HANDOFF" "<heading>" --file <file>`; never splice Markdown or write the architect's ledger.

At completion, run `node "<resolved handoff.mjs>" ready "$OFFLOAD_HANDOFF"`.
For a mid-slice blocker, record Open disagreements, then run `node "<resolved handoff.mjs>" blocked "$OFFLOAD_HANDOFF"` and report what needs a ruling. Do not silently wait.
Ownership refusal is a blocker: do not use --steal or edit the path to bypass it. The dispatcher supplies the architect's session identity. Use only the status vocabulary documented by the CLI.
```
