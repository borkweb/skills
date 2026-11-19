#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml>=6"]
# ///
"""Structural validation only; model behavior is evaluated separately in evals/.

Run with `uv run scripts/validate-skills.py`: uv reads the dependency block above, so no venv is needed.
"""
import glob
import json
import os
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
errors: list[str] = []
notes: list[str] = []


def rel_of(path: Path) -> str:
    return os.path.relpath(path, ROOT)


def read_text(path: Path) -> str:
    """Read as UTF-8, replacing invalid bytes, so one bad file cannot crash a scan."""
    return path.read_bytes().decode('utf-8', 'replace')


def lines_of(text: str):
    """Number lines split on \\n only, as git and editors do (str.splitlines also splits on \\f, \\u2028 and more)."""
    return enumerate(text.split('\n'), 1)


def clean(path: Path) -> Path:
    """Lexical normalization: collapse . and .. without touching the filesystem."""
    return Path(os.path.normpath(path))


manifests = [json.loads((ROOT / p).read_text(encoding='utf-8')) for p in ('.claude-plugin/plugin.json', '.codex-plugin/plugin.json')]
if manifests[0].get('skills') != manifests[1].get('skills'):
    errors.append('manifest skill lists differ')
if manifests[0].get('version') != manifests[1].get('version'):
    errors.append('manifest versions differ')
paths: list[str] = manifests[0]['skills']
if len(set(paths)) != len(paths):
    errors.append('duplicate manifest skill paths')

FRONTMATTER = re.compile(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)', re.S)
NAME = re.compile(r'[a-z0-9-]{1,64}')
names: list[str] = []
for path in paths:
    entry = ROOT / path / 'SKILL.md'
    try:
        header = FRONTMATTER.match(entry.read_text(encoding='utf-8'))
        if not header:
            raise ValueError('missing YAML frontmatter')
        meta = yaml.safe_load(header.group(1))
        if not isinstance(meta, dict):
            raise ValueError('frontmatter must be a mapping')
        name, description = meta.get('name'), meta.get('description')
        if not (isinstance(name, str) and NAME.fullmatch(name)):
            raise ValueError('invalid name')
        if not (isinstance(description, str) and 1 <= len(description.strip()) <= 1024):
            raise ValueError('missing/oversized description')
        names.append(name)
        for key in ('disable-model-invocation', 'user-invocable'):
            if key in meta and not isinstance(meta[key], bool):
                raise ValueError(f'{key} must be boolean')
        policy_path = entry.parent / 'agents/openai.yaml'
        if policy_path.exists():
            policy = yaml.safe_load(policy_path.read_text(encoding='utf-8'))
            if not isinstance(policy, dict):
                raise ValueError('agents/openai.yaml must be a mapping')
            section = policy.get('policy', {})
            if not isinstance(section, dict):
                raise ValueError('agents/openai.yaml policy must be a mapping')
            implicit = section.get('allow_implicit_invocation', True)
            if not isinstance(implicit, bool):
                raise ValueError('allow_implicit_invocation must be boolean')
            if meta.get('disable-model-invocation') is True and implicit is not False:
                raise ValueError('manual-only Claude skill needs matching Codex policy')
        elif meta.get('disable-model-invocation') is True:
            raise ValueError('missing Codex manual invocation policy')
    except Exception as e:  # noqa: BLE001 - every failure becomes one error line for this skill
        errors.append(f'{rel_of(entry)}: {e}')
if len(set(names)) != len(names):
    errors.append('duplicate skill names')

# Size ratchet: a manifest skill's SKILL.md stays within SIZE_BUDGET bytes. A file on the allowlist may stay
# over budget only while it never grows. Once it is within budget its entry must go; when it shrinks, lower it.
SIZE_BUDGET = 20_000
SIZE_ALLOWLIST = {
    'skills/core/offload/SKILL.md': 21_967,
    'skills/core/pr-review/SKILL.md': 23_954,
}
skill_files = [rel_of(ROOT / path / 'SKILL.md') for path in paths]
for rel in SIZE_ALLOWLIST:
    if rel not in skill_files:
        errors.append(f'{rel}: allowlist entry is not a manifest skill')
for rel in skill_files:
    if not (ROOT / rel).is_file():
        continue
    size = (ROOT / rel).stat().st_size
    recorded = SIZE_ALLOWLIST.get(rel)
    if recorded is None:
        if size > SIZE_BUDGET:
            errors.append(f'{rel}: {size} bytes exceeds the {SIZE_BUDGET}-byte budget')
    elif size <= SIZE_BUDGET:
        errors.append(f'{rel}: {size} bytes is within the {SIZE_BUDGET}-byte budget; remove from allowlist')
    elif size > recorded:
        errors.append(f'{rel}: grew to {size} bytes; allowlisted at {recorded}')
    elif size < recorded:
        notes.append(f'note: {rel} shrank to {size} bytes; lower its allowlist entry from {recorded}')

