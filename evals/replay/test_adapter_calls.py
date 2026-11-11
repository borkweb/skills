"""The real builder and grader adapters, called directly with stub claude and codex on a PATH that holds nothing else."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support  # noqa: E402

HARNESSES = ('claude', 'codex')
GRADES = {'C1': 'MET', 'C2': 'NOT MET', 'C3': 'MET'}


class AdapterBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-adapter-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = support.stub_bin(self.tmp)
        self.pidfile = self.tmp / 'pids.json'
        self.addCleanup(support.kill_pids, self.pidfile)

    def configure(self, **cfg):
        support.set_stub_config(self.bin, cfg)

    def builder(self, harness='claude', env=None, **over):
        return support.run_adapter('builder', support.adapter_request('builder', self.tmp, harness, **over), self.bin,
                                   self.tmp, env=env)

    def grader(self, harness='claude', env=None, **over):
        return support.run_adapter('grader', support.adapter_request('grader', self.tmp, harness, **over), self.bin,
                                   self.tmp, env=env)

    def calls(self, role=None):
        return support.stub_calls(self.bin, role)


class BuilderTests(AdapterBase):
    def test_builder_harness_launches_the_named_cli_in_the_trial_clone(self):
        self.configure(builder='no-commit')
        for harness, first in (('claude', '-p'), ('codex', 'exec')):
            with self.subTest(harness=harness):
                run = self.builder(harness)
                self.assertEqual(run.returncode, 0, run.stderr)
                row = self.calls('builder')[-1]
                self.assertEqual(row['tool'], harness)
                self.assertEqual(row['argv'][0], first)
                self.assertEqual(os.path.realpath(row['cwd']), os.path.realpath(self.tmp / 'work'))
                self.assertEqual(json.loads(run.stdout)['status'], 'ok')

    def test_builder_unknown_harness_is_refused_before_any_process_starts(self):
        for harness in ('opencode', 'Claude', '', 'CODEX', None):
            with self.subTest(harness=repr(harness)):
                run = self.builder(harness if harness is not None else support.ABSENT)
                self.assertNotEqual(run.returncode, 0)
                self.assertEqual(self.calls(), [])

    def test_builder_missing_binary_fails_naming_it_and_never_falls_back(self):
        (self.bin / 'claude').unlink()
        (self.bin / 'codex').unlink()
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                run = self.builder(harness)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(harness, run.stderr)
                self.assertEqual(self.calls(), [])
                self.assertNotIn('"status": "ok"', run.stdout)

    def test_builder_sends_the_brief_on_stdin_unchanged(self):
        self.configure(builder='no-commit')
        brief = '-- looks like a flag\nline two\n  indented\n'
        for harness in HARNESSES:
            self.builder(harness, brief=brief)
            self.assertEqual(self.calls('builder')[-1]['stdin'], brief)
            self.assertNotIn(brief, ' '.join(self.calls('builder')[-1]['argv']))

    def test_builder_cli_flags_budget_and_sandbox(self):
        self.configure(builder='no-commit')
        self.builder('claude')
        argv = self.calls('builder')[-1]['argv']
        for flag in ('--bare', '--no-session-persistence', '--output-format', '--max-budget-usd', '--settings'):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index('--max-budget-usd') + 1], '2')
        self.assertTrue(json.loads(argv[argv.index('--settings') + 1])['sandbox']['enabled'])
        self.builder('codex')
        argv = self.calls('builder')[-1]['argv']
        self.assertEqual(argv[argv.index('--sandbox') + 1], 'workspace-write')
        self.assertIn('--ephemeral', argv)
        self.assertEqual(argv[argv.index('-C') + 1], str(self.tmp / 'work'))

    def test_model_call_no_retry_builder_is_called_once(self):
        self.configure(builder='fail')
        for harness in HARNESSES:
            run = self.builder(harness)
            self.assertNotEqual(run.returncode, 0)
        self.assertEqual(len(self.calls('builder')), 2)

    def test_model_call_timeout_kills_child_builder(self):
        self.configure(builder='sleep', ignore_term=True, pidfile=str(self.pidfile))
        start = time.monotonic()
        run = self.builder('claude', timeout=2)
        self.assertLess(time.monotonic() - start, 30)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('timeout', run.stderr)
        pids = support.read_pids(self.pidfile)
        self.assertTrue(support.pid_dead(pids['stub']))
        self.assertTrue(support.pid_dead(pids['child']))


class GraderTests(AdapterBase):
    def graded(self, harness='claude', **over):
        run = self.grader(harness, **over)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def test_grader_no_tools_outside_worktree(self):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                self.graded(harness)
                row = self.calls('grader')[-1]
                if harness == 'claude':
                    self.assertEqual(row['argv'][row['argv'].index('--tools') + 1], '')
                else:
                    self.assertEqual(row['argv'][row['argv'].index('--sandbox') + 1], 'read-only')
                    self.assertIn('--skip-git-repo-check', row['argv'])
                self.assertEqual(row['ls'], [], 'the grader cwd is empty')
                self.assertFalse(Path(row['cwd']).exists(), 'and removed after the call')
                self.assertNotIn(str(self.tmp / 'work'), json.dumps(row['argv']))

    def test_grader_fresh_call_has_no_session_reuse(self):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                self.graded(harness)
                self.graded(harness)
                first, second = self.calls('grader')[-2:]
                for row in (first, second):
                    for bad in ('--resume', '--continue', '-r', '-c', '--session-id', 'resume'):
                        self.assertNotIn(bad, row['argv'])
                    self.assertIn('--no-session-persistence' if harness == 'claude' else '--ephemeral', row['argv'])

    def test_grader_reply_valid_is_recorded_per_id(self):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                self.configure(grades=GRADES)
                self.assertEqual(self.graded(harness)['grades'], GRADES)

    def test_grader_reply_malformed_never_records_met(self):
        rows = {
            'non-json text': ({'reply': 'I think it all passes'}, GRADES.keys()),
            'json array': ({'reply': '[1, 2]'}, GRADES.keys()),
            'empty stdout': ({'grader': 'empty'}, GRADES.keys()),
            'missing id': ({'grades': {'C1': 'MET', 'C2': 'MET'}}, ['C3']),
            'lowercase met': ({'grades': {'C1': 'met', 'C2': 'MET', 'C3': 'MET'}}, ['C1']),
            'PARTIAL': ({'grades': {'C1': 'PARTIAL', 'C2': 'MET', 'C3': 'MET'}}, ['C1']),
            'true': ({'reply': {'grades': {'C1': True, 'C2': 'MET', 'C3': 'MET'}}}, ['C1']),
            'nonzero exit': ({'grader': 'fail'}, GRADES.keys()),
            'grades not an object': ({'reply': {'grades': 'MET'}}, GRADES.keys()),
        }
        for harness in HARNESSES:
            for name, (cfg, ungraded) in rows.items():
                with self.subTest(harness=harness, shape=name):
                    self.configure(**cfg)
                    out = self.graded(harness)['grades']
                    for ident in ungraded:
                        self.assertEqual(out.get(ident), 'ungraded', out)
                    for ident, value in out.items():
                        if value == 'MET':
                            given = (cfg.get('grades') or (cfg.get('reply') or {}).get('grades') or {})
                            self.assertEqual(given.get(ident), 'MET', f'{ident} became MET from a malformed reply')

    def test_grader_reply_malformed_timeout_is_ungraded_and_kills_the_child(self):
        self.configure(grader='sleep', pidfile=str(self.pidfile))
        out = self.graded('claude', timeout=2)
        self.assertEqual(set(out['grades'].values()), {'ungraded'})
        pids = support.read_pids(self.pidfile)
        self.assertTrue(support.pid_dead(pids['stub']))
        self.assertTrue(support.pid_dead(pids['child']))

    def test_grader_reply_unknown_id_is_ignored(self):
        self.configure(grades={'C1': 'MET', 'C2': 'MET', 'C9': 'MET'})
        out = self.graded('claude')['grades']
        self.assertNotIn('C9', out)
        self.assertEqual(out['C3'], 'ungraded')
        self.assertEqual(out['C1'], 'MET')

    def test_grader_envelope_per_harness(self):
        fenced = '```json\n' + json.dumps({'grades': GRADES}) + '\n```'
        rows = [('claude', {'reply': {'grades': GRADES}}), ('claude', {'reply': {'grades': GRADES}, 'structured': True}),
                ('claude', {'reply': fenced}), ('codex', {'reply': {'grades': GRADES}}), ('codex', {'reply': fenced})]
        for harness, cfg in rows:
            with self.subTest(harness=harness, cfg=str(cfg)[:60]):
                self.configure(**cfg)
                self.assertEqual(self.graded(harness)['grades'], GRADES)
        self.configure(reply={'grades': GRADES})
        self.graded('claude')
        argv = self.calls('grader')[-1]['argv']
        self.assertEqual(argv[argv.index('--output-format') + 1], 'json')
        self.assertIn('--json-schema', argv)
        self.graded('codex')
        argv = self.calls('grader')[-1]['argv']
        self.assertIn('-o', argv)
        self.assertIn('--output-schema', argv)

    def test_grader_sends_only_the_sealed_input_on_stdin(self):
        self.graded('claude')
        stdin = self.calls('grader')[-1]['stdin']
        for part in ('DIFF-TEXT', 'GATE-TEXT', 'C1: one'):
            self.assertIn(part, stdin)

    def test_model_call_no_retry_grader_is_called_once(self):
        self.configure(grader='fail')
        self.graded('claude')
        self.graded('codex')
        self.assertEqual(len(self.calls('grader')), 2)


class GuardTests(AdapterBase):
    def test_spend_refusal_real_adapter_starts_nothing(self):
        for role in ('builder', 'grader'):
            for harness in HARNESSES:
                with self.subTest(role=role, harness=harness):
                    run = getattr(self, role)(harness, spend=support.ABSENT)
                    self.assertNotEqual(run.returncode, 0)
                    self.assertIn('--spend', run.stderr)
                    self.assertEqual(self.calls(), [])

    def test_spend_value_strict_accepts_only_json_true(self):
        for value in (False, 'false', '0', 'yes', 'true', 1, 0, None, []):
            for role in ('builder', 'grader'):
                with self.subTest(value=repr(value), role=role):
                    run = getattr(self, role)('claude', spend=value)
                    self.assertNotEqual(run.returncode, 0)
                    self.assertEqual(self.calls(), [])

    def test_missing_credential_is_refused_naming_the_variable(self):
        no_keys = {'ANTHROPIC_API_KEY': '', 'OPENAI_API_KEY': '', 'CODEX_API_KEY': ''}
        for role in ('builder', 'grader'):
            for harness, names in (('claude', ['ANTHROPIC_API_KEY']), ('codex', ['OPENAI_API_KEY', 'CODEX_API_KEY'])):
                with self.subTest(role=role, harness=harness):
                    run = getattr(self, role)(harness, env=no_keys)
                    self.assertNotEqual(run.returncode, 0)
                    for name in names:
                        self.assertIn(name, run.stderr)
                    self.assertEqual(self.calls(), [])

    def test_codex_accepts_codex_api_key_alone(self):
        self.configure(builder='no-commit')
        run = self.builder('codex', env={'OPENAI_API_KEY': '', 'CODEX_API_KEY': 'ck-test-0001'})
        self.assertEqual(run.returncode, 0, run.stderr)
        env = self.calls('builder')[-1]['env']
        self.assertEqual(env.get('CODEX_API_KEY'), 'ck-test-0001')
        self.assertNotIn('OPENAI_API_KEY', {k for k, v in env.items() if v == 'sk-oai-test-0001'})

    def test_only_the_selected_harness_credential_reaches_the_model_process(self):
        self.configure(builder='no-commit')
        self.builder('claude')
        env = self.calls('builder')[-1]['env']
        self.assertEqual(env['ANTHROPIC_API_KEY'], 'sk-ant-test-0001')
        self.assertNotIn('OPENAI_API_KEY', env)
        self.builder('codex')
        env = self.calls('builder')[-1]['env']
        self.assertEqual(env['OPENAI_API_KEY'], 'sk-oai-test-0001')
        self.assertNotIn('ANTHROPIC_API_KEY', env)


class IsolationTests(AdapterBase):
    def hostile(self):
        user = support.hostile_user_env(self.tmp)
        return user

    def child_envs(self, role):
        self.configure(builder='no-commit')
        user = self.hostile()
        for harness in HARNESSES:
            run = getattr(self, role)(harness, env=user)
            self.assertEqual(run.returncode, 0, run.stderr)
        return user, [r['env'] for r in self.calls(role)]

    def test_isolation_bork_env_is_not_inherited(self):
        for role in ('builder', 'grader'):
            user, envs = self.child_envs(role)
            for env in envs:
                for name in ('BORK_RUNS_HOME', 'BORK_RUN_DIR', 'BORK_RUN_ID', 'BORK_RUNS_CLI', 'ORCHESTRATOR_HOME'):
                    self.assertNotEqual(env.get(name), user[name], f'{role} saw {name}')
                    self.assertNotIn(user[name], json.dumps(env), f'{role} env holds the user value of {name}')
                self.assertEqual(env.get('BORK_RUN_ID'), None)

    def test_isolation_herdr_env_is_not_inherited(self):
        for role in ('builder', 'grader'):
            _, envs = self.child_envs(role)
            for env in envs:
                self.assertEqual([k for k in env if k.startswith('HERDR_')], [])

    def test_isolation_session_id_is_not_inherited(self):
        for role in ('builder', 'grader'):
            _, envs = self.child_envs(role)
            for env in envs:
                for name in ('CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID'):
                    self.assertNotIn(name, env)
                self.assertNotIn('session-user', json.dumps(env))

    def test_isolation_handoffs_dir_is_set_under_the_trial_and_rules_dir_is_private(self):
        user, envs = self.child_envs('builder')
        trial = os.path.realpath(self.tmp / 'trial')
        for env in envs:
            for name in ('AGENT_HANDOFFS_DIR', 'BORK_REPO_RULES_DIR', 'HOME'):
                self.assertTrue(os.path.realpath(env[name]).startswith(trial + os.sep), f'{name}={env[name]}')
            self.assertNotEqual(env['AGENT_HANDOFFS_DIR'], user['AGENT_HANDOFFS_DIR'])
        self.assertEqual({k for k in envs[0] if k.startswith('CODEX')}, set())  # claude run: no codex vars

    def test_x5_builder_home_is_a_temp_dir_and_the_env_is_an_allowlist(self):
        self.configure(builder='no-commit')
        home = self.tmp / 'realhome'
        (home / '.agent-handoffs' / 'replay-cases').mkdir(parents=True)
        (home / '.agent-handoffs' / 'replay-cases' / 'c.json').write_text('{"missed_ids": ["C2"]}')
        extra = {'HOME': str(home), 'AGENT_HANDOFFS_DIR': str(home / '.agent-handoffs'), 'RANDOM_USER_VAR': 'x',
                 'GITHUB_TOKEN': 'ghp_x', 'SSH_AUTH_SOCK': '/tmp/agent', 'CODEX_HOME': str(home / '.codex')}
        for harness in HARNESSES:
            self.builder(harness, env=extra)
            row = self.calls('builder')[-1]
            self.assertNotEqual(os.path.realpath(row['env']['HOME']), os.path.realpath(home))
            self.assertNotIn('.agent-handoffs', row['home_ls'] or [])
            self.assertNotIn(str(home), json.dumps(row['env']))
            for name in ('RANDOM_USER_VAR', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK'):
                self.assertNotIn(name, row['env'])
        self.assertTrue(os.path.realpath(self.calls('builder')[-1]['env']['CODEX_HOME']).startswith(
            os.path.realpath(self.tmp / 'trial')))

    def test_builder_gets_git_identity_and_no_gpg_signing(self):
        self.configure(builder='ok')
        work = self.tmp / 'work'
        work.mkdir()
        support.git(work, 'init', '-q')
        run = self.builder('claude')
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(support.git(work, 'log', '--format=%an'), 'replay')


if __name__ == '__main__':
    unittest.main()
