"""Runner hardening: process groups, the sealed diff, git env and filters, the disposable clone, reviewed gates."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture  # noqa: E402
import support  # noqa: E402


class HardBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-hard-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / 'out'
        self.tmpdir = self.tmp / 'tmpdir'
        self.tmpdir.mkdir()
        self.pidfile = self.tmp / 'pids.json'
        self.addCleanup(support.kill_pids, self.pidfile)

    def build(self, **kw):
        self.fx = fixture.build(self.tmp / 'fx', **kw)
        return self.fx

    def replay(self, extra=(), env=None):
        env = dict(env or {})
        env.setdefault('TMPDIR', str(self.tmpdir))
        return support.replay(self.fx, self.out, extra=extra, env=env)

    def scratch_left(self):
        return [p.name for p in self.tmpdir.glob('replay-*')]

    def only_main_worktree(self):
        listing = support.git(self.fx.repo, 'worktree', 'list', '--porcelain')
        self.assertEqual(listing.count('worktree '), 1, listing)

    def background_gate(self, pidfile=None):
        """A command that backgrounds a long sleep, records its pid and waits."""
        return f"sh -c 'sleep 300 & echo $! > {pidfile or self.pidfile}; wait'"

    def sleeper_pid(self):
        return int(Path(self.pidfile).read_text().strip())


class ProcessGroupTests(HardBase):
    def test_x1_a_timed_out_gate_kills_its_grandchildren(self):
        self.build(gates=(self.background_gate(),))
        run = self.replay(['--timeout', '2'])
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertTrue(support.pid_dead(self.sleeper_pid()))

    def test_x1_a_timed_out_setup_command_kills_its_grandchildren(self):
        self.build(setup_commands=(self.background_gate(),))
        self.replay(['--timeout', '2'])
        self.assertTrue(support.pid_dead(self.sleeper_pid()))
        self.assertEqual(support.case_record(self.out)['trials'][0]['outcome'], 'env-unavailable')

    def test_x1_a_timed_out_adapter_kills_its_grandchildren(self):
        self.build()
        body = ('import subprocess, time\nsys.stdin.read()\n'
                f'p = subprocess.Popen(["sleep", "300"]); open({str(self.pidfile)!r}, "w").write(str(p.pid))\n'
                'time.sleep(300)\n')
        builder = support.write_stub(self.tmp / 'b.py', body)
        args = [a for a in support.std_args(self.fx, self.out) if a != '--fake'] + [
            '--spend', '--builder-adapter', builder, '--fake-grader', '--timeout', '2']
        run = support.run_cli(support.RUNNER, args, env={'TMPDIR': str(self.tmpdir)})
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertTrue(support.pid_dead(self.sleeper_pid()))

    def test_x1_sigint_during_a_gate_kills_the_whole_group_and_cleans_up(self):
        self.build(gates=(self.background_gate(),))
        env = os.environ.copy()
        env.update(AGENT_HANDOFFS_DIR=str(self.tmp / 'store'), TMPDIR=str(self.tmpdir))
        proc = subprocess.Popen([sys.executable, str(support.RUNNER), *map(str, support.std_args(self.fx, self.out))],
                                env=env, cwd=str(support.ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(200):
            if self.pidfile.exists() and self.pidfile.read_text().strip():
                break
            time.sleep(0.1)
        pid = self.sleeper_pid()
        proc.send_signal(signal.SIGINT)
        proc.communicate(timeout=60)
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue(support.pid_dead(pid))
        self.assertEqual(self.scratch_left(), [])


class GitHardeningTests(HardBase):
    def wrapper_path(self, log):
        real = shutil.which('git')
        wrapper = self.tmp / 'wrap' / 'git'
        wrapper.parent.mkdir()
        wrapper.write_text(f'#!/bin/sh\necho "${{GIT_NO_LAZY_FETCH:-unset}}" >> {log}\nexec {real} "$@"\n')
        wrapper.chmod(0o755)
        return f'{wrapper.parent}:{os.environ["PATH"]}'

    def test_x3_every_runner_git_call_sets_no_lazy_fetch(self):
        self.build()
        log = self.tmp / 'git-env.log'
        run = self.replay(env={'PATH': self.wrapper_path(log)})
        self.assertEqual(run.returncode, 0, run.stderr)
        values = log.read_text().split()
        self.assertGreater(len(values), 10)
        self.assertEqual(set(values), {'1'})

    def test_x2_the_sealed_diff_ignores_repo_diff_config_and_runs_no_external_program(self):
        self.build()
        marker = self.tmp / 'EXTERNAL-RAN'
        script = self.tmp / 'ext.sh'
        script.write_text(f'#!/bin/sh\ntouch {marker}\necho EXTERNAL-OUTPUT\n')
        script.chmod(0o755)
        # planted in the live repo's config and, by the fake builder, in the trial repo's config
        live = self.fx.repo / '.git' / 'config'
        live.write_text(live.read_text() + f'[diff]\n\texternal = {script}\n\tnoprefix = true\n[color]\n\tdiff = always\n')
        run = self.replay(['--fake-builder-mode', 'plant', '--gate-env', 'FAKE_PLANT_EXTERNAL'], env={'FAKE_PLANT_EXTERNAL': str(script)})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertFalse(marker.exists(), 'a diff program ran')
        sealed = (support.trial_dir(self.out, 'current') / 'grader-stdin.json').read_text()
        diff = json.loads(sealed)['diff']
        self.assertIn('+++ b/fake-builder.txt', diff)
        self.assertIn('+FAKE-BUILDER-ADDED-LINE', diff)
        self.assertNotIn('\x1b', diff)
        self.assertNotIn('EXTERNAL-OUTPUT', diff)

    def test_x4_a_slow_smudge_filter_in_the_live_repo_never_runs(self):
        self.build()
        repo = self.fx.repo
        (repo / '.gitattributes').write_text('*.txt filter=slow\n')
        support.git(repo, 'add', '.gitattributes')
        support.git(repo, 'commit', '-q', '-m', 'attributes')
        base = support.git(repo, 'rev-parse', 'HEAD')
        case = json.loads(self.fx.case_path.read_text())
        case['base_commit'] = base
        self.fx.case_path.write_text(json.dumps(case))
        marker = self.tmp / 'SMUDGE-RAN'
        cfg = repo / '.git' / 'config'
        slow = self.tmp / 'slow-smudge.sh'
        slow.write_text(f'#!/bin/sh\ntouch {marker}\nsleep 30\ncat\n')
        slow.chmod(0o755)
        cfg.write_text(cfg.read_text() + f'[filter "slow"]\n\tsmudge = {slow}\n')
        start = time.monotonic()
        run = self.replay(['--timeout', '20'])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertFalse(marker.exists(), 'the live repo\'s smudge filter ran')
        self.assertLess(time.monotonic() - start, 20)
        self.assertEqual(support.case_record(self.out)['trials'][0]['outcome'], 'graded')

    def test_x6_candidates_without_review_are_refused_by_check_and_by_a_run(self):
        self.build(reviewed=False)
        case = json.loads(self.fx.case_path.read_text())
        case.update(gate_commands=[], gate_command_candidates=['echo GATE-OK-STRING'])
        self.fx.case_path.write_text(json.dumps(case))
        for args in (['--check', '--cases', self.fx.cases_dir], support.std_args(self.fx, self.out)):
            run = support.run_cli(support.RUNNER, args)
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertIn('gate_commands_reviewed', run.stderr)
        self.assertFalse(self.out.exists())
        case['gate_commands_reviewed'] = True
        self.fx.case_path.write_text(json.dumps(case))
        run = support.run_cli(support.RUNNER, ['--check', '--cases', self.fx.cases_dir])
        self.assertEqual(run.returncode, 0, run.stderr)


class CloneTests(HardBase):
    def test_the_trial_repo_is_a_disposable_clone_that_does_not_point_at_the_live_repo(self):
        self.build()
        branches = support.git(self.fx.repo, 'branch', '--list')
        run = self.replay(['--fake-builder-mode', 'inspect', '--gate-env', 'FAKE_LIVE_PATH'], env={'FAKE_LIVE_PATH': str(self.fx.repo)})
        self.assertEqual(run.returncode, 0, run.stderr)
        record = support.load(support.trial_dir(self.out, 'current') / 'builder-record.json')
        self.assertEqual(record['live_path_hits'], [])
        self.assertEqual(record['remotes'], [])
        self.assertFalse(record['dot_git_is_file'], 'a worktree has a .git file; a clone has a directory')
        self.assertTrue(record['branch'].startswith('replay/'))
        self.assertEqual(support.git(self.fx.repo, 'branch', '--list'), branches)
        self.only_main_worktree()
        self.assertEqual(self.scratch_left(), [])

    def test_a_read_only_clone_is_still_removed(self):
        self.build()
        run = self.replay(['--fake-builder-mode', 'readonly'])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(support.case_record(self.out)['trials'][0]['outcome'], 'graded', 'the readonly mode must run')
        self.assertEqual(self.scratch_left(), [])

    def test_a_clone_failure_is_a_trial_error_and_leaves_nothing(self):
        self.build()
        real = shutil.which('git')
        wrapper = self.tmp / 'wrap' / 'git'
        wrapper.parent.mkdir()
        wrapper.write_text(f'#!/bin/sh\ncase " $* " in *" fetch "*) echo clone-broke >&2; exit 1;; esac\nexec {real} "$@"\n')
        wrapper.chmod(0o755)
        self.replay(env={'PATH': f'{wrapper.parent}:{os.environ["PATH"]}'})
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('clone-broke', trial['reason'])
        self.assertEqual(self.scratch_left(), [])


ALLOWED = {'PATH', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'HOME', 'AGENT_HANDOFFS_DIR',
           'BORK_REPO_RULES_DIR', 'PWD', 'OLDPWD', 'SHLVL', '_', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
           'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
           'REQUESTS_CA_BUNDLE', '__CF_USER_TEXT_ENCODING', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'}
HOSTILE_NAMES = ('GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
                 'SERVICE_OAUTH_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET',
                 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CODEX_COMPANION_SESSION_ID', 'CODEX_SESSION_ID', 'SSH_AUTH_SOCK',
                 'CODEX_HOME', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
                 'CODEX_API_KEY', 'CLAUDE_CODE_SESSION_ID', 'HERDR_ENV', 'HERDR_PANE_ID', 'BORK_RUN_DIR', 'BORK_RUNS_HOME',
                 'BORK_RUN_ID', 'ORCHESTRATOR_HOME', 'FOO')


class GateEnvTests(HardBase):
    def hostile(self):
        home = self.tmp / 'realhome'
        home.mkdir()
        env = support.hostile_user_env(self.tmp)
        env.update(HOME=str(home), ANTHROPIC_API_KEY='sk-ant-GATE-12345678', OPENAI_API_KEY='sk-oai-GATE-12345678',
                   CODEX_API_KEY='ck-GATE-12345678')
        return home, env

    def env_lines(self, text):
        return dict(line.split('=', 1) for line in text.splitlines() if '=' in line and not line.startswith(' '))

    def test_b1_gates_and_setup_run_with_the_scrubbed_env(self):
        home, hostile = self.hostile()
        setup_out = self.tmp / 'setup-env.txt'
        self.build(gates=('env',), setup_commands=(f'env > {setup_out}',))
        run = self.replay(env=hostile)
        self.assertEqual(run.returncode, 0, run.stderr)
        trial = support.case_record(self.out)['trials'][0]
        for label, text in (('gate', trial['gates'][0]['output']), ('setup', setup_out.read_text())):
            seen = self.env_lines(text)
            self.assertTrue(seen, label)
            for name in HOSTILE_NAMES:
                self.assertNotIn(name, seen, f'{label} saw {name}')
            self.assertEqual(set(seen) - ALLOWED, set(), f'{label} saw a name outside the allowlist')
            self.assertNotIn(str(home), text, label)
            self.assertNotEqual(seen['HOME'], str(home))
            trials = os.path.realpath(self.out / 'trials')
            for name in ('HOME', 'AGENT_HANDOFFS_DIR', 'BORK_REPO_RULES_DIR'):
                self.assertTrue(os.path.realpath(seen[name]).startswith(trials + os.sep), f'{label} {name}={seen[name]}')
        self.assertIs(support.case_record(self.out)['gates_real_home'], False)

    def test_b10_gate_env_names_are_forwarded_only_when_passed_and_are_recorded(self):
        home, hostile = self.hostile()
        self.build(gates=('env',))
        run = self.replay(['--gate-env', 'FOO'], env=hostile)
        self.assertEqual(run.returncode, 0, run.stderr)
        seen = self.env_lines(support.case_record(self.out)['trials'][0]['gates'][0]['output'])
        self.assertEqual(seen.get('FOO'), 'bar')
        for name in HOSTILE_NAMES:
            if name != 'FOO':
                self.assertNotIn(name, seen, name)
        self.assertEqual(support.case_record(self.out)['gate_env'], ['FOO'])
        self.setUp()
        self.build(gates=('env',))
        self.replay(env=hostile)
        self.assertEqual(support.case_record(self.out)['gate_env'], [])
        self.assertNotIn('FOO', self.env_lines(support.case_record(self.out)['trials'][0]['gates'][0]['output']))

    def test_b10_a_bad_gate_env_name_is_refused(self):
        self.build()
        for name in ('', 'A=B', 'has space', '1X'):
            run = support.run_cli(support.RUNNER, support.std_args(self.fx, self.out, extra=['--gate-env', name]))
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertFalse(self.out.exists())

    def test_b10_the_runners_own_git_calls_get_the_allowlist_env_only(self):
        home, hostile = self.hostile()
        self.build()
        log = self.tmp / 'git-env.log'
        real = shutil.which('git')
        wrapper = self.tmp / 'wrap' / 'git'
        wrapper.parent.mkdir()
        wrapper.write_text(f'#!/bin/sh\n{{ echo ---; env; }} >> {log}\nexec {real} "$@"\n')
        wrapper.chmod(0o755)
        hostile['PATH'] = f'{wrapper.parent}:{os.environ["PATH"]}'
        run = self.replay(env=hostile)
        self.assertEqual(run.returncode, 0, run.stderr)
        calls = log.read_text().split('---\n')[1:]
        self.assertGreater(len(calls), 10)
        for call in calls:
            names = {line.split('=', 1)[0] for line in call.splitlines() if '=' in line and not line.startswith(' ')}
            for name in HOSTILE_NAMES:
                self.assertNotIn(name, names, f'a runner git call saw {name}')

    def test_b10_custom_adapters_get_the_allowlist_env_and_gate_env_names(self):
        home, hostile = self.hostile()
        self.build()
        dump = 'json.dump(dict(os.environ), open(os.environ["DUMP_TO"] + os.path.basename(sys.argv[0]), "w"))\nsys.stdin.read()\n'
        builder = support.write_stub(self.tmp / 'b.py', dump + 'print(json.dumps({"status": "ok"}))\n')
        grader = support.write_stub(self.tmp / 'g.py', dump + 'print(json.dumps({"grades": {}}))\n')
        hostile['DUMP_TO'] = str(self.tmp / 'env-')
        base = [a for a in support.std_args(self.fx, self.out) if a != '--fake'] + ['--spend', '--gate-env', 'DUMP_TO']
        support.run_cli(support.RUNNER, base + ['--builder-adapter', builder, '--fake-grader'], env=hostile)
        self.out = self.tmp / 'out2'
        base = [a for a in support.std_args(self.fx, self.out) if a != '--fake'] + ['--spend', '--gate-env', 'DUMP_TO']
        support.run_cli(support.RUNNER, base + ['--fake-builder', '--grader-adapter', grader], env=hostile)
        for name in ('b.py', 'g.py'):
            seen = json.loads(Path(str(self.tmp / 'env-') + name).read_text())
            for hostile_name in HOSTILE_NAMES:
                self.assertNotIn(hostile_name, seen, f'{name} saw {hostile_name}')
            self.assertIn('DUMP_TO', seen)

    def test_b1_gates_real_home_is_opt_in_and_recorded_in_the_case_json(self):
        home, hostile = self.hostile()
        self.build(gates=('env',))
        run = self.replay(['--gates-real-home'], env=hostile)
        self.assertEqual(run.returncode, 0, run.stderr)
        seen = self.env_lines(support.case_record(self.out)['trials'][0]['gates'][0]['output'])
        self.assertEqual(seen['HOME'], str(home))
        for name in HOSTILE_NAMES:
            self.assertNotIn(name, seen, name)
        self.assertIs(support.case_record(self.out)['gates_real_home'], True)


class ReadOnlyGitDirTests(HardBase):
    def test_b11_a_planted_clean_filter_never_runs_even_when_the_builder_locks_the_git_dir(self):
        self.build()
        marker = self.tmp / 'FILTER-RAN'
        script = self.tmp / 'clean.sh'
        script.write_text(f'#!/bin/sh\nenv > {marker}\ncat\n')
        script.chmod(0o755)
        run = self.replay(['--fake-builder-mode', 'filter-readonly', '--gate-env', 'FAKE_FILTER_SCRIPT'],
                          env={'FAKE_FILTER_SCRIPT': str(script), 'HERDR_ENV': '1', 'ANTHROPIC_API_KEY': 'sk-ant-FILTER-12345678'})
        self.assertFalse(marker.exists(), 'the runner ran the builder\'s clean filter' + (marker.read_text()[:300] if marker.exists() else ''))
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error', run.stderr)
        self.assertEqual(self.scratch_left(), [])


class CommonDirRedirectTests(HardBase):
    """B14: `.git/commondir` redirects git's config lookup to a directory the builder wrote."""

    def planted_filter(self):
        self.build()
        marker = self.tmp / 'FILTER-RAN'
        script = self.tmp / 'clean.sh'
        script.write_text(f'#!/bin/sh\nenv > {marker}\ncat\n')
        script.chmod(0o755)
        return marker, {'FAKE_FILTER_SCRIPT': str(script), 'HERDR_ENV': '1', 'ANTHROPIC_API_KEY': 'sk-ant-FILTER-12345678'}

    def run_planted(self, env, extra=()):
        return self.replay(['--fake-builder-mode', 'commondir', '--gate-env', 'FAKE_FILTER_SCRIPT', *extra], env=env)

    def test_b14_a_planted_commondir_filter_never_runs_and_the_trial_is_refused(self):
        marker, env = self.planted_filter()
        run = self.run_planted(env)
        self.assertFalse(marker.exists(), 'the runner ran a clean filter from a planted commondir: ' + (marker.read_text()[:200] if marker.exists() else ''))
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error', run.stderr)
        self.assertIn('commondir', trial['reason'])
        self.assertEqual(self.scratch_left(), [])

    def test_b14_the_git_dir_override_alone_keeps_a_planted_commondir_filter_from_running(self):
        marker, env = self.planted_filter()
        self.run_planted(env, ['--inject-fault', 'skip-redirect-refusal'])
        self.assertFalse(marker.exists(), 'with the refusal off, the runner ran a clean filter from a planted commondir: ' + (marker.read_text()[:200] if marker.exists() else ''))
        trial = support.case_record(self.out)['trials'][0]
        self.assertNotIn('commondir', trial['reason'] or '', 'the refusal was supposed to be off')

    def test_b14_a_planted_gitdir_file_is_refused_too(self):
        marker, env = self.planted_filter()
        run = self.replay(['--fake-builder-mode', 'gitdir-file', '--gate-env', 'FAKE_FILTER_SCRIPT'], env=env)
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error', run.stderr)
        self.assertIn('gitdir', trial['reason'])

    def test_b14_live_repo_git_calls_keep_their_own_repo(self):
        # The override is for trial-repo calls only: a case whose base commit is missing is still found missing in the
        # live repo, and a normal run still clones from it.
        self.build()
        run = self.replay()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(support.case_record(self.out)['trials'][0]['outcome'], 'graded')


