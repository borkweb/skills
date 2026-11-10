import json
import os
from pathlib import Path
import signal
import subprocess
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture  # noqa: E402
import support  # noqa: E402


class RunnerBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-run-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / 'out'

    def build(self, **kw):
        self.fx = fixture.build(self.tmp / 'fx', **kw)
        return self.fx

    def only_main_worktree(self):
        listing = support.git(self.fx.repo, 'worktree', 'list', '--porcelain')
        self.assertEqual(listing.count('worktree '), 1, listing)


class WorktreeTests(RunnerBase):
    def test_builder_starts_at_base_and_the_live_repo_is_left_alone(self):
        self.build()
        branches = support.git(self.fx.repo, 'branch', '--list')
        status = support.git(self.fx.repo, 'status', '--porcelain')
        head = support.git(self.fx.repo, 'rev-parse', 'HEAD')
        run = support.replay(self.fx, self.out)
        self.assertEqual(run.returncode, 0, run.stderr)
        record = support.load(support.trial_dir(self.out, 'current') / 'builder-record.json')
        self.assertEqual(record['head_at_start'], self.fx.base)
        self.assertNotEqual(os.path.realpath(record['cwd']), os.path.realpath(self.fx.repo))
        self.assertEqual(support.git(self.fx.repo, 'branch', '--list'), branches)
        self.assertEqual(support.git(self.fx.repo, 'status', '--porcelain'), status)
        self.assertEqual(support.git(self.fx.repo, 'rev-parse', 'HEAD'), head)
        self.only_main_worktree()

    def test_missing_base_commit_is_skipped_without_fetching_and_the_next_case_runs(self):
        self.build(missing_commit=True)
        good = json.loads(self.fx.case_path.read_text())
        # a second, valid case in the same run
        other = fixture.build(self.tmp / 'fx2')
        good_case = json.loads(other.case_path.read_text())
        good_case.update(id='second', repo=dict(good_case['repo'], path=str(other.repo)))
        (Path(self.fx.cases_dir) / 'second.json').write_text(json.dumps(good_case))
        run = support.replay(self.fx, self.out)
        self.assertEqual(run.returncode, 0, run.stderr)
        sha = good['base_commit']
        probe = subprocess.run(['git', '-C', str(self.fx.repo), 'cat-file', '-e', sha + '^{commit}'])
        self.assertNotEqual(probe.returncode, 0)
        summary = support.load(self.out / 'summary.json')
        self.assertEqual([c['case'] for c in summary['skipped_cases']], ['synthetic'])
        self.assertIn('base commit', summary['skipped_cases'][0]['reason'])
        second = support.case_record(self.out, 'second')
        self.assertEqual(second['trials'][0]['outcome'], 'graded')


