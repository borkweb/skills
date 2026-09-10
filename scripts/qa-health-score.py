#!/usr/bin/env python3
"""Optional QA score, not a release gate. Read JSON from stdin:
coverage: every category below -> inspected | not_inspected | not_applicable
findings (current unresolved only): [{category: <category>, severity: critical | high | medium | low}]
console_errors, failed_requests, broken_links: nonnegative integer counts,
required only for their inspected categories. The report describes tested scope.
Unknown coverage gives null scores; blockers cap a complete score at zero.
Malformed inputs exit 2. Valid inputs exit 0 even when blocked: inspect blocked
and coverage_complete, never use exit status alone as a release gate.
"""
import json
import sys

CATEGORY_WEIGHTS = {
    "console": .10, "network": .05, "links": .10, "visual": .10,
    "functional": .15, "ux": .10, "performance": .10, "content": .05,
    "accessibility": .15, "security": .10,
}
DEDUCTION = {"critical": 25, "high": 15, "medium": 8, "low": 3}
COUNTS = {"console": "console_errors", "network": "failed_requests", "links": "broken_links"}
STATES = {"inspected", "not_inspected", "not_applicable"}


def tiered(count, tiers, fallback):
    return next((score for limit, score in tiers if count <= limit), fallback)


def compute(data):
    if not isinstance(data, dict) or set(data) - {"coverage", "findings", *COUNTS.values()}:
        raise ValueError("input must be an object with supported fields")
    coverage = data.get("coverage")
    if not isinstance(coverage, dict) or set(coverage) != set(CATEGORY_WEIGHTS):
        raise ValueError("coverage must explicitly include every category")
    if any(not isinstance(v, str) or v not in STATES for v in coverage.values()):
        raise ValueError("invalid coverage state")
    findings = data.get("findings")
    if not isinstance(findings, list):
        raise ValueError("findings must be a list")
    normalized = []
    for finding in findings:
        if not isinstance(finding, dict):
            raise ValueError("each finding must be an object")
        cat, sev = finding.get("category"), finding.get("severity")
        if not isinstance(cat, str) or not isinstance(sev, str):
            raise ValueError("findings need category and severity strings")
        cat, sev = cat.lower(), sev.lower()
        if cat not in CATEGORY_WEIGHTS or sev not in DEDUCTION:
            raise ValueError("unknown finding category or severity")
        if coverage[cat] == "not_applicable":
            raise ValueError("a finding cannot belong to a not_applicable category")
        normalized.append({"category": cat, "severity": sev})
    for cat, key in COUNTS.items():
        if coverage[cat] == "inspected" and key not in data:
            raise ValueError(f"inspected {cat} requires {key}")
        if key in data and (type(data[key]) is not int or data[key] < 0):
            raise ValueError(f"{key} must be a nonnegative integer")
        if coverage[cat] != "inspected" and key in data:
            raise ValueError(f"{key} requires inspected {cat}")
    scores = {}
    for cat, state in coverage.items():
        if state != "inspected":
            scores[cat] = None
            continue
        if cat == "console":
            score = tiered(data[COUNTS[cat]], [(0, 100), (3, 70), (10, 40), (20, 20), (50, 10)], 0)
        elif cat == "network":
            score = tiered(data[COUNTS[cat]], [(0, 100), (2, 60), (5, 30)], 10)
        elif cat == "links":
            score = max(0, 100 - 15 * data[COUNTS[cat]])
        else:
            score = 100
        scores[cat] = max(0, score - sum(DEDUCTION[f["severity"]] for f in normalized if f["category"] == cat))
    blockers = [f for f in normalized if f["severity"] == "critical" or
                (f["category"] in {"security", "functional"} and f["severity"] == "high")]
    inspected = [cat for cat, state in coverage.items() if state == "inspected"]
    complete = bool(inspected) and "not_inspected" not in coverage.values()
    final = None
    if complete:
        weight = sum(CATEGORY_WEIGHTS[cat] for cat in inspected)
        final = round(sum(scores[cat] * CATEGORY_WEIGHTS[cat] for cat in inspected) / weight, 1)
        if blockers:
            final = 0.0
    return {"per_category": scores, "coverage": coverage, "coverage_complete": complete,
            "blocked": bool(blockers), "blockers": blockers, "final_score": final}


def main():
    try:
        result = compute(json.load(sys.stdin))
    except (ValueError, TypeError) as error:
        print(f"invalid QA input: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
