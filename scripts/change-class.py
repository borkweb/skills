#!/usr/bin/env python3
"""Classify changed paths for review: is a security pass needed, and what is the risk-tier floor.

Reads changed paths on stdin, NUL-separated (`git diff --name-only -z <merge-base> <head>`)
or one per line. Reads paths only, never file contents, and writes nothing.
--rules-dir <dir> names the repo-rules store directory; an optional `risk-paths.txt` there
holds the owner's lines: `high <glob>`, `person <glob>` or `low <glob>`. `#` starts a comment.
Globs use fnmatch, so `*` also crosses `/`. Prints JSON. Exits 2 on bad input.
"""
import argparse
import fnmatch
import json
from pathlib import Path, PurePosixPath
import sys

PROSE_EXT = {".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc",
             ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"}
PROSE_NAMES = {"license", "licence", "notice", "authors", "contributors", "changelog", "readme"}
# Markdown and text that a model or agent loads as instructions is code, not prose.
INSTRUCTION_NAMES = {"agents.md", "claude.md", "gemini.md", "skill.md", "copilot-instructions.md",
                     ".cursorrules", "llms.txt"}
INSTRUCTION_DIRS = {".claude", ".codex", ".cursor", ".agents", ".opencode", ".github", ".gemini",
                    "skills", "commands", "agents", "prompts", "hooks", "rules"}
CI_NAMES = {".gitlab-ci.yml", "jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml",
            ".travis.yml"}
CI_DIRS = {".circleci", ".buildkite", ".teamcity"}
DEPENDENCY_NAMES = {"package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock",
                    "bun.lockb", "composer.json", "composer.lock", "gemfile", "gemfile.lock",
                    "pipfile", "pipfile.lock", "poetry.lock", "uv.lock", "pyproject.toml", "go.mod",
                    "go.sum", "cargo.toml", "cargo.lock", ".npmrc", ".yarnrc", ".yarnrc.yml"}
MIGRATION_DIRS = {"migrations", "migrate"}
TEST_DIRS = {"test", "tests", "__tests__", "spec", "e2e", "fixtures"}
# Path words that always need a person, whatever the tier.
PERSON_WORDS = ("auth", "billing", "payment", "checkout", "secret", "credential", "crypto",
                "updater", "deploy", "release", "permission")
TIERS = ("LOW", "MEDIUM", "HIGH")


def classify(path):
    pure = PurePosixPath(path.replace("\\", "/"))
    parts = [part.lower() for part in pure.parts]
    name = parts[-1]
    dirs = set(parts[:-1])
    suffix = pure.suffix.lower()
    if ".github" in dirs and "workflows" in dirs or name in CI_NAMES or dirs & CI_DIRS:
        return "ci"
    if name in DEPENDENCY_NAMES or name.startswith("requirements") and suffix == ".txt":
        return "dependencies"
    if dirs & MIGRATION_DIRS or suffix == ".sql":
        return "migration"
    prose = suffix in PROSE_EXT or (not suffix and name in PROSE_NAMES)
    if prose and (name in INSTRUCTION_NAMES or dirs & INSTRUCTION_DIRS):
        return "instructions"
    if name in INSTRUCTION_NAMES:
        return "instructions"
    if prose:
        return "prose"
    if dirs & TEST_DIRS or name.startswith("test_") or ".test." in name or ".spec." in name \
            or pure.stem.lower().endswith("_test"):
        return "test"
    return "code"


def person_word(path):
    lowered = path.lower()
    return next((word for word in PERSON_WORDS if word in lowered), None)


def load_rules(rules_dir):
    rules, problems = [], []
    if not rules_dir:
        return rules, problems
    source = Path(rules_dir) / "risk-paths.txt"
    if not source.is_file():
        return rules, problems
    try:
        lines = source.read_text().splitlines()
    except (OSError, UnicodeDecodeError) as error:
        return rules, [f"{source}: unreadable ({error.__class__.__name__})"]
    for number, raw in enumerate(lines, 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        fields = line.split(None, 1)
        if len(fields) != 2 or fields[0].lower() not in ("high", "person", "low"):
            problems.append(f"{source}:{number}: expected `high|person|low <glob>`")
            continue
        rules.append((fields[0].lower(), fields[1].strip()))
    return rules, problems


def assess(paths, rules):
    files, reasons = [], []
    for path in paths:
        kind = classify(path)
        owner = {level: glob for level, glob in reversed(rules) if fnmatch.fnmatch(path, glob)}
        entry = {"path": path, "class": kind, "tier": "MEDIUM", "person_required": False, "why": kind}
        word = person_word(path)
        if "high" in owner:
            entry.update(tier="HIGH", person_required=True, why=f"owner: high {owner['high']}")
        elif "person" in owner:
            entry.update(person_required=True, why=f"owner: person {owner['person']}")
        elif kind in ("ci", "migration") or (word and kind != "prose"):
            entry.update(person_required=True, why=kind if kind in ("ci", "migration") else f"path word: {word}")
        elif kind == "prose" or ("low" in owner and kind not in ("instructions", "dependencies")):
            entry.update(tier="LOW", why=f"owner: low {owner['low']}" if kind != "prose" else "prose")
        files.append(entry)
        if entry["tier"] != "LOW" or entry["person_required"]:
            reasons.append(f"{path}: {entry['why']}")
    floor = max((entry["tier"] for entry in files), key=TIERS.index)
    prose_only = all(entry["class"] == "prose" for entry in files)
    return {
        "files": files,
        "security_pass": "SKIP" if prose_only else "REQUIRED",
        "security_reason": "every changed file is prose" if prose_only else
                           "the change has a file that is not prose",
        "tier_floor": floor,
        "person_required": any(entry["person_required"] for entry in files),
        "tier_reasons": reasons or ["every changed file is prose or an owner-marked low path"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rules-dir")
    args = parser.parse_args()
    data = sys.stdin.read()
    paths = [item for item in data.split("\0" if "\0" in data else "\n") if item.strip()]
    if not paths:
        print("change-class: no paths on stdin", file=sys.stderr)
        return 2
    rules, problems = load_rules(args.rules_dir)
    result = assess(paths, rules)
    result["rule_problems"] = problems
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
