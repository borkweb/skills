import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

HELPER = Path(__file__).with_name('qa-health-score.py')
spec = importlib.util.spec_from_file_location('qa_score', HELPER)
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class QAScoreTests(unittest.TestCase):
    def payload(self, state='inspected'):
        data = {'coverage': dict.fromkeys(qa.CATEGORY_WEIGHTS, state), 'findings': []}
        if state == 'inspected':
            data.update(console_errors=0, failed_requests=0, broken_links=0)
        return data

    def test_empty_input_fails_closed(self):
        run = subprocess.run([sys.executable, str(HELPER)], input='{}', text=True, capture_output=True)
        self.assertEqual(run.returncode, 2)
        self.assertEqual(run.stdout, '')

    def test_critical_security_cannot_be_averaged_away(self):
        data = self.payload()
        data['findings'] = [{'category': 'Security', 'severity': 'critical'}]
        result = qa.compute(data)
        self.assertTrue(result['blocked'])
        self.assertEqual(result['final_score'], 0)

    def test_incomplete_is_unknown(self):
        data = self.payload(); data['coverage']['security'] = 'not_inspected'
        result = qa.compute(data)
        self.assertIsNone(result['final_score'])
        self.assertIsNone(result['per_category']['security'])
        self.assertFalse(result['coverage_complete'])

    def test_partial_inspection_can_find_blocker(self):
        data = self.payload('not_inspected')
        data['findings'] = [{'category': 'functional', 'severity': 'high'}]
        self.assertTrue(qa.compute(data)['blocked'])

    def test_all_na_is_not_perfect(self):
        self.assertIsNone(qa.compute(self.payload('not_applicable'))['final_score'])

    def test_clean_inspection_with_valid_na(self):
        data = self.payload(); data['coverage']['performance'] = 'not_applicable'
        self.assertEqual(qa.compute(data)['final_score'], 100)

    def test_bad_inputs_rejected(self):
        for mutate in [lambda d: d.update(console_errors=True), lambda d: d.update(console_errors=-1),
                       lambda d: d.update(findings=[{'category': 'typo', 'severity': 'low'}]),
                       lambda d: d.update(findings=[{'category': 'security', 'severity': 'urgent'}]),
                       lambda d: d.pop('failed_requests'), lambda d: d.update(coverage={})]:
            with self.subTest(mutate=mutate):
                data = self.payload(); mutate(data)
                with self.assertRaises(ValueError): qa.compute(data)

    def test_na_finding_rejected(self):
        data = self.payload(); data['coverage']['security'] = 'not_applicable'
        data['findings'] = [{'category': 'security', 'severity': 'high'}]
        with self.assertRaises(ValueError): qa.compute(data)


if __name__ == '__main__': unittest.main()
