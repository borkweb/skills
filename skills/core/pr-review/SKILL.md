---
name: pr-review
description: >
  Review a GitHub PR and post its CRITICAL findings as line-anchored inline
  comments with suggestion blocks after you confirm; INFORMATIONAL findings
  stay in chat. Adds a second pass from the other harness when the diff needs
  one, reuses CI results, and reviews only new commits on a re-run. Invoke
  only when the user explicitly asks for /pr-review or for a PR review that
  posts comments, or when bork:do runs a review batch; never on your own. For
  a local diff or branch without posting, use review.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - Skill
---

# PR Review (comment-first)

You are running `/pr-review`. This is a **superset of `bork:review`**: same
analysis, different disposition. `bork:review` reports findings by default and
only fixes them when authorized. This skill puts the findings *on the PR*, where
the author sees them, and asks up front whether to authorize local mechanical
fixes.

Two things make it a superset rather than a rename:

1. **A second reviewer when the diff needs one.** The harness you invoked from
   runs `bork:review`; the other harness runs an independent pass over the same
   tree. Neither sees the other's findings until they're merged.
2. **Findings become PR comments,** with applyable suggestion blocks, instead of
   silent edits.

This file covers the common path. Some cases have their own file in
`references/`. Each step says when to read one. Read it then, not before.

| File | Read it when |
|---|---|
| [auto-fix.md](references/auto-fix.md) | Step 1 records AUTO-FIX |
| [codex-host.md](references/codex-host.md) | Step 0 finds you are not in Claude Code |
| [incremental.md](references/incremental.md) | Step 0 finds an earlier `/pr-review` review |
| [peer.md](references/peer.md) | Step 2b records the peer as REQUIRED |
| [checks.md](references/checks.md) | Step 3a maps the checks to CI (every run), Step 3c waits on a pending check, a CI check failed, or a check has to run on this machine |
| [edge-cases.md](references/edge-cases.md) | No PR, wrong repo, fork PR, peer failure, a 422 |
| [batch.md](references/batch.md) | Step 0 finds `--prepare-only` (a `bork:do` batch lane) |
| [setup.md](references/setup.md) | Step 0 starts (every run), or Step 2b finds the PR behind its base |
| [worktree.md](references/worktree.md) | Step 2 sets up a worktree, or Step 7 removes one |
| [host-contract.md](references/host-contract.md) | Step 3b dispatches the host pass, or a REQUIRED peer needs its brief |
| [posting.md](references/posting.md) | Step 5a keeps at least one finding to anchor, show and post |

---

## Rules

- **Ask once, at the start — or not at all.** Fix mode, location and the fork
  question are settled in Step 1, or by flags. After that the only stop is the
  Step 5 post confirmation, which is about what goes on the PR, not about what
  you do locally.
- **Never wait on a question.** Fetching and reading CI start before Step 1
  asks anything.
- **Nothing reaches the PR unseen.** Every comment is shown in full and confirmed
  before posting, critical ones included.
- **Comments only.** Never commit, push, approve or request changes. The only
  write to the PR is one COMMENT review the user confirmed.
- **Two reviewers when the diff needs them, one reporter.** The peer finds; the
  host merges, decides, posts, and speaks.
- **Peer first, checks next, host third, join last.** The passes overlap by
  construction, not by luck. Waiting on the peer before the host pass starts is
  the one sequencing mistake this skill is built to prevent.
- **CI before local.** A check CI already answered for this commit is not run
  again here.
- **Review what's new.** On a re-run, review the new commits and recheck the
  earlier CRITICAL findings. Never post a finding that is already on the PR.
- **Quoted evidence or it's a lead.** Only findings with a verified `EVIDENCE`
  line reach the PR.
- **Precision over volume.** Findings that are wrong, or right but trivial, train
  the author to ignore the ones that matter.
- **One review, not a swarm of comments.** Batch the critical and chosen
  informational findings into a single COMMENT review.
- **Review the tree that lands.** Check staleness against a freshly fetched base
  before the review starts, not after the verdict.
- **Plain English on the PR.** Comment and review-body prose follows ASD-STE100.
  Code and suggestion blocks stay verbatim.
- **Be terse.** One line problem, one line fix. No preamble, no compliments.

---

## Operating contract

