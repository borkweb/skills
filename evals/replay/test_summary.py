import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture  # noqa: E402
import run_replay  # noqa: E402
import support  # noqa: E402

MISS = {'C2': 'NOT MET'}
MET = {'C2': 'MET'}


def summarized(grades_by_arm):
    """summarize() over one case missing C2: per arm, a grade dict is a graded trial, a string is that outcome."""
    records = []
    for arm, grades in grades_by_arm.items():
        for grade in grades:
            graded = isinstance(grade, dict)
            records.append({'case': 'synthetic', 'arm': arm, 'outcome': 'graded' if graded else grade,
                            'grades': grade if graded else {}, 'named_miss': grade == MISS if graded else None})
    arms = [{'name': arm, 'ref': 'ref', 'sha': 'sha'} for arm in grades_by_arm]
    return run_replay.summarize([{'id': 'synthetic', 'missed_ids': ['C2']}], records, arms)


class SummarizeTests(unittest.TestCase):
    def test_named_miss_rate_per_arm_matches_hand_computed_values(self):
        arms = summarized({'current': [MISS, MISS, MET, MET], 'revised': [MET, MET, MET, MISS]})
        self.assertEqual((arms['current']['graded'], arms['current']['named_miss'], arms['current']['rate']), (4, 2, 0.5))
        self.assertEqual((arms['revised']['graded'], arms['revised']['named_miss'], arms['revised']['rate']), (4, 1, 0.25))
        self.assertEqual(arms['current']['per_id']['synthetic:C2'], {'graded': 4, 'misses': 2, 'rate': 0.5})
        self.assertEqual(arms['revised']['per_id']['synthetic:C2'], {'graded': 4, 'misses': 1, 'rate': 0.25})

    def test_ungraded_and_errored_trials_are_counted_apart_and_never_met(self):
        arm = summarized({'current': [MISS, MET, 'ungraded', 'error']})['current']
        self.assertEqual((arm['graded'], arm['named_miss'], arm['rate']), (2, 1, 0.5))
        self.assertEqual(arm['not_graded']['ungraded'], 1)
        self.assertEqual(arm['not_graded']['error'], 1)

    def test_arm_with_no_graded_trials_reports_null_rate(self):
        arm = summarized({'revised': ['ungraded'] * 4})['revised']
        self.assertIsNone(arm['rate'])
        self.assertEqual(arm['graded'], 0)
        self.assertIsNone(arm['per_id']['synthetic:C2']['rate'])


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

    def test_a_second_run_to_the_same_output_fails_and_keeps_the_first_files(self):
        self.run_with({})
        before = {p: p.read_bytes() for p in self.out.rglob('*') if p.is_file()}
        second = support.replay(self.fx, self.out, trials=1)
        self.assertNotEqual(second.returncode, 0)
        after = {p: p.read_bytes() for p in self.out.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_per_case_record_has_the_documented_fields(self):
        # this run also carries a grade table, so each kind of entry is seen to reach the summary through the runner
        arms = self.run_with({'synthetic/current/1': MISS, 'synthetic/current/2': 'exit1',
                              'synthetic/revised/1': MET, 'synthetic/revised/2': 'ungraded'}, trials=2)
        current, revised = arms['current'], arms['revised']
        self.assertEqual((current['graded'], current['named_miss'], current['not_graded']['error']), (1, 1, 1))
        self.assertEqual((revised['graded'], revised['named_miss'], revised['not_graded']['ungraded']), (1, 0, 1))
        self.assertEqual(current['per_id']['synthetic:C2'], {'graded': 1, 'misses': 1, 'rate': 1.0})
        record = support.case_record(self.out)
        for trial in record['trials']:
            for key in ['case', 'arm', 'skills_ref', 'skills_sha', 'trial', 'base_commit', 'gates', 'grades', 'outcome']:
                self.assertIn(key, trial)
            self.assertRegex(trial['skills_sha'], r'^[0-9a-f]{40}$')
            self.assertEqual(trial['base_commit'], self.fx.base)
        self.assertEqual({t['arm'] for t in record['trials']}, {'current', 'revised'})
        self.assertEqual(sorted({t['trial'] for t in record['trials']}), [1, 2])

    def test_same_seed_gives_the_same_grades_and_another_seed_may_differ(self):
        first = self.run_with({}, trials=2)
        out2 = self.tmp / 'out2'
        run = support.replay(self.fx, out2, trials=2)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(support.load(out2 / 'summary.json')['arms'], first)
        # trial by trial too: at two trials the arm totals alone match by chance
        grades = [{(t['arm'], t['trial']): t['grades'] for t in support.case_record(out)['trials']}
                  for out in (self.out, out2)]
        self.assertEqual(len(grades[0]), 4)
        self.assertEqual(grades[0], grades[1])


if __name__ == '__main__':
    unittest.main()
