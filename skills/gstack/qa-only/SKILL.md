---
name: qa-only
description: "Perform report-only browser QA with reproducible findings and coverage evidence. May read source for scoping; never edits application files or applies fixes."

allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - WebSearch
---

# QA Report Only

Test and document the requested web application using [shared exploration](../qa/exploration.md). The deliverable is a report and evidence; do not edit application code, tests or configuration, commit, push or merge.

Read source when needed to map a requested diff to routes or understand reproduction, including backend changes that affect user flows. Read-only source tracing is compatible with report-only QA. Use the actual verified base; do not assume main.

Follow the selected quick, diff-aware, full or regression scope. Report real findings, including zero when the evidence supports it. Do not force a quota or award untested categories a perfect score. Report unavailable browser, roles, data or checks as incomplete coverage. A healthy tested route does not establish whole-site health.

Write `qa-report-<domain>-<date>.md` in the requested artifact location with scope, tested coverage, issues, repro steps, evidence and limitations. Propose corrections when useful without applying them. Never claim required verification passed when it did not run.
