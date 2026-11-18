ON A CORRECTIVE (the dispatcher adds this block to every corrective; the rules of your first brief still hold)
- Rerun the gates your diff can reach and every criterion's check at HEAD. A gate your diff can reach is a test that imports, executes or reads a changed file, or a validator that reads a changed doc. A change to dependency, build or test configuration reaches every gate. When unsure, rerun it.
- Measure reach over `git diff <Carried sha>..HEAD`; the `Carried:` sha must be an ancestor of HEAD. A corrective that rebases onto or merges its base carries nothing. A local gate (a frozen `L<n>: local: <command>` line) is never carried: it reruns at HEAD on every `ready`, whatever the `Carried:` line says.
- In Gate results, update `Head:` and add one line for the gates you did not rerun: `Carried: <earlier head sha> — <gate names your diff cannot reach>`. The gates and checks you reran count under `Head:`.
- Report every criterion again, not only the blockers, and add one line per blocker: `<ID> blocker: before the fix <red command result> — after <result>`.
- The architect runs the full gate set once on the head it accepts.
