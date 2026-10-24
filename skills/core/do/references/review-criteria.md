# Review criteria from history

What the independent reviewer rejected after every frozen gate had passed, across 24 runs and 50 review-only rejections (August–October 2026). The spec reviewer reads this list against a slice spec and, for every class the slice can exhibit, writes one acceptance criterion with the smallest check that proves it. The builder then meets that bar before `ready`, instead of the reviewer finding it afterwards.

Regenerate the evidence with `node skills/core/offload/handoff.mjs ledger report --all --verdicts`, which prints every review-only rejection verdict. Add a class when the same finding appears in two runs.

## 1. Fails open

Seen as: a frozen contract that passes when its input is missing; redaction that skips when the capability is absent; an unknown provider falling through to the default; an error handler that returns success; an empty state shown for a query that errored.

Criterion: name each guard and the input that must make it refuse. Check: a test that feeds the missing or unknown input and asserts refusal, not a test of the happy path.

## 2. Secrets reach an output

Seen as: a password in an exception message; a credential returned by a serializer; key redaction defeated by trailing whitespace.

Criterion: list every value that must never appear in logs, exceptions, serialized output or test fixtures. Check: a test that plants a marker secret and greps every output channel for it.

## 3. Tests that prove nothing

Seen as: a tautological assertion; a pin test that three scratch mutations pass; a byte-identity test over a file the code never writes; guards that survive mutation; a required stress case dropped so the fixture grades well; a fixture whose declared dimensions the stylesheet overrides; exact float equality that any overlap silences.

Criterion: for each gate, state the mutation or omission it must catch. Check: the RED chronology (the test fails before the change) and, for a pin, one deliberate mutation that fails it. A gate the slice adds is not accepted on green alone.

## 4. Production behavior changed in a slice that claimed none

Seen as: a hold posture that now throws instead of waiting; persistence that now stores raw rows; a config lookup whose semantics changed and produced four production diffs; a flag whose default inverted and now hard-refuses with the opposite advice.

Criterion: name the production entry points the slice must leave byte-identical or behavior-identical. Check: a differential run (before/after on the same inputs) or an untouched-paths assertion, recorded as a gate.

## 5. A failure escapes the guard and takes the process

Seen as: a storage failure at session end exiting the whole process; an unguarded write from a background timer so ENOSPC crashes it; a write placed before disarm so the rejection escapes as unhandledRejection and production stays armed; a collector that never stops on storage failure.

Criterion: for every new timer, loop or background task, state what happens when its first I/O throws. Check: inject the failure and assert the process survives, the state disarms in the right order, and the gap is recorded.

## 6. The fake is not the real environment

Seen as: shapes the live broker never returns, masked by both fakes; a schema the real upgraded data never had; libxml 2.13 behaving unlike 2.9; PHP 8.1 `proc_get_status` returning -1; Apache stripping the bearer header; one ASCII space disabling a rule in real Chrome.

Criterion: name the real runtime, version and data shape the slice will meet, and which fixture reproduces it. Check: at least one gate runs against the real shape or the CI version, not only the fake; record the version in the gate line.

## 7. The defect moved instead of closing

Seen as: a collapse relocated so the new guard is dead code; an interleave defect moved to a flush path; a fix mirrored with the same hole one level up; a redaction fix that does not survive GC.

Criterion: for a corrective, state the mechanism that caused the blocker, not just the symptom. Check: the original failing input still fails without the fix and passes with it, and the reviewer looks for the same mechanism at the neighbouring level.

## 8. Lossy joins and dropped records

Seen as: an INNER JOIN silently dropping rows; corrections to consumed lots dropped; sell-side revisions ignored; an upgrade that double-charges cost; a baseline loop erasing fills completed while a discrepancy was pending.

Criterion: for every join, merge or upgrade, state the invariant that must hold over the full population (counts, totals, conservation). Check: an oracle comparison on a fuzzed or full-population fixture, not a hand-picked example.

## 9. Input accepted without validation

Seen as: regex-only ISO parsing accepting month 13; a zero or empty price overwriting a known one; id-less rows deduplicated into twins; a webhook payload used unvalidated; structured tool output written to the store without a shape check.

Criterion: list each external input and its accepted shape. Check: a rejection test per input with the nearest malformed value (boundary, empty, wrong type, duplicate).

## 10. The valid path crashes

Seen as: a script that crashes on every valid invocation because a validator returns undefined; a builder that drops a required argument and exits 1; an uncaught throw under a stray environment value causing 23 test failures.

Criterion: name the command-line or entry-point invocations a user will actually run. Check: each one runs end to end in a gate, with the real environment variables present and absent.

## 11. Lifecycle state left behind

Seen as: a `sent` cancel attempt left by a crash that nothing resolves; a token that outlives its dismissal; a retry loop that blocks the caller; a race between two evaluators.

Criterion: for every new state, name who clears it and on what event, including after a crash. Check: a restart test from each non-terminal state.

## 12. The spec contradicts a prior decision

Seen as: a period shift inverted by the plan itself; an architect ruling that introduced the defect it was meant to prevent; a slice spec contradicting an already-accepted report.

Criterion: before freezing, diff the slice spec against `decisions.md` and the accepted slices it touches. Check: the spec reviewer names any contradiction as a gap; the architect resolves it before dispatch, never the builder.
