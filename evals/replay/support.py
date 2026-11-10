"""Shared helpers for the replay tests. Not a test module."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RUNNER = HERE / 'run_replay.py'
BUILDER = HERE / 'build_cases.py'
BASE_REF = '94bdb26'
TEMPLATE_PATH = 'skills/core/offload/builder-template.md'
sys.path.insert(0, str(HERE))

# Every CLI call gets its own handoffs dir so no test can touch the user's real store.
_SCRATCH_STORE = tempfile.mkdtemp(prefix='replay-test-store-')


def run_cli(script, args, env=None, cwd=None, timeout=180):
    full = os.environ.copy()
    full['AGENT_HANDOFFS_DIR'] = _SCRATCH_STORE
    for key, value in (env or {}).items():
        if value is None:
            full.pop(key, None)
        else:
            full[key] = value
    return subprocess.run([sys.executable, str(script), *map(str, args)], capture_output=True, text=True,
                          env=full, cwd=str(cwd or ROOT), timeout=timeout)


def std_args(fx, out, trials=1, extra=()):
    """The usual fake run: current = 94bdb26 in this repo, revised = the fixture skills repo."""
    return ['--cases', fx.cases_dir, '--output', out, '--current-ref', BASE_REF, '--revised-ref', 'HEAD',
            '--revised-skills-repo', fx.skills_repo, '--fake', '--trials', str(trials), *extra]


def replay(fx, out, trials=1, extra=(), env=None, cwd=None):
    return run_cli(RUNNER, std_args(fx, out, trials, extra), env=env, cwd=cwd)


def git(repo, *args):
    import caselib
    return caselib.git(repo, *args)


def load(path):
    return json.loads(Path(path).read_text())


def case_record(out, case_id='synthetic'):
    return load(Path(out) / 'cases' / f'{case_id}.json')


def trial_dir(out, arm, trial=1, case_id='synthetic'):
    import caselib
    return Path(out) / 'trials' / caselib.trial_token(case_id, arm, trial)


def write_stub(path, body):
    """An executable adapter stub. Path may hold spaces; it is exec'd directly."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('#!/usr/bin/env python3\nimport json, os, sys\n' + body)
    path.chmod(0o755)
    return path


# Writes a marker holding whatever the runner had printed to stdout by now.
MARK = '''
marker = os.environ['STUB_MARKER']
seen = ''
if os.environ.get('STUB_STDOUT_FILE'):
    seen = open(os.environ['STUB_STDOUT_FILE']).read()
open(marker, 'a').write('called\\n' + seen)
sys.stdin.read()
'''

def store_snapshot(store):
    """Recursive (relative path, size, sha256, mtime) of every replay* entry directly under the store."""
    import hashlib
    found = {}
    store = Path(store)
    if not store.exists():
        return found
    for top in store.iterdir():
        if not top.name.startswith('replay'):
            continue
        for path in [top, *top.rglob('*')]:
            st = path.stat()
            digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else ''
            found[str(path.relative_to(store))] = (st.st_size, digest, st.st_mtime_ns)
    return found


STUB_BUILDER = MARK + 'print(json.dumps({"status": "ok"}))\n'
STUB_GRADER = MARK + 'print(json.dumps({"grades": {}}))\n'
