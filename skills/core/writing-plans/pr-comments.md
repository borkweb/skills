# PR text rules

Use these rules for all text that a skill writes to a pull request: the description, every comment, review body, inline comment and reply. They apply to drafts too, because a draft becomes the posted text.

## Talk about the work only

The text is about the code and the change. Do not write about how the text was made or who asked for it.

Never mention:

- the user who runs the skill, by name, login or role ("Matt asked", "on behalf of");
- a skill, slash command, agent, persona, model, harness or tool (`/pr-review`, `bork:do`, Codex, Claude, "the peer pass");
- the process: loops, sweeps, passes, rounds, runs, lanes, councils, "both reviewers", "flagged independently", "automated review";
- run IDs, local paths, scratchpad files, worktrees or herdr tabs.

A hidden HTML marker (`<!-- ... -->`) that a later run must find is permitted. Give it a neutral name, and put it on the first line.

## Keep it short

- Put the most important fact first: what is wrong, then what to do.
- Use one to three sentences for each finding. Use a short list for three or more items.
- Do not repeat the code back. Do not add greetings, praise or sign-offs.
- Keep code, identifiers, paths, error strings, required labels and suggestion blocks exactly as written.

## Use plain language

Write the prose in ASD-STE100 Simplified Technical English, by the rules in [ste100.md](ste100.md). Plain, jargon-free English in the style of `bork:layman` is also permitted. Use one style in a text.

## Put deep detail in a collapsed section

Evidence, traces, reproduction steps, long reasoning and lists of checked cases go after the short text, in this block:

```markdown
<details>
<summary>Details</summary>

The deep detail goes here.
</details>
```

Keep the blank line after `<summary>`, or GitHub does not render the Markdown inside. Leave the block out when there is no deep detail. A suggestion block stays outside the collapsed section, so the author can apply it.

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
- Keep issue links, testing steps the reviewer must run, and breaking-change warnings visible. Do not hide them in Details.
- When you update a description, keep the edits that the author made. Change only the parts that the new commits make wrong.
