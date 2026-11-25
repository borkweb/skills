---
name: writing-tests
description: "Use before writing, adding, changing, or reviewing unit tests in any repo (PHPUnit, Jest, Vitest), including 'add tests for this change', test-coverage requests, and reviewing the tests in a PR or branch. Defers to the repo's own test-writing skill when one exists. Decides whether a test is warranted, requires each test to name the regression it catches, defaults to no mocks and a happy-path-first test set, and self-corrects before reporting."
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
---

# Writing tests

Every test runs on every CI build, so a low-value test costs queue time on every PR, forever. Your job is to write the **fewest tests that would catch a realistic regression**. Writing zero tests can be the right result.

To audit a whole suite, or the tests a branch or PR adds, use `audit-tests`.

## 0. Use the repo's own skill first

Look for a test-writing skill in the repo: `.agents/skills/`, `.claude/skills/`, or `.cursor/rules/`, for example `.agents/skills/writing-tests/SKILL.md`. **If one exists, follow it instead of this skill and stop here.** It knows the codebase and ships checkers this skill can't run.

Otherwise, read the nearest `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` or `TESTING.md`, walking up from the code under test. Then continue below.

**Reviewing tests you didn't write**, such as a PR or another branch: apply sections 1 to 4 against that branch. Report findings instead of editing, and skip section 5.

## 1. Decide whether a test is warranted

**Repo and subsystem rules come first on whether to test.** If they require tests or a coverage minimum, that rule decides **whether** you test. This skill still decides **how**: no smells, data providers instead of clones, behavior instead of internals.

**Otherwise, zero new tests is a valid outcome** for:

- wiring (hook registration, imports, DI bindings) already exercised by a behavioral test;
- config, copy, string, or translation changes;
- registry or data entries (a new row, route, or definition) when a suite-wide invariant test already covers every row;
- trivial delegation or pass-through with no branching.

When you add no tests, write a one-line reason for the PR description (see the report template below). Don't skip the line, and don't add filler tests to satisfy a reviewer.

When you write a spec or prompt for another agent, ask for the behavior to hold, not for text to stay "byte for byte, with a test". That wording gets you a full-text snapshot.

## 2. Name the regression (required for every test)

Before you keep any test, write one sentence naming **a realistic code change that would make this test fail and that no existing test already catches.**

1. Find the suite the code belongs to.
2. Search what already exists. Grep the test directory for the class or function under test, and for the test names you plan to use. Read what you find. After a rebase, search again: a parallel PR can add the same test or helper, and git may merge both.
3. Write the sentence. Good: "If `normalize_x()` stopped casting `null` to `''`, the hook callback would fatal with a `TypeError`." Bad: "Verifies the class works." Also bad: "Ensures the constant equals 8."

**No sentence, no test.** If an existing test already catches the regression, extend that test or leave it alone. Treat a new test as redundant only when another executed test protects the same production path with an equal or stronger assertion.

### Choose what to cover

Cover the **happy path**, plus usually one to three **high-impact flows**. A flow is high impact when it is one of these:

- a failure that loses data, money, access, or security;
- the bug being fixed;
- the main error result a caller actually branches on.

Edge cases add bloat. Skip boundary, empty-input, and odd-format variants unless one of them is the bug being fixed or a repo rule requires it.

## 3. Write it well

- **Test public behavior and outputs, not internals.** Don't use reflection to call private methods, and don't assert on private state. Drive the code through its public entry point.
- **Test each behavior once.** If the entry point's tests already catch a helper's regression with an equal or stronger assertion, don't add a second set of tests for the helper. Keep helper tests for a helper with callers of its own.
- **No mocks by default.** A test double is any mock, stub, spy, fake, or partial mock: `createMock`, `getMockBuilder`, Mockery, `jest.mock`, `vi.mock`, `jest.spyOn` with a fake return, or a filter that short-circuits a call. Use real objects and in-memory fixtures instead. A test that mocks its dependencies mostly tests the mocks.
    - **If a double seems unavoidable, stop and ask the user before writing it.** Unavoidable usually means network or HTTP, a third-party API, the clock, or something that can't run in the test environment. Name the collaborator, why a real one can't be used, and what the test would lose without it.
    - **The default is no.** Without approval, write the test without the double, or drop it.
    - **In a non-interactive run, don't mock.** List the test under "Not written (needs a mock)" in the report.
    - **Use the repo's standard seam for outgoing HTTP** (for example `pre_http_request` in WordPress, `msw` or `nock` in JavaScript). It still needs approval. Give the fake response the real API's shape with specific values, and note the replaced call in the test.
