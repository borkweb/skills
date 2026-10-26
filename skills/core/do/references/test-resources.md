# Test gate resources

Run independent gates concurrently only after verifying that their runtime resources are isolated. Different commands, languages, repositories or worktrees alone do not prove isolation. Shared or unknown resources require serial execution for the affected gates; unrelated verified gates may continue.

Record each gate's resource use, isolation evidence and owner in the existing run notes or slice brief before launch. Check the resources relevant to that command:

- Worktree files and generated output paths, including caches and snapshots.
- Dependency directories and installs: finish an install before checks that consume it; do not mutate a shared dependency tree while another gate uses it.
- Ports and services, including dynamically chosen ports and who starts or stops each service.
- Databases, schemas, fixtures and reset/seed operations.
- Browser profiles, accounts and backend state; separate tabs do not isolate shared server state.
- Resource ownership and cleanup: a gate may reset or stop only the resources assigned to it, after their consumers finish.

A read-only check or a suite confined to its own temporary directory can run beside other gates when its implementation/configuration confirms no shared mutable resources. Static checks also need this assessment when they write caches or generated files. Do not assume isolation from a test's name or a claimed worktree boundary. No new scheduler or ledger is needed.

Join all prerequisite gates before fixing, integrating or accepting their result. After integration, run the relevant final gates on the final combined revision and preserve raw results tied to that revision; green per-slice gates do not replace integration evidence. Independent review, frozen criteria and acceptance ownership remain unchanged. Repeat affected gates after a source change; unchanged evidence remains reusable.
