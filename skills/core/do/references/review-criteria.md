# Review criteria (public seed)

The kinds of defect an independent reviewer rejects after every frozen gate has passed. The spec reviewer reads this list against a slice spec and, for every class the slice can exhibit, writes one acceptance criterion with the smallest check that proves it. The builder then meets that bar before `ready`, instead of the reviewer finding it afterwards.

This file is the public seed. Runs read the user's private copy, `~/.borkweb-skills/review-criteria.md`, when it exists, and fall back to this file. The private copy adds `Source:` citations, `Last seen:` dates and a `Last dreamed:` header from the user's own runs, and only the dreaming pass ([dreaming.md](dreaming.md)) edits it, row by row with the user's approval. Dreaming never edits this seed. A lesson moves here only by a normal commit the user asks for, in generic wording and without citations.

Class numbers are stable between the seed and the private copy, and a retired or merged number is not reused. Class 8 was retired and class 10 merged into 5 on 2026-11-13.

## 1. Fails open

Seen as: a frozen contract that passes when its input is missing; redaction that skips when the capability is absent; an unknown provider falling through to the default; an error handler that returns success; an empty state shown for a query that errored; a new entry point (a second API, a run endpoint, a REST exposure flag) that reaches an operation without one of its guards; a guard applied to one resource a write touches but not the other.

Criterion: name each guard, the input that must make it refuse, and every entry point and resource that reaches the guarded operation. Check: a test that feeds the missing or unknown input and asserts refusal, run through each entry point, not a test of the happy path.

## 2. Secrets reach an output

Seen as: a password in an exception message; a credential returned by a serializer; key redaction defeated by trailing whitespace; a child process that inherits the user's API key and tokens.

Criterion: list every value that must never appear in logs, exceptions, serialized output, child environments or test fixtures. Check: a test that plants a marker secret and greps every output channel for it.

## 3. A test that cannot fail

Seen as: a tautological assertion; a pin test that three scratch mutations pass; a byte-identity test over a file the code never writes; guards that survive mutation; a required stress case dropped so the fixture grades well; a fixture whose declared dimensions the stylesheet overrides; exact float equality that any overlap silences; a fixture that also meets a second condition, so it cannot isolate the first; a test of a double that short-circuits the rule it claims to test.

Criterion: for each gate, state the mutation or omission it must catch. Check: the RED chronology (the test fails before the change) and, for a pin, one deliberate mutation that fails it. A gate the slice adds is not accepted on green alone.

## 4. Production surface changed in a slice that claimed none

Seen as: a hold state that now throws instead of waiting; persistence that now stores raw rows; a config lookup whose semantics changed; a flag whose default inverted and now refuses with the opposite advice; a test hook in a production environment allowlist; an export or public method that exists only so a test can reach it and skips the validated entry point; a release package that ships test-only scripts.

Criterion: name the production entry points the slice must leave byte-identical or behavior-identical, and list every production-surface addition (export, public method, env key, packaged file) with its production caller. Check: a differential run (before/after on the same inputs) or an untouched-paths assertion, recorded as a gate. An addition referenced only from tests is a blocker.

## 5. The process dies on a valid call or an escaped failure

Seen as: a script that crashes on every valid invocation because a validator returns undefined; a builder that drops a required argument and exits 1; an uncaught throw under a stray environment value; a storage failure at session end exiting the whole process; an unguarded write from a background timer so a full disk crashes it; a write placed before disarm so the rejection escapes and production stays armed; a collector that never stops on storage failure; an unreadable record that crashes every listing command.

Criterion: name the command-line or entry-point invocations a user will actually run and, for every new timer, loop or background task, what happens when its first I/O throws. Check: each invocation runs end to end in a gate, with the real environment variables present and absent; inject each failure and assert the process survives, the state disarms in the right order, and the gap is recorded.

## 6. The fake is not the real environment

Seen as: shapes the live API never returns, masked by both fakes; a schema the real upgraded data never had; one parser version behaving unlike another; a language runtime version returning a different status code; a web server stripping an auth header; one character disabling a rule in a real browser; a backend that returns an empty list where the fake returned nothing.

