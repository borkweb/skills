# Shared browser QA

This procedure is shared by qa and qa-only. The invoking skill controls whether source fixes are allowed; report-only may read source for route tracing but must not edit application files.

## Establish scope

Use the supplied URL, local running app or documented launch command. Use available browser tools with their actual schemas; do not assume a Claude-specific tool exists. If the browser or required credentials are unavailable, report incomplete coverage instead of pretending to test.

For diff-aware work, verify the base ref and pin the merge-base/head using `../../../scripts/review-scope.py` relative to the invoking skill directory. Include requested local changes explicitly. Trace changed controllers, components, styles, services, migrations and API consumers to affected routes. Do not hardcode main or scan unrelated services when the project URL is available.

| Mode | Work |
|---|---|
| Diff-aware | Affected routes and shared behavior implied by the requested change |
| Full | Core user journeys and relevant reachable pages; record tested coverage |
| Quick | Home/entry page and up to five important navigation targets; smoke checks |
| Regression | Reproduce the baseline issues and affected flows; compare evidence |

Use task scope/time limits to bound exploration; zero findings is valid. No minimum issue quota. Record untested pages, states and roles rather than assuming they passed.

## Explore

1. Record URL, build/commit, viewport, mode, time and available roles. Create report/screenshot artifacts outside unrelated source paths. Redact credentials and sensitive data.
2. Walk the critical journey using realistic safe test data. Test navigation including back/forward, forms and validation, loading/empty/error states and recovery. Respect authorization for submissions or destructive/external actions; local QA does not imply permission to transact on production.
3. Check visible layout and responsive behavior at relevant sizes. Inspect console and network after meaningful interactions; correlate failures to the actual user consequence. Expected validation errors are not bugs just because a request is 4xx.
4. Check keyboard navigation, focus, labels, semantics and relevant announcements. Text contrast AA: 4.5:1 normal; 3:1 for large text (18pt/24px regular or 14pt/about 18.67px bold). Respect standard exceptions. Restore any temporary viewport/throttling overrides.
5. Where credentials permit, test actual role boundaries and stale state after role changes. UI hiding alone is not authorization. Never imply an untested role passed.
6. Measure performance where relevant: timings, oversized assets, repeated requests, layout shift and responsiveness under the recorded conditions. Treat thresholds as investigation signals; severity requires a demonstrated consequence or violated requirement. Do not infer memory leaks from console output alone.
7. Reproduce suspected issues and record concrete steps, expected/actual behavior, severity, category and evidence promptly. Use screenshot pairs for visible interactive failures and logs/traces for failures screenshots cannot show. Distinguish deterministic reproduction from intermittent observations.

## Framework-specific checks (only if applicable)

- Next.js: hydration, client navigation and actual data requests for the installed version.
- Rails: CSRF, Turbo/Stimulus transitions, flash/error handling and observed query performance.
- WordPress: plugin console conflicts, role/admin UI, REST behavior and mixed content.
- SPA: history, stale state after navigation and long-lived subscriptions where symptoms justify profiling.

## Coverage and optional score

Report each category as inspected, not_inspected or not_applicable with evidence/reason: console, network, links, visual, functional, ux, performance, content, accessibility and security. Category inspection covers only the listed routes/states, not the whole application. Counts and findings must be observed, not inferred from silence. Score only current unresolved findings; report verified fixes separately.

If a numeric score is requested, use `../../../scripts/qa-health-score.py` with its documented JSON input; do not compute a different rubric in prose. Missing coverage yields an incomplete score and blockers override a numeric summary. The score is a prioritization heuristic, never a release gate or proof of safety.

## Report

Return a standalone report with scope/build, actual duration, pages/states/roles tested, coverage, confirmed issues in severity order, reproduction/evidence links, console/network observations and limitations. List up to three highest-priority corrections when any exist. For regression mode, mark fixed/new/persisting based on comparable runs. Do not claim READY when required flows or checks were unavailable.
