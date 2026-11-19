"""Matrix validation, independent cost arithmetic and shipped smoke contracts."""
import contextlib
import copy
from dataclasses import fields
import datetime
import hashlib
import io
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import matrix

HERE = Path(__file__).resolve().parent


def document():
    return {'eval': 'review', 'cases': '~/cases', 'case_filter': {'skill': ['review'], 'tags_any': []},
            'skills_ref': 'HEAD', 'trials': 1, 'grader': {'harness': 'claude', 'model': 'claude-sonnet-5-5',
            'effort': 'high'}, 'budget_usd': 5,
            'configs': [{'harness': 'claude', 'model': 'claude-opus-5-5', 'effort': 'high'}]}


class MatrixTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='matrix-test-')
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.home = self.root/'home'; self.home.mkdir()
        self.env = patch.dict(os.environ, {'HOME': str(self.home)})
        self.env.start(); self.addCleanup(self.env.stop)

    def load(self, doc=None):
        path = self.root/'matrix.json'; path.write_text(json.dumps(document() if doc is None else doc))
        return matrix.load(path)

    def plan(self, doc=None, n=1):
        with contextlib.redirect_stdout(io.StringIO()):
            return matrix.plan(self.load(doc), [{'id': str(i)} for i in range(n)])


class LoadTests(MatrixTest):
    def test_rejects_malformed_fields(self):
        rows = [('eval', 'other'), *[('trials', v) for v in (0, True, 1.5)],
                *[('budget_usd', v) for v in (0, -1, float('nan'), True, '5')],
                *[('case_limit', v) for v in (0, -1, True, 1.5, '1')],
                *[('case_filter.skill', v) for v in ([], ['review', 'review-security'], ['nope'])],
                ('case_filter.tags_any', 'x'), ('case_filter.tags_any', [True]),
                ('configs.0.skill_loading', 'auto'), ('configs.0.harness', 'gpt'), ('configs', []),
                ('configs.0.effort', []), ('timeout_s', 0), ('timeout_s', True), ('max_parallel', 0),
                ('max_parallel', {'claude': True}), ('case_ids', []), ('skills_ref', '--bad')]
        for field, value in rows:
            with self.subTest(field=field, value=value):
                doc = document(); target = doc; parts = field.split('.')
                for p in parts[:-1]: target = target[int(p)] if isinstance(target, list) else target[p]
                target[parts[-1]] = value
                with self.assertRaisesRegex(matrix.MatrixError, parts[-1] if parts[-1] != '0' else 'configs'):
                    self.load(doc)
        for field in ('harness', 'model', 'effort'):
            with self.subTest(missing_grader=field):
                doc = document(); del doc['grader'][field]
                with self.assertRaisesRegex(matrix.MatrixError, 'grader.'+field): self.load(doc)

    def test_defaults(self):
        doc = document(); del doc['configs'][0]['effort']
        doc['configs'].append({'harness': 'grok', 'model': 'example'})
        m = self.load(doc)
        self.assertEqual(m.timeout_s, 2700); self.assertIsNone(m.case_limit)
        self.assertEqual(m.max_parallel, {'claude': 2, 'grok': 2})
        self.assertTrue(all(c['skill_loading'] == 'plugin' for c in m.configs))
        self.assertEqual(m.cases_dir, self.home/'cases')
        self.assertEqual(m.sha256, hashlib.sha256((self.root/'matrix.json').read_bytes()).hexdigest())
        self.assertEqual(m.raw, doc)
        self.assertTrue(matrix.Matrix.__dataclass_params__.frozen)
        self.assertEqual({f.name for f in fields(m)}, {'eval', 'cases_dir', 'case_filter', 'case_limit', 'skills_ref',
                         'trials', 'grader', 'budget_usd', 'timeout_s', 'max_parallel', 'skill', 'configs', 'raw', 'sha256'})

    def test_expands_lists(self):
        doc = document(); doc['configs'][0]['effort'] = ['medium', 'high']
        self.assertEqual([c['effort'] for c in self.load(doc).configs], ['medium', 'high'])
        doc['configs'][0]['model'] = ['one', 'two']
        self.assertEqual({(c['model'], c['effort']) for c in self.load(doc).configs},
                         {('one', 'medium'), ('one', 'high'), ('two', 'medium'), ('two', 'high')})

    def test_config_key_format(self):
        doc = document(); doc['configs'] = [{'harness': 'grok', 'model': 'example'}]
        m = self.load(doc)
        self.assertEqual(m.configs[0]['key'], 'grok|example|-|review|plugin')
        doc['configs'][0]['skill_loading'] = 'inline'
        self.assertEqual(self.load(doc).configs[0]['key'], 'grok|example|-|review|inline')

    def test_token_formula(self):
        doc = document(); doc['configs'] = [{'harness': 'grok', 'model': 'example'}]
        cfg = self.load(doc).configs[0]
        key = 'grok|example|-|review|plugin'
        self.assertEqual(cfg['key'], key)
        expected = 't' + hashlib.sha256(f'example-case|{key}|1'.encode()).hexdigest()[:12]
        self.assertEqual(matrix.token('example-case', cfg['key'], 1), expected)

    def test_skill_loading_is_a_declared_axis(self):
        doc = document(); doc['configs'] = [{'harness': 'grok', 'model': 'example',
                                           'skill_loading': ['plugin', 'inline']}]
        m = self.load(doc)
        self.assertEqual(len({c['key'] for c in m.configs}), 2)
        self.assertEqual(len({matrix.token('example', c['key'], 1) for c in m.configs}), 2)
        # Observe the actual schema boundary without substituting the validator's result.
        seen = []
        check = matrix.check_results.check
        def observe(doc):
            seen.append(copy.deepcopy(doc)); return check(doc)
        with patch.object(matrix.check_results, 'check', side_effect=observe): self.load(doc)
        self.assertEqual(len(seen), 1)
        skeleton = seen[0]
        self.assertEqual({a['key'] for a in skeleton['axes']}, {'harness', 'model', 'effort', 'skill_loading'})
        self.assertEqual([c['axes']['effort'] for c in skeleton['configs']], [None, None])
        self.assertEqual(check(skeleton), [])

    def test_duplicate_configs_refused(self):
        for configs in ([{'harness': 'claude', 'model': 'example', 'effort': ['high', 'high']}],
                        [document()['configs'][0], document()['configs'][0]]):
            with self.subTest(configs=configs):
                doc = document(); doc['configs'] = configs
                with self.assertRaisesRegex(matrix.MatrixError, 'same axis values'): self.load(doc)

    def test_rejects_key_ambiguous_values(self):
        for field in ('model', 'effort'):
            for value in ('a|b', '-'):
                with self.subTest(field=field, value=value):
                    doc = document(); doc['configs'][0][field] = value
                    with self.assertRaisesRegex(matrix.MatrixError, field): self.load(doc)


