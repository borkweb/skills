"""Runner contracts exercised with disposable homes, repositories and process-free or local CLI stubs."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run_review_eval as run
from stubs import common

TOKEN = 'test-only-token-0123456789abcdef'


class RunnerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        run.procs.reset_registry()
        cls.fixture = tempfile.TemporaryDirectory(prefix='review-fixture-')
        cls.fixture_root = Path(cls.fixture.name).resolve()
        cls.source = cls.fixture_root / 'source'
        cls.source.mkdir()
        run.caselib.git(cls.source, 'init', '-q', '--template=')
        run.caselib.git(cls.source, 'remote', 'add', 'origin', 'https://example.invalid/test/repo')
        (cls.source / 'file.txt').write_text('base\n')
        run.caselib.git(cls.source, 'add', 'file.txt')
        run.caselib.git(cls.source, 'commit', '-qm', 'base')
        cls.base = run.caselib.git(cls.source, 'rev-parse', 'HEAD')
        (cls.source / 'file.txt').write_text(''.join(f'line {i}\n' for i in range(220)))
        run.caselib.git(cls.source, 'commit', '-qam', 'head')
        cls.head = run.caselib.git(cls.source, 'rev-parse', 'HEAD')
        cls.export = cls.fixture_root / 'export'
        run.snapshot.export_skills(run.REPO, 'HEAD', cls.export)
        cls.addClassCleanup(cls.fixture.cleanup)

    def setUp(self):
        run.procs.reset_registry()
        self.temp = tempfile.TemporaryDirectory(prefix='review-test-')
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'home'; self.home.mkdir()
        self.token_file = self.home / '.borkweb-skills/evals/token'
        self.token_file.parent.mkdir(parents=True)
        self.token_file.write_text(TOKEN); self.token_file.chmod(0o600)
        self.bin = common.install(self.root / 'bin')
        self.env = {**run.caselib.scrubbed_env(), 'HOME': str(self.home),
                    'PATH': str(self.bin) + os.pathsep + os.defpath,
                    'BORK_EVAL_CLAUDE_TOKEN_FILE': str(self.token_file)}
        self.environ = patch.dict(os.environ, self.env, clear=True); self.environ.start()
        self.addCleanup(self.environ.stop)
        self.addCleanup(self.temp.cleanup)
        config = self.home / '.borkweb-skills/config.json'
        config.write_text(json.dumps({'repos': {'example.invalid/test/repo': str(self.source)}}))
        self.cases_dir = self.root / 'cases'; self.cases_dir.mkdir()
        for cid in ('case-a', 'case-b', 'case-c'):
            self.write_case(cid)
        self.matrix_file = self.root / 'matrix.json'
        self.output = self.root / 'run'
        self.configure()

    def write_case(self, cid, **updates):
        case = dict(id=cid, title='Private case title', skill='review', repo={'identity': 'example.invalid/test/repo'},
                    base=self.base, head=self.head, kind='bug', expected_verdict='DO NOT LAND',
                    expected_findings=[dict(id='F1', file='file.txt', lines='1', severity='IMPORTANT', answer='Missing check.')],
                    provenance={'test': 'synthetic'}, added='2026-11-19', tags=['test'])
        case.update(updates)
        (self.cases_dir / (cid + '.json')).write_text(json.dumps(case, indent=3) + '\n')
        return case

    def configure(self, harness='fake', grader='fake', trials=1, configs=None, **updates):
        raw = dict(eval='review', cases=str(self.cases_dir), case_filter={'skill': ['review'], 'tags_any': []},
                   case_limit=1, skills_ref='HEAD', trials=trials,
                   grader={'harness': grader, 'model': 'grade-model', 'effort': None}, budget_usd=100,
                   timeout_s=5, configs=configs or [dict(harness=harness, model='review-model', effort=None)])
        raw.update(updates)
        self.matrix_file.write_text(json.dumps(raw))
        return raw

    def cli(self, *flags, spend=False, resume=False, output=None):
        args = ['--resume', str(output or self.output)] if resume else [
            '--matrix', str(self.matrix_file), '--output', str(output or self.output)]
        if spend:
            args.append('--spend')
        return subprocess.run([sys.executable, str(HERE / 'run_review_eval.py'), *args, *flags],
                              env=self.env, capture_output=True, text=True, timeout=30)

    def assert_ok(self, done):
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def state(self, output=None):
        return run.results.read_records((output or self.output) / 'trials.jsonl')

    def manifest(self, output=None):
        return json.loads(((output or self.output) / 'run.json').read_text())

    def events(self, kind=None):
        return [e for e in common.calls(self.bin) if e['event'] == 'start' and (kind is None or e['kind'] == kind)]

    def in_process(self, *flags, resume=False):
        args = ['--resume', str(self.output)] if resume else ['--matrix', str(self.matrix_file), '--output', str(self.output)]
        original = run.snapshot.clone_copy
        def export(repo, ref, dest):
            original(self.export, dest)
            return run.caselib.git(repo, 'rev-parse', ref)
        with patch.object(run.snapshot, 'export_skills', side_effect=export):
            return run.main([*args, *flags])

    def rewrite_records(self, records):
        (self.output / 'trials.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in records))


class FakeHarnessTests(RunnerCase):
    def test_fake_contract(self):
        mod = run.harnesses.load('fake')
        ctx = run.harnesses.Context({}, lambda *a, **k: self.fail('fake started a process'), [], lambda s: None)
        mod.preflight(ctx)
        req = dict(base=self.base, head=self.head, skill='review', model='fake', effort=None)
        reply = mod.review(req, ctx)
        self.assertEqual(reply, mod.review(req, ctx))
        self.assertEqual(set(reply), {'text', 'usage', 'rounds', 'duration_s', 'resolved_model', 'resolved_effort',
                                     'skill_invoked', 'skill_evidence', 'skill_loading', 'rate_limited', 'error',
                                     'argv', 'raw_files', 'harness_version'})
        for name in ('text', 'resolved_model', 'skill_evidence', 'skill_loading', 'harness_version'):
            self.assertIsInstance(reply[name], str)
        self.assertIsNone(reply['resolved_effort']); self.assertIsNone(reply['error'])
        self.assertIs(type(reply['rounds']), int); self.assertIs(type(reply['duration_s']), float)
        self.assertIs(type(reply['skill_invoked']), bool); self.assertIs(type(reply['rate_limited']), bool)
        self.assertTrue(all(type(v) is int or v is None for v in reply['usage'].values()))
        self.assertTrue(all(isinstance(reply[k], list) for k in ('argv', 'raw_files')))
        case = self.write_case('case-a')
        for kind in ('match', 'extras'):
            if kind == 'match':
                prompt, schema = run.grader.match_prompt(case, reply['text'])
                parsed = mod.grade(dict(prompt=prompt, schema=schema), ctx)
                self.assertIsNotNone(run.grader.parse_match(parsed['parsed'], case))
            else:
                extra = dict(token='t123456789abc', n=1, summary='Claim', file='file.txt', lines='1')
                prompt, schema, order = run.grader.extras_prompt(case, [extra], 1)
                parsed = mod.grade(dict(prompt=prompt, schema=schema), ctx)
                self.assertIsNotNone(run.grader.parse_extras(parsed['parsed'], order))
        self.assertEqual(mod.HARNESS, 'fake')


class EndToEndTests(RunnerCase):
    def test_fake_run_end_to_end(self):
        self.configure(trials=2, case_limit=2, configs=[dict(harness='fake', model=['a', 'b'], effort=None)])
        self.assert_ok(self.cli('--jobs', '4'))
        m = run.matrix.load(self.matrix_file)
        expected = {run.matrix.token(c, cfg['key'], t) for c in ('case-a', 'case-b') for cfg in m.configs for t in (1, 2)}
        state = self.state()
        self.assertEqual(set(state.reviews), expected)
        for r in state.reviews.values():
            self.assertRegex(r['skill_evidence'], r'^(tool-use|output-evidence|none)(:.*)?$')
            self.assertIn(r['skill_invoked'], (True, False, None))
            self.assertIn(r['config_key'], [c['key'] for c in m.configs])
        doc = run.results.check_results.load(self.output)
        self.assertEqual(len(doc['trials']), 8)
        self.assertTrue(all(t['outcome'] == 'graded' for t in doc['trials']))
        self.assertTrue((self.output / 'report.html').is_file())


class OutcomeTests(RunnerCase):
    def test_classify_reply(self):
        cfg = run.matrix.load(self.matrix_file).configs[0]
        case = self.write_case('case-a')
        base = run.harnesses.load('fake').review(dict(base=self.base, head=self.head, skill='review',
                                                     model=cfg['model'], effort=None), None)
        conditions = [({'rate_limited': True, 'error': 'bad'}, ('env-unavailable', 'rate-limit')),
                      ({'error': 'plugin loading unavailable'}, ('env-unavailable', 'plugin loading unavailable')),
                      ({'error': 'bad\n' + TOKEN}, ('error', 'bad [redacted]')),
                      ({'resolved_model': 'other'}, ('env-unavailable', 'model fell back to other')),
                      ({'resolved_model': None}, ('ok', None)),
                      ({'resolved_effort': 'high'}, ('env-unavailable', 'effort fell back to high')),
                      ({'resolved_effort': None}, ('ok', None)),
                      ({'skill_invoked': False}, ('error', 'skill not invoked')),
                      ({'skill_invoked': None}, ('ok', None)),
                      ({'skill_invoked': None, 'text': 'nothing'}, ('error', 'skill not invoked'))]
        for update, expected in conditions:
            with self.subTest(update=update):
                answer = run.classify_reply(dict(base, **update), cfg, case, [TOKEN])
                self.assertEqual(answer[:2], expected)
                if update == {'skill_invoked': None}:
                    self.assertTrue(answer[2].startswith('output-evidence:'))

    def test_adapter_exception_becomes_error(self):
        self.configure(trials=2, max_parallel={'fake': 1})
        fake = run.harnesses.load('fake'); original = fake.review; count = 0
        def review(req, ctx):
            nonlocal count
            count += 1
            if count == 1:
                raise RuntimeError('broken\n' + TOKEN)
            return original(req, ctx)
        with patch.object(fake, 'review', side_effect=review):
            self.assertEqual(self.in_process(), 0)
        self.assertEqual(sorted(r['outcome'] for r in self.state().reviews.values()), ['error', 'ok'])

    def test_stub_fallback_and_no_skill(self):
        for mode, outcome, reason in [('fallback-model', 'env-unavailable', 'model fell back to'),
                                      ('no-skill', 'error', 'skill not invoked')]:
            with self.subTest(mode=mode):
                self.configure(harness='claude')
                common.configure(self.bin, mode=mode)
                dest = self.root / mode
                self.assert_ok(self.cli(spend=True, output=dest))
                review = next(iter(self.state(dest).reviews.values()))
                self.assertEqual(review['outcome'], outcome); self.assertTrue(review['reason'].startswith(reason))
                self.assertFalse(self.state(dest).matches)
                before = len(self.events('review'))
                self.assert_ok(self.cli(resume=True, spend=True, output=dest))
                self.assertEqual(len(self.events('review')), before)


class LayoutTests(RunnerCase):
    def test_manifest_and_layout(self):
        originals = {p.name: p.read_bytes() for p in self.cases_dir.glob('*.json')}
        self.assert_ok(self.cli())
        manifest = self.manifest()
        self.assertTrue({'schema', 'run_id', 'started_at', 'eval', 'eval_version', 'matrix_sha256', 'matrix',
                         'skills_ref', 'skills_sha', 'case_set_sha256', 'grader', 'context', 'export', 'work_root'} <= manifest.keys())
        self.assertEqual(manifest['context'], 'skill-only'); self.assertEqual(manifest['export'], 'skills-only')
        for p in (self.output, self.output / 'cases', self.output / 'trials', self.output / 'raw'):
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o700)
        self.assertEqual((self.output / 'cases/case-a.json').read_bytes(), originals['case-a.json'])
        self.assertEqual({p.name: p.read_bytes() for p in self.cases_dir.glob('*.json')}, originals)

    def test_work_root_location(self):
        seen = []
        original = run.harnesses.load('fake').review
        def review(req, ctx):
            work = Path(req['trial_copy']).parent
            seen.append((work, stat.S_IMODE(work.stat().st_mode), req))
            return original(req, ctx)
        with patch.object(run.harnesses.load('fake'), 'review', side_effect=review):
            self.assertEqual(self.in_process(), 0)
        work, mode, req = seen[0]
        self.assertEqual(work, self.home / '.borkweb-skills/eval-work' / self.manifest()['run_id'])
        self.assertEqual(mode, 0o700)
        self.assertEqual(str(work), self.manifest()['work_root'])
        for key in ('tmp_root', 'trial_copy', 'export_dir'):
            self.assertIn(work, Path(req[key]).parents)

    def test_trial_files(self):
        self.assert_ok(self.cli())
        record = next(iter(self.state().reviews.values())); folder = self.output / 'trials' / record['key']
        self.assertEqual({p.name for p in folder.iterdir()}, {'review.md', 'review-meta.json', 'match.json', 'stderr-tail.txt'})
        meta = json.loads((folder / 'review-meta.json').read_text())
        self.assertTrue({'usage', 'resolved_model', 'resolved_effort', 'skill_invoked', 'skill_evidence', 'argv',
                         'harness_version', 'independent_review', 'verdict_basis'} <= meta.keys())
        self.assertEqual(record['text_file'], f'trials/{record["key"]}/review.md')
        (folder / 'obsolete').write_text('old')
        records = self.state().records
        for r in records:
            if r['type'] == 'review': r.update(outcome='error', reason='retry')
        self.rewrite_records(records)
        self.assert_ok(self.cli('--retry-errors', resume=True))
        self.assertFalse((folder / 'obsolete').exists())

    def test_case_set_sha256(self):
        self.assert_ok(self.cli('--case', 'case-b'))
        data = [['case-b', hashlib.sha256((self.cases_dir / 'case-b.json').read_bytes()).hexdigest()]]
        expected = hashlib.sha256(json.dumps(data, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(self.manifest()['case_set_sha256'], expected)
        self.write_case('case-c', title='changed unselected')
        second = self.root / 'second'; self.assert_ok(self.cli('--case', 'case-b', output=second))
        self.assertEqual(self.manifest(second)['case_set_sha256'], expected)
        third = self.root / 'third'; self.assert_ok(self.cli('--case', 'case-a', output=third))
        self.assertNotEqual(self.manifest(third)['case_set_sha256'], expected)

    def test_stderr_tail(self):
        self.configure(harness='claude'); common.configure(self.bin, stderr_size=10000, echo_token=True)
        self.assert_ok(self.cli(spend=True))
        token = next(iter(self.state().reviews))
        raw = (self.output / 'raw' / token / 'stderr.txt').read_bytes()
        tail = (self.output / 'trials' / token / 'stderr-tail.txt').read_text()
        expected = raw[-8192:].decode('utf-8', 'replace').replace(TOKEN, '[redacted]')
        self.assertEqual(tail, expected); self.assertNotIn(TOKEN, tail)


class CliTests(RunnerCase):
    def test_help(self):
        done = subprocess.run([sys.executable, str(HERE / 'run_review_eval.py'), '--help'],
                              capture_output=True, text=True, env=self.env)
        self.assert_ok(done)
        for flag in ('--matrix', '--output', '--spend', '--resume', '--retry-errors', '--jobs', '--case', '--budget-usd'):
            self.assertIn(flag, done.stdout)

    def test_plan_only_without_spend(self):
        for config, grade in [('claude', 'fake'), ('fake', 'claude')]:
            with self.subTest(config=config, grade=grade):
                self.configure(harness=config, grader=grade)
                done = self.cli(); self.assert_ok(done)
                for phrase in ('Configs:', 'review calls:', 'match calls:', 'extras calls:', 'estimated cost:', 'budget_usd:'):
                    self.assertIn(phrase, done.stdout)
                self.assertFalse(self.output.exists()); self.assertFalse(self.events())

    def assert_refusal(self, done):
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertEqual(sum(l.startswith('refusing:') for l in done.stderr.splitlines()), 1)
        self.assertNotIn('Traceback', done.stderr)
        self.assertFalse(self.events())

    def test_refusals(self):
        for condition in ('exists', 'git', 'unknown', 'zero', 'case', 'matrix', 'jobs', 'preflight'):
            with self.subTest(condition=condition):
                self.configure(); self.write_case('case-a')
                output = self.root / ('refuse-' + condition)
                flags = []
                if condition == 'exists': output.mkdir()
                if condition == 'git': output = run.REPO / ('refuse-' + condition)
                if condition == 'unknown': flags = ['--case', 'unknown']
                if condition == 'zero': self.configure(case_filter={'skill': ['review'], 'tags_any': ['absent']})
                if condition == 'case': (self.cases_dir / 'case-a.json').write_text('{}')
                if condition == 'matrix': self.matrix_file.write_text('{}')
                if condition == 'jobs': flags = ['--jobs', '0']
                if condition == 'preflight': self.configure(harness='claude'); self.token_file.unlink()
                self.assert_refusal(self.cli(*flags, output=output, spend=condition == 'preflight'))
                if condition != 'exists': self.assertFalse(output.exists())

    def test_case_flag_overrides_filter(self):
        self.configure(case_filter={'skill': ['review'], 'tags_any': ['absent']}, case_limit=1)
        self.assert_ok(self.cli('--case', 'case-b', '--case', 'case-c'))
        self.assertEqual({r['case_id'] for r in self.state().reviews.values()}, {'case-b', 'case-c'})

    def test_hostile_environment_allowlist(self):
        self.configure(harness='claude', grader='claude')
        hostile = {k: 'hostile-marker' for k in ('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'BORK_RUN_DIR',
                   'HERDR_X', 'CLAUDE_CODE_SESSION_ID', 'CODEX_COMPANION_X', 'GOOGLE_CLIENT_SECRET_FILE')}
        self.env.update(hostile)
        self.assert_ok(self.cli(spend=True))
        self.assertEqual({e['kind'] for e in self.events()}, {'review', 'grade'})
        extras = {'HOME', 'CLAUDE_CONFIG_DIR', 'AGENT_HANDOFFS_DIR', 'BORK_REPO_RULES_DIR',
                  'CLAUDE_CODE_OAUTH_TOKEN', 'GIT_TERMINAL_PROMPT', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'}
        for event in self.events():
            self.assertTrue(all(k in run.caselib.ENV_PASS or k.startswith('LC_') or k in extras for k in event['env']))
            self.assertNotIn('hostile-marker', event['env'].values())

    def test_report_failure_exit(self):
        for target in ('results', 'report'):
            with self.subTest(target=target):
                dest = self.output; self.output = self.root / target
                where, name = (run.results, 'write') if target == 'results' else (run.build_report, 'build_run')
                module = 'r.results' if target == 'results' else 'r.build_report'
                code = ('import runpy,sys; sys.path.insert(0,' + repr(str(HERE)) + '); '
                        'import run_review_eval as r; '
                        f'{module}.{name} = lambda *a,**k: (_ for _ in ()).throw(RuntimeError("publish failed")); '
                        'sys.argv=[sys.argv[1],*sys.argv[2:]]; runpy.run_path(sys.argv[0],run_name="__main__")')
                done = subprocess.run([sys.executable, '-c', code, str(HERE / 'run_review_eval.py'),
                                       '--matrix', str(self.matrix_file), '--output', str(self.output)],
                                      env=self.env, capture_output=True, text=True)
                self.assertNotEqual(done.returncode, 0)
                self.assertEqual(len(done.stderr.splitlines()), 1)
                self.assertTrue(self.state().records)
                self.output = dest

    def test_refuses_paths_inside_deny_read(self):
        for kind in ('cases', 'token', 'private', 'work'):
            with self.subTest(kind=kind):
                output = self.root / ('outside-' + kind)
                if kind == 'cases': output = self.cases_dir / 'run'
                if kind == 'token': output = self.token_file.parent / 'run'
                if kind == 'private': output = self.home / 'git/skills-private/run'
                env = dict(self.env)
                if kind == 'work': self.env['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.home / '.borkweb-skills/token')
                self.assert_refusal(self.cli(output=output)); self.assertFalse(output.exists())
                self.assertFalse((self.home / '.borkweb-skills/eval-work').exists())
                self.env = env

    def test_unsupported_skill_loading_refuses(self):
        self.configure(configs=[dict(harness='claude', model='m', effort=None, skill_loading='inline')])
        for spend in (False, True):
            with self.subTest(spend=spend):
                self.assert_refusal(self.cli(spend=spend)); self.assertFalse(self.output.exists())
        self.assertEqual(run.harnesses.supported_loading('claude'), ('plugin',))
        self.assertIsInstance(run.harnesses.supported_loading('fake'), tuple)


class WriterTests(RunnerCase):
    def test_lines_whole_and_escaped(self):
        self.configure(trials=12)
        fake = run.harnesses.load('fake'); original = fake.grade
        def grade(req, ctx):
            reply = original(req, ctx)
            if 'reported' in reply['parsed']:
                reply['parsed']['reported'] = [dict(n=1, file='file.txt', lines='1', severity='IMPORTANT',
                                                   summary='a\u2028b\u2029c', names=['extra'])]
            return reply
        with patch.object(fake, 'grade', side_effect=grade):
            self.assertEqual(self.in_process('--jobs', '4'), 0)
        data = (self.output / 'trials.jsonl').read_bytes()
        self.assertTrue(data.endswith(b'\n')); self.assertNotIn('\u2028'.encode(), data); self.assertNotIn('\u2029'.encode(), data)
        records = self.state().records
        self.assertEqual(len(data.splitlines()), len(records))
        self.assertIn(b'\\u2028', data); self.assertIn(b'\\u2029', data)
        self.assertTrue(all(r['schema'] == 'bork-review-trial/1' for r in records))

    def test_cost_fields_bounded(self):
        fake = run.harnesses.load('fake'); original = fake.review
        for i, tokens in enumerate((True, '20', -1, 1.2, 10**20)):
            with self.subTest(tokens=tokens):
                self.output = self.root / f'run{i}'
                def review(req, ctx):
                    return dict(original(req, ctx), usage={'input_tokens': tokens, 'output_tokens': tokens})
                with patch.object(fake, 'review', side_effect=review):
                    self.assertEqual(self.in_process(), 0)
                for r in self.state().records:
                    for name in ('cost_usd', 'grader_cost_usd'):
                        cost = r.get(name)
                        self.assertTrue(cost is None or type(cost) is float and 0 <= cost <= 1e6)
                    if r['type'] == 'review':
                        # The report's finite-number contract caps numeric magnitude at 1e15.
                        self.assertEqual(r['usage']['input_tokens'], min(tokens, 10**15) if type(tokens) is int and tokens >= 0 else None)

    def test_attempts_strictly_increase(self):
        self.assert_ok(self.cli()); self.assert_ok(self.cli(resume=True))
        records = self.state().records
        for r in records:
            if r['type'] == 'review': r.update(outcome='error', reason='retry')
        self.rewrite_records(records)
        self.assert_ok(self.cli('--retry-errors', resume=True)); self.assert_ok(self.cli(resume=True))
        latest = {}
        for r in self.state().records:
            key = r['type'], r['key']
            self.assertEqual(r['attempt'], latest.get(key, 0) + 1)
            latest[key] = r['attempt']
        self.assertTrue(any(value > 1 for value in latest.values()))

    def test_extras_covers_name_earlier_records(self):
        self.assert_ok(self.cli())
        earlier = set()
        for r in self.state().records:
            if r['type'] == 'extras':
                self.assertEqual(set(r['covers']), set(r['tokens']))
                for token, attempts in r['covers'].items():
                    self.assertIn(('review', token, attempts['review_attempt']), earlier)
                    self.assertIn(('match', token, attempts['match_attempt']), earlier)
            earlier.add((r['type'], r['key'], r['attempt']))


class ResumeTests(RunnerCase):
    def test_resume_repairs_ledger_tail(self):
        self.assert_ok(self.cli()); complete = (self.output / 'trials.jsonl').read_bytes()
        for kind in ('torn', 'unterminated'):
            with self.subTest(kind=kind):
                lines = complete.splitlines(keepends=True)
                prefix = b''.join(lines[:-1])
                data = prefix + (lines[-1][:30] if kind == 'torn' else lines[-1].rstrip(b'\n'))
                (self.output / 'trials.jsonl').write_bytes(data)
                self.assert_ok(self.cli(resume=True))
                after = (self.output / 'trials.jsonl').read_bytes()
                self.assertTrue(after.startswith(prefix)); self.assertTrue(self.state().extras)
                self.assertTrue(after.endswith(b'\n'))

    def test_resume_at_each_record_boundary(self):
        self.configure(harness='claude'); self.assert_ok(self.cli(spend=True))
        lines = (self.output / 'trials.jsonl').read_bytes().splitlines(keepends=True)
        for k in range(len(lines) + 1):
            with self.subTest(k=k):
                (self.output / 'trials.jsonl').write_bytes(b''.join(lines[:k]))
                before = len(self.events('review'))
                self.assert_ok(self.cli(resume=True, spend=True))
                self.assertEqual(len(self.events('review')) - before, int(k == 0))
                self.assertTrue(self.state().matches); self.assertTrue(self.state().extras)

    def test_resume_rerun_policy(self):
        self.configure(harness='claude'); self.assert_ok(self.cli(spend=True))
        original = self.state().records
        rows = [('ok', None, False), ('error', 'bad', False), ('env-unavailable', 'model fell back to x', False),
                ('env-unavailable', 'effort fell back to x', False), ('env-unavailable', 'plugin loading unavailable', False),
                ('skipped', 'budget', True), ('env-unavailable', 'rate-limit', True),
                ('env-unavailable', 'snapshot: bad', True)]
        for outcome, reason, rerun in rows:
            with self.subTest(outcome=outcome, reason=reason):
                records = json.loads(json.dumps(original)); records[0].update(outcome=outcome, reason=reason)
                self.rewrite_records(records)
                before = len(self.events('review')); self.assert_ok(self.cli(resume=True, spend=True))
                self.assertEqual(len(self.events('review')) - before, int(rerun))
        for retry in (False, True):
            records = json.loads(json.dumps(original)); records[0].update(outcome='error', reason='bad')
            self.rewrite_records(records); before = len(self.events('review'))
            self.assert_ok(self.cli(*(['--retry-errors'] if retry else []), resume=True, spend=True))
            self.assertEqual(len(self.events('review')) - before, int(retry))
        for kind in ('missing', 'ungraded', 'stale'):
            with self.subTest(match=kind):
                records = json.loads(json.dumps(original))
                if kind == 'missing': records = [r for r in records if r['type'] != 'match']
                else:
                    for r in records:
                        if r['type'] == 'match':
                            if kind == 'ungraded': r['outcome'] = 'ungraded'
                            else: r['review_attempt'] += 1
                self.rewrite_records(records); before = len(self.events('review')); grade = len(self.events('grade'))
                self.assert_ok(self.cli(resume=True, spend=True))
                self.assertEqual(len(self.events('review')), before)
                self.assertGreater(len(self.state().matches), 0)

    def test_resume_refuses_manifest_drift(self):
        self.assert_ok(self.cli()); manifest = self.manifest()
        data = (self.output / 'trials.jsonl').read_bytes()
        for field in ('matrix_sha256', 'skills_sha', 'case_set_sha256', 'grader', 'matrix-file'):
            with self.subTest(field=field):
                changed = json.loads(json.dumps(manifest)); flags = []
                if field == 'grader': changed['grader']['model'] = 'changed'
                elif field == 'matrix-file':
                    self.configure(trials=2); flags = ['--matrix', str(self.matrix_file)]
                else: changed[field] = '0' * 64
                run.write_json(self.output / 'run.json', changed)
                done = self.cli(*flags, resume=True)
                self.assertEqual(done.returncode, 2, done.stderr)
                self.assertEqual(sum(s.startswith('refusing:') for s in done.stderr.splitlines()), 1)
                self.assertEqual((self.output / 'trials.jsonl').read_bytes(), data)
                self.assertFalse(self.events())
        run.write_json(self.output / 'run.json', manifest)

    def test_budget_override_on_resume(self):
        raw = self.configure(budget_usd=.000001)
        expected = hashlib.sha256(json.dumps({k: v for k, v in raw.items() if k != 'budget_usd'},
                                             sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assert_ok(self.cli()); self.assertEqual(self.manifest()['matrix_sha256'], expected)
        self.assertEqual(next(iter(self.state().reviews.values()))['reason'], 'budget')
        raw['budget_usd'] = 200; self.matrix_file.write_text(json.dumps(raw))
        self.assert_ok(self.cli('--matrix', str(self.matrix_file), '--budget-usd', '200', resume=True))
        self.assertEqual(next(iter(self.state().reviews.values()))['outcome'], 'ok')
        self.assertEqual(self.manifest()['budget_overrides'][-1]['budget_usd'], 200)
        fresh = self.root / 'fresh-budget'
        self.assert_ok(self.cli('--budget-usd', '0.000001', output=fresh))
        self.assertEqual(self.manifest(fresh)['matrix']['budget_usd'], .000001)
        self.assertEqual(next(iter(self.state(fresh).reviews.values()))['reason'], 'budget')

    def test_run_dir_lock(self):
        self.assert_ok(self.cli()); before = (self.output / 'trials.jsonl').read_bytes()
        lock = self.output / '.lock'; lock.write_text(str(os.getpid()))
        for flags in ([], ['--retry-errors']):
            with self.subTest(flags=flags):
                done = self.cli(*flags, resume=True)
                self.assertEqual(done.returncode, 2); self.assertIn('refusing:', done.stderr)
                self.assertEqual((self.output / 'trials.jsonl').read_bytes(), before)
                self.assertFalse(self.events())
        proc = subprocess.Popen([sys.executable, '-c', 'pass'], env=self.env); proc.wait()
        lock.write_text(str(proc.pid)); done = self.cli(resume=True); self.assert_ok(done)
        self.assertIn('replaced stale run lock', done.stderr); self.assertFalse(lock.exists())

    def test_regraded_match_refreshes_extras(self):
        self.configure(harness='claude', grader='claude')
        claim = dict(n=1, file='file.txt', lines='1', severity='IMPORTANT', summary='old claim', names=['extra'])
        common.configure(self.bin, reported=[claim], ruling='not-real')
        self.assert_ok(self.cli(spend=True)); old = self.state()
        records = old.records
        for r in records:
            if r['type'] == 'match': r['outcome'] = 'ungraded'
        self.rewrite_records(records)
        common.configure(self.bin, reported=[dict(claim, summary='new claim')], ruling='real')
        self.assert_ok(self.cli(resume=True, spend=True)); state = self.state()
        token = next(iter(state.reviews)); extra = state.extras['case-a']
        self.assertEqual(extra['covers'][token]['match_attempt'], state.matches[token]['attempt'])
        self.assertGreater(extra['attempt'], old.extras['case-a']['attempt'])
        doc = run.results.check_results.load(self.output)
        self.assertEqual(doc['trials'][0]['metrics']['precision'], 1)


def overlap(events):
    points = sorted([(e['at'], 1 if e['event'] == 'start' else -1) for e in events])
    active = peak = 0
    for _, delta in points:
        active += delta; peak = max(peak, active)
    return peak


class SchedulerTests(RunnerCase):
    def test_jobs_limit(self):
        self.configure(harness='claude', grader='claude', trials=8, max_parallel={'claude': 8})
        common.configure(self.bin, delay=.12, grade_delay=.12)
        self.assert_ok(self.cli('--jobs', '2', spend=True))
        self.assertEqual(overlap(common.calls(self.bin)), 2)

    def test_max_parallel_counts_grader_calls(self):
        self.configure(harness='claude', grader='claude', trials=4, max_parallel={'claude': 1})
        self.assert_ok(self.cli('--jobs', '4', spend=True))
        self.assertEqual({e['kind'] for e in self.events()}, {'review', 'grade'})
        self.assertEqual(overlap(common.calls(self.bin)), 1)

    def test_grader_harness_limit_from_raw_matrix(self):
        self.configure(grader='claude', trials=4, max_parallel={'claude': 1})
        self.assert_ok(self.cli('--jobs', '4', spend=True))
        self.assertEqual(len(self.events('grade')), 4)
        self.assertEqual(overlap(common.calls(self.bin)), 1)


class BudgetTests(RunnerCase):
    def test_reservation_is_atomic(self):
        count = 6
        cfg = dict(harness='claude', model='unpriced', effort=None)
        estimate = run.estimate('unpriced', 'review') + run.estimate('grade-model', 'match') + run.estimate('grade-model', 'extras') / count
        self.configure(harness='claude', grader='claude', trials=count, configs=[cfg], budget_usd=estimate * 2,
                       max_parallel={'claude': 4})
        common.configure(self.bin, delay=.2)
        self.assert_ok(self.cli('--jobs', '4', spend=True))
        events = common.calls(self.bin)
        first_end = min(e['at'] for e in events if e['event'] == 'end' and e['kind'] == 'review')
        initial = [e for e in events if e['event'] == 'start' and e['kind'] == 'review' and e['at'] < first_end]
        self.assertLessEqual(len(initial), 2)
        self.assertTrue(any(r['reason'] == 'budget' for r in self.state().reviews.values()))
        self.assertLessEqual(len(initial) * estimate, estimate * 2 + 1e-12)
        records = self.state().records
        reservations = {}
        share = run.estimate('grade-model', 'extras') / count
        for event in sorted(self.events('review'), key=lambda e: e['at']):
            past = [r for r in records if datetime.fromisoformat(r['at']).timestamp() <= event['at']]
            spent = sum((r.get('cost_usd') or r.get('grader_cost_usd') or 0) for r in past)
            completed = {r['key'] for r in past if r['type'] == 'match'}
            costs = [sum((r.get('cost_usd') or r.get('grader_cost_usd') or 0)
                         for r in past if r['key'] == token) for token in completed]
            reserve = (sum(costs) / len(costs) + share) if costs else estimate
            outstanding = 0
            for token, admission in reservations.items():
                paid = sum((r.get('cost_usd') or r.get('grader_cost_usd') or 0) for r in past if r['key'] == token)
                outstanding += share if token in completed else max(0, admission - paid)
            self.assertLessEqual(spent + outstanding + reserve, estimate * 2 + 1e-12)
            reservations[Path(event['cwd']).name] = reserve

    def test_unpriced_model_counts_at_highest_price(self):
        self.assert_ok(self.cli())
        r = next(iter(self.state().reviews.values()))
        prices = run.matrix._prices()['models']
        expected = max(run.matrix.cost(name, r['usage']) for name in prices)
        self.assertEqual(r['cost_usd'], expected)
        model = run.matrix.load(self.matrix_file)
        record = dict(r, cost_usd=None)
        budget = run.Budget(1, [record], model.configs, model.grader['model'])
        self.assertEqual(budget.spent, expected)
        self.assertEqual(run.estimate('unknown', 'review'), max(run.matrix.cost(n, run.matrix._prices()['estimates']['review']) for n in prices))

    def test_resume_seeds_spent_total(self):
        self.configure(harness='claude', grader='claude', trials=2, budget_usd=1)
        self.assert_ok(self.cli(spend=True)); records = self.state().records
        for r in records:
            if r['type'] == 'review': r['cost_usd'] = 1.0
        records = [r for r in records if not (r['type'] == 'review' and r['trial'] == 2)]
        self.rewrite_records(records); before = len(self.events('review'))
        self.assert_ok(self.cli(resume=True, spend=True))
        self.assertEqual(len(self.events('review')), before)
        self.assertTrue(any(r['reason'] == 'budget' for r in self.state().reviews.values()))

    def test_budget_never_strands_a_paid_review(self):
        self.configure(harness='claude', grader='claude', trials=6, budget_usd=1)
        common.configure(self.bin, usage={'input_tokens': 30000, 'output_tokens': 4000},
                         grade_usage={'input_tokens': 10000, 'output_tokens': 2000})
        self.assert_ok(self.cli('--jobs', '4', spend=True))
        state = self.state(); ok = {t for t, r in state.reviews.items() if r['outcome'] == 'ok'}
        self.assertTrue(ok); self.assertTrue(ok <= state.matches.keys())
        self.assertLessEqual(sum((r.get('cost_usd') or r.get('grader_cost_usd') or 0) for r in state.records), 1)

    def test_failed_call_cost_counts(self):
        for mode in ('error', 'rate-limit'):
            with self.subTest(mode=mode):
                self.output = self.root / mode; self.configure(harness='claude')
                common.configure(self.bin, mode=mode)
                self.assert_ok(self.cli(spend=True)); state = self.state()
                r = next(iter(state.reviews.values()))
                self.assertIsInstance(r['cost_usd'], float); self.assertGreater(r['cost_usd'], 0)
                m = run.matrix.load(self.matrix_file)
                self.assertEqual(run.Budget(10, state.records, m.configs, m.grader['model']).spent, r['cost_usd'])


class BreakerTests(RunnerCase):
    def setup_mixed(self):
        self.configure(grader='claude', trials=3, max_parallel={'claude': 1},
                       configs=[dict(harness='claude', model='review-model', effort=None),
                                dict(harness='fake', model='other', effort=None)])

    def test_review_rate_limit_trips_harness(self):
        self.setup_mixed()
        raw = json.loads(self.matrix_file.read_text()); raw['grader']['harness'] = 'fake'
        self.matrix_file.write_text(json.dumps(raw))
        common.configure(self.bin, mode='rate-limit')
        self.assert_ok(self.cli('--jobs', '2', spend=True)); state = self.state()
        limited = [r for r in state.reviews.values() if r['config_key'].startswith('claude|')]
        self.assertTrue(all(r['outcome'] == 'env-unavailable' and r['reason'] == 'rate-limit' for r in limited))
        self.assertEqual(len(self.events('review')), 1)
        review_end = next(e['at'] for e in common.calls(self.bin) if e['event'] == 'end' and e['kind'] == 'review')
        self.assertFalse(any(e['at'] > review_end for e in self.events()))
        self.assertTrue(any(r['outcome'] == 'ok' and r['config_key'].startswith('fake|') for r in state.reviews.values()))
        self.assertTrue(all(t['outcome'] == 'graded' for t in run.results.check_results.load(self.output)['trials']
                            if t['config_id'].startswith('fake|')))

    def test_grader_rate_limit_trips_grader_harness(self):
        self.setup_mixed(); common.configure(self.bin, grade_rate_limit=True)
        self.assert_ok(self.cli('--jobs', '1', spend=True)); state = self.state()
        self.assertTrue(any(r['outcome'] == 'ungraded' and r['reason'] == 'rate-limit' for r in state.matches.values()))
        self.assertEqual(len(self.events('grade')), 1)
        end = next(e['at'] for e in common.calls(self.bin) if e['event'] == 'end' and e['kind'] == 'grade')
        self.assertFalse(any(e['at'] > end for e in self.events()))
        self.assertTrue(all(r['outcome'] == 'ok' for r in state.reviews.values() if r['config_key'].startswith('fake|')))

    def test_resume_reruns_rate_limited(self):
        self.configure(harness='claude', grader='claude'); common.configure(self.bin, mode='rate-limit')
        self.assert_ok(self.cli(spend=True)); common.configure(self.bin, grade_rate_limit=True)
        self.assert_ok(self.cli(resume=True, spend=True)); before = len(self.events('review'))
        self.assertEqual(next(iter(self.state().matches.values()))['outcome'], 'ungraded')
        common.configure(self.bin); self.assert_ok(self.cli(resume=True, spend=True))
        self.assertEqual(len(self.events('review')), before)
        self.assertTrue(all(m['outcome'] == 'graded' for m in self.state().matches.values()))


class CouncilTests(RunnerCase):
    def test_independent_review_and_basis(self):
        # Completion-table form preserved from the review reports in this run.
        samples = [('| Independent review | unavailable — parent delegation limit |\nVerdict basis: defect found',
                    'unavailable — parent delegation limit', 'defect found'),
                   ('| Independent review |  Completed ' + TOKEN + ' |\nreadiness unverified',
                    'Completed [redacted]', 'readiness unverified'),
                   ('| Independent review | This report is the independent pass |',
                    'This report is the independent pass', None), ('plain text', None, None)]
        for text, independent, basis in samples:
            with self.subTest(text=text):
                value = run.metadata(text, [TOKEN])
                self.assertEqual(value, dict(independent_review=independent, verdict_basis=basis))

    def test_diff_over_200_tag(self):
        for text, result in [('1 file changed, 1 insertion(+)', False), ('1 file changed, 200 insertions(+)', False),
                             ('1 file changed, 201 deletions(-)', True),
                             ('2 files changed, 100 insertions(+), 101 deletions(-)', True)]:
            with self.subTest(text=text): self.assertEqual(run.diff_over_200(text), result)
        self.assert_ok(self.cli())
        self.assertIn('diff_over_200', run.results.check_results.load(self.output)['cases'][0]['tags'])
        self.assertNotIn('diff_over_200', json.loads((self.output / 'cases/case-a.json').read_text())['tags'])

    def test_block_sensitivity_note(self):
        self.assert_ok(self.cli()); doc = run.results.check_results.load(self.output)
        self.assertIn('block sensitivity only', doc['run']['notes']); self.assertIn('always blocks scores 100%', doc['run']['notes'])
        self.assertIn('block sensitivity only', (self.output / 'report.html').read_text())
        self.write_case('case-a', expected_verdict='SAFE TO LAND')
        other = self.root / 'nonblocking'; self.assert_ok(self.cli(output=other))
        self.assertNotIn('block sensitivity only', run.results.check_results.load(other)['run'].get('notes', ''))


class IsolationTests(RunnerCase):
    def test_deny_read_and_budget_in_requests(self):
        self.configure(harness='claude', grader='claude', budget_usd=3)
        self.assert_ok(self.cli(spend=True))
        for e in self.events():
            argv = e['argv']; settings = json.loads(argv[argv.index('--settings') + 1])
            rules = settings['permissions']['deny']
            for path in (self.output, self.cases_dir, self.token_file.parent, self.home / 'git/skills-private'):
                self.assertIn('Read(/' + str(path) + '/**)', rules)
            self.assertEqual(float(argv[argv.index('--max-budget-usd') + 1]), 3 if e['kind'] == 'review' else 2)

    def test_deny_read_never_covers_work_paths(self):
        self.configure(harness='claude', grader='claude'); self.assert_ok(self.cli(spend=True))
        denied = run.deny_paths(self.output, self.cases_dir)
        for e in self.events():
            paths = [Path(e['cwd']), *(Path(v) for k, v in e['env'].items() if k in ('HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR'))]
            if '--plugin-dir' in e['argv']: paths.append(Path(e['argv'][e['argv'].index('--plugin-dir') + 1]))
            for path in paths:
                self.assertFalse(any(path == d or d in path.parents for d in denied))

    def test_work_paths_are_opaque(self):
        self.configure(harness='claude', grader='claude'); seen = []
        fake = run.harnesses.load('fake')
        original = run.snapshot.make_snapshot
        def snap(source, base, head, dest, timeout):
            result = original(source, base, head, dest, timeout)
            seen.append((str(dest.name), run.caselib.git(dest, 'for-each-ref', '--format=%(refname)')))
            return result
        with patch.object(run.snapshot, 'make_snapshot', side_effect=snap):
            self.assertEqual(self.in_process('--spend'), 0)
        self.assertEqual(seen[0][0], 's' + hashlib.sha256(b'case-a').hexdigest()[:12])
        for e in self.events():
            work = Path(self.manifest()['work_root'])
            rel = str(Path(e['cwd']).relative_to(work))
            for marker in ('case-a', 'Private case title', 'claude', 'review-model', 'claude|review-model'):
                self.assertNotIn(marker, rel); self.assertNotIn(marker, seen[0][1])

    def test_grader_call_is_blind(self):
        self.configure(grader='claude', configs=[dict(harness='fake', model='private-model-marker', effort=None)])
        self.assert_ok(self.cli(spend=True))
        self.assertTrue(self.events('grade'))
        for e in self.events('grade'):
            text = json.dumps([e['argv'], list(e['env'].values()), e['stdin'], e['cwd']])
            for marker in ('private-model-marker', 'fake|', 'case-a', 'Private case title'):
                self.assertNotIn(marker, text)

    def test_grade_working_directories(self):
        self.configure(harness='claude', grader='claude')
        common.configure(self.bin, modify_review_copy=True, reported=[dict(n=1, file='file.txt', lines='1', severity='IMPORTANT',
                                                 summary='extra', names=['extra'])])
        self.assert_ok(self.cli(spend=True)); grades = self.events('grade')
        self.assertEqual(len(grades), 2)
        self.assertEqual(Path(grades[0]['cwd']).name, 'empty')
        self.assertEqual(grades[0]['cwd_entries'], [])
        self.assertEqual(Path(grades[1]['cwd']).name, 'extras')
        self.assertNotIn('review-only', grades[1]['cwd_entries'])
        self.assertEqual(grades[1]['head_file'], ''.join(f'line {i}\n' for i in range(220)))
        self.assertTrue(all(not Path(e['cwd']).exists() for e in grades))


class GraderFlowTests(RunnerCase):
    def test_verdict_fallback(self):
        self.configure(harness='claude', grader='claude')
        for verdict in ('DO NOT LAND', 'not-a-verdict'):
            with self.subTest(verdict=verdict):
                self.output = self.root / verdict.replace(' ', '-')
                common.configure(self.bin, result_text='SAFE TO LAND and DO NOT LAND', verdict=verdict)
                self.assert_ok(self.cli(spend=True)); record = next(iter(self.state().matches.values()))
                self.assertEqual(record['verdict_method'], 'grader')
                self.assertEqual(record['verdict'], verdict if verdict == 'DO NOT LAND' else None)
                self.assertEqual(record['outcome'], 'graded')

    def test_unparsed_reply_is_ungraded(self):
        self.configure(harness='claude', grader='claude'); common.configure(self.bin, grade_mode='non-json')
        self.assert_ok(self.cli(spend=True))
        self.assertEqual(next(iter(self.state().matches.values()))['outcome'], 'ungraded')
        self.assertEqual(run.results.check_results.load(self.output)['trials'][0]['outcome'], 'ungraded')

    def test_extras_fresh_after_run(self):
        self.configure(harness='claude', grader='claude', trials=2, max_parallel={'claude': 1})
        common.configure(self.bin, bad_match_n=2, reported=[dict(n=1, file='file.txt', lines='1', severity='IMPORTANT', summary='extra', names=['extra'])])
        self.assert_ok(self.cli(spend=True)); state = self.state()
        self.assertIn('case-a', state.extras)
        self.assertTrue(any(m['outcome'] == 'ungraded' for m in state.matches.values()))
        self.assertTrue(all(t['metrics']['precision'] is not None for t in run.results.check_results.load(self.output)['trials'] if t['outcome'] == 'graded'))

    def test_match_uses_frozen_case(self):
        self.configure(grader='claude')
        original = run.harnesses.load('fake').review
        def review(req, ctx):
            self.write_case('case-a', expected_findings=[dict(id='F2', file='file.txt', lines='2', severity='IMPORTANT', answer='Changed answer.')])
            return original(req, ctx)
        with patch.object(run.harnesses.load('fake'), 'review', side_effect=review):
            self.assertEqual(self.in_process('--spend'), 0)
        self.assertIn('Missing check.', self.events('grade')[0]['stdin'])
        self.assertNotIn('Changed answer.', self.events('grade')[0]['stdin'])


class SnapshotTests(RunnerCase):
    def test_one_live_snapshot(self):
        self.configure(harness='claude', grader='claude', case_limit=3)
        self.assert_ok(self.cli(spend=True)); self.assertTrue(self.events())
        self.assertTrue(all(e['snapshots'] == 1 for e in self.events()))

    def test_snapshot_failure_marks_case(self):
        self.write_case('case-a', base='f' * 40)
        self.configure(harness='claude', case_limit=2)
        self.assert_ok(self.cli(spend=True)); state = self.state()
        bad = [r for r in state.reviews.values() if r['case_id'] == 'case-a']
        self.assertTrue(all(r['outcome'] == 'env-unavailable' and r['reason'].startswith('snapshot: ') for r in bad))
        self.assertEqual(len(self.events('review')), 1)
        self.assertTrue(any(r['outcome'] == 'ok' and r['case_id'] == 'case-b' for r in state.reviews.values()))
        self.assert_ok(self.cli(resume=True, spend=True))
        self.assertGreater(self.state().reviews[bad[0]['key']]['attempt'], bad[0]['attempt'])

    def test_low_disk_refuses_snapshot(self):
        with patch.object(run.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(100, 99, 1)):
            self.assertEqual(self.in_process(), 0)
        record = next(iter(self.state().reviews.values()))
        self.assertEqual(record['outcome'], 'env-unavailable'); self.assertIn('free space', record['reason'])
        self.assertTrue(record['reason'].startswith('snapshot: '))

    def test_free_space_rule(self):
        marker = self.bin / 'du-marker'
        du = self.bin / 'du'; du.write_text(f'#!{sys.executable}\nfrom pathlib import Path\nPath({str(marker)!r}).touch()\n'); du.chmod(0o700)
        for free in (10 * 1024**3 - 1, 10 * 1024**3):
            with self.subTest(free=free):
                self.output = self.root / str(free)
                with patch.object(run.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(free, 0, free)):
                    self.assertEqual(self.in_process(), 0)
                self.assertEqual(next(iter(self.state().reviews.values()))['outcome'], 'ok' if free == 10 * 1024**3 else 'env-unavailable')
        self.assertFalse(marker.exists())

    def test_cleanup_link_safe(self):
        outside = self.root / 'outside'; outside.write_bytes(b'outside'); outside.chmod(0o444)
        original = run.harnesses.load('fake').review
        def review(req, ctx):
            copy = Path(req['trial_copy']); (copy / 'link').symlink_to(outside); os.link(outside, copy / 'hard')
            return original(req, ctx)
        with patch.object(run.harnesses.load('fake'), 'review', side_effect=review):
            self.assertEqual(self.in_process(), 0)
        self.assertEqual(outside.read_bytes(), b'outside'); self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o444)
        self.assertFalse(Path(self.manifest()['work_root']).exists())

    def test_resume_after_crash_leftovers(self):
        self.assert_ok(self.cli()); work = Path(self.manifest()['work_root']); work.mkdir()
        for name in ('s123', 't123', 't123-tmp'): (work / name).mkdir()
        self.assert_ok(self.cli(resume=True)); self.assertFalse(work.exists())


class SecretsTests(RunnerCase):
    def test_token_never_stored(self):
        self.configure(harness='claude', grader='claude'); common.configure(self.bin, echo_token=True)
        done = self.cli(spend=True); self.assert_ok(done)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)
        for path in self.output.rglob('*'):
            if path.is_file(): self.assertNotIn(TOKEN.encode(), path.read_bytes(), str(path.relative_to(self.output)))
        from harnesses import claude
        original = claude.review
        def review(req, ctx):
            reply = original(req, ctx)
            (Path(req['raw_dir']) / 'stderr.txt').write_text('late adapter stderr ' + TOKEN)
            return reply
        self.output = self.root / 'late-raw'
        with patch.object(claude, 'review', side_effect=review):
            self.assertEqual(self.in_process('--spend'), 0)
        for path in self.output.rglob('*'):
            if path.is_file(): self.assertNotIn(TOKEN.encode(), path.read_bytes(), str(path.relative_to(self.output)))

    def test_tmp_root_removed(self):
        self.configure(harness='claude')
        for mode in ('ok', 'error', 'sleep'):
            with self.subTest(mode=mode):
                self.output = self.root / mode
                self.configure(harness='claude', timeout_s=1)
                common.configure(self.bin, mode=mode)
                self.assert_ok(self.cli(spend=True))
                self.assertFalse(Path(self.manifest()['work_root']).exists())


class CleanupTests(RunnerCase):
    def test_cleanup_failure_is_logged_not_raised(self):
        from harnesses import claude
        logs = []
        ctx = run.harnesses.Context(run.caselib.scrubbed_env(), run.procs.run_group, [TOKEN], logs.append)
        original = run.snapshot.remove_tree
        def fail(path, root):
            if 'preflight' in str(path) or str(path).endswith('-tmp'):
                original(path, root)
                raise run.snapshot.SnapshotError('cleanup\n' + TOKEN)
            return original(path, root)
        with patch.object(run.snapshot, 'remove_tree', side_effect=fail):
            claude.preflight(ctx)
            self.assertEqual(self.in_process(), 0)
        self.assertTrue(logs); self.assertTrue(all('\n' not in s and TOKEN not in s for s in logs))
        import contextlib
        import io
        import check_isolation
        common.configure(self.bin, isolation=True)
        transcript = io.StringIO()
        def isolation_failure(path, root):
            original(path, root)
            raise run.snapshot.SnapshotError('cleanup\n' + TOKEN)
        with contextlib.redirect_stdout(transcript), contextlib.redirect_stderr(transcript):
            with patch.object(run.snapshot, 'remove_tree', side_effect=isolation_failure):
                code = check_isolation.main(['--spend', '--model', 'm', '--export', str(self.export)])
        self.assertIn(code, (0, 1, 2))
        self.assertIn('cleanup:', transcript.getvalue())
        self.assertNotIn(TOKEN, transcript.getvalue())


class ProcsRegistryTests(RunnerCase):
    def test_signal_between_spawn_and_registration_reaps_child(self):
        children = []
        original = subprocess.Popen
        def spawn(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            self.assertEqual(os.getpgid(child.pid), child.pid)
            os.kill(os.getpid(), signal.SIGINT)
            return child
        def stop(signum, frame):
            run.procs.kill_all(grace=0)
            raise KeyboardInterrupt()
        previous = signal.signal(signal.SIGINT, stop)
        try:
            with patch.object(run.procs.subprocess, 'Popen', side_effect=spawn):
                with self.assertRaises(KeyboardInterrupt):
                    run.procs.run_group([sys.executable, '-c', 'import time; time.sleep(60)'], env=self.env, grace=0)
            self.assertEqual(len(children), 1)
            self.assertTrue(pid_dead(children[0].pid))
            self.assertFalse(run.procs._groups)
        finally:
            signal.signal(signal.SIGINT, previous)
            run.procs.reset_registry()

    def test_registry_empty_after_every_exit_path(self):
        for mode in ('normal', 'timeout', 'exception', 'callback'):
            with self.subTest(mode=mode):
                run.procs.reset_registry()
                if mode == 'exception':
                    def fail(line):
                        raise RuntimeError('observer failed')
                    with self.assertRaises(RuntimeError):
                        run.procs.run_group([sys.executable, '-c', 'print("line",flush=True)'],
                                            env=self.env, on_stdout_line=fail, grace=0)
                elif mode == 'timeout':
                    with self.assertRaises(subprocess.TimeoutExpired):
                        run.procs.run_group([sys.executable, '-c', 'import time; time.sleep(5)'], env=self.env, timeout=.05, grace=0)
                else:
                    run.procs.run_group([sys.executable, '-c', 'print("line",flush=True)'], env=self.env,
                                        on_stdout_line=(lambda s: False) if mode == 'callback' else None, grace=0)
                self.assertFalse(run.procs._groups)

    def test_no_start_after_stop(self):
        run.procs.kill_all(grace=0)
        marker = self.root / 'spawned'
        try:
            with self.assertRaises(RuntimeError):
                run.procs.run_group([sys.executable, '-c', f'open({str(marker)!r},"w").close()'], env=self.env)
            self.assertFalse(marker.exists())
        finally:
            run.procs.reset_registry()

    def test_kill_all_reaches_worker_thread_groups(self):
        marker = self.root / 'pids'
        script = ('import os,signal,subprocess,sys,time,json\n'
                  'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                  'child=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"],env={})\n'
                  f'open({str(marker)!r},"w").write(json.dumps([os.getpid(),child.pid]))\n'
                  'time.sleep(60)\n')
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(run.procs.run_group, [sys.executable, '-c', script], env=self.env)
            deadline = time.monotonic() + 3
            while not marker.exists() and time.monotonic() < deadline: time.sleep(.01)
            self.assertTrue(marker.exists())
            run.procs.kill_all(grace=.1); future.result(timeout=2)
        time.sleep(.05)
        for pid in json.loads(marker.read_text()): self.assertTrue(pid_dead(pid))
        self.assertFalse(run.procs._groups); run.procs.reset_registry()


def pid_dead(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


class SignalTests(RunnerCase):
    def interrupt(self, sig=signal.SIGINT):
        self.configure(harness='claude', grader='claude', trials=2)
        common.configure(self.bin, ignore_term=True)
        proc = subprocess.Popen([sys.executable, str(HERE / 'run_review_eval.py'), '--matrix', str(self.matrix_file),
                                 '--output', str(self.output), '--spend', '--jobs', '2'],
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 8
            while len(self.events('review')) < 2 and time.monotonic() < deadline: time.sleep(.01)
            self.assertEqual(len(self.events('review')), 2)
            time.sleep(.04)
            proc.send_signal(sig)
            out, err = proc.communicate(timeout=8)
            self.assertNotEqual(proc.returncode, 0, out + err)
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()

    def test_signal_kills_every_group(self):
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(sig=sig):
                self.output = self.root / f'run{sig}'
                (self.bin / 'events.jsonl').unlink(missing_ok=True)
                (self.bin / 'pids.jsonl').unlink(missing_ok=True)
                self.interrupt(sig)
                pids = [json.loads(l) for l in (self.bin / 'pids.jsonl').read_text().splitlines()]
                deadline = time.monotonic() + 2
                while any(not pid_dead(p) for row in pids for p in row.values()) and time.monotonic() < deadline: time.sleep(.02)
                self.assertTrue(all(pid_dead(p) for row in pids for p in row.values()))

    def test_interrupted_trials_not_recorded_as_error(self):
        self.interrupt(); self.assertFalse(any(r['outcome'] == 'error' for r in self.state().reviews.values()))

    def test_interrupted_trials_rerun_on_resume(self):
        self.interrupt(); before = len(self.events('review')); common.configure(self.bin)
        self.assert_ok(self.cli(resume=True, spend=True))
        self.assertEqual(len(self.events('review')), before + 2)

    def test_signal_cleans_work_root(self):
        self.interrupt(); self.assertFalse(Path(self.manifest()['work_root']).exists())

    def test_signal_during_snapshot(self):
        marker = self.root / 'fetch-pid'
        real_git = shutil.which('git', path=os.defpath)
        git = self.bin / 'git'
        git.write_text(f'#!{sys.executable}\nimport os,sys,time\nfrom pathlib import Path\n'
                       f'if "fetch" in sys.argv:\n    Path({str(marker)!r}).write_text(str(os.getpid()))\n    time.sleep(60)\n'
                       f'os.execv({real_git!r},[{real_git!r},*sys.argv[1:]])\n')
        git.chmod(0o700)
        proc = subprocess.Popen([sys.executable, str(HERE / 'run_review_eval.py'), '--matrix', str(self.matrix_file),
                                 '--output', str(self.output)], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 8
            while not marker.exists() and time.monotonic() < deadline: time.sleep(.01)
            self.assertTrue(marker.exists()); pid = int(marker.read_text()); proc.send_signal(signal.SIGINT)
            proc.communicate(timeout=8)
            self.assertNotEqual(proc.returncode, 0); self.assertTrue(pid_dead(pid))
            self.assertFalse(Path(self.manifest()['work_root']).exists())
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()


def load_tests(loader, tests, pattern):
    # Both evals/ and evals/review/ have test_runner.py. Package discovery
    # must find the root module after collecting this package's tests.
    if __package__:
        sys.path.insert(0, str(HERE.parent))
    return tests


if __name__ == '__main__':
    unittest.main()