class AdapterHomeTests(HardBase):
    """B15: a custom adapter gets an empty HOME, never the real one: the builder's under the trial dir, the grader's apart."""

    def test_b15_builder_and_grader_adapters_get_separate_empty_homes_the_graders_outside_the_trial_dir(self):
        real_home = self.tmp / 'realhome'
        real_home.mkdir()
        (real_home / 'secret').write_text('x')
        self.build()
        dump = ('h = os.environ.get("HOME")\n'
                'open(os.environ["DUMP_TO"] + os.path.basename(sys.argv[0]), "w").write(json.dumps({"home": h, '
                '"exists": os.path.isdir(h or ""), "entries": os.listdir(h) if h and os.path.isdir(h) else None}))\n'
                'sys.stdin.read()\n')
        commit = ('request = json.loads(sys.stdin.read())\n'
                  'open("b.txt", "w").write("b\\n")\n'
                  'for cmd in (["add", "b.txt"], ["-c", "user.name=b", "-c", "user.email=b@example.invalid", "commit", "-q", "-m", "b"]):\n'
                  '    subprocess.run(["git", *cmd], check=True, cwd=request["worktree"])\n')
        builder = support.write_stub(self.tmp / 'b.py', 'import subprocess\n' + dump.replace('sys.stdin.read()\n', '') + commit + 'print(json.dumps({"status": "ok"}))\n')
        grader = support.write_stub(self.tmp / 'g.py', dump + 'print(json.dumps({"grades": {}}))\n')
        env = {'HOME': str(real_home), 'DUMP_TO': str(self.tmp / 'home-'), 'TMPDIR': str(self.tmpdir)}
        base =[a for a in support.std_args(self.fx, self.out) if a != '--fake'] + ['--spend', '--gate-env', 'DUMP_TO']
        run = support.run_cli(support.RUNNER, base + ['--builder-adapter', builder, '--grader-adapter', grader], env=env)
        seen = {n: json.loads(Path(str(self.tmp / 'home-') + n).read_text()) for n in ('b.py', 'g.py')}
        trials = os.path.realpath(self.out / 'trials')
        out = os.path.realpath(self.out)
        for name, record in seen.items():
            self.assertIsNotNone(record['home'], f'{name} got no HOME')
            self.assertNotEqual(os.path.realpath(record['home']), os.path.realpath(real_home), name)
            self.assertTrue(record['exists'], name)
            self.assertEqual(record['entries'], [], f'{name} HOME is not empty')
        # The builder's HOME is under the trial output dir. The grader's is not: the trial dir holds the builder's
        # result file, handoff and reply, so a grader HOME there would reach them through `..` (blinding, C6a).
        self.assertTrue(os.path.realpath(seen['b.py']['home']).startswith(trials + os.sep), seen['b.py']['home'])
        self.assertFalse(os.path.realpath(seen['g.py']['home']).startswith(out + os.sep), seen['g.py']['home'])
        self.assertFalse(Path(seen['g.py']['home']).exists(), 'the grader HOME was not removed')
        self.assertEqual(self.scratch_left(), [])
        self.assertNotEqual(seen['b.py']['home'], seen['g.py']['home'])


