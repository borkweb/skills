# Engineering checks

Read the sections relevant to the change. Preserve existing contracts and use repository evidence to choose mechanisms.

## Architecture and contracts
Trace entrypoints, shared callers, dependencies and data flow. Prefer an existing primitive when it satisfies the goal. Check API/schema definitions, consumers, compatibility, versioning and deprecation. Identify realistic failure scenarios at new integration boundaries; diagram a flow only when it clarifies ordering or ownership.

## Security
Identify trust boundaries, cross-user data access, validation, injection, secret handling and dependency risk. Trace authorization beyond the changed function. Check missing/empty/malformed input, excessive sizes and canonicalization where relevant. Ground a threat in an input, path and impact; load selected `../../core/review-security/patterns/` references when useful, not the whole library.

## Code quality and tests
Check whether new abstractions reduce real duplication and whether error paths preserve useful context. Choose tests from the failing behavior and affected contracts, including negative and integration cases. Keep explicit RED-before-GREEN requirements. Do not demand a test for every method or arbitrary 100% coverage.

## Failure, recovery and concurrency
For affected shared-state paths, record trigger → failure → mitigation → observable result → verification. Cover read/check/write races, atomic claims, retries/idempotency, duplicate and out-of-order events, lock order, cancellation, timeout and partial failure as relevant. Distinguish retryable errors from terminal ones and identify cleanup/compensation. One useful failure table can cover exceptions, races and recovery; do not repeat it in several registries.

## Performance and operations
Check N+1 work, bounded memory/queues, pool pressure, cache consistency and expensive paths against actual requirements. Define useful success/failure signals without logging every method entry/exit or leaking sensitive data. Add alerts and runbooks only when the service's operational needs warrant them.

## Deployment and migration
Check old/new code coexistence, schema locks and backfills, rollback or forward recovery, staged rollout where justified and post-deploy verification. Preserve intentional feature-flag policy. A local green suite cannot stand in for required CI or rendered/integration evidence.