class PlanTests(MatrixTest):
    def test_plan_counts(self):
        doc = document(); doc['trials'] = 3; doc['configs'][0]['effort'] = ['medium', 'high']
        m = self.load(doc)
        cases = [{'id': str(i), 'skill': 'review', 'tags': []} for i in range(4)]
        with contextlib.redirect_stdout(io.StringIO()): result = matrix.plan(m, matrix.select_cases(m, cases))
        self.assertEqual([result[k] for k in ('configs', 'review_calls', 'match_calls', 'extras_calls')], [2, 24, 24, 4])

    def test_unpriced_model_costed_at_highest_price(self):
        prices = json.loads((HERE/'prices.json').read_text())['models']
        highest = max(prices, key=lambda n: sum(prices[n][k] for k in ('input', 'cached_input', 'output')))
        doc = document(); doc['configs'][0]['model'] = 'unpriced-example'
        unknown = self.plan(doc)['estimated_cost_usd']; doc['configs'][0]['model'] = highest
        self.assertEqual(unknown, self.plan(doc)['estimated_cost_usd']); self.assertGreater(unknown, 0)

    def test_plan_includes_grader_cost(self):
        doc = document(); cheap = self.plan(doc)['estimated_cost_usd']
        doc['grader']['model'] = 'claude-opus-5-5'
        self.assertGreater(self.plan(doc)['estimated_cost_usd'], cheap)

    def test_plan_printout(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output): result = matrix.plan(self.load(), [{'id': 'example'}])
        text = output.getvalue()
        for label in ('Configs: 1', 'review calls: 1', 'match calls: 1', 'extras calls: 1',
                      f"${result['estimated_cost_usd']:.6f}", 'budget_usd: 5'):
            self.assertIn(label, text)

    def test_case_filter_and_limit(self):
        cases = [{'id': 'z', 'skill': 'review', 'tags': ['wpcom']},
                 {'id': 'a', 'skill': 'review', 'tags': ['wpcom']},
                 {'id': 'b', 'skill': 'review', 'tags': ['other']},
                 {'id': 'c', 'skill': 'review-security', 'tags': ['wpcom']}]
        doc = document(); doc['case_filter']['tags_any'] = ['wpcom']; doc['case_limit'] = 1
        m = self.load(doc)
        self.assertEqual([c['id'] for c in matrix.select_cases(m, cases)], ['a'])
        self.assertEqual([c['id'] for c in matrix.select_cases(m, cases, ['b', 'c', 'z'])], ['b', 'c', 'z'])
        self.assertEqual(matrix.select_cases(m, cases, []), [])
        doc['case_filter']['tags_any'] = []; del doc['case_limit']
        self.assertEqual([c['id'] for c in matrix.select_cases(self.load(doc), cases)], ['a', 'b', 'z'])


