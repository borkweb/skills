# Triage, anchor, show and post

Read this file when Step 3d merges a peer pass, or Step 5a starts with at least
one merged finding, before you drop, verify or anchor any. Each section names
the step it belongs to.

## Step 5a: Drop on proof

Re-read the hunk around each finding before you keep it. A finding leaves the
list on two grounds only: a line of the diff literally contradicts its central
claim with no chain of reasoning (the check it calls missing is added in a later
hunk; the value it calls hardcoded is read from config), or its `EVIDENCE` quote
is not in the file and a re-read finds nothing to anchor. "Unlikely", "cannot
verify" and "minor" are not grounds: an unconfirmed finding becomes a `LEAD` with
what would confirm it, and value is the user's call in 5b, not yours here.
Findings on protected subjects are never dropped, only kept or demoted to a
`LEAD` that quotes the contradicting line: memory or bounds safety, concurrency,
declaration or linkage consistency, a behavior or compatibility change (a
message, field, status, default or error path the old code produced and the new
code does not), an unused parameter, and the checklist's forced-CRITICAL classes
(data loss, trust-boundary bypass, uncapped spend). A wrong finding on a PR
costs the author minutes; a right one dropped is destroyed silently, and nobody
learns that it was.

## Step 5a: Check every `EVIDENCE` line

Search for the quoted line in `<file>` at `<headRefOid>`, or at `<merge-base>`
for a `LEFT` finding. If the quote isn't in the file, the reviewer misread the
code: re-read the code, then correct the finding or demote it to a lead. The
quote also confirms the anchor: `LINE` must point at the quoted line. A
`SOURCE: check` finding with `FILE: none` is verified by its check result
instead.

## Step 5a: Match a finding against comments already on the PR

Compare each finding with `existing-comments.jsonl`: the same `path`, a line
within a few of `line` (or of `original_line`, because an outdated comment has
`line: null`), and the same problem. Also compare with the bodies in
`earlier-reviews.jsonl`, which hold the findings that couldn't go inline.

## Step 5a: Anchor and write each comment

**Check every anchor is inside the diff.** GitHub rejects (422) an inline comment
on a line that isn't part of the PR's diff. For each CRITICAL finding:

```bash
git diff <merge-base> <headRefOid> -- <file>
```

Confirm the line appears in a hunk. Then:

- **Line is in the diff** → inline comment, `side: RIGHT` (or `LEFT` for a
  finding about a removed line).
- **Line is not in the diff** (common for enum-completeness findings, which point
  at untouched call sites) → it can't be inline. Move it into the review's summary
  body with an explicit `file:line` reference and a note that it's outside the diff.
- **Finding spans several lines** → use `start_line` + `line` for a multi-line
  anchor rather than picking one arbitrarily.

**Write each comment body** as:

```markdown
🤖 **CRITICAL — <title>**

<problem, one to three sentences>

<suggestion block, only when REPLACEMENT is a clean swap for the anchored lines>

<details>
<summary>Details</summary>

<evidence, trace or longer reasoning, only when the finding needs it>
</details>
```

The `both` tag is for the preview in Step 5b only. Do not put it, or any word
about the reviewers, models or this skill, in the comment.

The suggestion block must contain the complete replacement for *exactly* the
anchored line range — that's what GitHub applies when the author clicks Commit.
Wrong indentation or a partial line makes an unapplyable suggestion. When
`REPLACEMENT` is `none`, or the fix spans multiple files, or it needs a design
decision, **write the fix in prose and skip the suggestion block.** A suggestion
the author can't safely click is worse than no suggestion.

**Follow [pr-comments.md](../../writing-plans/pr-comments.md) for all PR
prose.** It says what a comment must never mention (the user, skills, models,
loops, runs), how short to keep it, and what goes in the collapsed Details
block. Read it before you write the first comment. The title and problem are
visible text: write them in plain English, lead with the effect on the code's
behavior, and name no more than two identifiers. Evidence, traces and further
identifiers go in Details, in ASD-STE100 Simplified Technical English
([ste100.md](../../writing-plans/ste100.md), the same rules file that
`bork:review` cites in **Result**). This covers every comment and the review
body. Rewrite each finding here; do not paste `PROBLEM` and `FIX` unchanged,
because the peer does not follow these rules.