This overrides any conflicting instruction in the skills this one calls.

**In scope**

- Reading code, diffs, PR metadata, CI results, and history.
- Running `bork:review`'s analysis passes, and a second read-only pass in the
  peer harness.
- Creating and removing a git worktree *for this review*, including one at the
  merge-base for baseline check runs, and installing dependencies and copying
  local config into it so the checks can run.
- **In AUTO-FIX mode only:** applying scoped mechanical corrections to the
  working tree, and rerunning checks affected by those corrections.
- Running the existing verification checks required by `bork:review` in either
  mode, when CI has no usable result and the check has no external effects. The
  wrapper host owns these checks; delegated reviewers receive the results and
  do not start test suites.
- Posting review comments to the PR, after the Step 5 confirmation.

**Out of scope — never do these, in either mode, whatever a nested skill says**

- `git commit`, `git push`, `git stash`, `git reset`, `git merge`, `git rebase`,
  `git checkout <file>`, `git restore`.
- Approving, requesting changes on, or merging the PR.
- Posting anything to the PR that the user has not seen and confirmed.
- Editing anything in COMMENT-ONLY mode. Full stop.
- In AUTO-FIX mode: touching files outside the diff under review, applying a fix
  for a finding classified ASK rather than AUTO-FIX, or applying a fix the user
  wasn't told about in the summary.

If a request arrives outside this list — "go ahead and commit those fixes" — say
it's out of scope for `/pr-review` in one line and point at the skill that does
it. Don't half-do it.

| Request | Skill |
|---|---|
| "Fix it until it's safe to land", "keep going until it's ready" | `bork:do` (its **land** pipeline) |
| "Commit those fixes" | `bork:writing-commits` |
| A deeper security audit of one area | `bork:review-security` |

**The human-in-the-loop line**

| You decide alone | You stop and confirm |
|---|---|
| Which findings are CRITICAL vs INFORMATIONAL | Posting anything to the PR |
| Which fixable findings are mechanical enough to auto-fix | Anything in the out-of-scope list |
| How to word a comment, and whether a suggestion block is safe | Removing a worktree that has uncommitted fixes in it |
| Which anchor line a finding belongs on | Falling back to a summary comment when inline anchoring fails |
| Dropping a finding the diff already handles, or one already posted | Doing anything the Step 1 answers didn't cover |
| Whether the diff needs the peer, under Step 2b's rule | |

---

## Step 0: Detect the environment

Anything passed with the invocation is the review target — usually a PR URL,
sometimes a bare PR number — plus optional flags. Read it before running
anything else.

| Flag | Effect |
|---|---|
| `--comment-only` / `--auto-fix` | Answers Step 1's fix-mode question |
| `--worktree` / `--in-place` | Answers Step 1's location question |
| `--run-fork` | Answers Step 1's fork question with yes |
| `--full` | Review the whole PR, even when an earlier `/pr-review` review exists |
| `--peer` | Run the peer pass even on a small, low-risk diff |
| `--solo` | Skip the peer pass |
| `--prepare-only <dir>` | Run as one lane of a `bork:do` batch: prepare the review in `<dir>` and stop before Step 5b. **Read [batch.md](references/batch.md) now.** It overrides Steps 0–7 where they differ. |

**Read [setup.md](references/setup.md) now,** before running anything else. Its
Step 0 section holds the commands and the six things to work out: the harness,
the GitHub host, the PR, the repo match, the earlier reviews and the prefetch.
The prefetch starts in the background before the Step 1 questions.

---

## Step 1: The one set of questions

Everything this skill asks about *how it should work*, it asks now, in a single
batch. After this it runs to completion and only stops for the Step 5 post
confirmation, which is about what goes on someone's PR, not about how the
review runs.

In Claude, one `AskUserQuestion` call carrying all the questions. Not two
rounds. **Skip any question a Step 0 flag already answers.** If flags answer all
of them, skip the questions and state the answers in one line. The two rules
below still apply, whether an answer came from the user or a flag.

**Once the mode is AUTO-FIX, read [auto-fix.md](references/auto-fix.md)
before Step 2.** It changes Steps 1, 2, 3b, 3c, 3d, 4 and 7. Its AUTO-FIX +
worktree warning applies to flags too: with `--auto-fix --worktree`, keep the
worktree at the end and hand back a patch, and say so in one line.

