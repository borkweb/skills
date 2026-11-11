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


# ---- stubs for the real adapters: a bin dir that holds ONLY stub `claude` and `codex` plus git ----
SENTINEL = 'SENTINEL-S3B-5d2e'
STUB_CLI = r'''#!@PYTHON@
import json, os, re, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
tool = os.path.basename(sys.argv[0])
argv = sys.argv[1:]
stdin = sys.stdin.read()
cfg = json.load(open(os.path.join(here, 'config.json'))) if os.path.exists(os.path.join(here, 'config.json')) else {}
role = 'grader' if ('--json-schema' in argv or '--output-schema' in argv) else 'builder'
files = {}
if role == 'grader':
    for base, _, names in os.walk(os.getcwd()):
        for n in names:
            try:
                files[os.path.join(base, n)] = open(os.path.join(base, n), errors='replace').read()
            except OSError:
                pass
with open(os.path.join(here, 'calls.jsonl'), 'a') as f:
    f.write(json.dumps({'tool': tool, 'role': role, 'argv': argv, 'cwd': os.getcwd(), 'env': dict(os.environ),
                        'stdin': stdin, 'ls': sorted(os.listdir(os.getcwd())), 'files': files,
                        'home_ls': sorted(os.listdir(os.environ['HOME'])) if os.path.isdir(os.environ.get('HOME', '/nonexistent')) else None}) + '\n')
if cfg.get('echo_env'):
    sys.stderr.write(json.dumps(dict(os.environ)))
mode = cfg.get(role, 'ok')
if mode == 'fail':
    sys.stderr.write('stub failure\n'); sys.exit(1)
if mode == 'sleep':
    if cfg.get('ignore_term'):
        import signal
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen(['sh', '-c', 'trap "" TERM; sleep 300'])
    else:
        child = subprocess.Popen(['sleep', '300'])
    json.dump({'stub': os.getpid(), 'child': child.pid}, open(cfg['pidfile'], 'w'))
    time.sleep(300)
def emit(text, structured=None):
    if cfg.get('echo_env'):
        text += json.dumps(dict(os.environ))
    if tool == 'codex':
        if '-o' in argv:
            open(argv[argv.index('-o') + 1], 'w').write(text)
        print('codex chatter')
    else:
        env = {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': text,
               'total_cost_usd': 0.01, 'usage': {'input_tokens': 1, 'output_tokens': 1}}
        if structured is not None:
            env['result'] = ''; env['structured_output'] = structured
        print(json.dumps(env))
if role == 'grader':
    if mode == 'empty':
        sys.exit(0)
    if mode == 'raw':
        print(cfg['raw']); sys.exit(0)
    ids = re.findall(r'^(C\d+[a-z]?)[:.]', stdin, re.M)
    grades = cfg.get('grades') or {i: 'MET' for i in ids}
    reply = cfg['reply'] if 'reply' in cfg else {'grades': grades}
    text = reply if isinstance(reply, str) else json.dumps(reply)
    emit(text, reply if cfg.get('structured') and isinstance(reply, dict) else None)
    sys.exit(0)
# builder
for var in ('AGENT_HANDOFFS_DIR', 'BORK_RUN_DIR'):
    if os.environ.get(var):
        os.makedirs(os.environ[var], exist_ok=True)
        open(os.path.join(os.environ[var], 'marker'), 'w').write('x')
open('fake-builder.txt', 'w').write('STUB-BUILDER-LINE\n')
if mode != 'no-commit':
    subprocess.run(['git', 'add', 'fake-builder.txt'], check=True)
    subprocess.run(['git', 'commit', '-q', '-m', 'stub change ' + cfg.get('commit_sentinel', 'x')], check=True)
if mode == 'plant':
    cfgfile = os.path.join('.git', 'config')
    open(cfgfile, 'a').write('[diff]\n\texternal = ' + cfg['external'] + '\n\tnoprefix = true\n[color "diff"]\n\tnew = red\n[color]\n\tdiff = always\n')
    open('.gitattributes', 'a').write('*.txt diff=evil\n')
    open(cfgfile, 'a').write('[diff "evil"]\n\ttextconv = ' + cfg['external'] + '\n')
m = re.search(r'(/\S*/trials/t[0-9a-f]{12}/result\.md)', stdin)
if m and cfg.get('result_text'):
    open(m.group(1), 'w').write(cfg['result_text'])
emit(cfg.get('builder_text', 'built'))
'''


def stub_bin(tmp, config=None):
    """A bin dir with stub claude and codex and a git symlink. Nothing else, so no real model CLI is reachable."""
    import shutil
    bindir = Path(tmp) / 'stubbin'
    bindir.mkdir(parents=True, exist_ok=True)
    for name in ('claude', 'codex'):
        write_stub_cli(bindir / name)
    git_path = shutil.which('git')
    if not (bindir / 'git').exists():
        os.symlink(git_path, bindir / 'git')
    set_stub_config(bindir, config or {})
    return bindir


def write_stub_cli(path):
    Path(path).write_text(STUB_CLI.replace('@PYTHON@', sys.executable))
    Path(path).chmod(0o755)


def set_stub_config(bindir, config):
    (Path(bindir) / 'config.json').write_text(json.dumps(config))


def safe_path(bindir):
    """PATH for any test that selects a real adapter: stubs first, then only the system dirs (no ~/.local/bin)."""
    return f'{bindir}:/usr/bin:/bin'


