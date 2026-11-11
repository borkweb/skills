# Repo rules

Lessons that hold for one repo, kept where every run and review of that repo can find them. A rule is a checkable condition. A run reads rules; it never writes them.

## Store

`~/.agent-handoffs/repo-rules/<key>/`, one rule per `*.md` file. The root is `$BORK_REPO_RULES_DIR` when set. The store is private to the user: it is not in any repo, so teammates and CI never see it. The store and its directories are mode 700, and dreaming creates them on the first approved write. A missing directory means no rules, not an error.

Durability is the user's choice: keep a backup of the store, or make it a private git repo. Nothing here syncs it.

Only two things are rule sources: the store, and the `AGENTS.md` and `CLAUDE.md` files `review` already reads. A rule a team should share goes into the repo's `AGENTS.md` by a normal PR, not into the store.

Only the user, or an approved row in [dreaming.md](dreaming.md), adds a rule. Runs never write rules: not the architect, the builder, the reviewer or the spec reviewer. They read, or copy a matched rule into the run directory.

## Key

The key names the repo, so the SSH and HTTPS forms of one remote land in one directory.

- It is the `origin` URL with scheme, user and password, port, a trailing `.git` and letter case removed, as `host/owner/repo`. `git@github.a8c.com:Automattic/wpcom.git` and `https://github.a8c.com/Automattic/wpcom` both give `github.a8c.com/automattic/wpcom`.
- With no `origin`, it is `local/<first 16 hex of sha256 of the realpath of git rev-parse --git-common-dir>`. Every worktree of the repo shares that directory, so they share the key.
- Each segment must match `[a-z0-9._-]+`. A `.` or `..` segment, an empty segment or an origin that is not `host/owner/repo` is refused, so a key can never leave the store root.

Resolve it with the script next to the `do` skill, from the skill's base directory:

```sh
node "<do skill base>/repo-rules-key.mjs" [path]          # the key
node "<do skill base>/repo-rules-key.mjs" --dir [path]    # the store directory for it
```

`path` is any directory in the repo and defaults to the current directory. The script only reads: it creates nothing and prints no remote URL. It exits nonzero with empty output when the path is not a repo or the origin cannot be turned into a key. Report that as a gap, never as "no rules".

## Rule format

The frontmatter has `title`, `applies_when` and an optional `retire_when`. The body holds the rule as a checkable condition, why it exists, and a source citation.

```markdown
---
title: <short name>
applies_when:
  - <a condition in task words: a path, a behavior>
retire_when: <optional: a condition that makes the rule obsolete>
---

Rule: <the rule as a condition a reviewer can check against a diff>

Why: <the incident or cost behind it>

Source: <citation, for example repo@session/slice, or a PR or file:line>
```

`applies_when` is a YAML list of conditions. A rule applies when any one of them fits the slice's files or behavior. Write them as the words a spec uses ("changes anything under `src/billing/`", "adds a REST endpoint"), not as globs a program must match. A file with bad frontmatter or a missing or non-list `applies_when` is malformed: skip it and report it as a gap. Never refuse the run over it.

`retire_when` is checked by the spec reviewer when that is a cheap read-only check. When it holds, the rule is skipped and reported as a gap ("rule `<file>` may be retired"). Dreaming may propose deleting it. Nothing deletes a rule automatically.

## Matching and freeze

1. The spec reviewer ([briefs.md](briefs.md)) resolves the key, reads each rule, and matches `applies_when` against the slice's files and behavior.
2. Each matched rule becomes one criterion citing `rule: <absolute path>`.
3. It copies the matched rule files into `repo-rules-<slice>/` in the run directory, and creates that directory empty when nothing matched. Unmatched rules are neither copied nor passed on.
4. The builder reads rules only through those criteria, from the frozen copy. The code reviewer gets the `repo-rules-<slice>/` path and reads only that copy, even when it is empty.
5. A standalone review, which has no frozen path, resolves the key and reads the live store at the start of the review ([review](../../../gstack/review/SKILL.md)). A violation is a finding that quotes the rule and the offending line.

The frozen copy is why a rule edited mid-run cannot change the bar a builder was held to.
