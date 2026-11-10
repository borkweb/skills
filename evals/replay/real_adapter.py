#!/usr/bin/env python3
"""Real builder and grader adapters for the replay runner: one paid, headless model call per request.

Usage: real_adapter.py builder|grader. One JSON object on stdin, one on stdout, no shell (the evals/run.py protocol).
The runner adds `harness` (claude or codex), `spend` (the JSON value true), `timeout` and `max_budget_usd`.

It refuses, before it starts any process, unless: spend is exactly true; the harness is exactly `claude` or `codex`;
the harness binary is on PATH (there is no fallback); and the harness credential is set in the environment.
The model process gets an allowlisted environment and a temp HOME, so it inherits nothing of the user's session.
"""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caselib  # noqa: E402
import procs  # noqa: E402

HARNESSES = ('claude', 'codex')
CREDENTIALS = {'claude': ('ANTHROPIC_API_KEY',), 'codex': ('OPENAI_API_KEY', 'CODEX_API_KEY')}
CREDENTIAL_NAMES = ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY')
# Nothing else is forwarded: no session ids, no BORK_* or HERDR_*, no tokens, no agent sockets.
PASS = ('PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
        'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
        'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE')
SCHEMA = {'type': 'object', 'properties': {'grades': {'type': 'object', 'additionalProperties': {
    'type': 'string', 'enum': ['MET', 'NOT MET']}}}, 'required': ['grades'], 'additionalProperties': False}
FENCE = re.compile(r'```(?:json)?\s*\n(.*?)\n```', re.S)
TAIL = 300


class Refusal(Exception):
    pass


class ModelFailure(Exception):
    pass


def scrub(text):
    for name in CREDENTIAL_NAMES:
        value = os.environ.get(name, '')
        if len(value) >= 8:
            text = text.replace(value, '[redacted]')
    return text


def check(request):
    """The refusal chain, in order. Returns the harness binary path and the credential names to forward."""
    if request.get('spend') is not True:
        raise Refusal('--spend was not passed to the runner, and this adapter makes paid model calls')
    harness = request.get('harness')
    if not isinstance(harness, str) or harness not in HARNESSES:
        raise Refusal(f'unknown harness {harness!r}: use exactly one of {", ".join(HARNESSES)}')
    timeout = request.get('timeout')
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise Refusal('timeout must be a positive number of seconds: every model call has a wall-clock limit')
    binary = shutil.which(harness, path=os.environ.get('PATH', ''))
    if not binary:
        raise Refusal(f'{harness} is not on PATH; there is no fallback to another harness or a fake')
    names = [n for n in CREDENTIALS[harness] if os.environ.get(n)]
    if not names:
        raise Refusal(f'{" or ".join(CREDENTIALS[harness])} is not set: the {harness} harness needs it, because the '
                      'model process gets a temp HOME and no keychain, config or auth file is copied')
    return binary, names


def child_env(names, home, extra):
    env = {k: os.environ[k] for k in PASS if k in os.environ}
    env.update({n: os.environ[n] for n in names}, HOME=str(home), GIT_TERMINAL_PROMPT='0')
    env.update(extra)
    return env


