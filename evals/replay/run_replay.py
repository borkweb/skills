#!/usr/bin/env python3
"""Replay a missed-criterion case against two skill revisions, using fake adapters only unless --spend is given.

For each case, trial and arm (current, revised) it makes a disposable local clone of the case repo at the case's base
commit, renders the arm's builder-template.md into a brief, calls a builder adapter, runs the case's gate commands in
that clone, and asks a grader adapter to grade the sealed input. Adapters are exec'd directly (no shell) with JSON on
stdin and stdout, as in evals/run.py, each in its own process group. Results are never overwritten.
"""
import argparse
import json
import os
from pathlib import Path
import re
import math
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caselib  # noqa: E402
import procs  # noqa: E402
import real_adapter  # noqa: E402
import render  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
TEMPLATE_PATH = 'skills/core/offload/builder-template.md'
FAKE = [sys.executable, str(HERE / 'fake_adapter.py')]
REAL = [sys.executable, str(HERE / 'real_adapter.py')]
# Set by the user's shell or a coordinating session; no adapter may inherit them (HERDR_* too).
ISOLATED = ('BORK_RUNS_HOME', 'BORK_RUN_DIR', 'BORK_RUN_ID', 'BORK_RUNS_CLI', 'ORCHESTRATOR_HOME',
            'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID')
NOT_GRADED = ('skipped', 'error', 'ungraded', 'env-unavailable')
OUTPUT_CAP = 20000


class Refusal(Exception):
    """A usage or safety refusal: print, exit 2, touch nothing."""


class AdapterError(Exception):
    pass


class Unsafe(Exception):
    """The builder left something the runner must not write through. The trial is an error."""


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
    p.add_argument('--builder-harness', help='real builder: claude or codex (paid model calls; needs --spend)')
    p.add_argument('--grader-harness', help='real grader: claude or codex (paid model calls; needs --spend)')
    p.add_argument('--gates-real-home', action='store_true',
                   help='give setup and gate commands the real HOME; weakens blinding (default: a temp HOME)')
    p.add_argument('--max-budget-usd', type=float, default=2.0, help='per-call cap where the harness has one (claude)')
    p.add_argument('--spend', action='store_true', help='allow adapters that are not the built-in fakes')
    p.add_argument('--seed', default='0', help='fake grader seed')
    p.add_argument('--fake-grades', help='JSON {"<case>/<arm>/<trial>": {"C1": "MET"} | "ungraded" | "exit1"}')
    p.add_argument('--fake-builder-mode', default='commit', choices=['commit', 'fail', 'no-commit', 'sleep', 'garbage', 'readonly', 'dirty', 'plant', 'inspect',
                                                                 'symlink-config', 'symlink-reply', 'symlink-grader-reply',
                                                                 'symlink-git'])
    p.add_argument('--inject-fault', choices=['after-worktree', 'skip-config-restore'], help='raise in the runner (for cleanup tests)')
    return p.parse_args(argv)


def resolve_adapters(args):
    """role -> (command, is_fake, harness). Exactly one of: the built-in fake, an adapter executable, a harness."""
    roles = {}
    for role in ('builder', 'grader'):
        fake = args.fake or getattr(args, f'fake_{role}')
        external = getattr(args, f'{role}_adapter')
        harness = getattr(args, f'{role}_harness')
        if bool(fake) + bool(external) + (harness is not None) != 1:
            raise Refusal(f'choose exactly one {role}: --fake{"" if args.fake else "-" + role}, --{role}-adapter '
                          f'or --{role}-harness')
        if harness is not None:
            if harness not in real_adapter.HARNESSES:
                raise Refusal(f'unknown {role} harness {harness!r}: use one of {", ".join(real_adapter.HARNESSES)}')
            roles[role] = (REAL + [role], False, harness)
        else:
            roles[role] = (FAKE + [role], True, None) if fake else ([external], False, None)
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


def secrets():
    """Credential values the runner holds, so recorded text can be scrubbed of them."""
    return [v for k in real_adapter.CREDENTIAL_NAMES if len(v := os.environ.get(k, '')) >= 8]