**Question 1 — Fix mode.**

> **What should happen to the fixable findings?**
> - **Comment only** — no source file changes. Every finding, fixable or not, becomes a PR comment or a chat report.
> - **Auto-fix the mechanical ones, comment the rest** — scoped mechanical corrections get applied to the working tree (uncommitted, unpushed). Judgment calls and CRITICAL findings still become PR comments.

Record the answer as **COMMENT-ONLY** or **AUTO-FIX**. Every later step branches
on it. Don't ask again — not before applying a fix, not before posting.

**Question 2 — Where it runs.** Pick the recommendation using Step 2's rules.

> **Where should this review run?**
> - **Separate worktree** — checks the PR head out under the scratchpad, reviews there, removes it when done. Your current checkout is untouched.
> - **In place** — reviews in the current checkout. Faster, no setup, but the diff includes any uncommitted changes.

**Question 3 — only when `isCrossRepository` is true.** Add the fork question
from [edge-cases.md](references/edge-cases.md) to the same call.

---

## Step 2: Set up the review directory

Act on the Step 1 worktree answer. Recommend, before asking:

- **A worktree** when the PR head is *not* the current branch, when
  `git status --porcelain` is non-empty (a review shouldn't have to read around
  your in-progress edits), or when the PR is from a fork. A PR URL for a branch
  you don't have checked out is the common case, so this is usually the
  recommendation.
- **In place** when you're already on the PR branch with a clean tree.

**If worktree:** read the Step 2 section of [worktree.md](references/worktree.md)
before you reuse or create one.

**If in place:** proceed in the current checkout, and say plainly in the final
summary if uncommitted changes were part of the reviewed diff.

**Either way, snapshot the review directory now.** Save its
`git status --porcelain` to `<scratchpad>/status-before.txt`. Step 4 compares
against this file, not the Step 0 snapshot of your own checkout.

---

## Step 2b: Pin the base, check staleness, choose scope and reviewers

Run this before Step 3. It settles four things every later step uses.

**1. Pin the base.** The Step 0 prefetch fetched the base once. Wait for it,
then record the SHAs. Use `<base-sha>` and `<merge-base>` everywhere after this
— in the peer brief, the host contract, the checks and the anchor check. Never
`origin/<base>` again: if the base moves during the review, a second fetch
would give the host and peer different diffs.

```bash
git rev-parse origin/<base>                       # → <base-sha>
git merge-base <headRefOid> <base-sha>            # → <merge-base>
git rev-list --left-right --count <headRefOid>...<base-sha>
```

**2. Staleness.** The last output is `<ahead> <behind>`. `<behind>` counts base
commits the PR does not contain. If it is `0`, the status is **CURRENT**.

Otherwise, follow the Step 2b section of [setup.md](references/setup.md) to
find the files both sides changed and to test the merge. Then set the status:

| Status | Condition | Effect |
|---|---|---|
| **CURRENT** | `<behind>` is `0` | None |
| **BEHIND** | Behind, no overlapping files | Note the count in the summary |
| **OVERLAP** | Overlapping files, clean merge | Reviewers check the PR against the base versions of those files; verdict is at most LAND WITH CAUTION |
| **CONFLICT** | `merge-tree` exits `1` | Verdict is DO NOT LAND — the merged result has not been reviewed |

A clean textual merge on an overlapping file can still break: the base can
rename a function the PR calls, or change a contract the PR relies on. That is
what OVERLAP exists to catch.

**3. Scope — FULL or INCREMENTAL.** The scope is **FULL**, with `<scope-base>`
set to `<merge-base>`, unless Step 0 found `<last-reviewed>` and the user didn't
pass `--full`. In that case, **read [incremental.md](references/incremental.md)
now** to decide. The reviewers review `git diff <scope-base> <headRefOid>`.

**4. Does this diff need the peer?** Use `bork:review`'s **Independent pass**
conditions exactly, measured on `git diff --shortstat <scope-base> <headRefOid>`.
The peer is **REQUIRED** when the diff makes nontrivial auth, payment or
security changes, adds a new external integration, changes more than 200 lines,
or the user passed `--peer`. Otherwise it is **SKIPPED**.

