import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_results as cr  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'synthetic-results.json'


def base():
    return copy.deepcopy(json.loads(FIXTURE.read_text(encoding='utf-8'))['runs'][0]['results'])


class FixtureTests(unittest.TestCase):
    def test_every_fixture_run_passes(self):
        bundle = json.loads(FIXTURE.read_text(encoding='utf-8'))
        self.assertEqual(bundle['format'], 'bork-eval-fixture/1')
        evals = {run['results']['run']['eval'] for run in bundle['runs']}
        self.assertEqual(evals, {'review', 'replay', 'triage'})
        for run in bundle['runs']:
            with self.subTest(run=run['dir']):
                self.assertEqual(cr.check(run['results']), [])


class RejectTests(unittest.TestCase):
    def assertRejects(self, doc, needle):
        errors = cr.check(doc)
        self.assertTrue(any(needle in e for e in errors), f'{needle!r} not in {errors}')

    def test_missing_required_fields(self):
        for path, needle in ((('run', 'id'), '$.run.id: is required'), (('run', 'grader'), '$.run.grader: is required'),
                             (('metrics',), '$.metrics: is required'), (('trials',), '$.trials: is required')):
            doc = base()
            target = doc
            for key in path[:-1]:
                target = target[key]
            del target[path[-1]]
            with self.subTest(path=path):
                self.assertRejects(doc, needle)
        doc = base()
        del doc['trials'][0]['reason']
        self.assertRejects(doc, 'reason: is required')

    def test_wrong_schema(self):
        doc = base()
        doc['schema'] = 'bork-eval-results/2'
        self.assertRejects(doc, '$.schema')

    def test_unknown_kind(self):
        doc = base()
        doc['metrics'][1]['kind'] = 'percent'
        self.assertRejects(doc, "unknown kind 'percent'")

    def test_zero_or_two_primary_metrics(self):
        doc = base()
        doc['metrics'][0]['primary'] = False
        self.assertRejects(doc, 'exactly one metric must have primary: true, found 0')
        doc = base()
        doc['metrics'][1]['primary'] = True
        self.assertRejects(doc, 'found 2')

    def test_trial_with_unknown_config_or_case(self):
        doc = base()
        doc['trials'][0]['config_id'] = 'nope'
        self.assertRejects(doc, "unknown config 'nope'")
        doc = base()
        doc['trials'][0]['case_id'] = 'nope'
        self.assertRejects(doc, "unknown case 'nope'")

    def test_outcome_rate_and_undeclared_metric(self):
        doc = base()
        doc['trials'][0]['outcome'] = 'passed'
        self.assertRejects(doc, "unknown outcome 'passed'")
        doc = base()
        doc['trials'][0]['metrics']['precision'] = 1.5
        self.assertRejects(doc, 'outside 0 to 1')
        doc = base()
        doc['trials'][0]['metrics']['made_up'] = 1
        self.assertRejects(doc, 'is not a declared metric')
        doc = base()
        doc['trials'][0]['metrics']['duration_s'] = -1
        self.assertRejects(doc, 'is negative')
        doc = base()
        doc['trials'][0]['metrics']['duration_s'] = True
        self.assertRejects(doc, 'finite number')
        doc = base()
        doc['trials'][0]['metrics']['duration_s'] = 1.5e308
        self.assertRejects(doc, 'at most 1e+15')

    def test_configs_must_differ_on_an_axis(self):
        # The index tells configs apart by their axis values; two configs with the same values merged into one line.
        doc = base()
        doc['configs'][1]['axes'] = dict(doc['configs'][0]['axes'])
        self.assertRejects(doc, "same axis values as config 'c1'")
        doc = base()
        doc['axes'] = []
        for config in doc['configs']:
            config['axes'] = {}
        self.assertRejects(doc, 'declare an axis that tells them apart')

    def test_band_metric_of_the_wrong_type_is_an_error_not_a_crash(self):
        doc = base()
        doc['bands'][0]['band_metric'] = ['recall']
        self.assertRejects(doc, "unknown metric ['recall']")

    def test_duplicates_and_references(self):
        doc = base()
        doc['configs'].append(copy.deepcopy(doc['configs'][0]))
        self.assertRejects(doc, "duplicate 'c1'")
        doc = base()
        doc['trials'][1]['trial'] = doc['trials'][0]['trial']
        self.assertRejects(doc, 'duplicate trial')
        doc = base()
        doc['bands'][0]['band_metric'] = 'nope'
        self.assertRejects(doc, "unknown metric 'nope'")
        doc = base()
        doc['configs'][0]['axes']['nope'] = 'x'
        self.assertRejects(doc, 'is not a declared axis')
        doc = base()
        doc['metrics'][0]['role'] = 'cost'
        self.assertRejects(doc, "role 'cost' is already on metric")
        doc = base()
        doc['item_statuses'][0]['color'] = '#ff0000'
        self.assertRejects(doc, 'color: must be one of')

    def test_token_must_be_one_safe_path_component(self):
        for token in ('../escape', 'a/b', '..', '.', '', '.hidden', 'x' * 200):
            doc = base()
            doc['trials'][0]['token'] = token
            with self.subTest(token=token):
                self.assertRejects(doc, '.token: must be one path component')
        doc = base()
        doc['trials'][1]['token'] = doc['trials'][0]['token']
        self.assertRejects(doc, 'duplicate token')


class LoadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='check-results-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_nan_and_infinity_are_refused_on_load(self):
        for constant in ('NaN', 'Infinity', '-Infinity'):
            text = json.dumps(base()).replace('"duration_s": null', f'"duration_s": {constant}', 1)
            if constant not in text:
                text = json.dumps(base()).replace('"precision": ', f'"precision": {constant}, "x_": ', 1)
            path = self.tmp / 'results.json'
            path.write_text(text, encoding='utf-8')
            with self.subTest(constant=constant), self.assertRaises(cr.CheckError) as ctx:
                cr.load(self.tmp)
            self.assertIn('not valid JSON', ctx.exception.errors[0])

    def test_cli_exit_codes(self):
        (self.tmp / 'results.json').write_text(json.dumps(base()), encoding='utf-8')
        self.assertEqual(cr.main([str(self.tmp)]), 0)
        bad = base()
        bad['metrics'][0]['kind'] = 'x'
        (self.tmp / 'results.json').write_text(json.dumps(bad), encoding='utf-8')
        self.assertEqual(cr.main([str(self.tmp)]), 1)


if __name__ == '__main__':
    unittest.main()