def model_call(command, prompt, env, cwd, timeout):
    """Run the harness in its own process group; a timeout or a TERM to this adapter kills that group."""
    try:
        run = procs.run_group(command, input=prompt, env=env, cwd=cwd, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ModelFailure(f'model call timeout after {timeout:g}s')
    except OSError as error:
        raise ModelFailure(f'could not start {command[0]}: {error}')
    if run.returncode != 0:
        raise ModelFailure(scrub(f'{os.path.basename(command[0])} exit {run.returncode}: {run.stderr.strip()[-TAIL:]}'))
    return run.stdout


def envelope(stdout):
    try:
        data = json.loads(stdout)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def builder(request, binary, names):
    harness, worktree, trial = request['harness'], request['worktree'], Path(request['trial_dir'])
    home, rules, handoffs = trial / 'home', trial / 'repo-rules', trial / 'handoffs'
    for path in (home, rules, handoffs):
        path.mkdir(parents=True, exist_ok=True)
    extra = {'AGENT_HANDOFFS_DIR': str(handoffs), 'BORK_REPO_RULES_DIR': str(rules),
             'GIT_AUTHOR_NAME': 'replay', 'GIT_AUTHOR_EMAIL': 'replay@example.invalid',
             'GIT_COMMITTER_NAME': 'replay', 'GIT_COMMITTER_EMAIL': 'replay@example.invalid',
             'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'commit.gpgsign', 'GIT_CONFIG_VALUE_0': 'false'}
    if harness == 'claude':
        # The clone is the working directory; the trial dir (result file, temp HOME) is the only other write root.
        settings = {'sandbox': {'enabled': True, 'autoAllowBashIfSandboxed': True, 'allowUnsandboxedCommands': False,
                                'filesystem': {'allowWrite': [str(trial)]}}}
        command = [binary, '-p', '--bare', '--output-format', 'json', '--no-session-persistence',
                   '--max-budget-usd', f"{request.get('max_budget_usd', 2):g}", '--permission-mode', 'acceptEdits',
                   '--settings', json.dumps(settings), '--add-dir', str(trial)]
    else:
        extra['CODEX_HOME'] = str(trial / 'codex-home')
        Path(extra['CODEX_HOME']).mkdir(exist_ok=True)
        command = [binary, 'exec', '-C', worktree, '--sandbox', 'workspace-write', '--add-dir', str(trial),
                   '--ephemeral', '-']
    out = model_call(command, request['brief'], child_env(names, home, extra), worktree, request['timeout'])
    data = envelope(out) if harness == 'claude' else None
    if data and data.get('is_error') is True:
        raise ModelFailure(scrub(f"claude reported an error: {data.get('subtype') or data.get('result') or 'unknown'}"))
    usage = {'cost_usd': (data or {}).get('total_cost_usd'), 'usage': (data or {}).get('usage')}
    text = (data or {}).get('result') if data else out
    return {'status': 'ok', 'harness': harness, 'argv': command, 'usage': usage, 'output': scrub(str(text or ''))[-2000:]}


def prompt_for(request):
    ids = ', '.join(caselib.criteria_ids(request['criteria']))
    return ('You grade a builder\'s work. Judge each criterion only from the diff and the gate output below. '
            'You have no tools and need none.\n\nReply with only a JSON object of the form '
            '{"grades": {"<ID>": "MET" | "NOT MET"}} with one entry for each of these IDs: ' + ids +
            '. Use MET only when the diff and gate output show the criterion holds.\n\n'
            f"## Criteria\n{request['criteria']}\n\n## Gate output\n{request['gate_output']}\n\n## Diff\n{request['diff']}\n")


def grades_from(candidate, frozen):
    """Per frozen ID: exactly MET or NOT MET as given, else ungraded. Unknown IDs are dropped."""
    out = {i: 'ungraded' for i in frozen}
    if isinstance(candidate, str):
        text = candidate.strip()
        match = FENCE.search(text)
        try:
            candidate = json.loads(match.group(1) if match else text)
        except ValueError:
            return out
    grades = candidate.get('grades') if isinstance(candidate, dict) else None
    if isinstance(grades, dict):
        for ident in frozen:
            if isinstance(grades.get(ident), str) and grades[ident] in ('MET', 'NOT MET'):
                out[ident] = grades[ident]
    return out


def grader(request, binary, names):
    frozen = caselib.criteria_ids(request['criteria'])
    root = Path(tempfile.mkdtemp(prefix='replay-grader-'))
    try:
        cwd, home, aux = root / 'cwd', root / 'home', root / 'aux'
        for path in (cwd, home, aux):
            path.mkdir()
        extra, answer = {}, None
        if request['harness'] == 'claude':
            command = [binary, '-p', '--bare', '--tools', '', '--output-format', 'json', '--json-schema',
                       json.dumps(SCHEMA), '--no-session-persistence', '--max-budget-usd',
                       f"{request.get('max_budget_usd', 2):g}"]
        else:
            (aux / 'schema.json').write_text(json.dumps(SCHEMA))
            answer = aux / 'answer.txt'
            extra['CODEX_HOME'] = str(root / 'codex-home')
            Path(extra['CODEX_HOME']).mkdir()
            command = [binary, 'exec', '-C', str(cwd), '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
                       '--output-schema', str(aux / 'schema.json'), '-o', str(answer), '-']
        try:
            out = model_call(command, prompt_for(request), child_env(names, home, extra), str(cwd), request['timeout'])
            if answer is not None:
                candidate = answer.read_text() if answer.exists() else None
            else:
                data = envelope(out)
                if data is None or data.get('is_error') is True:
                    raise ModelFailure('grader envelope unreadable or flagged is_error')
                candidate = data['structured_output'] if isinstance(data.get('structured_output'), dict) else data.get('result')
            grades = grades_from(candidate, frozen)
            reason = None if 'ungraded' not in grades.values() else 'the reply gave no valid grade for some IDs'
        except ModelFailure as error:
            grades, reason = {i: 'ungraded' for i in frozen}, str(error)
        return {'grades': grades, 'reason': reason}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main(argv=None):
    role = (argv or sys.argv[1:] or [''])[0]
    signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # the runner's timeout: unwind so the model group dies
    try:
        request = json.loads(sys.stdin.read())
        if role not in ('builder', 'grader') or not isinstance(request, dict):
            raise Refusal('usage: real_adapter.py builder|grader, with a JSON object on stdin')
        binary, names = check(request)
        reply = (builder if role == 'builder' else grader)(request, binary, names)
    except (Refusal, ValueError, KeyError) as error:
        print(f'refusing: {error}', file=sys.stderr)
        return 2
    except ModelFailure as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(reply))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