- Using the same rule as `bork:review` matters. Its SAFE TO LAND gate requires
  an independent review when those conditions hold, so a looser skip rule would
  turn a skipped peer into missing evidence.
- `--solo` skips the peer even when it is REQUIRED. Say in one line that the
  verdict will then cap at DO NOT LAND for missing independent review.
- State the decision in one line: *"Peer: skipped — 38 changed lines, no auth,
  payment, security or new integration. Re-run with `--peer` to force it."*
- **If the peer is REQUIRED, read [peer.md](references/peer.md) now.** It
  covers the launch, the brief, the join and the merge.

---

## Step 3: Review — peer, checks, host

The PR is reviewed by the host and, when Step 2b requires it, by a peer in the
other harness.

- **Host** = the harness you were invoked from. It runs `bork:review`, owns the
  merge, does all the talking, asks all the questions, applies any fixes, and
  posts everything.
- **Peer** = the other harness, driven headless over its CLI. It reviews the same
  tree independently and returns findings. **It never posts, never asks the user
  anything, and never writes to the repo — in either fix mode.**

Two models reading the same diff cold catch different things; that's the whole
reason for the second pass, so don't show the peer the host's findings.

**The work runs concurrently. This is not an optimization to apply when
convenient — it is the step order.** The peer launches first, detached, in 3a,
and the checks start right after it; the host pass runs while both work in 3b;
3c joins all three. Run sequentially and the review takes as long as the passes
added together, for no gain — they share nothing.

Never wait on the peer before starting the host pass. If you catch yourself
holding a completed peer result while the host pass hasn't started, you've
serialized it — start the host pass now.

### Step 3a: Launch the peer, then the checks

**If the peer is REQUIRED, launch it first**, as [peer.md](references/peer.md)
describes, and do not block on it. Skip this when Step 2b recorded SKIPPED.

**Then start the checks, from CI first.** Nobody else runs them: the host
reviewer and the peer are both told not to start test suites, so a review
without this step always ends with missing evidence.

Follow the Step 3a section of [checks.md](references/checks.md) now: list the
repo's checks, map them to CI, decide per check, and start each local run in
the background.

### Step 3b: Host pass — bork:review

Invoke `bork:review` — the real skill, not a re-implementation of it. Its
checklist, security pattern library, and design checklist are the point of
wrapping it.

**In Claude, dispatch it into an unnamed `general-purpose` subagent** so the
nested skill runs to completion without stalling the outer workflow, and its
final response comes back as the tool result rather than through a teammate
mailbox. This is an assigned review pass: do not let it launch additional
reviewers. The wrapper host started the checks in 3a and joins their results in
3c, so the delegated host reviewer records them as pending.

**Read [host-contract.md](references/host-contract.md) before you dispatch it.**
It holds the contract to give the subagent, and the bullets to add for OVERLAP,
CONFLICT, INCREMENTAL and AUTO-FIX.

In INCREMENTAL scope, recheck the earlier CRITICAL comments while the host pass
runs, as [incremental.md](references/incremental.md) describes.

### Step 3c: Join — peer, checks, host

Only now do you wait. The host pass is done; the peer and the checks have had
that whole time to work. If the peer ran, join it as
[peer.md](references/peer.md) describes.

**The checks.** For a CI check still pending, and for each local run, follow
the Step 3c section of [checks.md](references/checks.md).

Record each check as `PASS (CI)`, `PASS (local)`, `FAIL (CI)`, `FAIL (local)`,
`FAIL (baseline)`, `FAIL (base also red, new failures not ruled out)`,
`PENDING (CI)` or `NOT RUN` with its reason, and carry the results into Step 7's
Verification row.

Turn each regression into a CRITICAL finding with `SOURCE: check`. If you have
the failing assertion, set `FILE` and `LINE` to it in the test file and quote it
as `EVIDENCE`. Otherwise use `FILE: none`, put the check name and its CI or log
URL in `EVIDENCE`, and put the finding in the review summary body.

### Step 3d: Merge the findings

With the peer, merge the two passes as [peer.md](references/peer.md)
describes. Without it, the list is the host's, tagged `host`. Either way, carry
coverage forward: the host's Coverage row and, with a peer, its `READ` and
`SKIPPED` lines feed Step 7's Coverage row. A file in scope that no pass read is
named there, not folded into a count.

