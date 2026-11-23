# PR text rules

Use these rules for all text that a skill writes to a pull request: the description, every comment, review body, inline comment and reply. They apply to drafts too, because a draft becomes the posted text.

PR text has two readers. A person scans the visible part to learn what changed and what to do. A reviewer or an agent who needs the mechanism opens the collapsed Details block. Write each part for its reader.

## Check before you post

Write the body to a file. Then run:

```bash
node skills/core/writing-plans/pr-text-check.mjs --kind comment <body.md>
```

Resolve the path from the loaded skill. Use `--kind description` for a PR description and `--payload <review.json>` for a review payload (its `body` and each `comments[].body`). The script exits 0 when the text passes. When it exits 1, fix each line it prints and run it again. Never post a body that fails. Post with `--body-file` or `--input`, so the checked file is the posted text. When the PR is about a word that the check refuses, such as a PR that changes the `herdr` integration, pass `--allow herdr`. When the user asks for comments without the robot prefix, pass `--no-robot`.

## Start each comment with 🤖

The visible text of every comment, review body, inline comment and reply starts with `🤖 `, so a person can see that a tool posted it. A hidden marker comes first, on its own line, and 🤖 starts the line after it. A PR description does not get the prefix. Leave the prefix out only when the user says to. The check enforces the prefix for comments.

## Talk about the work only

The text is about the code and the change. Do not write about how the text was made or who asked for it.

Never mention:

- the user who runs the skill, by name, login or role ("Matt asked", "on behalf of");
- a skill, slash command, agent, persona, model, harness or tool (`/pr-review`, `bork:do`, Codex, Claude, "the peer pass");
- the process: loops, sweeps, passes, rounds, runs, lanes, councils, "both reviewers", "flagged independently", "automated review";
- run IDs, local paths, scratchpad files, worktrees or herdr tabs.

The 🤖 prefix is the one signal of automation that is permitted. A hidden HTML marker (`<!-- ... -->`) that a later run must find is permitted. Give it a neutral name, and put it on the first line.

## The visible part: write for a person

Write the visible text in plain, jargon-free English, in the style of `bork:layman`. The reader knows the product but has not read the code.

- Say what a person would notice: what was wrong, what happens now, what the reader must do. Do not explain the mechanism. "Broken accounts counted as working, so the share showed as queued when nothing would go out" is visible text. "The pre-check sent no `test_connections`, so the route set `status` to `null`" goes in Details.
- Put the most important fact first.
- Use one to three sentences for each item. Use a short list for three or more items.
- Use no more than two code spans in a paragraph or list item. Keep only names the reader must act on or search for: a filter to add, an error code they will see, a command they must run.
- Put test counts, lint results, call traces, function names and file paths in Details. A visible line such as "New tests cover both cases" is enough.
- Do not repeat the code back. Do not add greetings, praise or sign-offs.
- Keep identifiers, error strings, required labels and suggestion blocks exactly as written wherever they appear.

## Details: write for a reviewer or an agent

Evidence, traces, reproduction steps, identifiers, test commands and results, file-by-file notes and lists of checked cases go after the visible text, in this block:

```markdown
<details>
<summary>Details</summary>

The deep detail goes here.
</details>
```

Write the Details prose in ASD-STE100 Simplified Technical English, by the rules in [ste100.md](ste100.md). Keep every identifier exact, so another agent can find it. Keep the blank line after `<summary>`, or GitHub does not render the Markdown inside. Leave the block out when there is no deep detail. A suggestion block stays outside the collapsed section, so the author can apply it.

## Comment templates

Use the template for the comment you write. Review findings use the format in `pr-review`'s [posting.md](../pr-review/references/posting.md); the rules above apply to them too.

### Fix report

Use it after you push fixes to a PR.

```markdown
🤖 Pushed <short sha> with <N> fixes to <the feature, in product words>:

- **<What was wrong, as a person sees it.>** <What happens now. One or two sentences.>
- **<...>** <...>

<One line on tests, without counts.>

<details>
<summary>Details</summary>

<Per fix: the cause, the identifiers, the files, the tests that fail without the fix, the commands that ran and their results.>
</details>
```

### Status update

Use it after a merge, a rebase, a regenerated file or another change that has no behavior effect.

```markdown
🤖 <What you did, in one sentence.> <What the reader should know about the result, in one sentence.>

<details>
<summary>Details</summary>

<Commands, tool versions, conflict list, SHAs.>
</details>
```

### Example

Before: correct, but written for the person who wrote the fix.

```markdown
🤖 Pushed ff7a545de25 with two fixes to `jetpack-social/share-post`:

- **Broken accounts counted as working.** The pre-check fetched connections without `test_connections`, and in that case the route sets every `status` to `null`. Broken and `must_reauth` accounts therefore counted as working, so the ability returned `queued: true` with `connections: N` even when no account could receive the share. The pre-check now sends `test_connections`, matching what the editor does before it shares.
- **Posts that Publicize does not share.** Auto-share refuses password-protected posts and post types without `publicize` support (`Publicize_Base::save_meta()`, `post_type_is_publicizeable()`). The ability now returns a 400 for both cases.

Tests: one data-provider test covers the two refused cases. `Social_Abilities` gives 22/22 locally. PHPCS is clean.
```

After: the same facts, for two readers.

```markdown
🤖 Pushed ff7a545de25 with two fixes to sharing a post:

- **It reported success when no account could post.** Broken or expired accounts counted as working, so the share showed as queued even when nothing would go out. It now checks each account first, as the editor does.
- **It accepted posts that Social never shares.** Password-protected posts, and post types that do not support sharing, now get an error instead of being queued.

New tests cover both cases.

<details>
<summary>Details</summary>

- `jetpack-social/share-post` fetched connections without `test_connections`. Without that parameter, the route sets every `status` to `null`, so broken and `must_reauth` accounts counted as working. The ability returned `queued: true` with `connections: N` when no account could receive the share. The pre-check now sends `test_connections`, as the editor does.
- Auto-share refuses password-protected posts and post types without `publicize` support (`Publicize_Base::save_meta()`, `post_type_is_publicizeable()`). The ability now returns a 400 for both cases: `jetpack_social_password_protected` and `jetpack_social_post_type_not_shareable`.
- Tests: one data-provider test covers the two refused cases, and the share test asserts that `test_connections` is sent. `Social_Abilities`: 22/22. Each new assertion fails when its fix is reverted. PHPCS is clean.
</details>
```

## PR descriptions

A person who does not know the code must understand the PR from the top of the description. Start with three short sections:

```markdown
## What
One to three sentences: what the PR changes, as a person sees it.

## Why
One to three sentences: the problem or need that the change solves.

## How
One to three sentences or a short list: the approach, without a tour of the diff.

<details>
<summary>Details</summary>

File-by-file notes, design decisions, trade-offs, test commands and results, and anything a reviewer or an agent needs to go deeper.
</details>
```

- Keep each section approachable. Explain a domain term the first time, or use a simpler word.
- If the repository has a PR template, keep its headings. Put a short What, Why and How at the top of the matching sections, and put depth in a Details block.
- Keep issue links, testing steps the reviewer must run, and breaking-change warnings visible. Do not hide them in Details. The check does not count a section whose heading names testing.
- For each new test, name the break it catches that no other test does. With no new test, say why in one line. That line is a complete answer; never add a test only to satisfy a reviewer rule that asks for tests.
- When you update a description, keep the edits that the author made. Change only the parts that the new commits make wrong.