# Check links in entrypoints and transitively linked local references, not examples.
CODE_FENCE = re.compile(r'^```[^\n]*\n.*?^```\s*$', re.S | re.M)
LINK = re.compile(r'\[[^\]]*\]\(([^)]+)\)')
EXTERNAL = re.compile(r'(?:https?:|mailto:|#)')
pending = [clean(ROOT / path / 'SKILL.md') for path in paths]
seen: set[str] = set()
while pending:
    path = pending.pop(0)
    if str(path) in seen or not path.is_file():
        continue
    seen.add(str(path))
    text = CODE_FENCE.sub('', path.read_text(encoding='utf-8'))
    for link in LINK.findall(text):
        if EXTERNAL.match(link):
            continue
        target = link.split('#', 1)[0]
        if not target or '<' in target:
            continue
        resolved = clean(path.parent / target)
        if not resolved.exists():
            errors.append(f'{rel_of(path)}: broken link {link}')
        elif resolved.suffix == '.md' and str(resolved).startswith(str(ROOT) + '/'):
            pending.append(resolved)

# Frozen phrases: tokens that hooks, other skills and humans match on verbatim.
# A reword in one copy must fail here until every copy and its consumers follow.
INVARIANTS = {
    'skills/gstack/review/SKILL.md': ['Pre-Landing Review: N issues', '**SAFE TO LAND:**', '**LAND WITH CAUTION:**', '**DO NOT LAND:**', 'never infer commit, push, merge or PR permission', 'Gate Integrity'],
    'skills/gstack/review/checklist.md': ['#### Gate Integrity', '## Sideways sweep', '## Suppressions', 'record which load you assumed', 'A redundant or padded test'],
    'commands/pre-push.md': ['Gate Integrity'],
    'skills/core/do/references/briefs.md': ['SAFE TO LAND, LAND WITH CAUTION, or DO NOT LAND', '](../../offload/builder-template.md)', 'acceptance criteria, spec-review output'],
    'skills/core/offload/builder-template.md': ['Acceptance:', 'Gates:', 'Result file:', 'Do not grade your own work', 'RED chronology', 'Build the smallest change that fully works', 'never cut validation at trust boundaries', 'Not checked', 'Frozen criteria outrank spec prose', 'Complete the authorized delivery steps before you report', 'Settle a genuinely ambiguous design question with `council`', 'Implement only within the owned files', 'must fail when the behavior it names breaks', 'A test is redundant when an existing test already fails for the same break', 'Add no production export, flag, wrapper or hook that only tests use', 'name the assumption both relied on', 'by its ID exactly as frozen (C5, C5a)', 'it refuses unless Gate results has one line for every frozen criterion ID', 'On an `incomplete:` refusal, add the missing lines and run `ready` again. Do not run `blocked`, use `--steal` or run `status`.', 'Without `$OFFLOAD_HANDOFF` (a Local-tier subagent), write the same Returns to the result file'],
}
for rel, phrases in INVARIANTS.items():
    try:
        text = (ROOT / rel).read_text(encoding='utf-8')
        for phrase in phrases:
            if phrase not in text:
                errors.append(f'{rel}: frozen phrase missing: {json.dumps(phrase, ensure_ascii=False)}')
    except Exception as e:  # noqa: BLE001
        errors.append(f'{rel}: {e}')

# The dispatcher and the replay renderer read the brief by label from the one ```text fence, so the three
# labels must start a line inside it. A substring pin above would stay green if the template mentioned a
# label elsewhere.
template = 'skills/core/offload/builder-template.md'
try:
    fences = re.findall(r'^```text[ \t]*\r?\n(.*?)^```', (ROOT / template).read_text(encoding='utf-8'), re.S | re.M)
    if len(fences) != 1:
        errors.append(f'{template}: expected exactly one ```text fence, found {len(fences)}')
    else:
        for label in ('Acceptance:', 'Gates:', 'Result file:'):
            if not re.search('^' + re.escape(label), fences[0], re.M):
                errors.append(f'{template}: ```text fence has no line starting with {json.dumps(label)}')
except Exception as e:  # noqa: BLE001
    errors.append(f'{template}: {e}')


# The README is the inventory people read, so it must name what the repo ships and nothing else.
def section(text: str, heading: str, level: str) -> str:
    found = re.search(rf'^{level} {re.escape(heading)}\n(.*?)(?=^{level} |\Z)', text, re.S | re.M)
    return found.group(1) if found else ''


def table(text: str, heading: str) -> list[str]:
    return re.findall(r'^\| *(?:\[)?(?:\*\*|`)?/?([a-z0-9][a-z0-9-]*)(?:\*\*|`)?', section(text, heading, '##+'), re.M)