def scrub(text):
    for value in secrets():
        text = text.replace(value, '[redacted]')
    return text


def base_env():
    """The runner's env minus everything an adapter must not inherit from the user's shell or a coordinating session."""
    return {k: v for k, v in os.environ.items() if k not in ISOLATED and not k.startswith(('HERDR_', 'BORK_'))}


def gate_env(trial_dir, real_home):
    """What setup and gate commands may see: the adapters' scrubbed env with no credential, and per-trial store dirs.
    They run code the builder wrote, and their output reaches the grader."""
    env = {k: v for k, v in base_env().items() if k not in real_adapter.CREDENTIAL_NAMES and 'API_KEY' not in k
           and not k.startswith(('REPLAY_', 'OFFLOAD_'))}
    rules = trial_dir / 'repo-rules'
    rules.mkdir(exist_ok=True)
    env.update(AGENT_HANDOFFS_DIR=str(trial_dir / 'handoffs'), BORK_REPO_RULES_DIR=str(rules))
    if not real_home:
        (trial_dir / 'home').mkdir(exist_ok=True)
        env['HOME'] = str(trial_dir / 'home')
    return env


def safe_write(path, text):
    """Write `path` without following a symlink or hardlink the builder planted: refuse anything that exists and
    is not a regular file, drop a regular file, then create exclusively."""
    path = Path(path)
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        mode = None
    if mode is not None:
        if not stat.S_ISREG(mode):
            raise Unsafe(f'{path.name} is a symlink or not a regular file; refusing to write through it')
        os.unlink(path)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as handle:
        handle.write(text)


def require_real_git_dir(repo):
    try:
        mode = os.lstat(Path(repo) / '.git').st_mode
    except OSError:
        mode = None
    if mode is None or not stat.S_ISDIR(mode):
        raise Unsafe('the trial repo .git is not a real directory (a symlink or missing); refusing to run git in it')


