# Anchor, show and post

Read this file when Step 5a keeps at least one finding, before you anchor it.
Each section names the step it belongs to.

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
**CRITICAL — <title>**

<problem, one to three sentences>

<suggestion block, only when REPLACEMENT is a clean swap for the anchored lines>

<"Flagged independently by both reviewers." — only when the tag is `both`>
```

The suggestion block must contain the complete replacement for *exactly* the
anchored line range — that's what GitHub applies when the author clicks Commit.
Wrong indentation or a partial line makes an unapplyable suggestion. When
`REPLACEMENT` is `none`, or the fix spans multiple files, or it needs a design
decision, **write the fix in prose and skip the suggestion block.** A suggestion
the author can't safely click is worse than no suggestion.

**Write all PR prose in ASD-STE100 Simplified Technical English.** This covers
the title, the problem and any prose fix in every comment, and the review body.
Use [ste100.md](../../writing-plans/ste100.md), the same rules file that
`bork:review` cites in **Result**. Read it before you write the first comment.
Rewrite each finding here; do not paste `PROBLEM` and `FIX` unchanged, because
the peer does not follow these rules.

Keep code, identifiers, paths, error strings, the `**CRITICAL —**` label and the
suggestion block exactly as written. STE applies to the prose around them, never
inside a suggestion block. Chat output in Step 6 stays terse and is not bound by
these rules.

## Step 5b: What to print

First, print every planned critical comment exactly as it will appear:

````
Posting 3 inline comments to PR #<n> (<title>) as a COMMENT review:

1. app/models/post.rb:42  [RIGHT]  [both]  — Race condition in status transition
   **CRITICAL — Race condition in status transition**
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
     **INFORMATIONAL — The timeout log does not include the job ID**
     The log for an expected timeout does not include the job ID. Add the job
     ID to the structured log.
  2. ...

Design (1)
  ...
```

## Step 5c: The payload and the call

```jsonc
// <scratchpad>/pr-review-payload.json
{
  "commit_id": "<headRefOid>",
  "event": "COMMENT",
  "body": "<!-- pr-review sha=<headRefOid> -->\nReview via /pr-review (<host model> + <peer model, or 'no peer'>). <n> critical findings inline.\n\n<staleness note, only for OVERLAP or CONFLICT>\n\n<any findings that couldn't be anchored>",
  "comments": [
    { "path": "app/models/post.rb", "line": 42, "side": "RIGHT", "body": "..." }
  ]
}
```

```bash
gh api --method POST /repos/<owner>/<repo>/pulls/<number>/reviews \
  --input <scratchpad>/pr-review-payload.json
```

Spell out `<owner>/<repo>` from the PR URL rather than leaning on
`{owner}/{repo}` placeholder substitution — the placeholders resolve from the
current directory, which is not necessarily the PR's repo.

Use plain `gh api` here rather than `gh-axi` — `gh-axi api` takes only flat
`--field key=value` pairs and can't express the nested `comments` array. Add
`--hostname <host>` for a non-github.com PR.
