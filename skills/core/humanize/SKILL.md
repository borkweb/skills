---
name: humanize
version: 2.8.0
description: "Edit prose for natural, direct language while preserving facts, quotations and voice. Accept inline text or a file; apply file edits unless review-only is requested."

allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Humanize

Edit prose into natural, direct language while preserving the author's meaning.
Style patterns are editing cues, not evidence that a person used AI.

## Input and effect

- Existing file: edit prose in that file unless the user requests a review or a draft only.
- Inline text: return the rewrite. With no source or clear preceding text, ask for the source.
- A missing path presented as a file is a missing input; report it rather than rewriting the pathname.
- Infer register from the source and brief. Default to a light edit that preserves voice and structure. Ask only when unresolved intensity or register would materially change the result.

## Preserve

Keep all claims, uncertainty, conditions, options, numbers, dates, citations and attribution. Do not add facts, advice, opinions or personal experiences. First person is appropriate only when it belongs to the source author; a request for personality does not authorize fabricated experience. Direct quotations remain exact unless quote editing was explicitly requested.

For files, preserve frontmatter, code, HTML, imports, link definitions, structural data tables, Markdown syntax, original line endings and trailing newline. Edit narrative prose only. Inspect the diff for accidental structural changes.

## Edit

Remove filler, inflated significance, promotional wording, repetitive transitions and theatrical setup sentences. Prefer concrete verbs and vary rhythm where it helps. Retain necessary technical vocabulary and justified lists. Do not remove an option to avoid a list-length pattern or turn uncertain evidence into certainty.

Match the medium's existing typography or stated house style. Preserve quotation content; do not alternate straight and curly quotes merely to look more human. Read [patterns.md](patterns.md) only for a relevant editing concern; its catalog is optional, not a checklist to exhaust.

Tighten where possible. Meaning and coverage outrank a word-count target. A source that already works may need no change. Before delivery, compare the rewrite's claims and caveats to the input and correct any additions or losses.

## Output

Return the final rewrite only for inline text. For a file, apply the edit and briefly identify the file and change. Show drafts, critique or a change log only when requested. Do not publish or send the text.

## Examples

Input: “Her views have been cited in The New York Times and BBC. She maintains an active social media presence with over 500,000 followers.”

Rewrite: “The New York Times and BBC have cited her views. She has over 500,000 social media followers.”

Input: “It is important to note that the migration may take 30 minutes, but only if all workers are stopped first.”

Rewrite: “The migration may take 30 minutes, but only if all workers are stopped first.”
