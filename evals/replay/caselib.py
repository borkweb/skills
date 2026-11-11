"""Case format, criterion-ID parsing and git helpers shared by the replay scripts."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

import procs

REQUIRED = ('id', 'repo', 'base_commit', 'goal', 'owned_files', 'criteria', 'gates_text', 'gate_commands',
            'missed_ids', 'provenance')
# A line's first token is an ID: optional list marker, table pipe, ** or backticks, then C<n>[.<n>][a-z] and a
# terminator. `C3, C5b:`, `C1/C2:` and `C1 and C2:` lead with no single ID and count for none.
ID_LINE = re.compile(r'^\s*(?:[-*]\s+|\d+\.\s+|\|\s*)?(?:\*\*|`)*(C\d+(?:\.\d+)?[a-z]?)(?:[:.)*`|]|\s|$)')
MULTI = re.compile(r'^\s*(?:[-*]\s+|\d+\.\s+|\|\s*)?(?:\*\*|`)*C\d+(?:\.\d+)?[a-z]?[:.)*`|]*\s+and\s+C\d')
FULL_SHA = re.compile(r'^[0-9a-f]{40}$|^[0-9a-f]{64}$')
SAFE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')


class CaseError(ValueError):
    pass


def line_id(line):
    """The single criterion ID that leads `line`, else None."""
    match = ID_LINE.match(line)
    return match.group(1) if match and not MULTI.match(line) else None


def criteria_ids(text):
    return [i for i in map(line_id, text.splitlines()) if i]


# Everything the runner starts (gates, setup, adapters, its own git calls) gets an environment built only from these
# names, LC_*, and names the user passes with --gate-env. Nothing else is inherited: no tokens, sockets or session IDs.
ENV_PASS = ('PATH', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR', 'HTTP_PROXY',
            'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
            'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE')


def scrubbed_env(extra_names=()):
    return {k: v for k, v in os.environ.items() if k in ENV_PASS or k.startswith('LC_') or k in extra_names}


def git_env():
    env = scrubbed_env()
    env.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0',
               GIT_NO_LAZY_FETCH='1', GIT_LFS_SKIP_SMUDGE='1', GIT_AUTHOR_NAME='replay', GIT_AUTHOR_EMAIL='replay@example.invalid',
               GIT_COMMITTER_NAME='replay', GIT_COMMITTER_EMAIL='replay@example.invalid')
    return env


def git(repo, *args, check=True, timeout=120, env_extra=None):
    """Run git in `repo` with the user's config out of the way; return stripped stdout."""
    # The case repo's own hooks (post-checkout, husky, LFS) and fsmonitor are commands the case never listed.
    run = procs.run_group(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(repo), *args],
                          env={**git_env(), **(env_extra or {})}, timeout=timeout)
    if check and run.returncode != 0:
        raise RuntimeError(f'git {" ".join(args)} failed: {run.stderr.strip()}')
    return run.stdout.strip() if check else run


def trial_token(case_id, arm, trial):
    """An opaque, deterministic name for one trial. The builder and grader see this, never the case id or arm."""
    return 't' + hashlib.sha256(f'{case_id}|{arm}|{trial}'.encode()).hexdigest()[:12]


def private_dir(path, must_be_new=False):
    """Create `path` mode 700 outside any git work tree. Raise ValueError (inside a work tree) or
    FileExistsError (must_be_new and it exists)."""
    path = Path(path)
    if must_be_new and path.exists():
        raise FileExistsError(str(path))
    probe = path
    while not probe.exists():
        probe = probe.parent
    if git(probe, 'rev-parse', '--is-inside-work-tree', check=False).stdout.strip() == 'true':
        raise ValueError(f'{path} is inside a git work tree, so private case content could reach a repo')
    path.mkdir(mode=0o700, parents=True, exist_ok=not must_be_new)
    path.chmod(0o700)
    return path


def is_git_repo(path):
    return Path(path).is_dir() and git(path, 'rev-parse', '--git-dir', check=False).returncode == 0


def validate_case(case, source='case'):
    """Raise CaseError naming the first problem. Returns the case."""
    if not isinstance(case, dict):
        raise CaseError(f'{source}: a case is a JSON object')
    for field in REQUIRED:
        if field not in case:
            raise CaseError(f'{source}: missing required field {field}')

    def need(field, kind, what):
        if not isinstance(case[field], kind):
            raise CaseError(f'{source}: field {field} must be {what}')

    for field in ('id', 'base_commit', 'goal', 'owned_files', 'criteria', 'gates_text', 'provenance'):
        need(field, str, 'a string')
    if not SAFE_ID.match(case['id']):
        raise CaseError(f'{source}: field id must match [A-Za-z0-9._-]+')
    if not FULL_SHA.match(case['base_commit']):
        raise CaseError(f'{source}: field base_commit must be a full hex object ID, not a ref name')
    for field in ('goal', 'owned_files'):
        if not case[field].strip() or '\n' in case[field]:
            raise CaseError(f'{source}: field {field} must be one non-empty line')
    for field in ('gate_commands', 'missed_ids', 'setup_commands'):
        value = case.get(field, [])
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise CaseError(f'{source}: field {field} must be a list of strings')
    repo = case['repo']
    if not isinstance(repo, dict) or not isinstance(repo.get('identity'), str) or not isinstance(repo.get('path'), str):
        raise CaseError(f'{source}: field repo needs string identity and path')
    if not is_git_repo(repo['path']):
        raise CaseError(f'{source}: field repo.path is not an existing git repo: {repo["path"]}')
    ids = criteria_ids(case['criteria'])
    if not ids:
        raise CaseError(f'{source}: field criteria holds no criterion ID')
    if not case['missed_ids']:
        raise CaseError(f'{source}: field missed_ids is empty')
    for missed in case['missed_ids']:
        if missed not in ids:
            raise CaseError(f'{source}: missed ID {missed} does not lead any line of criteria')
    for command in case['gate_commands']:
        if command not in case['gates_text']:
            raise CaseError(f'{source}: field gate_commands holds a command missing from gates_text: {command}')
    candidates = case.get('gate_command_candidates', [])
    if (case['gate_commands'] or candidates) and case.get('gate_commands_reviewed') is not True:
        raise CaseError(f'{source}: gate_commands will run in a trial clone, and candidates are only proposals; read '
                        'them, copy the ones you trust into gate_commands, then set gate_commands_reviewed to true')
    for field in ('goal', 'owned_files'):
        for missed in case['missed_ids']:
            if re.search(rf'(?<![A-Za-z0-9]){re.escape(missed)}(?![A-Za-z0-9])', case[field]):
                raise CaseError(f'{source}: field {field} names the missed ID {missed}, which would reach the builder')
    return case


def load_cases(path):
    """Cases from one JSON file or every *.json in a directory, validated."""
    path = Path(path)
    files = sorted(path.glob('*.json')) if path.is_dir() else [path]
    if not files:
        raise CaseError(f'{path}: no case files')
    cases = []
    for file in files:
        try:
            data = json.loads(file.read_text())
        except (OSError, ValueError) as error:
            raise CaseError(f'{file.name}: unreadable case: {error}')
        cases.append(validate_case(data, file.name))
    ids = [c['id'] for c in cases]
    if len(ids) != len(set(ids)):
        raise CaseError(f'{path}: duplicate case id')
    return cases


def store_dir():
    return Path(os.environ.get('AGENT_HANDOFFS_DIR') or Path.home() / '.agent-handoffs')
