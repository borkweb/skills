"""Report production from frozen synthetic run inputs, copied before every write."""
from copy import deepcopy
import json
import math
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import results
import check_results

FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'run'


class RunTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'run'
        shutil.copytree(FIXTURE, self.root)
        self.manifest = json.loads((self.root / 'run.json').read_text())
        self.case = json.loads((self.root / 'cases' / 'synthetic-bug.json').read_text())
        self.records = [json.loads(line) for line in (self.root / 'trials.jsonl').read_text().splitlines()]
        self.review, self.match, self.extra = self.records

    def save(self):
        (self.root / 'run.json').write_text(json.dumps(self.manifest))
        (self.root / 'cases' / 'synthetic-bug.json').write_text(json.dumps(self.case))
        (self.root / 'trials.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in self.records))

    def build(self):
        self.save()
        return results.build(self.root)

    def values(self):
        return self.build()['trials'][0]['metrics']

    def second(self, outcome='ok', trial=2):
        token = f't{trial:012d}'
        review = dict(self.review, key=token, trial=trial, outcome=outcome)
        match = deepcopy(self.match)
        match['key'] = token
        self.records.extend([review, match])
        return review, match

    def no_extras(self):
        self.match['reported'] = self.match['reported'][:1]
        self.records.remove(self.extra)

    def nonfinite_subject(self):
        # A valid JSON exponent overflows decoding in metadata outside the declared metric checks.
        path = self.root / 'run.json'
        path.write_text(path.read_text().replace('"skills_sha": "' + '4' * 40 + '"', '"skills_sha": 1e999'))


class RecordsTests(RunTest):
    def test_unicode_separators_are_not_record_boundaries(self):
        for separator in ('\u2028', '\u2029', '\u0085'):
            with self.subTest(separator=ascii(separator)):
                self.review['reason'] = 'before' + separator + 'after'
                path = self.root / 'trials.jsonl'
                path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in self.records))
                state = results.read_records(path)
                self.assertEqual(state.records, self.records)
                self.assertEqual(state.reviews[self.review['key']]['reason'], 'before' + separator + 'after')

    def test_torn_multibyte_final_line_is_dropped(self):
        self.save()
        path = self.root / 'trials.jsonl'
        with path.open('ab') as stream:
            stream.write(b'{"reason":"' + 'λ'.encode('utf-8')[:1])
        self.assertEqual(results.read_records(path).records, self.records)

    def test_undecodable_nonfinal_line_names_its_line(self):
        path = self.root / 'trials.jsonl'
        path.write_bytes(json.dumps(self.review).encode() + b'\n\xff\n' + json.dumps(self.match).encode() + b'\n')
        with self.assertRaisesRegex(results.ResultsError, 'line 2:'):
            results.read_records(path)

    def test_each_missing_record_field_names_its_line(self):
        for original in self.records:
            for field in original.keys() - {'covers'}:
                record = dict(original)
                del record[field]
                with self.subTest(kind=original['type'], field=field):
                    path = self.root / 'trials.jsonl'
                    path.write_text(json.dumps(self.review) + '\n' + json.dumps(record) + '\n')
                    with self.assertRaisesRegex(results.ResultsError, 'line 2:'):
                        results.read_records(path)

    def test_grader_cost_must_be_finite_nonbool_number_or_null(self):
        for kind in ('match', 'extras'):
            original = self.match if kind == 'match' else self.extra
            for cost in ('"x"', '{}', 'true', 'false', '1e999', '-1e999', '9' * 400, '-0.01'):
                with self.subTest(kind=kind, cost=cost):
                    record = dict(original, grader_cost_usd=0.02)
                    path = self.root / 'trials.jsonl'
                    text = json.dumps(record).replace('"grader_cost_usd": 0.02', '"grader_cost_usd": ' + cost)
                    path.write_text(json.dumps(self.review) + '\n' + text + '\n')
                    with self.assertRaisesRegex(results.ResultsError, 'line 2:.*grader_cost_usd'):
                        results.read_records(path)

    def test_covers_shape_names_its_line(self):
        token = self.review['key']
        valid = {'review_attempt': 1, 'match_attempt': 1}
        invalid = [None, [], 'invalid', 1, {}, {'other-token': valid}, {token: None}, {token: []},
                   {token: {}}, {token: {'review_attempt': 1}}, {token: {'match_attempt': 1}},
                   {token: dict(valid, unexpected=1)}]
        for key in ('review_attempt', 'match_attempt'):
            invalid.extend({token: dict(valid, **{key: value})} for value in (None, True, False, 0, -1, 1.0, '1', [], {}))
        for covers in invalid:
            with self.subTest(covers=covers):
                self.extra['covers'] = covers
                self.save()
                with self.assertRaisesRegex(results.ResultsError, 'line 3:.*covers'):
                    results.read_records(self.root / 'trials.jsonl')
        for tokens in (None, token, [None], [[]], [{}], [True]):
            with self.subTest(tokens=tokens):
                self.extra.update(tokens=tokens, covers={token: valid})
                self.save()
                with self.assertRaisesRegex(results.ResultsError, 'line 3:.*covers'):
                    results.read_records(self.root / 'trials.jsonl')

    def test_missing_covers_is_stale_without_losing_call_cost(self):
        del self.extra['covers']
        state = self.state()
        self.assertNotIn(self.case['id'], state.extras)
        self.assertEqual(len(state.records), 3)
        trial = self.build()['trials'][0]
        self.assertEqual([item['id'] for item in trial['items']], ['F1', 'F2'])
        self.assertIsNone(trial['metrics']['precision'])
        self.assertEqual(self.build()['run']['grader']['calls'], 2)
        self.assertAlmostEqual(self.build()['run']['grader']['cost_usd'], .05)

    def test_covers_require_a_current_match(self):
        for mode in ('missing', 'other-review-attempt'):
            with self.subTest(mode=mode):
                self.records = [self.review, self.extra]
                if mode == 'other-review-attempt':
                    self.records.insert(1, dict(self.match, review_attempt=2))
                self.assertNotIn(self.case['id'], self.state().extras)

    def state(self):
        self.save()
        return results.read_records(self.root / 'trials.jsonl')

    def test_torn_final_line_is_dropped(self):
        self.save()
        with (self.root / 'trials.jsonl').open('a') as stream:
            stream.write('{"schema":')
        state = results.read_records(self.root / 'trials.jsonl')
        self.assertEqual(state.records, self.records)
        self.assertEqual(state.reviews[self.review['key']], self.review)

    def test_latest_record_per_type_and_key_wins(self):
        latest = dict(self.review, attempt=2, reason='second attempt')
        self.records.append(latest)
        self.assertEqual(self.state().reviews[self.review['key']], latest)

    def test_stale_extras_record_is_ignored(self):
        r2, _ = self.second()
        self.extra['tokens'].append(r2['key'])
        self.extra['tokens'].sort()
        self.extra['covers'][r2['key']] = {'review_attempt': 1, 'match_attempt': 1}
        self.assertIn(self.case['id'], self.state().extras)
        r3, _ = self.second(outcome='error', trial=3)
        self.assertIn(self.case['id'], self.state().extras)
        r3['outcome'] = 'ok'
        self.assertNotIn(self.case['id'], self.state().extras)

    def test_highest_attempt_wins_then_later_line(self):
        high = dict(self.review, attempt=3, reason='high')
        later = dict(high, reason='equal, later')
        self.records.extend([high, dict(self.review, attempt=2), later])
        self.assertEqual(self.state().reviews[self.review['key']], later)

    def test_bad_lines_raise_results_error_with_line_number(self):
        for bad in ('{', json.dumps(dict(self.review, type='alien')), json.dumps(dict(self.review, schema='wrong'))):
            with self.subTest(bad=bad):
                path = self.root / 'trials.jsonl'
                path.write_text(json.dumps(self.review) + '\n' + bad + '\n' + json.dumps(self.match) + '\n')
                with self.assertRaisesRegex(results.ResultsError, 'line 2:'):
                    results.read_records(path)

    def test_stale_match_is_ignored(self):
        self.review['attempt'] = 2
        self.assertNotIn(self.review['key'], self.state().matches)
        doc = self.build()
        self.assertEqual(doc['trials'][0]['outcome'], 'ungraded')
        self.assertIsNone(doc['trials'][0]['metrics']['recall'])