def call_adapter(command, request, env, cwd, timeout):
    try:
        run = procs.run_group(command, input=json.dumps(request), env=env, cwd=cwd, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AdapterError(f'adapter timeout after {timeout:g}s')
    except OSError as error:
        raise AdapterError(f'adapter could not start: {error}')
    if run.returncode != 0:
        raise AdapterError(scrub(f'adapter exit {run.returncode}: {run.stderr.strip()[-300:]}'))
    try:
        response = json.loads(run.stdout)
    except ValueError:
        raise AdapterError('adapter output is not JSON')
    if not isinstance(response, dict):
        raise AdapterError('adapter output is not a JSON object')
    return response


def run_shell(command, cwd, timeout, env):
    """A gate or setup command line, run in `cwd`. These are case text, not adapters, so they go through sh."""
    try:
        run = procs.run_group(['/bin/sh', '-c', command], cwd=cwd, timeout=timeout, merge_stderr=True, env=env)
    except subprocess.TimeoutExpired:
        return {'command': command, 'exit_code': None, 'output': '', 'timeout': True}
    return {'command': command, 'exit_code': run.returncode, 'output': scrub(run.stdout[-OUTPUT_CAP:]), 'timeout': False}


def live_paths(repo):
    """The repo and every worktree it already has: commands must not name any of them."""
    paths = {str(repo), os.path.realpath(repo)}
    for line in caselib.git(repo, 'worktree', 'list', '--porcelain', check=False).stdout.splitlines():
        if line.startswith('worktree '):
            paths |= {line[len('worktree '):], os.path.realpath(line[len('worktree '):])}
    return paths


def names_live_path(command, paths):
    """True when `command` names a live path literally, through ~ or $HOME, or by a path that resolves into one."""
    home = str(Path.home())
    expanded = re.sub(r'(?<![\w$~])~(?=/|\s|$)', home, command.replace('${HOME}', home).replace('$HOME', home))
    if any(p in text for p in paths for text in (command, expanded)):
        return True
    resolved = {os.path.realpath(p) for p in paths}
    for token in re.findall(r'/[^\s\'"`;|&<>()]*', expanded):
        real = os.path.realpath(token)
        if any(real == p or real.startswith(p + os.sep) for p in resolved):
            return True
    return False


def case_skip_reason(case):
    repo = case['repo']['path']
    probe = caselib.git(repo, 'cat-file', '-e', case['base_commit'] + '^{commit}', check=False)
    if probe.returncode != 0:
        return 'base commit is not in the repo (never fetched)'
    paths = live_paths(repo)
    for command in case['gate_commands'] + case.get('setup_commands', []):
        if names_live_path(command, paths):
            return f'command references the live repo path: {command}'
    # The brief is rendered from these fields, so the builder would read the live path.
    for field in ('goal', 'owned_files', 'criteria', 'gates_text'):
        if names_live_path(case[field], paths):
            return f'field {field} names the live repo path'
    return None


def remove_tree(path):
    """rmtree that also removes what a builder made read-only (a directory without write permission)."""
    for base, dirs, _ in os.walk(path):
        for name in [base] + [os.path.join(base, d) for d in dirs]:
            if not os.path.islink(name):
                try:
                    os.chmod(name, 0o700)
                except OSError:
                    pass
    shutil.rmtree(path, ignore_errors=True)


def make_clone(repo, base, branch, clone, timeout):
    """A disposable trial repo holding exactly one ref (`branch`, at `base`) and nothing after it: `git init`, then
    a fetch of that one commit, then a checkout. No other branch, no tag, no later commit, no remote, no reflog or
    FETCH_HEAD naming `repo`, no alternates and no hardlink to its object store. Returns an error string or None."""
    steps = (('init', clone.parent, ('init', '-q', str(clone))),
             ('config', clone, ('config', 'core.logAllRefUpdates', 'false')),
             ('fetch', clone, ('-c', 'core.logAllRefUpdates=false', '-c', 'uploadpack.allowAnySHA1InWant=true', 'fetch',
                               '-q', '--no-tags', '--no-write-fetch-head', str(repo), f'{base}:refs/heads/{branch}')),
             ('checkout', clone, ('checkout', '-q', branch)))
    for label, where, args in steps:
        done = caselib.git(where, *args, check=False, timeout=timeout)
        if done.returncode != 0:
            return f'clone failed ({label}): {done.stderr.strip()[-200:]}'
    return None


def grader_env():
    """What the grader process may see: nothing of the builder's run, and no arm name."""
    return {k: v for k, v in base_env().items() if not k.startswith(('REPLAY_', 'OFFLOAD_')) and k != 'AGENT_HANDOFFS_DIR'}


def adapter_request(ctx, role, request):
    """Real-adapter requests also carry the spend authorization, the harness, a model-call timeout (under the
    runner's own, so the adapter can kill its child and report) and the per-call budget."""
    harness = ctx[f'{role}_harness']
    if harness is None:
        return request
    args = ctx['args']
    return dict(request, harness=harness, spend=True, timeout=max(args.timeout / 2, args.timeout - 5),
                max_budget_usd=args.max_budget_usd)


def save_reply(trial_dir, name, reply):
    safe_write(trial_dir / name, scrub(json.dumps(reply, indent=2)))


def run_trial(case, arm, trial, ctx):
    args = ctx['args']
    key = f"{case['id']}/{arm['name']}/{trial}"
    # Everything the builder or grader can see is named by this token: no case id (it may carry a criterion ID)
    # and no arm. The per-case JSON maps it back.
    token = caselib.trial_token(case['id'], arm['name'], trial)
    record = {'case': case['id'], 'arm': arm['name'], 'skills_ref': arm['ref'], 'skills_sha': arm['sha'],
              'trial': trial, 'token': token, 'base_commit': case['base_commit'], 'outcome': None, 'reason': None,
              'gates': [], 'grades': {}, 'named_miss': None}
    trial_dir = ctx['out'] / 'trials' / token
    (trial_dir / 'handoffs').mkdir(parents=True)
    result_file, handoff_file = trial_dir / 'result.md', trial_dir / 'handoff.md'
    result_file.write_text('')
    handoff_file.write_text('')
    repo = case['repo']['path']
    scratch = Path(tempfile.mkdtemp(prefix='replay-wt-'))
    # The request key stays `worktree`: it is the directory the builder works in, now a disposable clone.
    worktree = Path(os.path.realpath(scratch)) / 'wt'
    branch = f"replay/{token}-{uuid.uuid4().hex[:8]}"
    try:
        try:
            failed = make_clone(repo, case['base_commit'], branch, worktree, args.timeout)
        except subprocess.TimeoutExpired:
            record.update(outcome='error', reason=f'clone timeout after {args.timeout:g}s')
            return record
        if failed:
            record.update(outcome='error', reason=failed)
            return record
        # The builder controls this repo's config. Keep a copy so the runner's own git calls read a trusted one.
        config_path = worktree / '.git' / 'config'
        trusted_config = config_path.read_text()
        if args.inject_fault == 'after-worktree':
            raise RuntimeError('injected fault after the clone was created')
        genv = gate_env(trial_dir, args.gates_real_home)
        for command in case.get('setup_commands', []):
            step = run_shell(command, worktree, args.timeout, genv)
            if step['timeout'] or step['exit_code'] != 0:
                record.update(outcome='env-unavailable', reason=f'setup failed: {command}')
                return record
        brief = render.render(arm['template'], case['goal'], str(worktree), branch, case['owned_files'],
                              case['criteria'], case['gates_text'], str(result_file))
        (trial_dir / 'brief.md').write_text(brief)
        env = dict(base_env(), AGENT_HANDOFFS_DIR=str(trial_dir / 'handoffs'), OFFLOAD_HANDOFF=str(handoff_file),
                   REPLAY_TRIAL_DIR=str(trial_dir))
        # The builder sees the brief, which holds the criteria. It never sees which criterion was missed.
        request = {'brief': brief, 'worktree': str(worktree), 'branch': branch, 'result_file': str(result_file),
                   'handoff_file': str(handoff_file), 'trial_dir': str(trial_dir), 'trial': token,
                   'skills': {'repo': arm['repo'], 'ref': arm['ref'], 'sha': arm['sha']},
                   'case': {'goal': case['goal'], 'owned_files': case['owned_files'],
                            'repo': {'identity': case['repo']['identity']}}}
        if ctx['builder_fake']:
            request['fake'] = {'mode': args.fake_builder_mode}
        try:
            reply = call_adapter(ctx['builder'], adapter_request(ctx, 'builder', request), env, str(worktree),
                                 args.timeout)
        except AdapterError as error:
            record.update(outcome='error', reason=str(error))
            return record
        require_real_git_dir(worktree)
        save_reply(trial_dir, 'builder-reply.json', reply)
        if args.inject_fault != 'skip-config-restore':
            try:
                safe_write(config_path, trusted_config)
            except OSError:
                pass  # a read-only clone: remove_tree handles it, and no planted config is read below
        head = caselib.git(worktree, 'rev-parse', 'HEAD')
        if head == case['base_commit']:
            record.update(outcome='error', reason='no-commit: the builder left HEAD at the base commit; only commits are graded')
            return record
        if caselib.git(worktree, 'status', '--porcelain'):
            record.update(outcome='error', reason='dirty-tree: the builder left uncommitted changes the grader would not see')
            return record
        for command in case['gate_commands']:
            step = run_shell(command, worktree, args.timeout, genv)
            record['gates'].append(step)
            if step['timeout']:
                record.update(outcome='error', reason=f'gate timeout: {command}')
                return record
        # The flags alone keep a planted diff or textconv program from running and fix the output format, so the
        # config restore above is a second layer, not the only one.
        diff = caselib.git(worktree, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames',
                           '--no-relative', '-U3', '--src-prefix=a/', '--dst-prefix=b/', case['base_commit'], head)
        gate_output = ''.join(f"$ {g['command']}\n[exit {g['exit_code']}]\n{g['output']}\n" for g in record['gates'])
        # The diff is in hand: drop the clone so the grader process cannot read commit messages from it.
        remove_tree(scratch)
        return grade_trial(case, record, key, token, trial_dir, ctx, diff, gate_output)
    except Unsafe as error:
        record.update(outcome='error', reason=str(error))
        return record
    finally:
        remove_tree(scratch)


def grade_trial(case, record, key, token, trial_dir, ctx, diff, gate_output):
    """Call the grader in an empty directory with a stripped environment; fold its reply into the record."""
    args = ctx['args']
    sealed = {'id': token, 'diff': diff, 'criteria': case['criteria'], 'gate_output': gate_output}
    env = grader_env()
    if ctx['grader_fake']:
        # Dedicated variables, read only by the built-in fake. They carry the opaque token, never the arm.
        env.update(REPLAY_FAKE_GRADER_TOKEN=token, REPLAY_FAKE_GRADER_CAPTURE=str(trial_dir / 'grader-stdin.json'),
                   REPLAY_FAKE_GRADER_SEED=args.seed)
        if args.fake_grades:
            entry = json.loads(Path(args.fake_grades).read_text()).get(key)
            if entry is not None:
                env['REPLAY_FAKE_GRADER_ENTRY'] = json.dumps(entry)
    empty = tempfile.mkdtemp(prefix='replay-grader-')
    try:
        reply = call_adapter(ctx['grader'], adapter_request(ctx, 'grader', sealed), env, empty, args.timeout)
    except AdapterError as error:
        record.update(outcome='error', reason=str(error))
        return record
    finally:
        shutil.rmtree(empty, ignore_errors=True)
    save_reply(trial_dir, 'grader-reply.json', reply)
    grades = reply.get('grades')
    if not isinstance(grades, dict):
        record.update(outcome='error', reason='adapter output lacks a grades object')
        return record
    frozen = caselib.criteria_ids(case['criteria'])
    # An ID outside the frozen set covers nothing and is dropped.
    record['grades'] = {i: (v if v in ('MET', 'NOT MET') else 'ungraded') for i, v in grades.items() if i in frozen}
    missed = case['missed_ids']
    if all(record['grades'].get(i) in ('MET', 'NOT MET') for i in missed):
        record['outcome'] = 'graded'
        record['named_miss'] = any(record['grades'][i] == 'NOT MET' for i in missed)
    else:
        why = scrub(str(reply.get('reason') or ''))[:300]
        record.update(outcome='ungraded', reason='the grader gave no valid grade for a missed ID' + (f': {why}' if why else ''))
    return record


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


def interrupt(signum, frame):
    raise KeyboardInterrupt


def main(argv=None):
    args = parse_args(argv)
    # A closed pane (SIGHUP) or a kill (SIGTERM) must clean up like Ctrl-C does. SIGINT is set explicitly: a runner
    # started as a background job inherits it as ignored.
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGHUP, interrupt)
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
    if not math.isfinite(args.max_budget_usd) or args.max_budget_usd <= 0:
        raise Refusal('--max-budget-usd must be a finite number greater than 0')
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
    external = [role for role, (_, fake, _) in adapters.items() if not fake]
    if external and not args.spend:
        raise Refusal(f'the {" and ".join(external)} adapter is not a built-in fake; pass --spend to allow it')
    # Before the first paid call: every selected harness must have its binary and credential, or a builder call
    # could be paid for and then never graded.
    for harness in sorted({h for _, _, h in adapters.values() if h}):
        try:
            real_adapter.find_harness(harness)
        except real_adapter.Refusal as error:
            raise Refusal(f'cannot start a real run: {error}')
    out = Path(args.output)
    try:
        caselib.private_dir(out, must_be_new=True)
    except FileExistsError:
        raise Refusal(f'output exists, results are never overwritten: {out}')
    except ValueError as error:
        raise Refusal(str(error))
    (out / 'cases').mkdir()
    ctx = {'args': args, 'out': out, 'builder': adapters['builder'][0], 'grader': adapters['grader'][0],
           'builder_fake': adapters['builder'][1], 'grader_fake': adapters['grader'][1],
           'builder_harness': adapters['builder'][2], 'grader_harness': adapters['grader'][2]}
    records, skipped, status = [], [], {}
    for case in cases:
        reason = case_skip_reason(case)
        case_record = {'id': case['id'], 'base_commit': case['base_commit'], 'gate_commands': case['gate_commands'],
                       'gates_real_home': args.gates_real_home,
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