- **Use a data provider or table instead of near-identical tests.** One test plus `@dataProvider`, `test.each`, or `it.each` beats 20 `test_accepts_x` copies. If the code already has a provider-driven test, add a row for a distinct case instead of a new method.
- **Check the setup cost per case.** A fixture that installs a site, boots an app, or seeds a database is expensive. Create it once per class or file when each case can restore what it changes. Keep a fresh fixture when a case needs an independent one. When sharing setup, check that each case passes alone and that the full set passes together.
- **Keep providers short.** Aim for about 3 to 6 cases, one per distinct outcome. Fold edge conditions that share a branch into one case, unless each names a requirement a reader would search for. When you trim a long list, check that every distinct high-impact outcome still has a case.
- **Write one suite-wide test for registry-wide invariants**, such as "no two rows share an id". Don't copy the same check into every row's test file.
- **When fixing a bug, write the regression test first** and confirm it fails without the fix.
- **Document the rule the test protects**, and why any unusual fixture or flag is needed. If the fixture can't exercise part of the behavior, say what stays uncovered.
- **Prove every kept test can fail.** Break the line it protects: delete the guard, flip the condition, or return early. Confirm the test fails, then revert. If it still passes, drop it or tighten its assertion. If you can't run tests, trace the broken path by hand and say so in the report.
- **For computed output, assert the exact expected value**, not only shape, type, count, or non-null.
- **Keep the expected value independent of the production code.** Use a literal, not the same helpers the code under test uses.
- **Use strict equality** (`assertSame`, `toBe`, `toStrictEqual`) unless you are comparing objects by value on purpose.
- **Pin broad exception expectations.** Pair a broad exception type with its message or code. A bare broad type passes when the wrong path throws.
- **Extend an existing test or file before adding a new one.**
- **Never catch and skip real failures.** Skips belong only in environment guards that run before the code under test.
- **Don't assert inside a callback the code under test may catch.** Record what the callback received, then assert after the call returns.

## 4. Check for low-value patterns

Run the repo's test checker if it has one. If it doesn't, check each new or changed test against this list by hand:

| Pattern | What to look for |
|---|---|
| No meaningful assertion | No assertion, or only a trivially true one like `assertTrue(true)` or `expect(true).toBe(true)` |
| Existence assertion | `class_exists`, `method_exists`, `function_exists`, or `toBeDefined()` on an import as the claim |
| Ghost test | A claim that removed code is gone after a refactor, such as `assertFalse( method_exists( $order, 'legacy_total' ) )`, or `assertArrayNotHasKey( 'legacy_total', $data )` when no caller or contract needs the key to be absent. Also comments that describe how the code used to work, or how it does not work |
| Private reflection | Reflection that calls a private method or reads private state |
| Constant restatement | Asserting a constant equals its own literal value |
| Source-text assertion | Reading production source and matching its text |
| Swallowed failure | A skip inside a `catch`, or an unconditional skip as the first statement |
| Mock-only verification | The only claim is that a mock was called |
| Excessive mocks | Many collaborators mocked in one test |
| Snapshot hash | An `md5(serialize(...))`-style fingerprint, or a large snapshot nobody reads |
| Loose equality | `assertEquals` or `toEqual` where strict equality fits |
| Near-duplicate tests | Near-identical tests in one file, or the same body cloned across files |

## 5. Self-correct before reporting

For **tests you wrote in this session**, act on every finding:

1. **Delete** it if you can't name the regression it catches.
2. **Merge** it: near-duplicates go into a data provider, and per-row clones become one suite-wide test.
3. **Rewrite** it against public behavior: drop the reflection, assert real values, remove the catch-and-skip, use strict equality.
4. **Remove** any test double the user did not approve, and trim cases beyond "Choose what to cover".
5. **Keep it only with a specific reason** in a one-line comment. "Needed" is not a reason. "Regression for the TypeError fatal in the hook; reaching the end is the assertion" is.

Then compare the number of new tests with the lines of production code changed. If the tests far outnumber the change, you are probably testing one change many times. Re-examine.

**Don't edit pre-existing tests you didn't write** unless the user asks. If you notice something serious nearby, mention it in the report.

## 6. Report

Use this template in your final message:

```
### Tests
**Kept**
- `FooTest::test_bar` — catches: <realistic change that would fail it, not caught elsewhere>; fails when: <the line you broke to prove it>

**Dropped / merged**
- `test_x`, `test_y` → merged into `test_z` data provider (near-duplicates)
- `test_class_exists` — dropped: existence check, covered by behavioral tests

**Mocks**
- none | `FooTest` — <seam> fakes <external call>; approved because <justification the user approved>

**Not written (needs a mock)**
- `FooTest::test_baz` — would need a double for <collaborator>; not approved

**Remaining findings (justified)**
- `FooTest.php:42` source-text assertion — <why no runtime alternative exists>

**Suggested PR "Testing" line** (when no tests were added):
No unit tests: change is a registry entry; covered by RegistryInvariantsTest, which asserts all rows.
```

Then run the tests the way the repo documents.