class LivePathInCaseTextTests(HardBase):
    def test_b2_a_case_naming_the_live_repo_in_any_text_field_is_skipped_naming_the_field(self):
        for field in ('goal', 'owned_files', 'criteria', 'gates_text'):
            with self.subTest(field=field):
                self.setUp()
                self.build()
                case = json.loads(self.fx.case_path.read_text())
                live = str(self.fx.repo)
                case[field] = (f'work in {live}' if field in ('goal', 'owned_files')
                               else case[field] + (f'\nC9: `cd {live} && true` works' if field == 'criteria' else f'\nnote: {live}'))
                self.fx.case_path.write_text(json.dumps(case))
                run = self.replay()
                self.assertEqual(run.returncode, 0, run.stderr)
                record = support.case_record(self.out)
                self.assertEqual(record['status'], 'skipped')
                self.assertIn(field, record['reason'])
                self.assertIn('live repo path', record['reason'])
                self.assertEqual({t['outcome'] for t in record['trials']}, {'skipped'})


class SymlinkTests(HardBase):
    def victim_run(self, mode, victim_is_dir=False):
        self.build()
        victim = self.tmp / 'victim'
        if victim_is_dir:
            victim.mkdir()
            (victim / 'config').write_text('USER FILE CONTENT\n')
            watched = victim / 'config'
        else:
            victim.write_text('USER FILE CONTENT\n')
            watched = victim
        run = self.replay(['--fake-builder-mode', mode, '--gate-env', 'FAKE_VICTIM'], env={'FAKE_VICTIM': str(victim)})
        self.assertEqual(watched.read_text(), 'USER FILE CONTENT\n', 'the runner wrote through a symlink the builder planted')
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error', run.stderr)
        self.assertRegex(trial['reason'], r'symlink|regular file|real directory')
        self.assertEqual(self.scratch_left(), [])

    def test_b3_a_symlinked_git_config_is_refused_and_the_victim_is_unchanged(self):
        self.victim_run('symlink-config')

    def test_b3_a_symlinked_builder_reply_is_refused_and_the_victim_is_unchanged(self):
        self.victim_run('symlink-reply')

    def test_b3_a_symlinked_grader_reply_is_refused_and_the_victim_is_unchanged(self):
        self.victim_run('symlink-grader-reply')

    def test_b3_a_trial_repo_whose_dot_git_is_a_symlink_is_refused(self):
        self.victim_run('symlink-git', victim_is_dir=True)