class PriceTests(MatrixTest):
    def test_prices_cover_smoke_models(self):
        prices = json.loads((HERE/'prices.json').read_text())['models']
        self.assertTrue({'claude-opus-5-5', 'claude-sonnet-5-5'} <= prices.keys())
        for name, row in prices.items():
            with self.subTest(model=name):
                values = [row[k] for k in ('input', 'cached_input', 'output')]
                self.assertTrue(all(type(v) in (float, int) and math.isfinite(v) and v >= 0 for v in values))
                self.assertGreater(sum(values), 0)
                self.assertEqual(row['source'], 'https://claude.com/pricing')
                self.assertRegex(row['as_of'], r'^\d{4}-\d{2}-\d{2}$')
                self.assertLessEqual(datetime.date.fromisoformat(row['as_of']), datetime.date.today())
        # Public page read on 2026-11-19; cache reads are separate from ordinary input.
        self.assertEqual([prices['claude-opus-5-5'][k] for k in ('input', 'cached_input', 'output')], [4, .2, 20])
        self.assertEqual([prices['claude-sonnet-5-5'][k] for k in ('input', 'cached_input', 'output')], [2, .1, 10])

    def test_cost_unknown_model_is_none(self):
        self.assertIsNone(matrix.cost('unknown-example', {'input_tokens': 10}))

    def test_cost_formula(self):
        self.assertAlmostEqual(matrix.cost('claude-opus-5-5', {'input_tokens': 1000, 'cached_input_tokens': 2000,
                                                            'output_tokens': 300}), .0104)
        self.assertEqual(matrix.cost('claude-opus-5-5', {'input_tokens': None, 'cached_input_tokens': 2000,
                                                       'output_tokens': None}), .0004)
        self.assertIsNone(matrix.cost('claude-opus-5-5', {'input_tokens': None, 'cached_input_tokens': None,
                                                        'output_tokens': None}))
        self.assertEqual(matrix.cost('claude-opus-5-5', {'input_tokens': 0}), 0)

    def test_estimates_block_drives_plan(self):
        estimates = json.loads((HERE/'prices.json').read_text())['estimates']
        for kind in ('review', 'match', 'extras'):
            for field in ('input_tokens', 'cached_input_tokens', 'output_tokens'):
                self.assertIs(type(estimates[kind][field]), int); self.assertGreaterEqual(estimates[kind][field], 0)
            self.assertTrue(estimates[kind]['basis'].strip()); self.assertNotIn('\n', estimates[kind]['basis'])
        r, m, e = (estimates[k] for k in ('review', 'match', 'extras'))
        expected = (r['input_tokens']*4 + r['cached_input_tokens']*.2 + r['output_tokens']*20 +
                    (m['input_tokens']+e['input_tokens'])*2 +
                    (m['cached_input_tokens']+e['cached_input_tokens'])*.1 +
                    (m['output_tokens']+e['output_tokens'])*10) / 1e6
        self.assertAlmostEqual(self.plan()['estimated_cost_usd'], expected)


class SmokeMatrixTests(MatrixTest):
    def test_smoke_matrices_shape(self):
        for harness in ('claude', 'codex', 'antigravity', 'grok'):
            with self.subTest(harness=harness):
                m = matrix.load(HERE/'matrices'/f'smoke-{harness}.json')
                self.assertEqual(m.trials, 1); self.assertEqual(m.budget_usd, 5)
                self.assertEqual(len(m.configs), 1); self.assertEqual(m.configs[0]['harness'], harness)
                self.assertEqual(m.case_filter, {'skill': ['review'], 'tags_any': ['wpcom']})
                self.assertEqual(m.case_limit, 1)
                if harness == 'antigravity':
                    self.assertEqual(m.configs[0]['model'], 'Gemini 4 Neon')
                    self.assertEqual(m.configs[0]['effort'], 'high')
