import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture  # noqa: E402
import support  # noqa: E402

MISS = {'C2': 'NOT MET'}
MET = {'C2': 'MET'}


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-sum-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / 'out'
        self.fx = fixture.build(self.tmp / 'fx')

    def run_with(self, table, trials=4):
        grades = self.tmp / 'grades.json'
        grades.write_text(json.dumps(table))
        run = support.replay(self.fx, self.out, trials=trials, extra=['--fake-grades', grades])
        self.assertIn(run.returncode, (0, 1), run.stderr)  # 1 only when a trial errored
        return support.load(self.out / 'summary.json')['arms']

    def test_named_miss_rate_per_arm_matches_hand_computed_values(self):
        table = {f'synthetic/current/{n}': g for n, g in enumerate([MISS, MISS, MET, MET], 1)}
        table.update({f'synthetic/revised/{n}': g for n, g in enumerate([MET, MET, MET, MISS], 1)})
        arms = self.run_with(table)
        self.assertEqual((arms['current']['graded'], arms['current']['named_miss'], arms['current']['rate']), (4, 2, 0.5))
        self.assertEqual((arms['revised']['graded'], arms['revised']['named_miss'], arms['revised']['rate']), (4, 1, 0.25))
        self.assertEqual(arms['current']['per_id']['synthetic:C2'], {'graded': 4, 'misses': 2, 'rate': 0.5})

    def test_ungraded_and_errored_trials_are_counted_apart_and_never_met(self):
        table = {'synthetic/current/1': MISS, 'synthetic/current/2': MET, 'synthetic/current/3': 'ungraded',
                 'synthetic/current/4': 'exit1'}
        arm = self.run_with(table)['current']
        self.assertEqual((arm['graded'], arm['named_miss'], arm['rate']), (2, 1, 0.5))
        self.assertEqual(arm['not_graded']['ungraded'], 1)
        self.assertEqual(arm['not_graded']['error'], 1)

    def test_arm_with_no_graded_trials_reports_null_rate(self):
        table = {f'synthetic/revised/{n}': 'ungraded' for n in range(1, 5)}
        arm = self.run_with(table)['revised']
        self.assertIsNone(arm['rate'])
        self.assertEqual(arm['graded'], 0)
        self.assertIsNone(arm['per_id']['synthetic:C2']['rate'])

    def test_a_second_run_to_the_same_output_fails_and_keeps_the_first_files(self):
        self.run_with({})
        before = {p: p.read_bytes() for p in self.out.rglob('*') if p.is_file()}
        second = support.replay(self.fx, self.out, trials=1)
        self.assertNotEqual(second.returncode, 0)
        after = {p: p.read_bytes() for p in self.out.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_per_case_record_has_the_documented_fields(self):
        self.run_with({}, trials=2)
        record = support.case_record(self.out)
        for trial in record['trials']:
            for key in ['case', 'arm', 'skills_ref', 'skills_sha', 'trial', 'base_commit', 'gates', 'grades', 'outcome']:
                self.assertIn(key, trial)
            self.assertRegex(trial['skills_sha'], r'^[0-9a-f]{40}$')
            self.assertEqual(trial['base_commit'], self.fx.base)
        self.assertEqual({t['arm'] for t in record['trials']}, {'current', 'revised'})
        self.assertEqual(sorted({t['trial'] for t in record['trials']}), [1, 2])

    def test_same_seed_gives_the_same_grades_and_another_seed_may_differ(self):
        first = self.run_with({}, trials=6)
        out2 = self.tmp / 'out2'
        run = support.replay(self.fx, out2, trials=6)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(support.load(out2 / 'summary.json')['arms'], first)


if __name__ == '__main__':
    unittest.main()
