---
name: review
description: "Review a PR or requested local diff for concrete defects, scope gaps and landing readiness. Report-only unless fixes are requested; includes independent review when warranted."

allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
  - WebSearch
---

# Pre-Landing Review

Review the requested change for real defects and missing acceptance evidence. Default to report-only for a review request. Apply fixes only when requested or already authorized; never infer commit, push, merge or PR permission from a review invocation.

## Pin scope

Identify the PR target or explicitly supplied base, then verify the ref exists. Use repository configuration/default branch only as a fallback, and disclose uncertainty. If needed and available, `../../../scripts/detect-base-branch.sh` resolves a candidate; its fallback is not proof. Resolve this path from the loaded skill directory, not an assumed Claude environment variable.

Fetch the base once if network access is available and freshness matters. Record base SHA, HEAD and merge-base. Review `git diff <merge-base> <head>` for committed branch changes, not a diff against a newer base tip. Use [review-scope.py](../../../scripts/review-scope.py) with `--base <verified-ref>` to capture scope and fingerprints. Add `--include-local` only for requested working-tree changes; its local patch and untracked files are separate evidence. A base-branch name does not exclude local review. No changes in the requested scope means there is nothing to review.

Preserve unrelated dirt. Snapshot the checkout before review; if HEAD or scoped files change during review, stop, identify the writer and re-pin affected evidence. Do not revert another writer's changes.

## Review

Once scope is pinned, start work that needs only the snapshot before reading the diff. Dispatch any required independent reviewer (see below). Run the repository's existing test and lint commands in the background when they have no external effects. Run one suite at a time, because suites share ports, databases and fixtures. For a small diff with no required reviewer, the background checks are the only parallel work.

Read [checklist.md](checklist.md); report missing checklist coverage if unavailable. Its diagnostic rules and suppressions apply, while this entrypoint controls scope, action permissions and verdicts.

Compare the diff to the user's goal and PR intent; report scope additions and omitted requirements with evidence. Trace shared callers, persisted data, enum consumers, error paths, authorization and trust boundaries outside diff hunks when the change requires it. Check existing handling before raising a finding.

Prioritize data/SQL and migration safety, concurrency, auth, API contracts and LLM trust boundaries. Then examine relevant error handling, conditional side effects, coupling, tests, performance and frontend behavior. Severity follows the demonstrated consequence, not which checklist section found it. Read only the matching security pattern before using it as evidence:

| Diff touches…                       | Read pattern(s)                        |
|-------------------------------------|----------------------------------------|
| Buffer/array handling (C/C++)       | 01 Bounds, 11 Integer Arithmetic       |
| New/changed auth or middleware      | 03 Auth                                |
| Crypto ops (hashing, signing, RNG)  | 04 Crypto Hygiene                      |
| Parsers / deserialization / uploads | 17 Canonicalization, 02 Injection, 01  |
| Concurrency / goroutines / locks    | 05 Race Conditions                     |
| Error paths on privileged ops       | 07 Error Handling                      |
| Dependency / lockfile / CI config   | 08 Supply Chain                        |
| Web / browser / frontend            | 16 Web App Security                    |
| New HTTP endpoint                   | 03 Auth, 02 Injection, 16 Web          |
| Refactors of security-sensitive code| 14 Regression Prevention               |


Pattern paths are under `../../core/review-security/patterns/`. A CVE resemblance is a hypothesis; establish reachable inputs and impact in this code. Verify APIs against the installed version and authoritative documentation. Mark an unavailable check as unverified.

For frontend changes, use the existing design system, tokens and components (with DESIGN.md when present). Load [design-checklist.md](design-checklist.md) for relevant checks. Code-only suspicions require rendered/computed confirmation before becoming visual defects. A font, grid, CSS override or small label is not automatically defective. For a large frontend change, such as several files or more than 200 changed frontend lines, you may give the design checklist to one read-only subagent. Give it the pinned scope and changed frontend files, and have it return code-level findings in the checklist's format. Rendered confirmation stays with the primary reviewer, one browser check at a time.

## Independent pass

When acting as the primary review owner, use a separate read-only reviewer for nontrivial auth/payment/security changes, new external integrations, diffs over 200 changed lines or an explicit request. Dispatch with the actual runtime's supported tool and model configuration; do not invent API fields or assume Claude agent naming rules apply in Codex. Respect parent delegation limits. If unavailable, record that coverage gap. Dispatch it as soon as scope is pinned, before your own pass, and wait for it only before the verdict.

When assigned as that independent reviewer or as a design subagent, perform the review and return evidence to the parent. Do not delegate further, start test suites, or mark the absence of a third reviewer as missing coverage; the parent owns checks.

Give the reviewer only the goal, exact base/head or local snapshot, absolute checkout path, relevant raw artifacts and read-only constraint, never your own findings. Ask for confirmed findings with triggers, file/line evidence and impact. Zero findings is valid. Require a final response, including reviewed scope and any incomplete checks. Record its agent ID and save the returned evidence as the parent; a silent or partial response is not clean review. Ask once for available results if needed, then report the gap without repeated dispatches.

## Findings and authorized fixes

Each finding states severity, file/line, concrete failing scenario, evidence and a proposed correction. Distinguish confirmed defects from investigation leads and risk acceptance. Do not invent findings to satisfy a quota.

In report-only mode, stop at findings, background check results and verdict. In fix mode, apply scoped corrections under existing authorization, batch genuine design/scope decisions, and keep unrelated changes out. After changes, rerun on the final files every check the fixes could affect; background results stand only for the rest. Preserve failed regression tests that expose a real bug. Re-review changed scope, including independent review when required. Flag documentation only when a specific statement became false.

## Result

Report reviewed base/head and local scope, findings, fixes if any, checks with results, independent-review status, unresolved decisions and delivery state. Keep the summary concise.

- **SAFE TO LAND:** no unresolved blockers; required verification and independent review completed against stable final files.
- **LAND WITH CAUTION:** no unresolved blockers and all required gates complete, with explicitly nonblocking caveats or optional coverage gaps.
- **DO NOT LAND:** a confirmed blocker, a regression, or missing required evidence. Distinguish “defect found” from “readiness unverified.”

A skipped critical finding remains unresolved and yields DO NOT LAND. User acceptance of risk is recorded separately; it does not change finding severity or verification status. A required reviewer returning no response is missing evidence, not zero findings. The verdict does not authorize a merge.