class OneRefCloneTests(HardBase):
    def test_b4_the_trial_repo_has_one_ref_no_post_base_commit_no_tags_and_no_hardlinks(self):
        self.build()
        repo = self.fx.repo
        support.git(repo, 'tag', 'base-light')  # tags on the base commit itself: only --no-tags keeps them out
        support.git(repo, 'tag', '-a', 'base-ann', '-m', 'annotated base tag')
        (repo / 'post.txt').write_text('the fix\n')
        support.git(repo, 'add', 'post.txt')
        support.git(repo, 'commit', '-q', '-m', 'post-base fix naming C2')
        post = support.git(repo, 'rev-parse', 'HEAD')
        support.git(repo, 'tag', 'light')
        support.git(repo, 'tag', '-a', 'ann', '-m', 'annotated')
        support.git(repo, 'branch', 'extra', self.fx.base)
        run = self.replay(['--fake-builder-mode', 'inspect', '--gate-env', 'FAKE_LIVE_PATH', '--gate-env', 'FAKE_POST_BASE'],
                          env={'FAKE_LIVE_PATH': str(repo), 'FAKE_POST_BASE': post})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(support.git(repo, 'cat-file', '-t', post), 'commit', 'positive control: the live repo has it')
        record = support.load(support.trial_dir(self.out, 'current') / 'builder-record.json')
        self.assertEqual(len(record['refs']), 1, record['refs'])
        self.assertTrue(record['refs'][0].startswith('refs/heads/replay/'))
        self.assertFalse(record['has_post_base'], 'the post-base commit is present in the trial repo')
        self.assertEqual(record['max_nlink'], 1, 'an object file is hardlinked to the live repo')
        self.assertEqual(record['live_path_hits'], [])