class GateTests(RunnerBase):
    def test_criteria_text_is_never_executed_and_gate_commands_are_listed(self):
        crit, gate = self.tmp / 'MARKER_CRIT', self.tmp / 'MARKER_GATE'
        self.build(criteria=f'C1: run `touch {crit}` now.\nC2: two.', gates=(f'touch {gate}', 'echo GATE-OK-STRING'))
        work = self.tmp / 'work'
        work.mkdir()
        run = support.replay(self.fx, self.out, cwd=work)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(gate.exists(), 'positive control: the gate command did run')
        self.assertFalse(crit.exists(), 'criteria text was executed')
        self.assertEqual([p for p in Path(work).rglob('MARKER_CRIT')], [])
        record = support.case_record(self.out)
        self.assertEqual(record['gate_commands'], [f'touch {gate}', 'echo GATE-OK-STRING'])
        self.assertEqual([g['command'] for g in record['trials'][0]['gates']], record['gate_commands'])

    def test_gate_naming_the_live_repo_path_is_refused(self):
        self.build(gates=('touch {repo}/LEAK',))
        run = support.replay(self.fx, self.out)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertFalse((self.fx.repo / 'LEAK').exists())
        skipped = support.load(self.out / 'summary.json')['skipped_cases']
        self.assertIn('live repo path', skipped[0]['reason'])

    def test_tilde_and_home_forms_of_the_live_path_are_refused(self):
        for form in ('~', '$HOME', '${HOME}'):
            with self.subTest(form=form):
                self.setUp()
                self.build(gates=(f'touch {form}/repo/LEAK'.replace('{', '{{').replace('}', '}}'),))
                run = support.replay(self.fx, self.out, env={'HOME': str(self.fx.root)})
                self.assertFalse((self.fx.repo / 'LEAK').exists())
                self.assertIn('live repo path', support.load(self.out / 'summary.json')['skipped_cases'][0]['reason'])

    def test_another_worktree_of_the_repo_counts_as_the_live_path(self):
        self.build(gates=('echo x',))
        other = self.fx.root / 'other'
        support.git(self.fx.repo, 'worktree', 'add', '-q', '--detach', str(other))
        case = json.loads(self.fx.case_path.read_text())
        command = f'touch {other}/LEAK'
        case.update(gate_commands=[command], gates_text=f'Gates:\n- G1 `{command}`')
        self.fx.case_path.write_text(json.dumps(case))
        support.replay(self.fx, self.out)
        self.assertFalse((other / 'LEAK').exists())
        self.assertIn('live repo path', support.load(self.out / 'summary.json')['skipped_cases'][0]['reason'])

    def test_builder_that_leaves_uncommitted_changes_is_a_dirty_tree_error(self):
        self.build()
        support.replay(self.fx, self.out, extra=['--fake-builder-mode', 'dirty'])
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('dirty-tree', trial['reason'])
        self.assertEqual(trial['gates'], [], 'no gate runs on a tree the grader cannot see')

    def test_unreviewed_gate_commands_are_refused_even_under_fake(self):
        self.build(reviewed=False)
        run = support.replay(self.fx, self.out)
        self.assertEqual(run.returncode, 2)
        self.assertIn('gate_commands_reviewed', run.stderr)
        self.assertFalse(self.out.exists())

    def test_repo_hooks_do_not_run_during_the_runners_git_calls(self):
        self.build()
        marker = self.tmp / 'hook-ran'
        hook = self.fx.repo / '.git' / 'hooks' / 'post-checkout'
        hook.write_text(f'#!/bin/sh\ntouch {marker}\n')
        hook.chmod(0o755)
        support.replay(self.fx, self.out)
        self.assertFalse(marker.exists())

    def test_gate_runs_in_the_throwaway_worktree(self):
        self.build(gates=('pwd',))
        support.replay(self.fx, self.out)
        trial = support.case_record(self.out)['trials'][0]
        cwd = support.load(support.trial_dir(self.out, 'current') / 'builder-record.json')['cwd']
        self.assertEqual(os.path.realpath(trial['gates'][0]['output'].strip()), os.path.realpath(cwd))
        self.assertNotEqual(os.path.realpath(cwd), os.path.realpath(self.fx.repo))

    def test_gate_timeout_is_an_error_not_a_hang(self):
        self.build(gates=('sleep 30',))
        start = time.monotonic()
        run = support.replay(self.fx, self.out, extra=['--timeout', '1'])
        self.assertLess(time.monotonic() - start, 25)
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('timeout', trial['reason'])

    def test_failed_setup_is_env_unavailable_and_leaves_the_denominator(self):
        self.build(setup_commands=('exit 9',))
        support.replay(self.fx, self.out)
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'env-unavailable')
        arm = support.load(self.out / 'summary.json')['arms']['current']
        self.assertEqual(arm['graded'], 0)
        self.assertEqual(arm['not_graded']['env-unavailable'], 1)
        self.assertIsNone(arm['rate'])

    def test_setup_naming_the_live_repo_path_is_refused(self):
        self.build(setup_commands=('touch {repo}/LEAK',))
        support.replay(self.fx, self.out)
        self.assertFalse((self.fx.repo / 'LEAK').exists())