**Keep leads in their own list** either way. A `LEAD` never merges into a
finding or counts toward one. If you read the code and confirm a lead, promote
it to a finding with a real `EVIDENCE` line. Otherwise it goes to Step 6 for the
chat report, and it never goes on the PR.

---

## Step 4: Verify the tree matches the mode you were given

Before going near the PR, check what actually happened on disk:

```bash
git status --porcelain
git diff --stat
```

Compare against `status-before.txt` from Step 2, or against
`status-after-setup.txt` when local checks ran. In that case, separate the check artifacts as
[checks.md](references/checks.md) describes.

**In COMMENT-ONLY mode:** the tracked files must match the snapshot. **If they
differ**, something violated the contract: stop, show the user exactly what
changed with `git diff`, and ask how they want to proceed. Do not post to the
PR, and do not revert on your own — the user decides.

Report this check in one line. An unverified "I didn't touch anything else" is
worth nothing.

---

## Step 5: Triage, anchor, show, post

### 5a: Triage and anchor

Split the merged findings into CRITICAL and INFORMATIONAL. Auto-fixed items are
neither — they go in the summary, not on the PR.

**Drop on proof, not on judgment.** Re-read the hunk around each finding before
you keep it. A finding leaves the list on two grounds only: a line of the diff
literally contradicts its central claim with no chain of reasoning (the check it
calls missing is added in a later hunk; the value it calls hardcoded is read from
config), or its `EVIDENCE` quote is not in the file and a re-read finds nothing
to anchor. "Unlikely", "cannot verify" and "minor" are not grounds: an
unconfirmed finding becomes a `LEAD` with what would confirm it, and value is
the user's call in 5b, not yours here. Findings on protected subjects are never
dropped, only kept or demoted to a `LEAD` that quotes the contradicting line:
memory or bounds safety, concurrency, declaration or linkage consistency, a
behavior or compatibility change (a message, field, status, default or error
path the old code produced and the new code does not), an unused parameter, and
the checklist's forced-CRITICAL classes (data loss, trust-boundary bypass,
uncapped spend). A wrong finding on a PR costs the author minutes; a right one
dropped is destroyed silently, and nobody learns that it was.

**Don't post anything already on the PR.** Compare each finding with
`existing-comments.jsonl`: the same `path`, a line within a few of `line` (or of
`original_line`, because an outdated comment has `line: null`), and the same
problem. Also compare with the bodies in `earlier-reviews.jsonl`, which hold
the findings that couldn't go inline. If an earlier `/pr-review` comment
matches, don't post the finding again; note the existing URL. If another
reviewer already raised it, don't post it either; list it in chat as already
raised, with the URL. **A duplicate stays in the findings list.** Not posting it
doesn't resolve it: a duplicate CRITICAL finding still counts as unresolved in
Step 7.

**Check every `EVIDENCE` line against the file.** Search for the quoted line in
`<file>` at `<headRefOid>`, or at `<merge-base>` for a `LEFT` finding. If the
quote isn't in the file, the reviewer misread the code: re-read the code, then
correct the finding or demote it to a lead. The quote also confirms the anchor:
`LINE` must point at the quoted line. A `SOURCE: check` finding with
`FILE: none` is verified by its check result instead.

**Before you anchor the first finding, read [posting.md](references/posting.md).**
Its Step 5a section covers the anchor check, the comment body and the
ASD-STE100 rules for all PR prose.

### 5b: Show, then confirm once

Show everything that could go on the PR, then ask once. The critical comments
and the informational choice share one confirmation, and the result is one
review.

Print every planned comment exactly as it will appear, in the formats in the
Step 5b section of [posting.md](references/posting.md): the critical comments
first, then the INFORMATIONAL findings, numbered and grouped by source.

Then one `AskUserQuestion` call with up to two questions. Leave out a question
that has nothing to ask about. With no critical and no informational findings,
there is nothing to post: skip to Step 6.

- **Critical comments** — *Post* or *Cancel*. The user edits a comment through
  the free-text answer.
