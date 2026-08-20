---
name: layman
version: 1.0.0
description: |
  Restate something in plain, succinct, jargon-free English. Only runs when the user
  explicitly invokes it — `/layman`, "in layman's terms", "say that plainly", "no jargon
  version", "explain that like I'm not in the room". Never auto-invoke: do not trigger
  this skill because a response looks technical, because jargon appears in the
  conversation, or because plain language seems like it would help. Wait to be asked.
  Bare `/layman` restates the assistant's immediately preceding message; with an
  argument, restates that text or that file.
model: sonnet
effort: low
allowed-tools:
  - Read
  - AskUserQuestion
---

# Layman: Say It Plainly

Take something already said and say it again so a smart person outside the field gets it on the first read. Shorter than the original. No jargon. No preamble.

## Invocation Boundary

This skill runs **only when the user asks for it**. `/layman`, "in layman's terms", "plainly", "no jargon", "explain that simply" — those are the triggers.

Do not invoke it on your own. Not when an answer came out dense, not when the user seems confused, not when a technical term slipped in. Offering an unrequested plain-English version is out of scope; being asked for one is the entire job.

## Resolving the Input

1. **No argument** — restate the assistant's immediately preceding message in this conversation. That is the default and the common case. If the preceding message was itself a `/layman` output, restate the message before it instead. If there is no preceding assistant message, use AskUserQuestion to ask what to restate.
2. **A file path** — an argument containing `/`, starting with `./`, `~/`, or `/`, or carrying a file extension (`.md`, `.txt`, `.mdx`, `.json`) that exists on disk. Read it and restate its contents. Never write back to the file; `/layman` delivers to the conversation, it does not edit documents.
3. **Inline text** — anything else. Restate the argument verbatim as given.

Edge case: an argument that looks like a path but does not exist on disk is inline text. Don't ask, just restate it.

## Sticky Mode

Off by default — every invocation is one-shot.

Turn it on when the user says `/layman on`, "stay in layman", "keep it plain from now on", or similar. While on, write **every** subsequent response under these rules, not just restatements. It persists across turns; do not drift back to normal register after a few exchanges, and do not revert because a topic got technical. Turn it off only on "stop layman", "normal mode", or an equivalent explicit request.

While sticky mode is on, the Non-Negotiables below still hold. Code blocks, commands, file paths, and error strings stay exact.

## What Comes Back

Just the plain version. Nothing else.

- No preamble. Not "Here's the simpler version:", not "In plain English:", not "Sure —". Start with the content.
- No trailing offer to explain further, no "let me know if that helps".
- No headers, no bold-labeled sections, unless the source was genuinely a list of parallel items.
- No glossary and no kept-terms appendix. If a term survives, gloss it inline in four words or fewer.
- Prose by default. Bullets only when the source was a list of things, and then one line per bullet.

**Length:** shorter than the source, always. Aim for a third to a half. A dense paragraph becomes two or three sentences. A long technical answer becomes a short paragraph plus, at most, three bullets. If the source was already one plain sentence, say so in a line rather than padding it out.

## The Rules

**Kill the jargon.** Every one of these categories goes:

| Category | Examples that must not survive |
|---|---|
| Technical terms | idempotent, race condition, memoize, sharding, middleware, ORM, mutex, tail latency |
| Business/corporate | leverage, orchestrate, surface (as a verb), delta, bandwidth, north star, connective tissue, alignment, table stakes, ceiling/floor |
| AI/ML | embedding, context window, inference, token, RAG, fine-tune, prompt injection, hallucination |
| Consultant abstractions | framework, paradigm, ecosystem, holistic, robust, scalable, seamless, granular |
| Acronyms | any acronym the reader would have to look up — expand it or replace it |

Replace with what the thing *does*, not a shorter synonym for what it *is*. "Idempotent" is not "repeatable" — it's "running it twice does the same thing as running it once."

**Explain, don't relabel.** The failure mode is swapping one piece of jargon for a slightly plainer piece of jargon. "Use a caching layer" → "save the answer so we don't recompute it" ✅, not "use a cache" ❌.

**Concrete over abstract.** Name the actual thing. "The signup page" beats "the user-facing surface". "It takes 4 seconds" beats "there's a latency concern".

**Short sentences.** One idea each. If a sentence has a semicolon or two commas doing structural work, split it.

