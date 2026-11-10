#!/usr/bin/env python3
"""Replay a missed-criterion case against two skill revisions, using fake adapters only unless --spend is given.

For each case, trial and arm (current, revised) it makes a throwaway worktree at the case's base commit, renders the
arm's builder-template.md into a brief, calls a builder adapter, runs the case's gate commands in that worktree,
and asks a grader adapter to grade the sealed input. Adapters are exec'd directly (no shell) with JSON on stdin and
stdout, as in evals/run.py. Results are never overwritten.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caselib  # noqa: E402
import render  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TEMPLATE_PATH = 'skills/core/offload/builder-template.md'
FAKE = [sys.executable, str(HERE / 'fake_adapter.py')]
NOT_GRADED = ('skipped', 'error', 'ungraded', 'env-unavailable')
OUTPUT_CAP = 20000


class Refusal(Exception):
    """A usage or safety refusal: print, exit 2, touch nothing."""


class AdapterError(Exception):
    pass


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--cases', help='a case file or a directory of them (default: <store>/replay-cases)')
    p.add_argument('--output', help='new directory for summary.json, cases/ and trials/; never overwritten')
    p.add_argument('--trials', type=int, default=1)
    p.add_argument('--timeout', type=float, default=600, help='seconds for each adapter, setup and gate command')
    p.add_argument('--skills-repo', default=str(ROOT), help='repo holding the current arm template')
    p.add_argument('--current-ref')
    p.add_argument('--revised-ref')
    p.add_argument('--revised-skills-repo', help='repo holding the revised arm template (default: --skills-repo)')
    p.add_argument('--check', action='store_true', help='parse the cases and exit')
    p.add_argument('--demo', metavar='DIR', help='build the synthetic fixture under DIR (must not exist) and replay it')
    p.add_argument('--fake', action='store_true', help='both adapters are the built-in fakes')
    p.add_argument('--fake-builder', action='store_true')
    p.add_argument('--fake-grader', action='store_true')
    p.add_argument('--builder-adapter', help='executable that is not the built-in fake; needs --spend')
    p.add_argument('--grader-adapter', help='executable that is not the built-in fake; needs --spend')
    p.add_argument('--spend', action='store_true', help='allow adapters that are not the built-in fakes')
    p.add_argument('--seed', default='0', help='fake grader seed')
    p.add_argument('--fake-grades', help='JSON {"<case>/<arm>/<trial>": {"C1": "MET"} | "ungraded" | "exit1"}')
    p.add_argument('--fake-builder-mode', default='commit', choices=['commit', 'fail', 'no-commit', 'sleep', 'garbage'])
    p.add_argument('--inject-fault', choices=['after-worktree'], help='raise in the runner (for cleanup tests)')
    return p.parse_args(argv)


def resolve_adapters(args):
    roles = {}
    for role in ('builder', 'grader'):
        fake = args.fake or getattr(args, f'fake_{role}')
        external = getattr(args, f'{role}_adapter')
        if bool(fake) == bool(external):
            raise Refusal(f'choose exactly one {role}: --fake{"" if args.fake else "-" + role} or --{role}-adapter')
        roles[role] = (FAKE + [role], True) if fake else ([external], False)
    return roles


def arm_template(arm, repo, ref):
    if not ref:
        raise Refusal(f'--{arm}-ref is required')
    try:
        sha = caselib.git(repo, 'rev-parse', '--verify', ref + '^{commit}')
        text = caselib.git(repo, 'show', f'{sha}:{TEMPLATE_PATH}')
    except RuntimeError as error:
        raise Refusal(f'{arm} arm: cannot read the template at {ref} in {repo}: {error}')
    try:
        render.validate(text)
    except render.TemplateError as error:
        raise Refusal(f'{arm} arm template refused: {error}')
    return {'name': arm, 'repo': str(repo), 'ref': ref, 'sha': sha, 'template': text}


def call_adapter(command, request, env, cwd, timeout):
    try:
        run = subprocess.run(command, input=json.dumps(request), capture_output=True, text=True, env=env, cwd=cwd,
                             timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AdapterError(f'adapter timeout after {timeout:g}s')
    except OSError as error:
        raise AdapterError(f'adapter could not start: {error}')
    if run.returncode != 0:
        raise AdapterError(f'adapter exit {run.returncode}: {run.stderr.strip()[-300:]}')
    try:
        response = json.loads(run.stdout)
    except ValueError:
        raise AdapterError('adapter output is not JSON')
    if not isinstance(response, dict):
        raise AdapterError('adapter output is not a JSON object')
    return response


def run_shell(command, cwd, timeout):
    """A gate or setup command line, run in `cwd`. These are case text, not adapters, so they go through sh."""
    try:
        run = subprocess.run(['/bin/sh', '-c', command], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {'command': command, 'exit_code': None, 'output': '', 'timeout': True}
    return {'command': command, 'exit_code': run.returncode, 'output': run.stdout[-OUTPUT_CAP:], 'timeout': False}


def names_live_path(command, repo):
    return any(p in command for p in {str(repo), os.path.realpath(repo)})


def case_skip_reason(case):
    repo = case['repo']['path']
    probe = caselib.git(repo, 'cat-file', '-e', case['base_commit'] + '^{commit}', check=False)
    if probe.returncode != 0:
        return 'base commit is not in the repo (never fetched)'
    for command in case['gate_commands'] + case.get('setup_commands', []):
        if names_live_path(command, repo):
            return f'command references the live repo path: {command}'
    return None


def worktree_gone(repo, worktree, branch, scratch):
    caselib.git(repo, 'worktree', 'remove', '--force', str(worktree), check=False)
    caselib.git(repo, 'worktree', 'prune', check=False)
    caselib.git(repo, 'branch', '-D', branch, check=False)  # only this trial's own, uniquely named branch
    shutil.rmtree(scratch, ignore_errors=True)


def run_trial(case, arm, trial, ctx):
    args = ctx['args']
    key = f"{case['id']}/{arm['name']}/{trial}"
    record = {'case': case['id'], 'arm': arm['name'], 'skills_ref': arm['ref'], 'skills_sha': arm['sha'],
              'trial': trial, 'base_commit': case['base_commit'], 'outcome': None, 'reason': None, 'gates': [],
              'grades': {}, 'named_miss': None}
    trial_dir = ctx['out'] / 'trials' / case['id'] / f"{arm['name']}-{trial}"
    (trial_dir / 'handoffs').mkdir(parents=True)
    result_file, handoff_file = trial_dir / 'result.md', trial_dir / 'handoff.md'
    result_file.write_text('')
    handoff_file.write_text('')
    repo = case['repo']['path']
    scratch = Path(tempfile.mkdtemp(prefix='replay-wt-'))
    worktree = Path(os.path.realpath(scratch)) / 'wt'
    branch = f"replay/{case['id']}-{arm['name']}-{trial}-{uuid.uuid4().hex[:8]}"
    made = False
    try:
        added = caselib.git(repo, 'worktree', 'add', '-q', '-b', branch, str(worktree), case['base_commit'], check=False)
        if added.returncode != 0:
            record.update(outcome='error', reason=f'worktree add failed: {added.stderr.strip()}')
            return record
        made = True
        if args.inject_fault == 'after-worktree':
            raise RuntimeError('injected fault after the worktree was created')
        for command in case.get('setup_commands', []):
            step = run_shell(command, worktree, args.timeout)
            if step['timeout'] or step['exit_code'] != 0:
                record.update(outcome='env-unavailable', reason=f'setup failed: {command}')
                return record
        brief = render.render(arm['template'], case['goal'], str(worktree), branch, case['owned_files'],
                              case['criteria'], case['gates_text'], str(result_file))
        (trial_dir / 'brief.md').write_text(brief)
        env = dict(os.environ, AGENT_HANDOFFS_DIR=str(trial_dir / 'handoffs'), OFFLOAD_HANDOFF=str(handoff_file),
                   REPLAY_TRIAL_DIR=str(trial_dir), REPLAY_FAKE_KEY=key, REPLAY_FAKE_SEED=args.seed)
        if args.fake_grades:
            env['REPLAY_FAKE_GRADES'] = str(Path(args.fake_grades).resolve())
        # The builder sees the brief, which holds the criteria. It never sees which criterion was missed.
        request = {'brief': brief, 'worktree': str(worktree), 'branch': branch, 'result_file': str(result_file),
                   'handoff_file': str(handoff_file), 'trial_dir': str(trial_dir),
                   'skills': {'repo': arm['repo'], 'ref': arm['ref'], 'sha': arm['sha']},
                   'case': {'id': case['id'], 'goal': case['goal'], 'owned_files': case['owned_files'],
                            'repo': {'identity': case['repo']['identity']}}}
        if ctx['builder_fake']:
            request['fake'] = {'mode': args.fake_builder_mode}
        try:
            call_adapter(ctx['builder'], request, env, str(worktree), args.timeout)
        except AdapterError as error:
            record.update(outcome='error', reason=str(error))
            return record
        head = caselib.git(worktree, 'rev-parse', 'HEAD')
        if head == case['base_commit']:
            record.update(outcome='error', reason='no-commit: the builder left HEAD at the base commit; only commits are graded')
            return record
        for command in case['gate_commands']:
            step = run_shell(command, worktree, args.timeout)
            record['gates'].append(step)
            if step['timeout']:
                record.update(outcome='error', reason=f'gate timeout: {command}')
                return record
        diff = caselib.git(worktree, 'diff', f"{case['base_commit']}..{head}")
        gate_output = ''.join(f"$ {g['command']}\n[exit {g['exit_code']}]\n{g['output']}\n" for g in record['gates'])
        sealed = {'id': f"{case['id']}/{trial}", 'diff': diff, 'criteria': case['criteria'], 'gate_output': gate_output}
        try:
            reply = call_adapter(ctx['grader'], sealed, env, str(trial_dir), args.timeout)
        except AdapterError as error:
            record.update(outcome='error', reason=str(error))
            return record
        grades = reply.get('grades')
        if not isinstance(grades, dict):
            record.update(outcome='error', reason='adapter output lacks a grades object')
            return record
        record['grades'] = {i: (v if v in ('MET', 'NOT MET') else 'ungraded') for i, v in grades.items()}
        missed = case['missed_ids']
        if all(record['grades'].get(i) in ('MET', 'NOT MET') for i in missed):
            record['outcome'] = 'graded'
            record['named_miss'] = any(record['grades'][i] == 'NOT MET' for i in missed)
        else:
            record.update(outcome='ungraded', reason='the grader gave no valid grade for a missed ID')
        return record
    finally:
        if made:
            worktree_gone(repo, worktree, branch, scratch)
        else:
            shutil.rmtree(scratch, ignore_errors=True)


def summarize(cases, records, arms):
    out = {}
    for arm in arms:
        mine = [r for r in records if r['arm'] == arm['name']]
        graded = [r for r in mine if r['outcome'] == 'graded']
        per_id = {}
        for case in cases:
            for missed in case['missed_ids']:
                rows = [r for r in graded if r['case'] == case['id']]
                misses = sum(1 for r in rows if r['grades'][missed] == 'NOT MET')
                per_id[f"{case['id']}:{missed}"] = {'graded': len(rows), 'misses': misses,
                                                    'rate': misses / len(rows) if rows else None}
        misses = sum(1 for r in graded if r['named_miss'])
        out[arm['name']] = {
            'skills_ref': arm['ref'], 'skills_sha': arm['sha'], 'trials': len(mine), 'graded': len(graded),
            'named_miss': misses, 'rate': misses / len(graded) if graded else None, 'per_id': per_id,
            'not_graded': {k: sum(1 for r in mine if r['outcome'] == k) for k in NOT_GRADED}}
    return out


def main(argv=None):
    args = parse_args(argv)
    try:
        return execute(args)
    except Refusal as refusal:
        print(f'refusing: {refusal}', file=sys.stderr)
        return 2
    except caselib.CaseError as error:
        print(f'invalid case: {error}', file=sys.stderr)
        return 2


def execute(args):
    if args.trials < 1:
        raise Refusal('--trials must be at least 1')
    if args.timeout <= 0:
        raise Refusal('--timeout must be positive')
    if args.demo:
        import fixture
        if Path(args.demo).exists():
            raise Refusal(f'--demo target exists: {args.demo}')
        fx = fixture.build(args.demo)
        args.cases = args.cases or str(fx.cases_dir)
        args.revised_skills_repo = args.revised_skills_repo or str(fx.skills_repo)
        args.revised_ref = args.revised_ref or 'HEAD'
    cases = caselib.load_cases(args.cases or caselib.store_dir() / 'replay-cases')
    if args.check:
        for case in cases:
            print(f"ok {case['id']}")
        return 0
    if not args.output:
        raise Refusal('--output is required')
    adapters = resolve_adapters(args)
    arms = [arm_template('current', args.skills_repo, args.current_ref),
            arm_template('revised', args.revised_skills_repo or args.skills_repo, args.revised_ref)]
    calls = len(cases) * len(arms) * args.trials
    print(f'planned: {calls} builder calls, {calls} grader calls '
          f'({len(cases)} cases x {len(arms)} arms x {args.trials} trials)', flush=True)
    external = [role for role, (_, fake) in adapters.items() if not fake]
    if external and not args.spend:
        raise Refusal(f'the {" and ".join(external)} adapter is not a built-in fake; pass --spend to allow it')
    out = Path(args.output)
    try:
        out.mkdir()
    except FileExistsError:
        raise Refusal(f'output exists, results are never overwritten: {out}')
    (out / 'cases').mkdir()
    ctx = {'args': args, 'out': out, 'builder': adapters['builder'][0], 'grader': adapters['grader'][0],
           'builder_fake': adapters['builder'][1]}
    records, skipped, status = [], [], {}
    for case in cases:
        reason = case_skip_reason(case)
        case_record = {'id': case['id'], 'base_commit': case['base_commit'], 'gate_commands': case['gate_commands'],
                       'status': 'skipped' if reason else 'ran', 'reason': reason, 'trials': []}
        for trial in range(1, args.trials + 1):
            for arm in arms:
                if reason:
                    result = {'case': case['id'], 'arm': arm['name'], 'skills_ref': arm['ref'],
                              'skills_sha': arm['sha'], 'trial': trial, 'base_commit': case['base_commit'],
                              'outcome': 'skipped', 'reason': reason, 'gates': [], 'grades': {}, 'named_miss': None}
                else:
                    result = run_trial(case, arm, trial, ctx)
                case_record['trials'].append(result)
                records.append(result)
        if reason:
            skipped.append({'case': case['id'], 'reason': reason})
        status[case['id']] = case_record['status']
        with (out / 'cases' / f"{case['id']}.json").open('x') as handle:
            json.dump(case_record, handle, indent=2)
    summary = {'planned': {'builder_calls': calls, 'grader_calls': calls}, 'cases': status, 'skipped_cases': skipped,
               'arms': summarize(cases, records, arms)}
    with (out / 'summary.json').open('x') as handle:
        json.dump(summary, handle, indent=2)
    for name, arm in summary['arms'].items():
        rate = 'n/a' if arm['rate'] is None else f"{arm['rate']:.3f}"
        print(f"{name}: named-miss rate {rate} ({arm['named_miss']}/{arm['graded']} graded), not graded {arm['not_graded']}")
    return 1 if any(r['outcome'] == 'error' for r in records) else 0


if __name__ == '__main__':
    raise SystemExit(main())