class BuildTests(RunTest):
    def test_new_attempts_invalidate_even_unchanged_extra_numbers(self):
        review, match, extra = deepcopy(self.records)
        token = review['key']
        for variant in ('match', 'review'):
            with self.subTest(variant=variant):
                newer = deepcopy(match)
                newer['reported'][1] = dict(newer['reported'][1], file='other.py', lines='300',
                                            summary='A different defect the old ruling never saw.')
                if variant == 'match':
                    newer['attempt'] = 2
                    self.records = [review, match, extra, newer, deepcopy(match)]
                    coverage = {'review_attempt': 1, 'match_attempt': 2}
                else:
                    review2 = dict(review, attempt=2)
                    newer['review_attempt'] = 2
                    newer['reported'][1].update(file='new.py', lines='9', summary='New review, new extra claim.')
                    self.records = [review, match, extra, review2, newer, deepcopy(review)]
                    coverage = {'review_attempt': 2, 'match_attempt': 1}
                doc = self.build()
                trial = doc['trials'][0]
                self.assertEqual(trial['outcome'], 'graded')
                self.assertEqual([item['id'] for item in trial['items']], ['F1', 'F2'])
                self.assertIsNone(trial['metrics']['precision'])
                # A later extras grade covering the actual winners restores the current claim, not the old one.
                fresh = deepcopy(extra)
                fresh.update(attempt=2, covers={token: coverage})
                fresh['groups'][0]['ruling'] = 'real'
                self.records.append(fresh)
                trial = self.build()['trials'][0]
                self.assertEqual(trial['metrics']['precision'], 1)
                self.assertEqual(trial['items'][-1], {'id': 'extra:g1', 'label': newer['reported'][1]['summary'],
                                                     'status': 'extra-real'})

    def test_incompatible_group_members_cannot_emit_extra_items(self):
        for n in (1, 99):
            with self.subTest(member_n=n):
                self.extra['groups'][0]['members'] = [[self.review['key'], n]]
                trial = self.build()['trials'][0]
                self.assertEqual([item['id'] for item in trial['items']], ['F1', 'F2'])
                self.assertIsNone(trial['metrics']['precision'])

    def test_new_match_cannot_reuse_incompatible_extra_items(self):
        baseline = deepcopy(self.match)
        for variant in ('dropped-extra', 'renumbered'):
            with self.subTest(variant=variant):
                regrade = deepcopy(baseline)
                regrade['attempt'] = 2
                if variant == 'dropped-extra':
                    regrade['reported'] = regrade['reported'][:1]
                else:
                    finding, extra = regrade['reported']
                    regrade['reported'] = [dict(extra, n=1), dict(finding, n=2)]
                self.records = [self.review, baseline, self.extra, regrade]
                doc = self.build()
                trial = doc['trials'][0]
                self.assertEqual(trial['outcome'], 'graded')
                self.assertEqual([i['id'] for i in trial['items']], ['F1', 'F2'])
                self.assertEqual(trial['metrics']['precision'], 1 if variant == 'dropped-extra' else None)
                self.save()
                results.write(self.root)
                check_results.load(self.root)

    def test_unknown_case_is_an_error_instead_of_a_dropped_trial(self):
        unknown, _ = self.second()
        unknown['case_id'] = 'unknown-case'
        with self.assertRaisesRegex(results.ResultsError, unknown['key'] + ': unknown case unknown-case'):
            self.build()

    def test_only_trials_with_a_review_record_appear(self):
        doc = self.build()
        self.assertEqual(len(doc['trials']), 1)
        self.assertEqual(doc['trials'][0]['trial'], 1)

    def test_declared_metrics_axes_bands_and_statuses(self):
        doc = self.build()
        specs = {m['key']: m for m in doc['metrics']}
        self.assertEqual(set(specs), {'recall', 'recall_important', 'precision', 'verdict_block_ok',
                                     'clean_false_alarm', 'cost_usd', 'duration_s', 'rounds'})
        for key in ('recall', 'recall_important', 'precision', 'verdict_block_ok'):
            self.assertEqual((specs[key]['kind'], specs[key]['better']), ('rate', 'higher'))
        self.assertTrue(specs['recall']['primary'])
        self.assertEqual(specs['verdict_block_ok']['label'], 'Verdict accuracy')
        self.assertEqual((specs['clean_false_alarm']['kind'], specs['clean_false_alarm']['better']), ('rate', 'lower'))
        for key, kind, role in [('cost_usd', 'cost', 'cost'), ('duration_s', 'duration', 'latency'), ('rounds', 'count', None)]:
            self.assertEqual((specs[key]['kind'], specs[key]['better'], specs[key].get('role')), (kind, 'lower', role))
        self.assertTrue(specs['cost_usd']['estimated'])
        self.assertEqual({a['key'] for a in doc['axes']}, {'harness', 'model', 'effort', 'skill_loading'})
        self.assertEqual({b['key']: b['band_metric'] for b in doc['bands']}, {'bug': 'recall', 'clean': 'clean_false_alarm'})
        self.assertEqual(doc['cases'][0]['band'], 'bug')
        statuses = {s['key']: s['color'] for s in doc['item_statuses']}
        self.assertEqual(set(statuses), {'hit', 'partial', 'miss', 'extra-real', 'extra-not-real', 'extra-unsure'})
        self.assertTrue(all(color in check_results.STATUS_COLORS for color in statuses.values()))

    def test_valid_edge_runs_pass_check_results(self):
        baseline = deepcopy((self.case, self.records))
        for edge in ('X1', 'same-group', 'empty-summary', 'null-effort', 'zero-findings', 'all-error'):
            with self.subTest(edge=edge):
                self.case, self.records = deepcopy(baseline)
                self.review, self.match, self.extra = self.records
                if edge == 'X1':
                    self.case['expected_findings'][0]['id'] = 'X1'
                    self.match['expected']['X1'] = self.match['expected'].pop('F1')
                    self.match['reported'][0]['names'] = ['X1']
                    self.extra['groups'][0]['group'] = 'X1'
                elif edge == 'same-group':
                    self.match['reported'].append(dict(self.match['reported'][1], n=3))
                    self.extra['groups'][0]['members'].append([self.review['key'], 3])
                elif edge == 'empty-summary':
                    self.match['reported'][1]['summary'] = ''
                elif edge == 'zero-findings':
                    self.match['reported'] = []
                    self.match['expected'] = {'F1': 'miss', 'F2': 'miss'}
                    self.records.remove(self.extra)
                elif edge == 'all-error':
                    self.review['outcome'] = 'error'
                    self.review['reason'] = 'synthetic error'
                self.save()
                results.write(self.root)
                doc = check_results.load(self.root)
                self.assertIsNone(doc['configs'][0]['axes']['effort'])
                for trial in doc['trials']:
                    for value in trial['metrics'].values():
                        self.assertTrue(value is None or math.isfinite(value))
                if edge == 'same-group':
                    self.assertEqual(len(doc['trials'][0]['items']), 3)
        self.nonfinite_subject()
        with self.assertRaisesRegex(ValueError, 'Out of range float values'):
            results.write(self.root)

    def test_extras_group_item_id_is_stable_across_trials(self):
        r2, _ = self.second()
        self.extra['tokens'].append(r2['key'])
        self.extra['covers'][r2['key']] = {'review_attempt': 1, 'match_attempt': 1}
        self.extra['groups'][0]['members'].append([r2['key'], 2])
        doc = self.build()
        ids = [[i['id'] for i in t['items'] if i['status'].startswith('extra-')] for t in doc['trials']]
        self.assertEqual(ids[0], ids[1])
        self.assertEqual(len(ids[0]), 1)

    def test_outcome_map_and_reason(self):
        for review_outcome, match_outcome, want in [('ok', 'graded', 'graded'), ('ok', 'ungraded', 'ungraded'),
                                                    ('ok', None, 'ungraded'), ('error', 'graded', 'error'),
                                                    ('skipped', 'graded', 'skipped'),
                                                    ('env-unavailable', 'graded', 'env-unavailable')]:
            with self.subTest(review=review_outcome, match=match_outcome):
                self.records = [self.review] + ([self.match] if match_outcome else [])
                self.review.update(outcome=review_outcome, reason='exact reason: Ω\nsecond line')
                self.match['outcome'] = match_outcome
                trial = self.build()['trials'][0]
                self.assertEqual(trial['outcome'], want)
                self.assertEqual(trial['reason'], 'exact reason: Ω\nsecond line')

    def test_skill_loading_axis_is_declared_not_observed(self):
        cfg = self.manifest['matrix']['configs'][0]
        self.manifest['matrix']['configs'].append(dict(cfg, skill_loading='inline'))
        self.review.update(skill_loading='inline', outcome='env-unavailable', reason='plugin loading unavailable')
        doc = self.build()
        self.assertEqual(len(doc['configs']), 2)
        self.assertEqual({c['axes']['skill_loading'] for c in doc['configs']}, {'plugin', 'inline'})
        trial = doc['trials'][0]
        self.assertTrue(trial['config_id'].endswith('|plugin'))
        self.assertEqual((trial['outcome'], trial['reason']), ('env-unavailable', 'plugin loading unavailable'))
        results.write(self.root)
        check_results.load(self.root)

    def test_build_reads_only_the_run_dir(self):
        empty_home = Path(self.temp.name) / 'empty-home'
        empty_home.mkdir()
        self.case['title'] = 'Unique frozen title'
        self.case['expected_findings'][0]['answer'] = 'Frozen answer from this run only.'
        self.case['expected_verdict'] = 'SAFE TO LAND'
        original_open = Path.open

        def frozen_inputs_only(path, *args, **kwargs):
            self.assertTrue(path.is_relative_to(self.root), f'input outside run: {path}')
            return original_open(path, *args, **kwargs)

        with patch.dict(os.environ, {'HOME': str(empty_home)}), patch.object(Path, 'open', frozen_inputs_only):
            doc = self.build()
        self.assertEqual(doc['cases'][0]['title'], 'Unique frozen title')
        self.assertEqual(doc['cases'][0]['band'], 'bug')
        self.assertEqual(doc['trials'][0]['items'][0]['label'], 'Frozen answer from this run only.')
        self.assertEqual(doc['trials'][0]['metrics']['verdict_block_ok'], 0)

    def test_run_block_and_grader_cost(self):
        run = self.build()['run']
        self.assertEqual(run, {'id': 'synthetic-run', 'eval': 'review', 'eval_version': '1',
                              'started_at': '2026-11-19T00:00:00Z', 'context': 'skill-only',
                              'subject': {'skills_sha': '4' * 40, 'skills_ref': 'main'},
                              'case_set': {'sha': '5' * 64},
                              'grader': {'harness': 'fake', 'model': 'synthetic-grader', 'effort': None,
                                         'cost_usd': .05, 'calls': 2, 'cost_complete': True}})

    def test_write_is_atomic_private_and_read_only_on_inputs(self):
        self.save()
        inputs = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        results.write(self.root)
        path = self.root / 'results.json'
        before = path.read_bytes()
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        for rel, data in inputs.items():
            self.assertEqual((self.root / rel).read_bytes(), data)
        self.nonfinite_subject()
        inputs = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*')
                  if p.is_file() and p.name != 'results.json'}
        with self.assertRaisesRegex(ValueError, 'Out of range float values'):
            results.write(self.root)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(self.root.glob('*.tmp')), [])
        for rel, data in inputs.items():
            self.assertEqual((self.root / rel).read_bytes(), data)

    def test_grader_calls_and_cost_totals(self):
        self.records.extend([dict(self.match, attempt=2, outcome='ungraded', grader_cost_usd=None),
                             dict(self.extra, attempt=2, outcome='ungraded', grader_cost_usd=5.0)])
        grader = self.build()['run']['grader']
        self.assertEqual(grader['calls'], 4)
        self.assertAlmostEqual(grader['cost_usd'], 5.05)
        self.assertFalse(grader['cost_complete'])
        for r in self.records:
            if r['type'] != 'review':
                r['grader_cost_usd'] = None
        self.assertIsNone(self.build()['run']['grader']['cost_usd'])
        for r in self.records:
            if r['type'] != 'review':
                r['grader_cost_usd'] = 0
        self.assertEqual(self.build()['run']['grader']['cost_usd'], 0)
        self.assertTrue(self.build()['run']['grader']['cost_complete'])

    def test_output_evidence_record_builds(self):
        self.review.update(skill_invoked=None, skill_evidence='output-evidence: refs and Coverage row')
        doc = self.build()
        self.assertEqual(doc['trials'][0]['outcome'], 'graded')
        self.assertEqual(set(doc['configs'][0]), {'id', 'label', 'axes'})
        for invalid in ('output-evidence', 0, 1):
            self.review['skill_invoked'] = invalid
            with self.subTest(value=invalid), self.assertRaises(results.ResultsError):
                self.build()


