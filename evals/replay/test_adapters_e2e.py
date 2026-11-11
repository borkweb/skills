"""The runner with the real adapters selected, end to end on the synthetic fixture. Stub claude and codex only."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture  # noqa: E402
import render  # noqa: E402
import support  # noqa: E402

README = support.ROOT / 'evals' / 'README.md'
HARNESSES = ('claude', 'codex')


class RealBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-real-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / 'out'
        self.fx = fixture.build(self.tmp / 'fx')
        self.bin = support.stub_bin(self.tmp)
        self.pidfile = self.tmp / 'pids.json'
        self.addCleanup(support.kill_pids, self.pidfile)

    def configure(self, **cfg):
        support.set_stub_config(self.bin, cfg)

    def go(self, harness='claude', **kw):
        return support.run_real(self.fx, self.out, self.bin, self.tmp, harness, **kw)

    def calls(self, role=None):
        return support.stub_calls(self.bin, role)

    def trials(self):
        return support.case_record(self.out)['trials']

    def scratch_left(self):
        return [p.name for p in (self.tmp / 'tmpdir').glob('replay-*')]


class BriefTests(RealBase):
    def test_builder_prompt_is_rendered_brief_for_the_arms_own_template(self):
        self.go('claude')
        record = support.case_record(self.out)
        arms = {t['token']: t['arm'] for t in record['trials']}
        current = subprocess.run(['git', '-C', str(support.ROOT), 'show', f'{support.BASE_REF}:{support.TEMPLATE_PATH}'],
                                 capture_output=True, text=True, check=True).stdout
        templates = {'current': current, 'revised': (support.HERE / 'fixtures' / 'revised-template.md').read_text()}
        case = self.fx.case
        seen = set()
        for call in self.calls('builder'):
            token = re.search(r'/trials/(t[0-9a-f]{12})/result\.md', call['stdin']).group(1)
            arm = arms[token]
            seen.add(arm)
            branch = re.search(r' on (replay/\S+)\.\n', call['stdin']).group(1)
            expected = render.render(templates[arm], case['goal'], os.path.realpath(call['cwd']), branch,
                                     case['owned_files'], case['criteria'], case['gates_text'],
                                     str(self.out) + f'/trials/{token}/result.md')
            self.assertEqual(call['stdin'], expected, arm)
        self.assertEqual(seen, {'current', 'revised'})
        self.assertNotEqual(templates['current'], templates['revised'])

    def test_builder_harness_runs_in_the_clone_never_the_live_repo(self):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                self.setUp()
                run = self.go(harness)
                self.assertEqual(run.returncode, 0, run.stderr)
                for call in self.calls('builder'):
                    self.assertEqual(call['tool'], harness)
                    self.assertNotEqual(os.path.realpath(call['cwd']), os.path.realpath(self.fx.repo))
                    self.assertNotIn(str(self.fx.repo), json.dumps(call['argv']) + json.dumps(call['env']) + call['stdin'])


class IsolationE2E(RealBase):
    def test_isolation_handoffs_dir_differs_per_trial_and_sits_under_the_trial_dir(self):
        run = self.go('claude', trials=2)
        self.assertEqual(run.returncode, 0, run.stderr)
        dirs = [c['env']['AGENT_HANDOFFS_DIR'] for c in self.calls('builder')]
        self.assertEqual(len(dirs), 4)
        self.assertEqual(len(set(dirs)), 4)
        for d in dirs:
            self.assertTrue(os.path.realpath(d).startswith(os.path.realpath(self.out / 'trials') + os.sep), d)

    def test_isolation_user_dir_untouched_and_marker_lands_under_the_trial(self):
        user = support.hostile_user_env(self.tmp)
        before = support.tree_snapshot(user['AGENT_HANDOFFS_DIR'])
        run = self.go('claude', env=user)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(support.tree_snapshot(user['AGENT_HANDOFFS_DIR']), before)
        for name in ('user-runs', 'user-run', 'user-orch', 'user-rules'):
            self.assertFalse((self.tmp / name).exists(), name)
        markers = list((self.out / 'trials').rglob('marker'))
        self.assertEqual(len(markers), 2, markers)
        for call in self.calls('builder'):
            self.assertTrue((Path(call['env']['AGENT_HANDOFFS_DIR']) / 'marker').exists())

    def test_isolation_end_to_end_no_user_value_reaches_any_model_process(self):
        user = support.hostile_user_env(self.tmp)
        self.go('codex', env=user)
        self.assertTrue(self.calls())
        blob = json.dumps([(c['env'], c['argv']) for c in self.calls()])
        for name, value in user.items():
            if value.startswith('/') or len(value) > 6:
                self.assertNotIn(value, blob, name)
        for call in self.calls():
            for name, value in user.items():
                self.assertNotEqual(call['env'].get(name), value, name)

    def test_x5_builder_cannot_read_the_case_store_through_home(self):
        home = self.tmp / 'realhome'
        (home / '.agent-handoffs' / 'replay-cases').mkdir(parents=True)
        self.go('claude', env={'HOME': str(home), 'AGENT_HANDOFFS_DIR': str(home / '.agent-handoffs')})
        for call in self.calls():
            self.assertNotIn('.agent-handoffs', call['home_ls'] or [])
            self.assertNotEqual(os.path.realpath(call['env']['HOME']), os.path.realpath(home))
            self.assertNotIn(str(home / '.agent-handoffs'), json.dumps(call['env']))


class GraderE2E(RealBase):
    def test_grader_sealed_real_adapter_never_sees_the_builders_narration(self):
        self.configure(commit_sentinel=support.SENTINEL, result_text=support.SENTINEL, builder_text=support.SENTINEL)
        run = self.go('claude')
        self.assertEqual(run.returncode, 0, run.stderr)
        on_disk = ''.join(p.read_text() for p in (self.out / 'trials').rglob('*') if p.is_file())
        self.assertIn(support.SENTINEL, on_disk, 'positive control: the sentinel is in the builder output')
        self.assertIn(support.SENTINEL, ''.join(p.read_text() for p in (self.out / 'trials').rglob('result.md')))
        graders = self.calls('grader')
        self.assertEqual(len(graders), 2)
        for row in graders:
            self.assertNotIn(support.SENTINEL, json.dumps(row))
            self.assertEqual(row['ls'], [])
            self.assertNotIn('current', ''.join(row['argv']))
        self.assertEqual({t['outcome'] for t in self.trials()}, {'graded'})

    def test_grader_isolation_in_the_real_chain_drops_the_runner_variables(self):
        self.go('claude')
        for row in self.calls('grader'):
            self.assertFalse([k for k in row['env'] if k.startswith(('REPLAY_', 'OFFLOAD_', 'HERDR_', 'BORK_'))])
            self.assertNotIn('AGENT_HANDOFFS_DIR', row['env'])


class SpendE2E(RealBase):
    def test_runner_refuses_real_without_spend_and_prints_the_planned_counts(self):
        for harness in HARNESSES:
            run = self.go(harness, spend=False, trials=3)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('planned: 6 builder calls, 6 grader calls', run.stdout + run.stderr)
            self.assertIn('--spend', run.stdout + run.stderr)
            self.assertEqual(self.calls(), [])
            self.assertFalse(self.out.exists())

    def test_builder_missing_binary_is_a_runner_error_and_the_grader_is_never_called(self):
        (self.bin / 'claude').unlink()
        run = support.run_real(self.fx, self.out, self.bin, self.tmp, 'claude', grader_harness='codex')
        self.assertEqual(run.returncode, 1, run.stderr)
        trial = self.trials()[0]
        self.assertEqual(trial['outcome'], 'error')
        self.assertIn('claude', trial['reason'])
        self.assertEqual(trial['grades'], {})
        self.assertEqual(self.calls(), [], 'no stub ran: not the builder, not the codex grader')
        self.assertNotIn('MET', json.dumps(trial['grades']))

    def test_runner_refuses_an_unknown_or_empty_harness_before_any_call(self):
        for harness in ('opencode', 'Claude', ''):
            run = self.go(harness)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('harness', run.stderr)
            self.assertEqual(self.calls(), [])

    def test_runner_refuses_a_second_adapter_choice_for_the_same_role(self):
        args = support.real_args(self.fx, self.out, 'claude') + ['--fake-builder']
        run = support.run_cli(support.RUNNER, args, env=support.real_env(self.bin, self.tmp))
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_runner_refuses_a_missing_credential_before_the_first_call(self):
        run = self.go('claude', env={'ANTHROPIC_API_KEY': ''})
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertEqual({t['outcome'] for t in self.trials()}, {'error'})
        self.assertIn('ANTHROPIC_API_KEY', json.dumps(self.trials()))

    def test_model_call_timeout_kills_child_through_the_runner(self):
        self.configure(builder='sleep', pidfile=str(self.pidfile))
        run = self.go('claude', extra=['--timeout', '2'])
        self.assertEqual(run.returncode, 1)
        self.assertEqual({t['outcome'] for t in self.trials()}, {'error'})
        pids = support.read_pids(self.pidfile)
        self.assertTrue(support.pid_dead(pids['stub']))
        self.assertTrue(support.pid_dead(pids['child']))
        self.assertEqual(self.calls('grader'), [], 'no grader call after a failed builder')

    def test_model_call_timeout_kills_child_that_ignores_sigterm(self):
        self.configure(builder='sleep', ignore_term=True, pidfile=str(self.pidfile))
        for timeout in ('2', '8'):
            self.out = self.tmp / f'out{timeout}'
            run = self.go('claude', extra=['--timeout', timeout])
            self.assertEqual(run.returncode, 1)
            pids = support.read_pids(self.pidfile)
            self.assertTrue(support.pid_dead(pids['stub']), f'stub survived at --timeout {timeout}')
            self.assertTrue(support.pid_dead(pids['child']), f'its child survived at --timeout {timeout}')
            self.pidfile.unlink()

    def test_model_call_timeout_in_the_grader_is_ungraded_and_leaves_no_process(self):
        self.configure(grader='sleep', pidfile=str(self.pidfile))
        run = self.go('claude', extra=['--timeout', '2'])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual({t['outcome'] for t in self.trials()}, {'ungraded'})
        self.assertEqual({v for t in self.trials() for v in t['grades'].values()}, {'ungraded'})
        pids = support.read_pids(self.pidfile)
        self.assertTrue(support.pid_dead(pids['stub']))
        self.assertTrue(support.pid_dead(pids['child']))

    def test_model_call_no_retry_each_adapter_is_called_once_per_trial(self):
        self.configure(builder='fail')
        self.go('claude', trials=2)
        self.assertEqual(len(self.calls('builder')), 4)
        self.assertEqual(self.calls('grader'), [])
        self.out = self.tmp / 'out2'
        self.configure(grader='fail')
        self.go('claude', trials=2)
        self.assertEqual(len(self.calls('grader')), 4)

    def test_sigint_kills_model_child_that_ignores_sigterm(self):
        self.test_sigint_kills_model_child_and_cleans_up(ignore_term=True)

    def test_sigint_kills_model_child_and_cleans_up(self, ignore_term=False):
        self.configure(builder='sleep', pidfile=str(self.pidfile), ignore_term=ignore_term)
        env = os.environ.copy()
        env.update(support.real_env(self.bin, self.tmp))
        env['AGENT_HANDOFFS_DIR'] = str(self.tmp / 'store')
        proc = subprocess.Popen([sys.executable, str(support.RUNNER), *map(str, support.real_args(self.fx, self.out))],
                                env=env, cwd=str(support.ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        pids = support.read_pids(self.pidfile)
        proc.send_signal(signal.SIGINT)
        proc.communicate(timeout=60)
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue(support.pid_dead(pids['stub']))
        self.assertTrue(support.pid_dead(pids['child']))
        listing = support.git(self.fx.repo, 'worktree', 'list', '--porcelain')
        self.assertEqual(listing.count('worktree '), 1, listing)
        self.assertEqual(self.scratch_left(), [])

    def test_no_credential_in_outputs(self):
        marker_a, marker_o = 'sk-ant-MARKER-77aa-secretvalue', 'sk-oai-MARKER-77bb-secretvalue'
        for harness in HARNESSES:
            self.setUp()
            self.configure(echo_env=True)
            run = self.go(harness, env={'ANTHROPIC_API_KEY': marker_a, 'OPENAI_API_KEY': marker_o})
            self.assertIn(run.returncode, (0, 1), run.stderr)
            files = [p for p in self.out.rglob('*') if p.is_file()]
            self.assertTrue(files)
            for row in self.calls('grader'):
                for marker in (marker_a, marker_o):
                    self.assertNotIn(marker, row['stdin'], 'the credential reached the grader input')
            for path in files:
                text = path.read_text(errors='replace')
                for marker in (marker_a, marker_o):
                    self.assertNotIn(marker, text, f'{marker} in {path}')
            for marker in (marker_a, marker_o):
                self.assertNotIn(marker, run.stdout + run.stderr)
            # positive control: the stub did see its own harness credential, so the scrub had something to do
            own = marker_a if harness == 'claude' else marker_o
            self.assertTrue(any(own in json.dumps(c['env']) for c in self.calls()))


def readme_commands():
    """The shell lines of evals/README.md that hold a replay command, with continuation lines joined."""
    lines = README.read_text().splitlines()
    return [line.strip() for line in lines if 'run_replay.py' in line and '--builder-harness' in line]


class ReadmeCommandTests(RealBase):
    def doc_args(self, harness, spend, trials='1'):
        real = [c for c in readme_commands() if '--spend' in c and '--trials 1 ' not in c]
        self.assertTrue(real, 'no README command line holds --spend')
        tokens = shlex.split(real[-1])
        values = [('$OUT/run-1', str(self.out)), ('$CASES', str(self.fx.cases_dir)), ('$A', support.BASE_REF), ('$B', 'HEAD')]
        out = []
        for token in tokens[2:]:  # drop `python3 evals/replay/run_replay.py`
            for name, value in values:
                token = token.replace(name, value)
            out.append(token)
        for name in ('--builder-harness', '--grader-harness'):
            out[out.index(name) + 1] = harness
        out[out.index('--trials') + 1] = trials
        if not spend:
            out.remove('--spend')
        return out + ['--revised-skills-repo', str(self.fx.skills_repo)]

    def test_readme_real_run_command_is_one_line_with_every_option_and_states_the_cost(self):
        text = README.read_text()
        real = [c for c in readme_commands() if '--spend' in c and '--trials 1 ' not in c]
        smoke = [c for c in readme_commands() if '--spend' in c and '--trials 1 ' in c]
        self.assertEqual((len(real), len(smoke)), (1, 1), (real, smoke))
        for line in (real[0], smoke[0]):
            for needle in ('--builder-harness', '--grader-harness', '--current-ref', '--revised-ref', '--trials',
                           '--output', '--cases'):
                self.assertIn(needle, line)
            self.assertRegex(line, r'--builder-harness (claude|codex)')
            self.assertRegex(line, r'--grader-harness (claude|codex)')
        self.assertRegex(text, r'(?i)paid')
        self.assertRegex(text, r'(?i)no real run was made')
        self.assertLess(text.index(smoke[0]), text.index(real[0]), 'the one-case smoke step comes first')

    def test_readme_command_without_spend_reaches_the_refusal_with_planned_counts(self):
        for harness in HARNESSES:
            args = self.doc_args(harness, spend=False, trials='4')
            run = support.run_cli(support.RUNNER, args, env=support.real_env(self.bin, self.tmp))
            self.assertNotEqual(run.returncode, 0)
            self.assertNotIn('usage:', run.stderr)
            self.assertRegex(run.stdout + run.stderr, r'planned: [1-9]\d* builder calls, [1-9]\d* grader calls')
            self.assertEqual(self.calls(), [])

    def test_e2e_real_adapters_stubbed_runs_the_documented_command_for_each_harness(self):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                self.setUp()
                self.configure(grades={'C1': 'MET', 'C2': 'NOT MET', 'C3': 'MET'})
                args = self.doc_args(harness, spend=True, trials='2')
                run = support.run_cli(support.RUNNER, args, env=support.real_env(self.bin, self.tmp))
                self.assertEqual(run.returncode, 0, run.stderr)
                summary = support.load(self.out / 'summary.json')
                self.assertEqual(summary['arms']['current']['graded'], 2)
                self.assertEqual(summary['arms']['current']['named_miss'], 2)
                self.assertTrue(support.case_record(self.out)['trials'])
                self.assertEqual(len(self.calls('builder')), 4)
                self.assertEqual({c['tool'] for c in self.calls()}, {harness})

    def test_e2e_real_adapters_stubbed_counts_ungraded_apart_from_met(self):
        self.configure(grades={'C1': 'MET', 'C2': 'PARTIAL', 'C3': 'MET'})
        run = self.go('claude', trials=2)
        self.assertEqual(run.returncode, 0, run.stderr)
        arm = support.load(self.out / 'summary.json')['arms']['current']
        self.assertEqual((arm['graded'], arm['not_graded']['ungraded'], arm['named_miss']), (0, 2, 0))
        self.assertIsNone(arm['rate'])


if __name__ == '__main__':
    unittest.main()
