# Commit Message Examples

Use these examples for voice and level of detail, not as fixed templates. Match the repository's established commit format when it differs.

## Small changes

An obvious, single-purpose change often needs only a subject:

```
fix(auth): stop expired sessions from refreshing forever
```

```
docs(setup): clarify which Node version the build needs
```

Add a short body only when it contributes context the subject cannot carry:

```
refactor(database): keep query rules in one place

Keeps database queries consistent without changing behavior.
```

## Larger changes

Summarize the shared outcome and why it matters. Do not list each class, file, or wiring change.

```
feat(admin): show session cost and progress as work runs

## Summary

Makes long-running agent sessions easier to follow and shows their cost while they are still running.

## Why

Admins could not tell whether work was active or how much a session had cost until it ended.
```

```
fix(queue): keep jobs safe during worker restarts

## Summary

Work in progress is recovered after an unexpected restart instead of being lost.

## Why

Deployments were dropping about 2% of active jobs, including payment confirmations and email sends.

## Testing

- [ ] Run `php artisan test --filter=JobRecoveryTest`
- [ ] Stop a worker during a slow job, restart it, and verify that the job finishes
```

## Plain language with technical precision

Keep a technical term when it identifies the actual subject of the change or is normal language for the intended readers:

```
feat(payments): verify Stripe webhooks before accepting events

Rejects forged or stale payment events before they can change an order.
```

```
feat(api): add Redis caching for product lists

Keeps frequently viewed product lists fast during busy periods and reduces pressure on the database.
```

`Stripe webhooks` and `Redis` belong here because they identify the integration and architectural choice. Extra details such as helper names, cache keys, and event-listener wiring belong in the diff.

## Refactors

Describe the maintenance benefit or preserved behavior instead of the code movement:

```
refactor(auth): keep permission checks consistent

Keeps every endpoint on the same permission rules. No behavior changes.
```

Avoid:

```
refactor(auth): extract PermissionGate and replace controller checks
```

The avoided version narrates code actions. The preferred version records the theme and the reason for the refactor.

## Performance

Lead with the observed effect. Keep exact measurements when they are supported by the change:

```
perf(products): make product lists load faster

Cuts the slowest product-list requests from 800ms to 45ms and reduces database load during peak traffic.
```

Avoid:

```
perf(api): implement Redis-backed stale-while-revalidate caching
```

Use the technical version only when adopting that caching design is itself the point future readers need to find in history.

## Build and continuous integration

```
ci(migrations): block unsafe database changes before merge

Catches destructive migrations and migrations that take over 30 seconds before they can reach production.
```

```
build(docker): make the production image smaller

Cuts the image from 1.2GB to 180MB, which speeds up deployments without changing application behavior.
```

## Breaking changes

State the impact and required action plainly. Keep the required Conventional Commits footer exact.

```
feat(api)!: return errors in one consistent format

Clients can now handle every API error the same way.

BREAKING CHANGE: Error details now live under the `error` field. Clients must update before deploying this version.
```

## Dependency updates

Names and versions are useful context, not jargon to remove:

```
chore(deps): update React to version 18.2.0

Keeps the app on the supported React release. Existing components continue to work without changes.
```

## Multiple concerns

Unrelated themes belong in separate commits:

**Commit 1 — product performance:**

```
perf(products): keep product lists fast during busy periods
```

**Commit 2 — database maintenance:**

```
refactor(database): make connection cleanup consistent
```

**Commit 3 — documentation:**

```
docs(readme): fix the product name
```

## Choosing the wording

- State the outcome, problem, or reason before the implementation.
- Use one theme per commit and omit details the diff already shows.
- Prefer familiar words when they remain accurate.
- Keep project and domain terms when removing them would be vague or misleading.
- Preserve exact warnings, measurements, versions, commands, issue references, and breaking-change instructions.
