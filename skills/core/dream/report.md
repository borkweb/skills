# The dream report

Every dream pass builds one page that explains what it found and what it proposes, and the user decides each row on that page. It is built twice: as **proposed** at the approval step (§4 of [dreaming.md](../do/references/dreaming.md)), and again as **final** after the approved rows are applied (§5). `dream-report.mjs` in this directory writes the page, keeps the newest five reports and deletes older ones, and collects the decisions.

The report cites private repos and sessions. It lives in `output/dream/` of the repo the dream was invoked in, which the helper keeps out of git through the repo's local `.git/info/exclude`. Never commit it, never copy it into a tracked path and never publish it to a hosted page.

## 1. Write the data

Write `report.json` in the dream run directory:

- `id`: the dream run directory name (`<YYYY-MM-DD>-dream-<chars>`). The same id rebuilds the same report in place.
- `title`, `date`, and `summary`: two or three plain sentences on what this pass found.
- `stats`: `{label, value, note}` tiles, such as runs scanned, rows proposed, classes before and after, the escape rate and the enforcement share.
- `sections`: `{title, intro, items}`. One section per group that has rows: review criteria, repo rules, checks, gotchas, escapes, and one section per memory store. A group with no rows is left out.
- `findings`: `{title, body}` blocks that need no decision: the harness bug list, runs with missing evidence, approved checks still pending, spec-reviewer gaps and recommendation lines.

Each item is one proposal row or one memory change row:

| Field | Holds |
| --- | --- |
| `id` | Unique in the report: `row-<n>` for a proposal row, `mem-<project>-<n>` for a memory row |
| `kind` | The row kind (`add`, `merge`, `retire`, `check`, `escape`, `replace` and so on) |
| `title`, `detail` | The change in one line, then what a reader needs to decide it. A check row's `detail` says a check in a shared repo becomes a teammate-visible change |
| `target` | The file, rule, store or run the row changes |
| `before`, `after` | The current text and the proposed text, when the row rewrites something |
| `evidence` | Run citations, session ids or the repo check, one per entry |
| `recommended`, `why` | `keep` or `revert`, and the reason in one line |

Every value is shown as plain text. Copy citations and quoted text as they are; do not write HTML or Markdown into a field.

## 2. Build, serve and wait

Run both commands from the repo the dream was invoked in:

```
node "<dream skill base>/dream-report.mjs" build --data <run dir>/report.json
node "<dream skill base>/dream-report.mjs" serve --report <printed report dir> --out <run dir>/report-decisions.json
```

`build` prints the page path; the report directory is the directory that holds it. `serve` opens the page in the browser and exits 0 when the user sends their decisions. Start it in the background and wait for it to exit; do not poll. Tell the user the page is open and that the session waits for it.

Each item gets **Keep**, **Revert** or **Change it** with a comment. **Approve all** sets every item to Keep. The page sends nothing until every item has a decision.

## 3. Act on the decisions

Read `<run dir>/report-decisions.json`. It holds one entry per item id.

- `keep`: the row is approved. Apply it as §4 of dreaming.md says for its kind. Keep on a check row authorizes the proof and what follows it, as that section says.
- `revert`: the row is not applied. Record it in `decisions.md` as rejected in the report.
- `change`: the comment is the user's instruction for that row and nothing else. Revise the row, then ask about the revised row with AskUserQuestion, showing the new text. Apply it only on that approval.

A decision in the file is the user's approval of that row, so do not ask again about a kept or reverted row.

**Fallback.** Ask row by row with AskUserQuestion, as §4 describes, when the page cannot be served or opened, `serve` exits 3 (nobody answered in time), or the user prefers to answer in the session. When the user pastes the decisions the page copied, check that every item id is present and use them.

## 4. Build the final report

After the approved rows are applied, set `state` to `final`. Give each item an `outcome` (`applied`, `reverted`, `revised`, `refused` or `pending`) and an `outcome_note` where the result needs one, such as a check that could not be proven or a memory swap that was refused. Put the §5 report in `stats` and `findings`. Then rebuild and open it:

```
node "<dream skill base>/dream-report.mjs" build --data <run dir>/report.json --open
```

Give the user the page path and the path of `output/dream/index.html`, which lists the reports that are kept.