def stub_calls(bindir, role=None, tool=None):
    log = Path(bindir) / 'calls.jsonl'
    rows = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return [r for r in rows if (role is None or r['role'] == role) and (tool is None or r['tool'] == tool)]


def real_args(fx, out, harness='claude', trials=1, spend=True, extra=(), grader_harness=None):
    args = ['--cases', fx.cases_dir, '--output', out, '--current-ref', BASE_REF, '--revised-ref', 'HEAD',
            '--revised-skills-repo', fx.skills_repo, '--builder-harness', harness,
            '--grader-harness', grader_harness or harness, '--trials', str(trials), *extra]
    return args + (['--spend'] if spend else [])


KEY = {'claude': 'ANTHROPIC_API_KEY', 'codex': 'OPENAI_API_KEY'}


def real_env(bindir, tmp, extra=None):
    """Env for a runner process that may call a (stub) real adapter: safe PATH, a credential, a private TMPDIR."""
    tmpdir = Path(tmp) / 'tmpdir'
    tmpdir.mkdir(exist_ok=True)
    env = {'PATH': safe_path(bindir), 'ANTHROPIC_API_KEY': 'sk-ant-test-0001', 'OPENAI_API_KEY': 'sk-oai-test-0001',
           'TMPDIR': str(tmpdir)}
    env.update(extra or {})
    return env


def run_real(fx, out, bindir, tmp, harness='claude', **kw):
    extra_env = kw.pop('env', None)
    return run_cli(RUNNER, real_args(fx, out, harness, **kw), env=real_env(bindir, tmp, extra_env))


def hostile_user_env(root):
    """A fake user's env: every variable the adapters must not forward, pointing at a tree the test watches."""
    root = Path(root)
    user = {'AGENT_HANDOFFS_DIR': root / 'user-handoffs', 'BORK_RUNS_HOME': root / 'user-runs',
            'BORK_RUN_DIR': root / 'user-run', 'BORK_RUN_ID': 'user-run-id', 'BORK_RUNS_CLI': root / 'user-cli',
            'ORCHESTRATOR_HOME': root / 'user-orch', 'HERDR_ENV': '1', 'HERDR_PANE_ID': 'pane-user',
            'HERDR_TAB_ID': 'tab-user', 'HERDR_WORKSPACE_ID': 'ws-user', 'HERDR_SOCKET_PATH': str(root / 'herdr.sock'),
            'CLAUDE_CODE_SESSION_ID': 'claude-session-user', 'CODEX_SESSION_ID': 'codex-session-user',
            'BORK_REPO_RULES_DIR': root / 'user-rules'}
    (root / 'user-handoffs').mkdir(parents=True, exist_ok=True)
    (root / 'user-handoffs' / 'ledger.json').write_text('{}')
    return {k: str(v) for k, v in user.items()}


def tree_snapshot(path):
    path = Path(path)
    return sorted((str(p.relative_to(path)), p.stat().st_mtime_ns) for p in path.rglob('*')) if path.exists() else []


def pid_dead(pid, wait=8.0):
    """True once `pid` is gone or a zombie. Polls, because a killed grandchild lingers briefly."""
    import time
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        stat = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
        if not stat or stat.startswith('Z'):
            return True
        time.sleep(0.1)
    return False


def read_pids(pidfile, wait=20.0):
    import time
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        try:
            return json.loads(Path(pidfile).read_text())
        except (OSError, ValueError):
            time.sleep(0.1)
    raise AssertionError(f'no pid file {pidfile}')


def kill_pids(pidfile):
    try:
        data = json.loads(Path(pidfile).read_text())
        for pid in (data.values() if isinstance(data, dict) else [data]):
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
    except (OSError, ValueError):
        pass


ADAPTER = HERE / 'real_adapter.py'


def adapter_request(role, tmp, harness='claude', **over):
    tmp = Path(tmp)
    if role == 'builder':
        work = tmp / 'work'
        work.mkdir(exist_ok=True)
        req = {'brief': 'BRIEF TEXT\nline two\n', 'worktree': str(work), 'branch': 'replay/t0123456789ab-x',
               'result_file': str(tmp / 'result.md'), 'handoff_file': str(tmp / 'handoff.md'),
               'trial_dir': str(tmp / 'trial'), 'trial': 't0123456789ab', 'skills': {}, 'case': {}}
    else:
        req = {'id': 't0123456789ab', 'diff': 'DIFF-TEXT', 'criteria': 'C1: one\nC2: two\nC3: three',
               'gate_output': 'GATE-TEXT'}
    req.update(harness=harness, spend=True, timeout=30, max_budget_usd=2)
    req.update(over)
    return {k: v for k, v in req.items() if v is not ABSENT}


ABSENT = object()


def run_adapter(role, request, bindir, tmp, env=None, timeout=60):
    """Run the real adapter directly with a safe PATH and a fake credential."""
    full = {'PATH': safe_path(bindir), 'ANTHROPIC_API_KEY': 'sk-ant-test-0001', 'OPENAI_API_KEY': 'sk-oai-test-0001',
            'TMPDIR': str(tmp)}
    full.update(env or {})
    return subprocess.run([sys.executable, str(ADAPTER), role], input=json.dumps(request), capture_output=True,
                          text=True, env=full, timeout=timeout)