try:
    readme = (ROOT / 'README.md').read_text(encoding='utf-8')
    for name in names:
        if not re.search(rf'^\| \*\*{re.escape(name)}\*\*', readme, re.M):
            errors.append(f'README.md: skill {name} has no `| **{name}**` row')
    skills_doc = (ROOT / 'docs/skills.md').read_text(encoding='utf-8')
    for folder, heading in (('commands', 'Commands'), ('agents', 'Agents')):
        on_disk = sorted(Path(f).stem for f in glob.glob('*.md', root_dir=ROOT / folder))
        listed = table(readme, heading)
        for n in on_disk:
            if n not in listed:
                errors.append(f'README.md: {folder}/{n}.md is not in the {heading} table')
        for n in listed:
            if n not in on_disk:
                errors.append(f'README.md: the {heading} table lists {n}, and {folder}/{n}.md does not exist')
        for n in table(skills_doc, heading):
            if n not in on_disk:
                errors.append(f'docs/skills.md: the {heading} table lists {n}, and {folder}/{n}.md does not exist')
    events = json.loads((ROOT / 'hooks/hooks.json').read_text(encoding='utf-8'))['hooks'].keys()
    hooks_text = section(readme, 'Hooks', '##')
    for event in events:
        if f'`{event}`' not in hooks_text:
            errors.append(f'README.md: the Hooks section does not name the {event} event')
except Exception as e:  # noqa: BLE001
    errors.append(f'inventory check: {e}')

# Git spawn ratchet: a user's ~/.gitconfig (diff.context, status.showUntrackedFiles) can change what a git
# child prints, so non-test code spawns git with GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM set, or with a
# pinned env constant (GIT_ENV, GITENV), on the same line. scripts/git-spawn-baseline.txt holds today's
# unpinned count per file; a file may never go above it. At zero the entry must go; when it drops, lower it.
SPAWN_CALL = re.compile(r'\b(?:spawn|spawnSync|execFileSync|execSync)\(\s*[\'"`]git\b')
PINNED_ENV = re.compile(r'\bGIT_ENV\b|\bGITENV\b')
TEST_FILE = re.compile(r'test_|.*\.test\.')
baseline_rel = 'scripts/git-spawn-baseline.txt'
try:
    baseline: dict[str, int] = {}
    for n, line in lines_of((ROOT / baseline_rel).read_text(encoding='utf-8')):
        if not line.strip() or line.startswith('#'):
            continue
        fields = line.split()
        count = fields[1] if len(fields) > 1 else ''
        if re.fullmatch(r'[0-9]+', count):
            baseline[fields[0]] = int(count)
        else:
            errors.append(f'{baseline_rel}:{n}: expected `<path> <count>`')
    sources = set()
    for top in ('skills', 'hooks', 'scripts'):
        for ext in ('mjs', 'js', 'cjs', 'ts'):
            sources.update(glob.glob(f'{top}/**/*.{ext}', root_dir=ROOT, recursive=True))
    offenders: dict[str, list[int]] = {}
    for rel in sorted(sources):
        if 'node_modules' in rel.split('/') or TEST_FILE.match(os.path.basename(rel)):
            continue
        for n, line in lines_of(read_text(ROOT / rel)):
            pinned = PINNED_ENV.search(line) or ('GIT_CONFIG_GLOBAL' in line and 'GIT_CONFIG_NOSYSTEM' in line)
            if SPAWN_CALL.search(line) and not pinned:
                offenders.setdefault(rel, []).append(n)
    for rel, found in offenders.items():
        allowed = baseline.get(rel, 0)
        if len(found) > allowed:
            for n in found:
                errors.append(f'{rel}:{n}: git spawn does not pin GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM ({len(found)} in file, baseline {allowed})')
    for rel, allowed in baseline.items():
        found = len(offenders.get(rel, []))
        if found == 0:
            errors.append(f'{baseline_rel}: {rel} has no unpinned git spawn; remove its entry')
        elif found < allowed:
            notes.append(f'note: {rel} has {found} unpinned git spawns; lower its {baseline_rel} entry from {allowed}')
except Exception as e:  # noqa: BLE001
    errors.append(f'git spawn check: {e}')

# A public repo must not carry one person's home path. Placeholder users are fine.
PLACEHOLDER_USERS = {'me', 'you', 'someone', 'user', 'name', 'example', 't'}
TEXT_EXT = {'.md', '.mjs', '.js', '.ts', '.tsx', '.py', '.sh', '.json', '.yaml', '.yml', '.toml'}
SKIP_DIRS = {'.git', '.claude', '.lavish', '.opencode', 'node_modules', '__pycache__', 'graphify-out', '.codegraph'}
HOME_PATH = re.compile(r'(?:/Users|/home)/([A-Za-z0-9._-]+)(?=/)')
for folder, dirs, files in os.walk(ROOT):
    dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
    for file in sorted(files):
        path = Path(folder) / file
        rel = rel_of(path)
        if file in SKIP_DIRS or rel.startswith('docs/superpowers/') or path.is_symlink():
            continue
        if os.path.splitext(file)[1] not in TEXT_EXT and rel not in ('AGENTS.md', 'README.md'):
            continue
        for n, line in lines_of(read_text(path)):
            for user in HOME_PATH.findall(line):
                if user not in PLACEHOLDER_USERS:
                    errors.append(f'{rel}:{n}: personal path /…/{user}/ (use ~ or a placeholder such as /Users/me)')

if errors:
    print('\n'.join(errors), file=sys.stderr)
    sys.exit(1)
for note in notes:
    print(note)
print(f'PASS: {len(paths)} skills, YAML policies, manifests, {len(seen)} linked Markdown files and '
      f'{sum(len(p) for p in INVARIANTS.values())} frozen phrases')