class InformationalTests(HardBase):
    def test_x2_with_the_config_restore_skipped_the_diff_flags_alone_stop_the_planted_driver(self):
        self.build()
        marker = self.tmp / 'EXTERNAL-RAN'
        script = self.tmp / 'ext.sh'
        script.write_text(f'#!/bin/sh\ntouch {marker}\necho EXTERNAL-OUTPUT\n')
        script.chmod(0o755)
        run = self.replay(['--fake-builder-mode', 'plant', '--inject-fault', 'skip-config-restore', '--gate-env', 'FAKE_PLANT_EXTERNAL'],
                          env={'FAKE_PLANT_EXTERNAL': str(script)})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertFalse(marker.exists(), 'a diff program ran')
        diff = json.loads((support.trial_dir(self.out, 'current') / 'grader-stdin.json').read_text())['diff']
        self.assertIn('+++ b/fake-builder.txt', diff)
        self.assertNotIn('\x1b', diff)
        self.assertNotIn('EXTERNAL-OUTPUT', diff)

    def test_max_budget_must_be_finite_and_positive_in_the_runner(self):
        self.build()
        for value in ('nan', 'inf', '-inf', '0', '-1'):
            with self.subTest(value=value):
                run = support.run_cli(support.RUNNER, support.std_args(self.fx, self.out, extra=['--max-budget-usd', value]))
                self.assertEqual(run.returncode, 2, run.stderr)
                self.assertIn('max-budget-usd', run.stderr)
                self.assertFalse(self.out.exists())


class ReplayReadmeTests(unittest.TestCase):
    def test_x7_output_section_documents_the_token_dir_and_manual_step_four_names_the_review_field(self):
        text = (support.HERE / 'README.md').read_text()
        output = text[text.index('### Output'):text.index('### Fake adapters')]
        self.assertIn('trials/<token>/', output)
        self.assertNotIn('trials/<case id>', text)
        self.assertRegex(output, r'cases/<case id>\.json.*maps each token back')
        step4 = [line for line in text.splitlines() if line.startswith('4. Write `<case id>.json`')]
        self.assertEqual(len(step4), 1)
        self.assertIn('gate_commands_reviewed', step4[0])


if __name__ == '__main__':
    unittest.main()
