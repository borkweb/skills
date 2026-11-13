# Setup commands

Read the Step 0 section at the start of every run, before running anything
else. Read the Step 2b section when the PR is behind its base.

## Step 0: Detect the environment

Then run these and keep the results — the Step 1 questions and later steps branch
on them.

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --porcelain
git remote get-url origin
```

Then work out six things:

1. **Harness — you are the host, the other one is the peer.** In a batch lane,
   the brief names both; skip the detection below. Otherwise, if you have the
   `Agent` tool and `AskUserQuestion`, you're in Claude Code: use subagent
   dispatch in Step 3b and `AskUserQuestion` for the checkpoints. The peer is
   Codex. **If you have neither, read
   [codex-host.md](codex-host.md) now.** The peer is then Claude.

   Confirm the peer CLI is actually there before promising a second pass:
   `command -v codex` / `command -v claude`. State which harness is host, which
   is peer, and whether the peer is available — one line, so the user can
   redirect it.

2. **GitHub host.** If the PR isn't on `github.com` (e.g. a GitHub Enterprise
   host), every `gh`/`gh-axi` call needs `--hostname <host>` (or
   `GH_HOST=<host>`). If the repo's own instructions name a wrapper alias for
   `gh`, use it. In zsh, quote every API path that contains `?` or `&`.

3. **The PR.** The user usually passes a **PR URL** — treat that as the primary
   input. Resolve in this order:

   - **A PR URL** (`https://<host>/<owner>/<repo>/pull/<number>`). Parse all four
     parts out of it. The URL — not the current directory — is the authority on
     host, owner, and repo.
   - A bare PR number → the current repo.
   - Nothing → `gh pr view` for the current branch.

   Then fetch it, scoping the call to the URL's repo and host. One call returns
   the PR, the head commit's CI results and the earlier reviews:

   ```bash
   gh pr view <number> --repo <owner>/<repo> \
     --json number,title,url,headRefName,headRefOid,baseRefName,isCrossRepository,headRepositoryOwner,statusCheckRollup,reviews \
     > <scratchpad>/pr.json
   ```

   Record `headRefOid` — the inline comments must be anchored to that commit.
   **If there is no PR**, follow [edge-cases.md](edge-cases.md).

4. **Does the PR's repo match where you are?** Compare the URL's
   `<owner>/<repo>` against `origin`. On a mismatch, follow
   [edge-cases.md](edge-cases.md). Never review a PR against the
   wrong repository's files.

5. **Earlier reviews on this PR.** Save your earlier `/pr-review` reviews, with
   their bodies, and every existing inline comment. Step 5a, Step 7 and
   [incremental.md](incremental.md) read both files:

   ```bash
   gh api user --jq .login                                  # → <me>
   jq -c --arg me "<me>" '.reviews[] | select(.author.login == $me)
         | select((.body // "") | (contains("<!-- pr-review sha=")
                                   or startswith("Review via /pr-review")))
         | {submittedAt, commit: .commit.oid, body}' \
     <scratchpad>/pr.json > <scratchpad>/earlier-reviews.jsonl
   jq -rs 'sort_by(.submittedAt) | last | .commit // empty' \
     <scratchpad>/earlier-reviews.jsonl                     # → <last-reviewed>
   ```

   The inline comments come from the prefetch below. An empty
   `<last-reviewed>` means this is the first review. Step 2b decides whether to
   use it.

6. **Start the prefetch, then ask.** Nothing in this job depends on a Step 1
   answer, so launch it with `Bash(run_in_background: true)` **before** the
   Step 1 questions. It runs while the user reads them:

   ```bash
   git fetch origin <base> <headRefName> --quiet     # fork: <base> pull/<number>/head
   gh api --paginate "repos/<owner>/<repo>/pulls/<number>/comments" \
     --jq '.[] | {path, line, original_line, user: .user.login,
                  title: (.body | split("\n")[0]), url: .html_url}' \
     > <scratchpad>/existing-comments.jsonl
   ```

   This is the only fetch in the run. Step 2 and Step 2b wait for the job's
   completion notice, then read its results. If it fails, report the error and
   run the fetch once in the foreground.

## Step 2b: Overlapping files and the merge test

Step 2b sends you here when `<behind>` is not `0`.

Otherwise, find the files both sides changed since they split, and test the
merge itself:

```bash
git diff --name-only <merge-base> <headRefOid> | sort > <scratchpad>/pr-files.txt
git diff --name-only <merge-base> <base-sha> | sort > <scratchpad>/base-files.txt
comm -12 <scratchpad>/pr-files.txt <scratchpad>/base-files.txt
git merge-tree --write-tree --name-only --no-messages <base-sha> <headRefOid>
```

`git merge-tree` exits `0` for a clean merge and `1` for conflicts. On `1`, the
lines after the tree OID name the conflicted files. Any other exit is an error —
report it and treat the merge as untested. (`--write-tree` needs git 2.38+.)