- **Informational findings** (single-select) — *My recommendation (#1, #4)*,
  *All <n>*, *None*. The user types other numbers through the free-text answer.
  Say which you'd post and why in one line; they're informational precisely
  because reasonable people would leave some of them off a PR.

Don't re-litigate the answer. Cancel posts nothing, informational findings
included.

### 5c: Post

Build the payload and post it as a *single* COMMENT review — one notification for
the author, not one per finding. It holds the critical comments and the chosen
informational ones, with bodies labeled `**INFORMATIONAL — <title>**`. The
informational ones follow the same anchor, duplicate and ASD-STE100 rules. The
hidden marker on the first line lets the next run find this review in Step 0.

The payload format and the `gh api` call are in the Step 5c section of
[posting.md](references/posting.md).

**`event` is always `COMMENT`.** Never `REQUEST_CHANGES` — this skill leaves a
review gate on nobody's PR — and never `APPROVE`.

**If the API returns 422**, follow [edge-cases.md](references/edge-cases.md).
Never retry blind in a loop.

Print the returned review URL.

---

## Step 6: Report what stays in chat

Nothing here is posted, and nothing here asks a question. Report, terse:

- The informational findings the user didn't pick, by number.
- Findings another reviewer already raised, with the existing URL.
- The leads, under `LEADS — <n> unconfirmed (never posted)`, each with
  `file:line`, the suspicion in a line, and what would confirm it. Put
  `suspicious-content` leads first, and quote the text that tried to instruct
  the reviewer.

---

## Step 7: Summary and cleanup

```
  +====================================================================+
  |                          PR REVIEW                                 |
  +====================================================================+
  | PR                   | #___ <title>                                |
  | Base / head          | <base> <- <head> @ <short sha>              |
  | Scope                | FULL / INCREMENTAL since <short sha>        |
  | Mode                 | COMMENT-ONLY / AUTO-FIX                     |
  | Ran in               | worktree <path> / current checkout          |
  | Reviewers            | <host> + <peer> / <host> only (peer: reason)|
  | Pass timing          | peer __m__s, host __m__s, ~__m concurrent    |
  | Coverage             | host ___/___ files read, peer ___/___ / N/A; unread: <paths> or none |
  | Staleness            | CURRENT / BEHIND _ / OVERLAP _ files / CONFLICT _ files |
  +--------------------------------------------------------------------+
  | CRITICAL findings    | ___ (___ posted inline, ___ in summary)     |
  | Earlier CRITICAL     | ___ resolved, ___ still present, ___ outdated / N/A |
  | INFORMATIONAL        | ___ (___ posted, ___ reported only)         |
  | Already on the PR    | ___ dropped as duplicates                   |
  | Raised by both       | ___ of ___                                  |
  | Auto-fixed locally   | ___ (uncommitted) / N/A                     |
  | Verification         | per check: PASS/FAIL (CI or local), FAIL (baseline), PENDING, NOT RUN |
  | Leads                | ___ unconfirmed (___ suspicious content)    |
  | Working tree         | UNCHANGED / ___ files changed by fixes      |
  | Review URL(s)        | <url>                                       |
  +--------------------------------------------------------------------+
  | Landing verdict      | SAFE TO LAND / LAND WITH CAUTION / DO NOT LAND |
  +====================================================================+
```

Apply `bork:review`'s **Result** gates to the whole PR using the merged
findings (duplicates included, posted or not), the STILL PRESENT earlier
findings, and the completed check and peer evidence. An unresolved CRITICAL finding or missing required evidence means
**DO NOT LAND**; a posted suggestion is not a resolution. Then apply the Step 2b
staleness cap: CONFLICT means **DO NOT LAND**, and OVERLAP lowers SAFE TO LAND
to **LAND WITH CAUTION**. A cap never raises a verdict. Say plainly that the
verdict describes the PR as it stands, not as it would stand once the
suggestions are applied.

**When the verdict isn't SAFE TO LAND**, name the next step in one line. Don't
start it. `bork:do` runs its **land** pipeline to fix the PR until it is safe to
land. Give it the unresolved CRITICAL findings as its starting blockers, so it
checks the same bar this review used.

**Cleanup.** If you created a worktree in Step 2, or local checks created one at
the merge-base, follow the Step 7 section of
[worktree.md](references/worktree.md) before you remove it.

Never `--force` a worktree removal. That's how a review becomes a data-loss
incident.
