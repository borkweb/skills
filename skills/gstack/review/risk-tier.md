# Risk tier

Only the primary review owner uses this file. An assigned independent reviewer or a design subagent skips it. Paths here are relative to this skill's directory.

The tier says how many people must approve the change. It is separate from the verdict: a change can be SAFE TO LAND and HIGH. It never changes a finding's severity.

## Classify

Classify the changed paths once scope is pinned: `git -C <checkout> diff --name-only -z <merge-base> <head> | python3 ../../../scripts/change-class.py --rules-dir <repo-rules directory>`, with the local and untracked paths added when they are in scope. Resolve the script from the loaded skill directory, and leave out `--rules-dir` when the key could not be resolved. The script reads paths only. Record its `tier_floor`, `person_required` and reasons. If the script cannot run, use MEDIUM and report the gap; never assume LOW.

## Set the tier

Start from `tier_floor`, then adjust by what the diff does:

- **Raise to HIGH** when the change alters authentication or authorization, payments or billing, secret or key handling, cryptography, destructive operations on stored data, or the release, update or deploy path. Quote the line that shows it.
- **Lower MEDIUM to LOW** only when `person_required` is false and a quoted line shows one of these: the feature is internal-only, or the change is only additive and behind a flag that is off by default.
- Never go below the floor for any other reason, and never lower HIGH.
- A change is never LOW when its author is not the user and has no OWNER, MEMBER or COLLABORATOR association on the PR. For a local diff, the author is the user.

| Tier | Typical change | Human approvals |
|---|---|---|
| LOW | Docs, copy, internal-only features, additive changes behind an off flag | None, once the checks are green and any security review that ran has passed |
| MEDIUM | Ordinary product changes, agent instructions, dependencies, config | One person |
| HIGH | The classes above, and paths the owner marked `high` | Two people |

`person_required` means at least one person approves, whatever the tier: CI workflows, migrations, paths named for auth, billing, secrets, release or deploy, and paths the owner marked. A LOW change with `person_required` still needs one person. The owner marks paths in `risk-paths.txt` in the repo-rules directory, one `high <glob>`, `person <glob>` or `low <glob>` per line. Only the user edits that file.

An agent's review never counts as a person's approval: not this review, an independent reviewer, a security review or a peer harness. An approval is for the reviewed head SHA; a new commit needs another look. Never approve a PR from this skill.

In the result, fill the `Risk tier` row with the tier, the reason and `person required` when it applies.
