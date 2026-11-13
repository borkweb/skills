# Do gotchas

Failures that past runs hit outside the work itself. Each one names what you see and what to do.

This file is the public seed. After reading it, also read the user's private `~/.borkweb-skills/gotchas/do.md` when it exists: it adds entries, it does not replace these. Only an approved dreaming **gotcha** row ([dreaming.md](references/dreaming.md)) writes the private file. An entry moves here only by a commit the user asks for, in generic wording and without citations.

## A nested subagent's result never reaches its lane

**What you see:** a **land batch** or **review batch** lane starts its own reviewer subagent, and the lane reports that the reviewer finished but its result never arrived. It happened to every lane in one batch.

**Why:** a subagent of a subagent cannot always hand its final message back to its parent.

**Do:** brief every nested reviewer with `review`'s designated report path, so the result is a file, not a message. When a lane reports a lost handback, read that file from the host, save it in the lane's directory as `<name>-relayed.md`, and send the lane its path. Do not dispatch the reviewer again. A missing or incomplete file is missing evidence.

## The permission classifier refuses a delivery step

**What you see:** a lane's PR comment or review post is denied, `git push --force-with-lease` is denied, or an APPROVE is denied as self-approval because the user has commits on that PR.

**Do:**
- Have the host post every PR comment and review, not the lane.
- Before a run whose delivery needs a force push, ask the user in the first status question.
- On a PR where the user has commits, plan a COMMENT review rather than an APPROVE, and tell the user it needs another reviewer.

Never retry a denied step through another route, and never treat the denial as the step having happened.