class MetricTests(RunTest):
    def test_recall_and_recall_important(self):
        self.match['expected']['F2'] = 'partial'
        self.match['reported'].append(dict(self.match['reported'][0], n=3, names=['F2']))
        values = self.values()
        self.assertEqual(values['recall'], .75)
        self.assertEqual(values['recall_important'], 1)
        self.case['expected_findings'][0]['severity'] = 'NIT'
        self.assertIsNone(self.values()['recall_important'])
        self.case['skill'] = 'review-security'
        self.case['expected_findings'][0]['severity'] = 'CRITICAL'
        self.case['expected_findings'][1]['severity'] = 'HIGH'
        self.assertEqual(self.values()['recall_important'], .75)
        self.case.update(kind='clean', expected_findings=[])
        self.match['expected'] = {}
        self.assertIsNone(self.values()['recall'])

    def test_precision_edge_cases(self):
        self.no_extras()
        self.match['reported'] = []
        self.match['expected'] = {'F1': 'miss', 'F2': 'miss'}
        self.assertIsNone(self.values()['precision'])
        for copies, names, want in [(1, ['F1', 'F2'], .5), (2, ['F1'], 2 / 3)]:
            with self.subTest(copies=copies, names=names):
                self.match['reported'] = [{'n': i + 1, 'file': 'cache.py', 'lines': '12', 'severity': 'IMPORTANT',
                                           'summary': 'Matched finding', 'names': names} for i in range(copies)]
                self.match['reported'].extend([{'n': 10, 'file': 'cache.py', 'lines': '80', 'severity': 'IMPORTANT',
                                                'summary': 'False extra', 'names': ['extra']},
                                               {'n': 11, 'file': 'cache.py', 'lines': '90', 'severity': 'NIT',
                                                'summary': 'Uncertain extra', 'names': ['extra']}])
                self.extra['groups'] = [{'group': 'false', 'ruling': 'not-real', 'members': [[self.review['key'], 10]]},
                                        {'group': 'uncertain', 'ruling': 'unsure', 'members': [[self.review['key'], 11]]}]
                self.records = [self.review, self.match, self.extra]
                self.assertAlmostEqual(self.values()['precision'], want)
        self.extra['groups'][0]['ruling'] = 'real'
        self.assertEqual(self.values()['precision'], 1)

    def test_verdict_block_ok(self):
        rows = [('review', 'DO NOT LAND', 'DO NOT LAND', 1), ('review', 'DO NOT LAND', 'LAND WITH CAUTION', 0),
                ('review', 'SAFE TO LAND', 'LAND WITH CAUTION', 1), ('review', 'LAND WITH CAUTION', 'SAFE TO LAND', 1),
                ('review-security', 'FAIL', 'FAIL', 1), ('review-security', 'FAIL', 'PASS', 0),
                ('review-security', 'PASS', 'PASS WITH REMEDIATIONS', 1),
                ('review-security', 'PASS', 'INCOMPLETE', None), ('review-security', 'INCOMPLETE', 'FAIL', None),
                ('review', None, 'DO NOT LAND', None), ('review', 'SAFE TO LAND', None, 0)]
        for skill, expected, actual, want in rows:
            with self.subTest(skill=skill, expected=expected, actual=actual):
                self.case.update(skill=skill, expected_verdict=expected)
                self.match['verdict'] = actual
                self.assertEqual(self.values()['verdict_block_ok'], want)

    def test_clean_false_alarm(self):
        self.case.update(kind='clean', expected_findings=[])
        self.match['expected'] = {}
        self.match['reported'] = [self.match['reported'][1]]
        for skill, severity, ruling, want in [('review', 'IMPORTANT', 'not-real', 1),
                                            ('review', 'NIT', 'not-real', 0), ('review', 'PRE-EXISTING', 'not-real', 0),
                                            ('review', 'IMPORTANT', 'real', 0), ('review', 'IMPORTANT', 'unsure', 0),
                                            ('review-security', 'CRITICAL', 'not-real', 1),
                                            ('review-security', 'HIGH', 'not-real', 1),
                                            ('review-security', 'INFORMATIONAL', 'not-real', 0)]:
            with self.subTest(skill=skill, severity=severity, ruling=ruling):
                self.case['skill'] = skill
                self.match['reported'][0]['severity'] = severity
                self.extra['groups'][0]['ruling'] = ruling
                self.assertEqual(self.values()['clean_false_alarm'], want)
        self.case['kind'] = 'bug'
        self.assertIsNone(self.values()['clean_false_alarm'])

    def test_trial_cost_is_review_only_and_null_stays_null(self):
        self.match['grader_cost_usd'] = 5.0
        values = self.values()
        self.assertEqual((values['cost_usd'], values['duration_s'], values['rounds']), (.01, 3.5, 2))
        self.review['cost_usd'] = None
        self.assertIsNone(self.values()['cost_usd'])

    def test_missing_stale_or_ungraded_extras_make_dependent_metrics_null(self):
        r2, m2 = self.second()
        m2['reported'] = m2['reported'][:1]  # Even a trial without extras depends on case-wide verification.
        for mode in ('missing', 'stale', 'ungraded'):
            for kind in ('bug', 'clean'):
                with self.subTest(mode=mode, kind=kind):
                    self.case['kind'] = kind
                    self.records = [self.review, self.match, r2, m2]
                    self.extra.update(tokens=[self.review['key'], r2['key']], outcome='graded')
                    if mode == 'stale':
                        self.extra['tokens'] = [self.review['key']]
                    self.extra['covers'] = {t: {'review_attempt': 1, 'match_attempt': 1}
                                            for t in self.extra['tokens']}
                    if mode == 'ungraded':
                        self.extra['outcome'] = 'ungraded'
                    if mode != 'missing':
                        self.records.append(self.extra)
                    doc = self.build()
                    for trial in doc['trials']:
                        self.assertIsNone(trial['metrics']['precision'])
                        if kind == 'clean':
                            self.assertIsNone(trial['metrics']['clean_false_alarm'])
        self.case['kind'] = 'bug'
        self.match['reported'] = self.match['reported'][:1]
        self.records = [self.review, self.match]
        self.assertEqual(self.values()['precision'], 1)


if __name__ == '__main__':
    unittest.main()
