---
name: investigate
description: >
  Systematic debugging with root cause investigation. Phases: context
  detection, investigate, analyze, hypothesize, implement, verify. Iron Law:
  no fixes without root cause. Supports quick-pass for obvious bugs and full
  investigation for mysteries. Evidence log tracks what's been checked and
  ruled out. Use when asked to "debug this", "fix this bug", "why is this
  broken", "investigate this error", or "root cause analysis". Proactively
  suggest when the user reports errors, unexpected behavior, or is
  troubleshooting why something stopped working.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
---

# Systematic Debugging

## Iron Law

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Fixing symptoms creates whack-a-mole debugging. Every fix that doesn't address root cause makes the next bug harder to find. Find the root cause, then fix it.

---

## Step 0: Investigation Context Detection

Before investigating, detect what you're working with. The context determines which phases to emphasize.

**Auto-detect the investigation context:**

| Signal | Context type | Starting point |
|--------|-------------|----------------|
| User pasted a stack trace or error message | **Error report** | Parse the trace → jump to Phase 1 step 2 (read the code) |
| A test is failing (`test`, `spec`, `_test` in the message) | **Failing test** | Run the test → read the assertion → trace backwards |
| User says "it was working before" or references a recent change | **Regression** | `git log` / `git bisect` → find the breaking commit |
| User describes unexpected behavior (no error) | **Logic bug** | Reproduce → add assertions to narrow the gap between expected and actual |
| User reports slowness, timeouts, high resource usage | **Performance bug** | Jump to Performance Investigation Branch (below) |
| User says "works locally, fails in CI/staging/prod" | **Environment bug** | Jump to Environment Comparison Checklist (below) |
| Issue tracker ticket or TODO reference | **Tracked issue** | Read the ticket/TODO → gather prior context before investigating |

Use AskUserQuestion **only if** you cannot determine the context from the user's message and available project state. Ask ONE question:
```
I need a bit more context to investigate effectively.

A) I have an error message or stack trace to share
B) A test is failing — here's which one: [name]
C) Something that was working is now broken
D) The behavior is wrong but there's no error
E) It's a performance/slowness issue
F) It works locally but fails elsewhere
```

---

## Step 0A: Investigation Pacing

*Choose pacing based on bug complexity. Simple bugs shouldn't get the full treatment.*

**Quick-pass mode** — use when:
- The error message points directly to the cause (e.g., typo, missing import, undefined variable)
- A single test is failing with an obvious assertion mismatch
- The user already knows the root cause and just needs the fix verified

Quick-pass flow: Phase 1 (abbreviated) → Phase 4 → Phase 5. Skip Phases 2-3.

**Full investigation mode** — use when:
- The bug is intermittent or non-deterministic
- Multiple symptoms or multiple failing tests
- Prior fix attempts have failed
- The cause is not obvious from the error message
- Performance or environment bugs

If Quick-pass stalls after 10 minutes or one failed hypothesis, **escalate to Full investigation**.

---

## Step 0B: Evidence Log

*Track everything you check. Investigations fail when you forget what you've ruled out.*

Maintain a running evidence log throughout the investigation. Update it after every significant action:

```
EVIDENCE LOG
────────────────────────────────────────
#  | Phase | What was checked              | Finding              | Status
1  | P1    | Stack trace line 42           | NPE in user.name     | CONFIRMED
2  | P1    | git log -5 -- user.rb         | No recent changes    | RULED OUT
3  | P2    | Pattern: nil propagation       | Matches signature    | HYPOTHESIS
4  | P3    | Added assert at line 38       | user is nil          | CONFIRMED
────────────────────────────────────────
```

Statuses: **CONFIRMED** (evidence supports), **RULED OUT** (evidence contradicts), **HYPOTHESIS** (untested), **INCONCLUSIVE** (needs more data)

---

## Phase 1: Root Cause Investigation

*_5 Whys — don't stop at the first "because." Each answer should prompt "but why?"_*

Gather context before forming any hypothesis.

1. **Collect symptoms:** Read the error messages, stack traces, and reproduction steps. If the user hasn't provided enough context, ask ONE question at a time via AskUserQuestion.

2. **Read the code:** Trace the code path from the symptom back to potential causes. Use Grep to find all references, Read to understand the logic.

3. **Check recent changes:**
   ```bash
   git log --oneline -20 -- <affected-files>
   ```
   Was this working before? What changed? A regression means the root cause is in the diff.

   **If this is a regression**, use git bisect to find the breaking commit:
   ```bash
   git bisect start
   git bisect bad              # current state is broken
   git bisect good <known-good-ref>  # last known working state
   # Run reproduction at each step, mark good/bad
   ```
   *Git bisect finds the breaking commit in O(log n) steps. For a regression, this is almost always faster than reading diffs manually.*

4. **Check the data, not just the code:** *_Many bugs are data bugs, not code bugs._*
   - Query the database for the affected record(s) — is the data what you expect?
   - Check cache state (Redis keys, CDN headers, browser storage)
   - Check queue state (pending jobs, dead letter queues)
   - Check file system state (permissions, missing files, stale locks)
   - Check external API responses (has the contract changed?)

