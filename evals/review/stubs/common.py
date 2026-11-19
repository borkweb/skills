"""Install local CLI stubs. All controls live beside the stub, never in child env."""
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import subprocess
import sys
import time


def install(directory, **config):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(Path(__file__).with_name('claude'), directory / '_claude')
    wrapper = directory / 'claude'
    wrapper.write_text(f'#!{sys.executable}\nimport runpy\nrunpy.run_path({str(Path(__file__).resolve())!r}, '
                       f'run_name="__main__", init_globals={{"STUB_DIR": {str(directory.resolve())!r}}})\n')
    wrapper.chmod(0o700)
    configure(directory, **config)
    return directory


def configure(directory, **config):
    (Path(directory) / 'control.json').write_text(json.dumps(config))
    # The shipped stub remains unchanged, with its existing settings file protocol.
    (Path(directory) / 'stub_config.json').write_text(json.dumps(config))


def calls(directory):
    path = Path(directory) / 'events.jsonl'
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def _append(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, (json.dumps(value, ensure_ascii=True) + '\n').encode())
    finally:
        os.close(fd)


def _main():
    # CoreFoundation injects this process-local key during Python startup on
    # macOS (also covered by test_adapter_claude). It was not in the exec env.
    os.environ.pop('__CF_USER_TEXT_ENCODING', None)
    here = Path(STUB_DIR)
    cfg = json.loads((here / 'control.json').read_text())
    argv = sys.argv[1:]
    if '--version' in argv:
        print('2.1.328 (Claude Code stub)')
        return
    stdin = sys.stdin.read()
    grade = '--json-schema' in argv
    work = next((p for p in Path.cwd().parents if p.parent.name == 'eval-work'), None)
    event = dict(pid=os.getpid(), kind='grade' if grade else 'review', argv=argv,
                 stdin=stdin, cwd=os.getcwd(), env=dict(os.environ), at=time.time(), event='start',
                 cwd_entries=sorted(p.name for p in Path.cwd().iterdir()),
                 head_file=(Path.cwd() / 'file.txt').read_text() if (Path.cwd() / 'file.txt').is_file() else None,
                 snapshots=len(list(work.glob('s*'))) if work else 0)
    _append(here / 'events.jsonl', event)
    if cfg.get('ignore_term'):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen([sys.executable, '-c',
                                  'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'],
                                 env={k: v for k, v in os.environ.items() if k in ('PATH', 'LANG')})
        _append(here / 'pids.jsonl', {'pid': os.getpid(), 'child': child.pid})
        time.sleep(60)
    time.sleep(cfg.get('grade_delay' if grade else 'delay', .05))
    try:
        if not grade and cfg.get('modify_review_copy'):
            (Path.cwd() / 'review-only').write_text('review mutation')
        if cfg.get('stderr_size'):
            sys.stderr.write('z' * cfg['stderr_size'] + os.environ.get('CLAUDE_CODE_OAUTH_TOKEN', '') + '\n')
        if grade and not cfg.get('grade_mode'):
            schema = json.loads(argv[argv.index('--json-schema') + 1])
            props = schema['properties']
            if 'expected' in props:
                parsed = {'reported': cfg.get('reported', []),
                          'expected': {k: cfg.get('expected_status', 'miss') for k in props['expected']['properties']},
                          'verdict': cfg.get('verdict')}
            else:
                labels = props['groups']['items']['properties']['members']['items']['enum']
                parsed = {'groups': [{'group': f'G{i}', 'members': [label], 'ruling': cfg.get('ruling', 'real')}
                                     for i, label in enumerate(labels)]}
            if cfg.get('grade_rate_limit'):
                print(json.dumps({'is_error': True, 'result': 'rate limit reached', 'type': 'result'}))
            else:
                grade_count = sum(e['kind'] == 'grade' and e['event'] == 'start' for e in calls(here))
                if cfg.get('bad_match_n') == grade_count and 'expected' in props:
                    parsed = {'not': 'a match'}
                print(json.dumps({'type': 'result', 'is_error': False, 'structured_output': parsed,
                                  'usage': cfg.get('grade_usage', cfg.get('usage', {'input_tokens': 100, 'output_tokens': 10,
                                                          'cache_read_input_tokens': 0}))}))
        else:
            sys.stdin = io.StringIO(stdin)
            try:
                runpy.run_path(str(here / '_claude'), run_name='__main__')
            except SystemExit as exc:
                if exc.code:
                    raise
    finally:
        _append(here / 'events.jsonl', dict(event='end', pid=os.getpid(), kind=event['kind'], at=time.time()))


if __name__ == '__main__':
    _main()
