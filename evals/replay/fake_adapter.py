#!/usr/bin/env python3
"""Deterministic fake builder and grader for the replay runner. No model calls.

Speaks the adapter protocol: one JSON object on stdin, one JSON object on stdout, no shell.
Usage: fake_adapter.py builder|grader
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caselib  # noqa: E402

SENTINEL_COMMIT = 'SENTINEL-COMMIT-MESSAGE-7f3a'
SENTINEL_SUMMARY = 'SENTINEL-WORK-SUMMARY-9c1d'
ADDED_LINE = 'FAKE-BUILDER-ADDED-LINE'


def git(cwd, *args):
    env = dict(os.environ, GIT_NO_LAZY_FETCH='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
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
    if mode == 'inspect':
        live = os.environ['FAKE_LIVE_PATH']
        needles = [live.encode(), os.path.realpath(live).encode()]
        hits = [str(p) for p in Path(worktree, '.git').rglob('*') if p.is_file() and not p.is_symlink()
                and any(n in p.read_bytes() for n in needles)]
        record = json.loads((trial / 'builder-record.json').read_text())
        post = os.environ.get('FAKE_POST_BASE', '')
        probe = subprocess.run(['git', '-C', worktree, 'cat-file', '-e', post + '^{commit}'], capture_output=True) if post else None
        links = [p.stat().st_nlink for p in Path(worktree, '.git', 'objects').rglob('*') if p.is_file()]
        record.update(live_path_hits=hits, remotes=git(worktree, 'remote').split(),
                      dot_git_is_file=Path(worktree, '.git').is_file(),
                      refs=git(worktree, 'for-each-ref', '--format=%(refname)').split(),
                      has_post_base=bool(probe is not None and probe.returncode == 0), max_nlink=max(links or [1]))
        (trial / 'builder-record.json').write_text(json.dumps(record))
    (trial / 'started').write_text('started\n')
    if mode == 'fail':
        sys.exit(3)
    if mode == 'garbage':
        print('this is not json')
        return None
    if mode == 'sleep':
        time.sleep(120)
    (Path(worktree) / 'fake-builder.txt').write_text(ADDED_LINE + '\n')
    if mode != 'no-commit':
        git(worktree, 'add', 'fake-builder.txt')
        git(worktree, 'commit', '-q', '-m', f'fake change {SENTINEL_COMMIT}')
    if mode == 'readonly':
        for base, dirs, files in os.walk(worktree):  # leave the clone without write permission, files and directories
            for name in dirs + [base]:
                os.chmod(base if name == base else os.path.join(base, name), 0o555)
    if mode == 'dirty':
        (Path(worktree) / 'left-over.txt').write_text('uncommitted\n')
    if mode == 'plant':
        # A builder controls the trial repo's config and attributes: plant a diff program, a textconv and color.
        ext = os.environ['FAKE_PLANT_EXTERNAL']
        Path(worktree, '.gitattributes').write_text('*.txt diff=evil\n')
        with open(Path(worktree, '.git', 'config'), 'a') as handle:
            handle.write(f'[diff]\n\texternal = {ext}\n\tnoprefix = true\n[diff "evil"]\n\ttextconv = {ext}\n[color]\n\tdiff = always\n')
        git(worktree, 'add', '.gitattributes')
        git(worktree, 'commit', '-q', '-m', 'attributes')
    if mode == 'filter-readonly':
        # Plant a clean filter, make a tracked file dirty so `git status` must run it, then lock the git dir.
        Path(worktree, '.gitattributes').write_text('*.txt filter=x\n')
        Path(worktree, 'x.txt').write_text('one\n')
        git(worktree, 'add', '.gitattributes', 'x.txt')
        git(worktree, 'commit', '-q', '-m', 'filter fixture')
        with open(Path(worktree, '.git', 'config'), 'a') as handle:
            handle.write(f'[filter "x"]\n\tclean = {os.environ["FAKE_FILTER_SCRIPT"]}\n')
        Path(worktree, 'x.txt').write_text('two changed\n')
        os.chmod(Path(worktree, '.git'), 0o555)
    if mode == 'commondir':
        # Plant a second git dir with its own config, then point `.git/commondir` at it last (the builder's own git
        # calls would break after that). A clean filter in that config must never run under the runner's git calls.
        Path(worktree, '.gitattributes').write_text('*.txt filter=x\n')
        Path(worktree, 'x.txt').write_text('one\n')
        git(worktree, 'add', '.gitattributes', 'x.txt')
        git(worktree, 'commit', '-q', '-m', 'filter fixture')
        dot, evil = Path(worktree, '.git'), Path(worktree, '.git', 'evilcommon')
        shutil.copytree(dot, evil, ignore=shutil.ignore_patterns('evilcommon'))
        with open(evil / 'config', 'a') as handle:
            handle.write(f'[filter "x"]\n\tclean = {os.environ["FAKE_FILTER_SCRIPT"]}\n')
        Path(worktree, 'x.txt').write_text('two changed\n')
        os.utime(Path(worktree, 'x.txt'), (1000000000, 1000000000))
        (dot / 'commondir').write_text('evilcommon\n')
    if mode == 'gitdir-file':
        Path(worktree, '.git', 'gitdir').write_text(worktree + '/.git\n')
    victim = os.environ.get('FAKE_VICTIM')
    if mode == 'symlink-config':  # the runner restores this file after the builder; a symlink must not be followed
        Path(worktree, '.git', 'config').rename(Path(worktree, '.git', 'config.orig'))
        os.symlink(victim, Path(worktree, '.git', 'config'))
    if mode == 'symlink-reply':
        os.symlink(victim, trial / 'builder-reply.json')
    if mode == 'symlink-grader-reply':
        os.symlink(victim, trial / 'grader-reply.json')
    if mode == 'symlink-git':
        Path(worktree, '.git').rename(Path(worktree, '.git-real'))
        os.symlink(victim, Path(worktree, '.git'))
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
