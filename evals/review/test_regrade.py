"""Regrade's CLI, frozen inputs, source immutability and grading-only execution."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

if __package__:
    from .test_runner import RunnerCase, HERE, common, run, overlap
else:
    from test_runner import RunnerCase, HERE, common, run, overlap
import regrade_run


class RegradeCase(RunnerCase):
    def source_run(self):
        self.configure(harness='claude', grader='claude')
        common.configure(self.bin, reported=[dict(n=1, file='file.txt', lines='1', severity='IMPORTANT',
                                                 summary='check this claim', names=['extra'])])
        self.assert_ok(self.cli(spend=True))
        self.dest = self.root / 'regraded'
        (self.bin / 'events.jsonl').unlink()

    def regrade(self, *flags, grader='claude:grade-model:-', spend=True, output=None):
        return subprocess.run([sys.executable, str(HERE / 'regrade_run.py'), str(self.output),
                               '--grader', grader, '--output', str(output or self.dest),
                               *(['--spend'] if spend else []), *flags],
                              env=self.env, capture_output=True, text=True, timeout=30)

    def hashes(self):
        return {str(p.relative_to(self.output)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.output.rglob('*') if p.is_file()}


class RegradeTests(RegradeCase):
    def test_runs_no_review(self):
        self.source_run(); self.assert_ok(self.regrade(grader='claude:new-grader:high'))
        self.assertFalse(self.events('review')); self.assertEqual(len(self.events('grade')), 2)
        for e in self.events('grade'):
            self.assertIn('new-grader', e['argv']); self.assertIn('high', e['argv'])

    def test_output_layout(self):
        self.source_run(); source = self.manifest(); self.assert_ok(self.regrade())
        dest = self.manifest(self.dest)
        self.assertNotEqual(dest['run_id'], source['run_id']); self.assertEqual(dest['started_at'], source['started_at'])
        self.assertEqual(dest['regraded_from'], source['run_id'])
        self.assertEqual(dest['grader'], dict(harness='claude', model='grade-model', effort=None))
        raw = dict(dest['matrix']['raw']); raw.pop('budget_usd')
        self.assertEqual(dest['matrix_sha256'], hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
        for token in self.state().reviews:
            for name in ('review.md', 'review-meta.json', 'stderr-tail.txt'):
                self.assertEqual((self.output / 'trials' / token / name).read_bytes(),
                                 (self.dest / 'trials' / token / name).read_bytes())
        doc = run.results.check_results.load(self.dest)
        self.assertEqual(doc['run']['regraded_from'], source['run_id']); self.assertTrue((self.dest / 'report.html').is_file())

    def test_source_untouched(self):
        self.source_run(); before = self.hashes(); self.assert_ok(self.regrade())
        self.assertEqual(self.hashes(), before)
        with patch.object(run, 'finish', side_effect=RuntimeError('report failed')):
            self.assertNotEqual(regrade_run.main([str(self.output), '--grader', 'fake:g:-',
                                                 '--output', str(self.root / 'failed')]), 0)
        self.assertEqual(self.hashes(), before); self.assertFalse((self.output / '.lock').exists())

    def test_current_cases(self):
        self.source_run(); original = (self.output / 'cases/case-a.json').read_bytes()
        self.write_case('case-a', title='new case title')
        self.assert_ok(self.regrade())
        self.assertEqual((self.dest / 'cases/case-a.json').read_bytes(), original)
        other = self.root / 'current'; self.assert_ok(self.regrade('--current-cases', output=other))
        data = [['case-a', hashlib.sha256((self.cases_dir / 'case-a.json').read_bytes()).hexdigest()]]
        self.assertEqual(self.manifest(other)['case_set_sha256'], hashlib.sha256(json.dumps(data, separators=(',', ':')).encode()).hexdigest())
        self.write_case('case-a', expected_findings=[dict(id='F2', file='file.txt', lines='1', severity='IMPORTANT', answer='new')])
        before = len(self.events()); refused = self.regrade('--current-cases', output=self.root / 'missing')
        self.assertEqual(refused.returncode, 2); self.assertIn('refusing:', refused.stderr)
        self.assertEqual(len(self.events()), before)
        self.write_case('case-a', expected_verdict='SAFE TO LAND')
        nonblocking = self.root / 'nonblocking'
        self.assert_ok(self.regrade('--current-cases', output=nonblocking))
        self.assertNotIn('block sensitivity only', run.results.check_results.load(nonblocking)['run'].get('notes', ''))

    def test_rebuilds_snapshot_for_extras(self):
        self.source_run(); self.assertFalse(Path(self.manifest()['work_root']).exists())
        self.assert_ok(self.regrade()); extras = [e for e in self.events('grade') if Path(e['cwd']).name == 'extras']
        self.assertEqual(len(extras), 1); self.assertEqual(extras[0]['snapshots'], 1)
        self.assertFalse(Path(self.manifest(self.dest)['work_root']).exists())

    def test_rejects_unsafe_source_paths(self):
        self.source_run(); original = self.state().records
        for bad in ('key', 'text_file'):
            with self.subTest(field=bad):
                rows = json.loads(json.dumps(original))
                for r in rows:
                    if r['type'] == 'review': r[bad] = '../../outside' if bad == 'text_file' else 'unsafe'
                self.rewrite_records(rows)
                done = self.regrade(output=self.root / bad)
                self.assertEqual(done.returncode, 2); self.assertIn('refusing:', done.stderr); self.assertFalse(self.events())
        self.rewrite_records(original)

    def test_ledger_invariants_and_blinding(self):
        self.source_run(); self.assert_ok(self.regrade()); earlier = set(); source = self.state()
        attempts = {}
        for r in self.state(self.dest).records:
            key = r['type'], r['key']
            self.assertEqual(r['attempt'], attempts.get(key, 0) + 1)
            attempts[key] = r['attempt']
            if r['type'] == 'extras':
                for token, attempts in r['covers'].items():
                    self.assertIn(('review', token, attempts['review_attempt']), earlier)
                    self.assertIn(('match', token, attempts['match_attempt']), earlier)
            self.assertNotIn((r['type'], r['key'], r['attempt']), earlier)
            earlier.add((r['type'], r['key'], r['attempt']))
        for e in self.events('grade'):
            data = json.dumps([e['argv'], list(e['env'].values()), e['stdin'], e['cwd']])
            for marker in ('review-model', 'case-a', 'Private case title', 'claude|review-model'):
                self.assertNotIn(marker, data)
            settings = json.loads(e['argv'][e['argv'].index('--settings') + 1])
            for path in (self.dest, self.cases_dir, self.token_file.parent, self.home / 'git/skills-private'):
                self.assertIn('Read(/' + str(path) + '/**)', settings['permissions']['deny'])


class RegradeCliTests(RegradeCase):
    def test_help(self):
        done = subprocess.run([sys.executable, str(HERE / 'regrade_run.py'), '--help'], env=self.env,
                              capture_output=True, text=True)
        self.assert_ok(done)
        for flag in ('--grader', '--output', '--spend', '--current-cases', '--jobs', '--budget-usd'):
            self.assertIn(flag, done.stdout)

    def test_plan_and_refusals(self):
        self.source_run(); done = self.regrade(spend=False); self.assert_ok(done)
        self.assertIn('review calls: 0', done.stdout); self.assertFalse(self.dest.exists()); self.assertFalse(self.events())
        done = self.regrade('--current-cases', spend=False)
        self.assert_ok(done); self.assertFalse(self.dest.exists()); self.assertFalse(self.events())
        source_json = (self.output / 'run.json').read_bytes()
        ledger = (self.output / 'trials.jsonl').read_bytes()
        for condition in ('exists', 'git', 'grader', 'missing', 'ledger'):
            with self.subTest(condition=condition):
                dest, grade = self.root / condition, 'fake:model:-'
                if condition == 'exists': dest.mkdir()
                if condition == 'git': dest = run.REPO / 'forbidden-regrade'
                if condition == 'grader': grade = 'fake:model'
                if condition == 'missing': (self.output / 'run.json').unlink()
                if condition == 'ledger': (self.output / 'trials.jsonl').write_text('{"schema":"wrong"}\n')
                done = self.regrade(grader=grade, output=dest)
                self.assertEqual(done.returncode, 2, done.stderr)
                self.assertEqual(sum(l.startswith('refusing:') for l in done.stderr.splitlines()), 1)
                self.assertNotIn('Traceback', done.stderr); self.assertFalse(self.events())
                if condition == 'missing': (self.output / 'run.json').write_bytes(source_json)
                if condition == 'ledger': (self.output / 'trials.jsonl').write_bytes(ledger)

    def test_grader_flag_forms(self):
        self.configure(harness='claude', grader='claude', trials=4)
        common.configure(self.bin, grade_delay=.1)
        self.assert_ok(self.cli(spend=True)); self.dest = self.root / 'new'
        (self.bin / 'events.jsonl').unlink()
        self.assert_ok(self.regrade('--jobs', '1', '--budget-usd', '20'))
        self.assertIsNone(self.manifest(self.dest)['grader']['effort'])
        self.assertEqual(self.manifest(self.dest)['matrix']['budget_usd'], 20)
        self.assertEqual(overlap(common.calls(self.bin)), 1)
        for event in self.events('grade'):
            self.assertNotIn('--effort', event['argv']); self.assertNotIn('-', event['argv'])
        rows = self.state().records
        for row in rows:
            if row['type'] == 'review': row['cost_usd'] = 100.0
        self.rewrite_records(rows)
        before = len(self.events('grade'))
        small = self.root / 'new-budget'
        self.assert_ok(self.regrade('--jobs', '4', '--budget-usd', '1', output=small))
        self.assertEqual(len(self.events('grade')) - before, 4)
        self.assertEqual(self.manifest(small)['matrix']['budget_usd'], 1)


if __name__ == '__main__':
    unittest.main()