5. **Reproduce:** Can you trigger the bug deterministically? If not, gather more evidence before proceeding.

Update the Evidence Log after each step.

Output: **"Root cause hypothesis: ..."** — a specific, testable claim about what is wrong and why.

---

## Phase 2: Pattern Analysis

*_Occam's Razor — the simplest explanation that fits all the evidence is most likely correct. Resist exotic hypotheses when a common pattern matches._*

Check if this bug matches a known pattern:

| Pattern | Signature | Where to look |
|---------|-----------|---------------|
| Race condition | Intermittent, timing-dependent, passes alone / fails in suite | Concurrent access to shared state, async operations |
| Nil/null propagation | NoMethodError, TypeError, "undefined is not a function" | Missing guards on optional values, empty collections |
| State corruption | Inconsistent data, partial updates | Transactions, callbacks, hooks, shared mutable state |
| Integration failure | Timeout, unexpected response, connection refused | External API calls, service boundaries, network config |
| Configuration drift | Works locally, fails in staging/prod | Env vars, feature flags, DB state, secrets |
| Stale cache | Shows old data, fixes on cache clear | Redis, CDN, browser cache, OPcache, compiled assets |
| Off-by-one | Fence-post errors, missing last item, index out of bounds | Loops, pagination, array slicing, date ranges |
| Encoding/charset | Mojibake, truncated strings, failed comparisons | UTF-8 vs Latin-1, BOM markers, binary in text fields |
| Timezone/locale | Wrong dates, off-by-N-hours, failed date comparisons | TZ-unaware timestamps, locale-dependent formatting |
| Dependency version | "method not found" on valid method, changed behavior | Lock file drift, transitive dependency updates |
| Permission/ownership | "access denied", silent failures, empty results | File permissions, DB grants, IAM roles, CORS |
| Silent truncation | Data shorter than expected, no error | VARCHAR limits, integer overflow, payload size limits |
| Memory leak | Gradual slowdown, OOM after N requests | Unclosed connections, growing caches, event listener accumulation |
| Deadlock | Hangs indefinitely, no error, no timeout | Nested locks, DB row-level locks, circular waits |

Also check:
- `TODOS.md` for related known issues
- `git log` for prior fixes in the same area — **recurring bugs in the same files are an architectural smell**, not a coincidence

**External pattern search:** If the bug doesn't match a known pattern above, use WebSearch for:
- "{framework} {generic error type}" — **sanitize first:** strip hostnames, IPs, file paths, SQL, customer data. Search the error category, not the raw message.
- "{library} {component} known issues"

If WebSearch is unavailable, skip this search and proceed with hypothesis testing.

---

## Performance Investigation Branch

*_Measure, don't guess. Intuition about performance is wrong more often than right._*

When the context is a performance bug, replace Phases 1-2 with this branch, then rejoin at Phase 3.

1. **Quantify the problem:** Get a baseline measurement. "Slow" is not a metric. What's the actual latency/memory/CPU? What's the expected target?

2. **Profile, don't guess:**
   - **Slow requests:** Application profiler, `EXPLAIN ANALYZE` on queries, request timing breakdown
   - **Memory growth:** Heap snapshots before/after, object allocation tracking
   - **CPU usage:** Flame graphs, CPU profiling
   - **Frontend:** Browser DevTools Performance tab, Lighthouse

3. **Identify the bottleneck:** The profile shows where time/memory is spent. The fix targets that specific bottleneck — not "general optimization."

4. **Check for known performance anti-patterns:**
   - N+1 queries (ORM eager loading)
   - Missing database indexes (check `EXPLAIN` plans)
   - Unbounded result sets (no LIMIT, loading entire tables)
   - Synchronous I/O in async context
   - Unnecessary serialization/deserialization
   - Cache misses on hot paths

Output: **"Performance bottleneck: [specific location] consuming [measured amount] of [resource]. Target: [specific improvement]."**

Then proceed to Phase 3 with this as your hypothesis.

---

## Environment Comparison Checklist

*_When it works locally but fails elsewhere, the bug is in the delta between environments._*

Systematically diff the environments:

| Layer | Check | Command/method |
|-------|-------|---------------|
| Runtime | Language/framework version | `node -v`, `php -v`, `ruby -v`, etc. |
| Dependencies | Lock file matches | Compare `package-lock.json`, `composer.lock`, `Gemfile.lock` |
| Environment vars | All required vars set, correct values | `env \| grep APP_`, check `.env` vs deployed config |
| Database | Schema matches, migrations applied | Compare migration status, check for pending migrations |
| Services | External services reachable | Ping endpoints, check DNS resolution, verify credentials |
| Permissions | File/directory ownership | `ls -la`, check service account permissions |
| Network | Firewall, proxy, DNS differences | `curl` endpoints, check security groups, proxy config |
| Config files | Deployment-specific overrides | Compare nginx/apache config, application config files |
| Feature flags | Flag state matches expectations | Check flag service, DB-stored flags |

