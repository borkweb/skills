# Specialized investigation

## Performance
Record the observed metric, workload, environment and target. Profile the relevant boundary: request timing, query plan, CPU, allocations, queue/pool pressure or browser performance. Identify the measured bottleneck, test one causal change and compare under matched conditions. A faster unrelated microbenchmark does not prove the user-facing problem is fixed.

## Environment differences
Compare runtime and locked dependency versions, deployed configuration, schema/migration state, services, permissions, network and intended feature flags. Inspect only relevant values; do not dump secrets or entire environments into logs. Test the suspected difference against the reproduction.

## Regressions
Inspect relevant history first. Use bisect only with a meaningful known-good revision and sufficiently cheap, reliable reproduction. Run it in an isolated checkout, preserve unrelated dirt and reset the bisect state afterward. A regression report can involve data/config as well as source changes.