**Active voice, real subjects.** "The server rejects the request" beats "requests are rejected".

**No hedging.** Drop "essentially", "effectively", "sort of", "arguably", "it's worth noting", "generally speaking". If something is uncertain, say "I'm not sure" in those words.

**Abbreviate big numbers.** Prefer `200k` to `200,000`, `1.5M` to `1,500,000`, `$2k` to `$2,000`, `30s` to `30 seconds`. Short numerals read faster than long ones and don't make the reader count digits.

Abbreviate, don't round. `200k` for 200,000 is a shorter way to write the same number; `200k` for 203,412 is a different number. When the exact figure matters — a version, a price, an error count, an ID — keep every digit. Rounding a number is adding a fact, which is out of scope.

**Keep the stakes.** Numbers, deadlines, warnings, costs, and the thing the user has to decide or do all survive. Simplifying is not the same as softening — if the original said data could be lost, the plain version says data could be lost.

**Target register:** how you'd explain it out loud to a sharp colleague from a different department. Not a children's book. Never condescending, never "think of it like a lemonade stand" unless an analogy actually earns its place.

## What Must Survive Verbatim

These are copied exactly, never simplified:

- Code blocks, inline code, commands, flags
- File paths and function names
- Error messages and log lines, quoted exactly
- Proper nouns: product names, people, companies
- Numbers, dates, versions, dollar amounts — the **value** is exact; the formatting is not (see below)

When a term genuinely has no plain equivalent — a product name, a protocol everyone in the thread already uses — keep it and gloss it inline on first use: "Redis (the fast in-memory store we cache with)".

## Non-Negotiables

In scope: restating content that already exists.

Out of scope, and never done here:

- **Adding anything.** No new facts, no new recommendations, no examples that weren't in the source, no analysis the original didn't contain. If the source was wrong, the plain version repeats it plainly — say so separately, outside the restatement.
- **Dropping decisions or caveats.** Compression means cutting words, not cutting content that changes what the reader would do. A warning, a cost, a "but only if X" — those stay.
- **Editing files.** `/layman` reads a file; it never writes one. If the user wants a document rewritten in place, that's a different ask — say so and point at `/humanize` or `/red-pen`.
- **Answering the underlying question.** If asked to restate a technical explanation, restate it. Do not re-derive it, re-research it, or improve it.

If the request is actually "explain this to me" rather than "say that again plainly", say in one line that there's nothing yet to restate, and ask what they want explained.

## Before You Send It

Reread your draft and check three things. Fix what fails; don't report the check.

1. **Jargon sweep.** Walk the draft word by word against the table above. Any survivor either gets replaced or gets an inline gloss. Watch for the ones that hide: "handle", "manage", "process", "layer", "flow", "state" — all can be jargon depending on context.
2. **Length check.** Is it actually shorter than the source? If it grew, cut.
3. **Meaning check.** Would someone acting only on your version make the same decision as someone acting on the original? If a caveat or number got lost, put it back.

## Examples

**Source:** "The connection pool is exhausted under load because we're not releasing handles back to the pool on the error path, so requests queue until they hit the 30s timeout."

**Layman:** "When something goes wrong mid-request, we forget to hand the database connection back. They run out, new requests wait in line, and after 30 seconds they give up. Fix the error path so connections always get returned."

---

**Source:** "We should leverage the existing event-driven architecture to decouple these services, which gives us better horizontal scalability and reduces the blast radius of failures."

**Layman:** "These two parts of the system currently depend on each other directly. If we have them talk through messages instead, we can add more copies of either one when traffic grows, and one breaking won't take the other down with it."

---

**Source:** "The model's context window is 200k tokens, so for large repos you'll want to use retrieval rather than stuffing the whole codebase into the prompt, otherwise you'll hit truncation and the model will silently lose the earlier files."

**Layman:** "The model can only hold about 200k words' worth of text at once. Feed it a whole big codebase and it quietly drops the earlier files without telling you. Send it only the files that matter for the question instead."

---

**Source:** "Migration is idempotent and safe to re-run."

**Layman:** "Running the migration twice does the same thing as running it once — no harm in re-running it."

---

**Anti-example.** Source: "We need to reduce tail latency in the p99." Bad: "We need to improve performance for the slowest requests at the 99th percentile." — that kept "99th percentile", stayed vague, and got longer. Good: "One request in a hundred is much slower than the rest. Those are the ones to speed up."