After completing the checklist, return to Phase 1 with the delta as your starting point.

---

## Phase 3: Hypothesis Testing

*_Confirmation bias guard — actively seek evidence that DISPROVES your hypothesis, not just evidence that confirms it. If you can't think of a way to disprove it, the hypothesis isn't specific enough._*

Before writing ANY fix, verify your hypothesis.

1. **Confirm the hypothesis:** Add a temporary log statement, assertion, or debug output at the suspected root cause. Run the reproduction. Does the evidence match?

2. **If the hypothesis is wrong:** Before forming the next hypothesis, consider searching for the error. **Sanitize first** — strip hostnames, IPs, file paths, SQL fragments, customer identifiers, and any internal/proprietary data from the error message. Search only the generic error type and framework context. If WebSearch is unavailable, skip and proceed. Then return to Phase 1. Gather more evidence. Do not guess.

3. **3-strike rule:** If 3 hypotheses fail, **STOP**. Use AskUserQuestion:
   ```
   3 hypotheses tested, none match. This may be an architectural issue
   rather than a simple bug.

   A) Continue investigating — I have a new hypothesis: [describe]
   B) Escalate for human review — this needs someone who knows the system
   C) Add logging and wait — instrument the area and catch it next time
   ```

**Red flags** — if you see any of these, slow down:
- "Quick fix for now" — there is no "for now." Fix it right or escalate.
- Proposing a fix before tracing data flow — you're guessing.
- Each fix reveals a new problem elsewhere — wrong layer, not wrong code.

Update the Evidence Log after each hypothesis test.

---

## Phase 4: Implementation

*_Minimal intervention — the best fix changes the least. Every line you touch is a line that can regress._*

Once root cause is confirmed:

1. **Fix the root cause, not the symptom.** The smallest change that eliminates the actual problem.

2. **Minimal diff:** Fewest files touched, fewest lines changed. Resist the urge to refactor adjacent code.

3. **Write a regression test** that:
   - **Fails** without the fix (proves the test is meaningful)
   - **Passes** with the fix (proves the fix works)

4. **Run the full test suite.** Paste the output. No regressions allowed.

5. **If the fix touches >5 files:** Use AskUserQuestion to flag the blast radius:
   ```
   This fix touches N files. That's a large blast radius for a bug fix.
   A) Proceed — the root cause genuinely spans these files
   B) Split — fix the critical path now, defer the rest
   C) Rethink — maybe there's a more targeted approach
   ```

---

## Phase 5: Verification & Report

**Fresh verification:** Reproduce the original bug scenario and confirm it's fixed. This is not optional.

Run the test suite and paste the output.

### Post-Fix Architectural Assessment

*_Zoom out — does this bug reveal a pattern, or is it truly isolated?_*

Before writing the debug report, answer these questions:

- **Recurrence check:** Has this area had bugs before? (`git log --oneline --all -- <file>` — look for "fix", "bug", "patch" in messages)
- **Blast radius check:** Could the same root cause exist elsewhere? (Grep for the same anti-pattern in other files)
- **Design check:** Did this bug happen because of a missing abstraction, wrong responsibility assignment, or missing validation layer?

If any of these trigger, add an **Architectural Note** to the debug report with a specific recommendation (not just "consider refactoring").

### Debug Report

Output a structured debug report:
```
DEBUG REPORT
════════════════════════════════════════
Symptom:         [what the user observed]
Root cause:      [what was actually wrong — the ACTUAL why, not just the what]
Investigation:   [key evidence log entries that led to the root cause]
Fix:             [what was changed, with file:line references]
Evidence:        [test output, reproduction attempt showing fix works]
Regression test: [file:line of the new test]
Related:         [TODOS.md items, prior bugs in same area]
Architectural:   [if triggered: specific recommendation for preventing recurrence]
Status:          DONE | DONE_WITH_CONCERNS | BLOCKED
════════════════════════════════════════
```

---

## Important Rules

- **3+ failed fix attempts → STOP and question the architecture.** Wrong architecture, not failed hypothesis.
- **Never apply a fix you cannot verify.** If you can't reproduce and confirm, don't ship it.
- **Never say "this should fix it."** Verify and prove it. Run the tests.
- **If fix touches >5 files → AskUserQuestion** about blast radius before proceeding.
- **Evidence Log is mandatory.** Update it after every significant action. If you lose track of what you've checked, the investigation will loop.
- **Quick-pass escalation:** If a "simple" bug resists the first hypothesis, escalate to Full investigation immediately. Don't burn time on a second quick guess.
- **Parallel investigation:** For complex bugs with independent search lanes, dispatch at most two read-only agents. Keep hypothesis selection, reproduction, and root-cause synthesis in the parent.
- **Completion status:**
  - DONE — root cause found, fix applied, regression test written, all tests pass
  - DONE_WITH_CONCERNS — fixed but cannot fully verify (e.g., intermittent bug, requires staging)
  - BLOCKED — root cause unclear after investigation, escalated
