# Staleness status

Read this file when Step 2b finds `<behind>` above `0`, after the merge test in
[setup.md](setup.md). A `<behind>` of `0` is **CURRENT** and needs no table.

| Status | Condition | Effect |
|---|---|---|
| **CURRENT** | `<behind>` is `0` | None |
| **BEHIND** | Behind, no overlapping files | Note the count in the summary |
| **OVERLAP** | Overlapping files, clean merge | Reviewers check the PR against the base versions of those files; verdict is at most LAND WITH CAUTION |
| **CONFLICT** | `merge-tree` exits `1` | Verdict is DO NOT LAND — the merged result has not been reviewed |

A clean textual merge on an overlapping file can still break: the base can
rename a function the PR calls, or change a contract the PR relies on. That is
what OVERLAP exists to catch.
