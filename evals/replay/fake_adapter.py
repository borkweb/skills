#!/usr/bin/env python3
"""Deterministic fake builder and grader for the replay runner. No model calls.

Speaks the adapter protocol: one JSON object on stdin, one JSON object on stdout, no shell.
Usage: fake_adapter.py builder|grader
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caselib  # noqa: E402

SENTINEL_COMMIT = 'SENTINEL-COMMIT-MESSAGE-7f3a'
SENTINEL_SUMMARY = 'SENTINEL-WORK-SUMMARY-9c1d'
ADDED_LINE = 'FAKE-BUILDER-ADDED-LINE'


def git(cwd, *args):
    env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
               GIT_AUTHOR_NAME='fake', GIT_AUTHOR_EMAIL='fake@example.invalid',
               GIT_COMMITTER_NAME='fake', GIT_COMMITTER_EMAIL='fake@example.invalid')
    return subprocess.run(['git', '-C', cwd, *args], capture_output=True, text=True, env=env, check=True).stdout.strip()


def builder(request):
    mode = request.get('fake', {}).get('mode', 'commit')
    worktree = request['worktree']
    trial = Path(request['trial_dir'])
    (trial / 'builder-record.json').write_text(json.dumps({
        'head_at_start': git(worktree, 'rev-parse', 'HEAD'), 'cwd': worktree, 'branch': request['branch'],
        'mode': mode}))
    (trial / 'started').write_text('started\n')
    if mode == 'fail':
        sys.exit(3)
    if mode == 'garbage':
        print('this is not json')
        return None
    if mode == 'sleep':
        time.sleep(120)
    (Path(worktree) / 'fake-builder.txt').write_text(ADDED_LINE + '\n')
    if mode == 'lock':
        git(worktree, 'worktree', 'lock', worktree)  # a real builder may do this; cleanup must still win
    if mode != 'no-commit':
        git(worktree, 'add', 'fake-builder.txt')
        git(worktree, 'commit', '-q', '-m', f'fake change {SENTINEL_COMMIT}')
    if mode == 'dirty':
        (Path(worktree) / 'left-over.txt').write_text('uncommitted\n')
    # A work summary and gate results live in the result file and handoff, outside the worktree.
    for name in ('result_file', 'handoff_file'):
        Path(request[name]).write_text(f'## Gate results\n{SENTINEL_SUMMARY}\n\n## Work summary\n{SENTINEL_SUMMARY}\n')
    return {'status': 'ok'}


def grade(seed, ident, criterion):
    digest = hashlib.sha256(f'{seed}:{ident}:{criterion}'.encode()).digest()
    return 'NOT MET' if digest[0] < 128 else 'MET'


def grader(request, raw):
    capture = os.environ.get('REPLAY_FAKE_GRADER_CAPTURE')
    if capture:
        Path(capture).write_text(raw)
    # Only an opaque token and the runner's pre-resolved table entry reach here: no case id, no arm.
    key = os.environ.get('REPLAY_FAKE_GRADER_TOKEN', request['id'])
    entry = json.loads(os.environ['REPLAY_FAKE_GRADER_ENTRY']) if 'REPLAY_FAKE_GRADER_ENTRY' in os.environ else None
    if entry == 'exit1':
        sys.exit(1)
    ids = caselib.criteria_ids(request['criteria'])
    if entry == 'ungraded':
        return {'grades': {i: 'maybe' for i in ids}}
    grades = {}
    seed = os.environ.get('REPLAY_FAKE_GRADER_SEED', '0')
    for i in ids:
        grades[i] = (entry or {}).get(i) or grade(seed, key, i)
    return {'grades': grades}


def main():
    role = sys.argv[1]
    raw = sys.stdin.read()
    request = json.loads(raw)
    result = builder(request) if role == 'builder' else grader(request, raw)
    if result is not None:
        print(json.dumps(result))


if __name__ == '__main__':
    main()