class CleanupTests(RunnerBase):
    def test_worktree_and_branch_are_gone_after_builder_failure(self):
        self.build()
        branches = support.git(self.fx.repo, 'branch', '--list')
        support.replay(self.fx, self.out, extra=['--fake-builder-mode', 'fail'])
        self.only_main_worktree()
        self.assertEqual(support.git(self.fx.repo, 'branch', '--list'), branches)
        self.assertEqual(support.case_record(self.out)['trials'][0]['outcome'], 'error')

    def test_worktree_is_gone_after_a_failing_gate(self):
        self.build(gates=('exit 3',))
        run = support.replay(self.fx, self.out)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.only_main_worktree()
        self.assertEqual(support.case_record(self.out)['trials'][0]['gates'][0]['exit_code'], 3)

    def test_worktree_is_gone_when_the_runner_itself_raises(self):
        self.build()
        branches = support.git(self.fx.repo, 'branch', '--list')
        run = support.replay(self.fx, self.out, extra=['--inject-fault', 'after-worktree'])
        self.assertNotEqual(run.returncode, 0)
        self.only_main_worktree()
        self.assertEqual(support.git(self.fx.repo, 'branch', '--list'), branches)

    def test_worktree_is_gone_after_sigint_and_exit_is_non_zero(self):
        self.build()
        branches = support.git(self.fx.repo, 'branch', '--list')
        env = os.environ.copy()
        env['AGENT_HANDOFFS_DIR'] = str(self.tmp / 'store')
        proc = subprocess.Popen([sys.executable, str(support.RUNNER), *map(str, support.std_args(
            self.fx, self.out, extra=['--fake-builder-mode', 'sleep']))], env=env, cwd=str(support.ROOT),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        started = support.trial_dir(self.out, 'current') / 'started'
        for _ in range(200):
            if started.exists():
                break
            time.sleep(0.1)
        self.assertTrue(started.exists(), 'fake builder never started')
        proc.send_signal(signal.SIGINT)
        proc.communicate(timeout=60)
        self.assertNotEqual(proc.returncode, 0)
        self.only_main_worktree()
        self.assertEqual(support.git(self.fx.repo, 'branch', '--list'), branches)


    def slow_clone_path(self):
        """A git wrapper on PATH that finishes `clone`, writes a marker, then lingers, so a signal lands in the clone window."""
        real = subprocess.run(['which', 'git'], capture_output=True, text=True).stdout.strip()
        wrapper = self.tmp / 'bin' / 'git'
        wrapper.parent.mkdir()
        self.window = self.tmp / 'window-open'
        wrapper.write_text('#!/bin/sh\ncase " $* " in *" clone "*) ' + real + ' "$@"; rc=$?; touch ' + str(self.window)
                           + '; sleep 30; exit $rc;; esac\nexec ' + real + ' "$@"\n')
        wrapper.chmod(0o755)
        return f'{wrapper.parent}:{os.environ["PATH"]}'

    def scratch_left(self):
        return [p.name for p in (self.tmp / 'tmpdir').glob('replay-*')]

    def test_signal_during_the_clone_leaves_no_scratch_clone_or_branch(self):
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=sig.name):
                self.setUp()
                self.build()
                (self.tmp / 'tmpdir').mkdir()
                branches = support.git(self.fx.repo, 'branch', '--list')
                env = os.environ.copy()
                env.update(AGENT_HANDOFFS_DIR=str(self.tmp / 'store'), PATH=self.slow_clone_path(),
                           TMPDIR=str(self.tmp / 'tmpdir'))
                proc = subprocess.Popen([sys.executable, str(support.RUNNER), *map(str, support.std_args(self.fx, self.out))],
                                        env=env, cwd=str(support.ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                for _ in range(300):
                    if self.window.exists():
                        break
                    time.sleep(0.1)
                self.assertTrue(self.window.exists(), 'the clone window never opened')
                proc.send_signal(sig)
                proc.communicate(timeout=90)
                self.assertNotEqual(proc.returncode, 0)
                self.only_main_worktree()
                self.assertEqual(support.git(self.fx.repo, 'branch', '--list'), branches)
                self.assertEqual(self.scratch_left(), [])

    def test_clone_timeout_is_a_trial_error_and_cleans_up(self):
        self.build()
        (self.tmp / 'tmpdir').mkdir()
        branches = support.git(self.fx.repo, 'branch', '--list')
        run = support.replay(self.fx, self.out, extra=['--timeout', '2'],
                             env={'PATH': self.slow_clone_path(), 'TMPDIR': str(self.tmp / 'tmpdir')})
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('timeout', trial['reason'])
        self.only_main_worktree()
        self.assertEqual(support.git(self.fx.repo, 'branch', '--list'), branches)
        self.assertEqual(self.scratch_left(), [])


class AdapterTests(RunnerBase):
    def spend_args(self, builder, grader=None):
        extra = ['--spend', '--builder-adapter', builder]
        extra += ['--grader-adapter', grader] if grader else ['--fake-grader']
        return [a for a in support.std_args(self.fx, self.out) if a != '--fake'] + extra

    def test_adapter_path_with_spaces_runs(self):
        self.build()
        marker = self.tmp / 'marker'
        builder = support.write_stub(self.tmp / 'dir with space' / 'builder adapter.py', support.STUB_BUILDER)
        run = support.run_cli(support.RUNNER, self.spend_args(builder), env={'STUB_MARKER': str(marker)})
        self.assertTrue(marker.exists(), run.stderr)

    def test_failing_adapter_is_an_error_never_graded_met(self):
        self.build()
        builder = support.write_stub(self.tmp / 'b.py', 'sys.exit(5)\n')
        support.run_cli(support.RUNNER, self.spend_args(builder))
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('adapter', trial['reason'])
        self.assertNotIn('MET', json.dumps(trial.get('grades', {})))

    def test_non_json_adapter_output_is_an_error(self):
        self.build()
        builder = support.write_stub(self.tmp / 'b.py', 'print("not json")\n')
        support.run_cli(support.RUNNER, self.spend_args(builder))
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('adapter', trial['reason'])

    def test_failing_grader_is_an_error(self):
        self.build()
        grader = support.write_stub(self.tmp / 'g.py', 'sys.exit(2)\n')
        args = [a for a in support.std_args(self.fx, self.out) if a != '--fake']
        run = support.run_cli(support.RUNNER, args + ['--fake-builder', '--spend', '--grader-adapter', grader])
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error', run.stderr)

    def test_uncommitted_edit_is_a_no_commit_error_not_an_empty_diff_grade(self):
        self.build()
        support.replay(self.fx, self.out, extra=['--fake-builder-mode', 'no-commit'])
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('no-commit', trial['reason'])

    def test_timeout_adapter_is_an_error(self):
        self.build()
        support.replay(self.fx, self.out, extra=['--fake-builder-mode', 'sleep', '--timeout', '1'])
        trial = support.case_record(self.out)['trials'][0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('timeout', trial['reason'])


class SpendGuardTests(RunnerBase):
    def run_guard(self, spend, builder_fake=False, grader_fake=False, trials=3):
        self.build()
        marker = self.tmp / 'marker'
        stdout_file = self.tmp / 'stdout.txt'
        base = [a for a in support.std_args(self.fx, self.out, trials=trials) if a != '--fake']
        # Stub is named like the built-in fake, so the name alone must not bypass the guard.
        builder = support.write_stub(self.tmp / 'fake_builder.py', support.STUB_BUILDER)
        grader = support.write_stub(self.tmp / 'fake_grader.py', support.STUB_GRADER)
        args = base + (['--fake-builder'] if builder_fake else ['--builder-adapter', builder])
        args += ['--fake-grader'] if grader_fake else ['--grader-adapter', grader]
        args += ['--spend'] if spend else []
        env = os.environ.copy()
        env.update(STUB_MARKER=str(marker), STUB_STDOUT_FILE=str(stdout_file), AGENT_HANDOFFS_DIR=str(self.tmp / 'store'))
        with stdout_file.open('w') as handle:
            run = subprocess.run([sys.executable, str(support.RUNNER), *map(str, args)], stdout=handle,
                                 stderr=subprocess.PIPE, text=True, env=env, cwd=str(support.ROOT))
        return run, marker, stdout_file.read_text()

    def test_non_fake_builder_is_refused_without_spend(self):
        run, marker, out = self.run_guard(spend=False, grader_fake=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertIn('--spend', out + run.stderr)

    def test_non_fake_grader_is_refused_without_spend(self):
        run, marker, out = self.run_guard(spend=False, builder_fake=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertIn('--spend', out + run.stderr)

    def test_refusal_prints_the_planned_counts(self):
        run, marker, out = self.run_guard(spend=False, grader_fake=True)
        self.assertIn('6 builder calls', out + run.stderr)
        self.assertIn('6 grader calls', out + run.stderr)

    def test_with_spend_the_count_prints_before_the_first_adapter_call(self):
        run, marker, out = self.run_guard(spend=True, grader_fake=True)
        self.assertTrue(marker.exists(), run.stderr)
        self.assertIn('6 builder calls, 6 grader calls', marker.read_text())
        self.assertIn('6 builder calls, 6 grader calls', out)

    def test_output_inside_a_git_work_tree_is_refused_and_otherwise_mode_700(self):
        self.build()
        inside = self.fx.repo / 'results'
        run = support.run_cli(support.RUNNER, support.std_args(self.fx, inside))
        self.assertEqual(run.returncode, 2)
        self.assertIn('git work tree', run.stderr)
        self.assertFalse(inside.exists())
        run = support.replay(self.fx, self.out)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(self.out.stat().st_mode & 0o777, 0o700)

    def test_trials_zero_or_negative_is_refused_before_any_worktree(self):
        self.build()
        for trials in ['0', '-2']:
            with self.subTest(trials=trials):
                run = support.run_cli(support.RUNNER, support.std_args(self.fx, self.out, trials=trials))
                self.assertNotEqual(run.returncode, 0)
                self.assertFalse(self.out.exists())
                self.only_main_worktree()


if __name__ == '__main__':
    unittest.main()