Criterion: name the real runtime, version and data shape the slice will meet, and which fixture reproduces it. Check: at least one gate runs against the real shape or the CI version, not only the fake; record the version in the gate line.

## 7. The defect moved instead of closing

Seen as: a collapse relocated so the new guard is dead code; an interleave defect moved to a flush path; a fix mirrored with the same hole one level up; a redaction fix that does not survive garbage collection; a fix applied to one of two parallel normalizers.

Criterion: for a corrective, state the mechanism that caused the blocker, not just the symptom. Check: the original failing input still fails without the fix and passes with it, and the reviewer looks for the same mechanism at the neighbouring level.

## 9. Input accepted without validation

Seen as: regex-only date parsing accepting month 13; a zero or empty price overwriting a known one; id-less rows deduplicated into twins; a webhook payload used unvalidated; structured tool output written to the store without a shape check; a value longer than its database column.

Criterion: list each external input and its accepted shape. Check: a rejection test per input with the nearest malformed value (boundary, empty, wrong type, duplicate, over-length).

## 11. Lifecycle state left behind

Seen as: a `sent` attempt left by a crash that nothing resolves; a token that outlives its dismissal; a retry loop that blocks the caller; a race between two evaluators; a lock released under the wrong key; access that outlives an account recovery.

Criterion: for every new state, name who clears it and on what event, including after a crash. Check: a restart test from each non-terminal state.

## 12. The spec, a ruling or a gate prescribes the defect

Seen as: a period shift inverted by the plan itself; an architect ruling that introduced the defect it was meant to prevent; a slice spec contradicting an already-accepted report; spec-dictated text that the called code contradicts; a frozen criterion that prescribes the bug; a ruling that departs from a written repo convention and is reversed by a later review; a requirement added by a ruling that stays prose and never becomes a numbered criterion; a ruling that waives a user's precondition; a gate that measures the wrong object.

Criterion: before freezing, diff the slice spec and every ruling against `decisions.md`, the accepted slices it touches and the repo's written conventions (`AGENTS.md`, repo skills and checklists). Check every message, description and derivation the spec dictates against the code path it describes. A ruling that adds a requirement becomes a numbered criterion. Check: the spec reviewer names any contradiction as a gap; the architect resolves it before dispatch, never the builder.

## 13. A claim the code does not back

Seen as: mutation evidence labeled for two paths when only one was edited; a test that is RED at base for an unrelated reason; a builder note claiming a flag is passed when it is not; a docblock naming one cause of several; a user-facing or agent-facing description promising a guarantee the code gives only conditionally; a skill doc that omits the caller step a new CLI flag or exit code needs; an unlisted loosened assertion.

Criterion: every claim a reader acts on (evidence lines, docblocks, user-facing and agent-facing descriptions and errors, the PR body, skill docs) names the code or test that backs it. Check: the reviewer samples evidence lines against the diff and the rerun output. Every removed, skipped or loosened assertion, expectation, fixture value or golden file appears on the builder's `Loosened tests:` line with its source of truth (spec, API doc, real response); the reviewer diffs the test files against that line, and an unlisted or unsourced change is a blocker.

## 14. The check reads something other than what the consumer uses

Seen as: a validator that reads markup or declared dimensions while the reader sees rendered output; a checker on one parser's tree while production parses with another; an approval prompt built by a different normalizer than the write, so the user approves one value and the write uses another; an approval prompt that drops values under a length bound or shows caller text instead of the resolved target; host checks run before a canonicalizing transform; a guard that reimplements an external enforcer's matching and diverges from it; blinding applied to a subject's stdin but not its environment, working directory or version-control history.

Criterion: for each check, name the consumer that acts on the value (renderer, parser, write path, enforcer, subject process). The check runs on that consumer's input after every transform, or through the consumer itself. Check: a differential test feeds hostile inputs (control and bidi characters, maximum length, encoded forms) to both the check and the consumer and asserts that they agree; for isolation, plant a marker and search every channel the subject can reach.