Keep code, identifiers, paths, error strings, the `🤖 **CRITICAL —**` label and the
suggestion block exactly as written. Every comment and the review body start
with 🤖 unless the user asks you to leave it out; then pass `--no-robot` to the
check. The prose rules apply around them, never
inside a suggestion block. Chat output in Step 6 stays terse and is not bound by
these rules.

## Step 5b: What to print

First, print every planned critical comment exactly as it will appear:

````
Posting 3 inline comments to PR #<n> (<title>) as a COMMENT review:

1. app/models/post.rb:42  [RIGHT]  [both]  — Race condition in status transition
   🤖 **CRITICAL — Race condition in status transition**
   Two concurrent publishes both read status='draft' and both write...
   ```suggestion
     .where(status: 'draft')
     .update_all(status: 'published')
   ```

2. ...

Plus 1 finding in the review summary (outside the diff):
   lib/notifier.rb:88 — new `archived` status isn't handled here

Staleness note in the review body:
   This branch is 14 commits behind `trunk`. `trunk` also changed
   `app/models/post.rb`. Rebase the branch, then run the checks again.
````

Then list the INFORMATIONAL findings, numbered and grouped by source. Show each
one's planned comment exactly as it would be posted, so that nothing reaches the
PR unseen:

```
INFORMATIONAL — 6 findings (post only the ones you pick)

Error handling (2)
  1. app/jobs/import.rb:31  [RIGHT]  [both]
     🤖 **INFORMATIONAL — The timeout log does not include the job ID**
     The log for an expected timeout does not include the job ID. Add the job
     ID to the structured log.
  2. ...

Design (1)
  ...
```

Then one `AskUserQuestion` call with up to two questions. Leave out a question
that has nothing to ask about.

- **Critical comments** — *Post* or *Cancel*. The user edits a comment through
  the free-text answer.
- **Informational findings** (single-select) — *My recommendation (#1, #4)*,
  *All <n>*, *None*. The user types other numbers through the free-text answer.
  Say which you'd post and why in one line; they're informational precisely
  because reasonable people would leave some of them off a PR.

## Step 5c: The payload and the call

Post one COMMENT review: one notification for the author, not one per finding.
It holds the critical comments and the chosen informational ones, with bodies
labeled `🤖 **INFORMATIONAL — <title>**`. The informational ones follow the same
anchor, duplicate and prose rules. The hidden marker on the first line lets
the next run find this review in Step 0.

Before the call, check the payload, and fix every line it prints until it exits
0:

```bash
node skills/core/writing-plans/pr-text-check.mjs --payload <scratchpad>/pr-review-payload.json
```

Resolve the path from the loaded skill. Pass `--allow <word>` only when the PR
is about a word the check refuses. Never post a payload that fails.

```jsonc
// <scratchpad>/pr-review-payload.json
{
  "commit_id": "<headRefOid>",
  "event": "COMMENT",
  "body": "<!-- review sha=<headRefOid> -->\n🤖 <n> critical findings inline.\n\n<staleness note, only for OVERLAP or CONFLICT>\n\n<any findings that couldn't be anchored>",
  "comments": [
    { "path": "app/models/post.rb", "line": 42, "side": "RIGHT", "body": "..." }
  ]
}
```

**Check the head again right before the call.** The user may have taken a
while to answer Step 5b, and the author may have pushed meanwhile. The
findings and their line anchors describe `<headRefOid>` only:

```bash
gh pr view <number> --repo <owner>/<repo> --json headRefOid --jq .headRefOid
```

If it no longer equals `<headRefOid>`, do not post. Say that the PR moved to
the new SHA, keep the payload file, and offer an INCREMENTAL re-run, which
reviews only the new commits and rechecks these findings.

```bash
gh api --method POST /repos/<owner>/<repo>/pulls/<number>/reviews \
  --input <scratchpad>/pr-review-payload.json
```

**Confirm the review landed.** Read the review's `id` and `html_url` from the
response, then reload `repos/<owner>/<repo>/pulls/<number>/reviews/<id>` and
check that its `commit_id` is `<headRefOid>`. Report the URL only after that
check. A post you cannot confirm is not posted.

Spell out `<owner>/<repo>` from the PR URL rather than leaning on
`{owner}/{repo}` placeholder substitution — the placeholders resolve from the
current directory, which is not necessarily the PR's repo.

Use plain `gh api` here rather than `gh-axi` — `gh-axi api` takes only flat
`--field key=value` pairs and can't express the nested `comments` array. Add
`--hostname <host>` for a non-github.com PR.
