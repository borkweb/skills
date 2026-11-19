from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_stats as s  # noqa: E402


def doc(trials, configs=('a', 'b'), cases=('k1', 'k2', 'k3'), metrics=None):
    return {
        'schema': 'bork-eval-results/1',
        'run': {'id': 'r', 'eval': 'e', 'eval_version': '1', 'started_at': '2026-11-20T00:00:00Z',
                'grader': {'harness': None, 'model': None, 'effort': None}},
        'axes': [{'key': 'model', 'label': 'Model'}, {'key': 'effort', 'label': 'Effort'}],
        'metrics': metrics or [
            {'key': 'score', 'label': 'Score', 'kind': 'rate', 'better': 'higher', 'primary': True},
            {'key': 'cost', 'label': 'Cost', 'kind': 'cost', 'better': 'lower', 'role': 'cost'}],
        'configs': [{'id': c, 'label': c, 'axes': {'model': 'm', 'effort': c}} for c in configs],
        'cases': [{'id': c, 'title': c} for c in cases],
        'trials': trials,
    }


def trial(case, config, n, score, outcome='graded', cost=None):
    return {'case_id': case, 'config_id': config, 'trial': n, 'token': f'{case}-{config}-{n}', 'outcome': outcome,
            'reason': None, 'metrics': {'score': score, 'cost': cost}}


class MeanTests(unittest.TestCase):
    def test_mean_leaves_out_none(self):
        self.assertEqual(s.mean([1, None, 0, None]), 0.5)
        self.assertIsNone(s.mean([None, None]))
        self.assertIsNone(s.mean([]))

    def test_config_mean_uses_graded_trials_only_and_null_is_not_zero(self):
        d = doc([trial('k1', 'a', 1, 1.0), trial('k1', 'a', 2, None), trial('k2', 'a', 1, 0.0, outcome='error'),
                 trial('k2', 'a', 2, 0.5)])
        got = s.summarize(d)['configs']['a']['metrics']['score']
        self.assertEqual((got['mean'], got['n_trials'], got['n_cases']), (0.75, 2, 2))

    def test_point_estimate_is_the_pooled_trial_mean_with_uneven_trials(self):
        # k1 has three trials at 1.0, k2 one trial at 0.0: pooled mean 0.75, case-mean average would be 0.5.
        d = doc([trial('k1', 'a', i, 1.0) for i in (1, 2, 3)] + [trial('k2', 'a', 1, 0.0)])
        got = s.summarize(d)['configs']['a']['metrics']['score']
        self.assertEqual(got['mean'], 0.75)
        self.assertLessEqual(got['lo'], got['mean'])
        self.assertGreaterEqual(got['hi'], got['mean'])

    def test_no_graded_values_gives_none_not_nan(self):
        d = doc([trial('k1', 'a', 1, None), trial('k2', 'b', 1, 0.5, outcome='error')])
        got = s.summarize(d)['configs']
        self.assertEqual(got['a']['metrics']['score'], {'mean': None, 'lo': None, 'hi': None, 'n_trials': 0, 'n_cases': 0})
        self.assertIsNone(got['b']['metrics']['score']['mean'])


class BootstrapTests(unittest.TestCase):
    groups = [[1.0, 1.0, 0.0], [0.0], [0.5, 1.0], [1.0], [0.0, 0.0]]

    def test_fixed_seed_gives_pinned_interval(self):
        lo, hi = s.cluster_ci(self.groups)
        self.assertEqual((round(lo, 6), round(hi, 6)), (0.142857, 0.777778))

    def test_same_input_same_interval_regardless_of_call_order(self):
        first = s.cluster_ci(self.groups)
        s.cluster_ci([[0.1], [0.9], [0.3]])
        self.assertEqual(first, s.cluster_ci(self.groups))

    def test_one_case_has_no_interval(self):
        self.assertIsNone(s.cluster_ci([[1.0, 0.0, 1.0]]))
        self.assertIsNone(s.cluster_ci([]))

    def test_paired_pinned_and_edges(self):
        got = s.paired([0.5, 0.25, 0.0, 0.5, 1.0])
        self.assertEqual(got, {'diff': 0.45, 'lo': 0.2, 'hi': 0.75, 'n': 5})
        self.assertEqual(s.paired([]), {'diff': None, 'lo': None, 'hi': None, 'n': 0})
        self.assertEqual(s.paired([0.3]), {'diff': 0.3, 'lo': None, 'hi': None, 'n': 1})

    def test_paired_comparison_uses_only_cases_both_configs_have(self):
        d = doc([trial('k1', 'a', 1, 1.0), trial('k1', 'b', 1, 0.0), trial('k2', 'a', 1, 1.0),
                 trial('k2', 'b', 1, 0.5), trial('k3', 'a', 1, 1.0), trial('k3', 'b', 1, None)])
        got = s.summarize(d)['pairs']['a|b']
        self.assertEqual(got['metrics']['score']['n'], 2)
        self.assertEqual(got['metrics']['score']['diff'], 0.75)
        self.assertEqual([r['case_id'] for r in got['top_cases']], ['k1', 'k2'])

    def test_quantile_interpolates(self):
        self.assertEqual(s.quantile([0, 10], 0.25), 2.5)
        self.assertEqual(s.quantile([4], 0.975), 4)


class RankAndParetoTests(unittest.TestCase):
    def test_competition_rank_with_ties_and_none(self):
        self.assertEqual(s.rank({'a': 0.9, 'b': 0.5, 'c': 0.9, 'd': None}, 'higher'),
                         {'a': 1, 'c': 1, 'b': 3, 'd': None})
        self.assertEqual(s.rank({'a': 3, 'b': 1, 'c': 2}, 'lower'), {'b': 1, 'c': 2, 'a': 3})

    def test_pareto_front_quality_against_cost(self):
        points = {'cheap': (0.1, 0.5), 'mid': (0.5, 0.8), 'dear': (1.0, 0.9), 'bad': (0.6, 0.6),
                  'nocost': None, 'tie-dear': (1.0, 0.9)}
        self.assertEqual(s.pareto_front(points, 'lower', 'higher'), ['cheap', 'mid', 'dear', 'tie-dear'])

    def test_pareto_point_equal_on_one_axis_and_worse_on_the_other_is_dominated(self):
        self.assertEqual(s.pareto_front({'a': (1, 0.9), 'b': (1, 0.8)}, 'lower', 'higher'), ['a'])

    def test_null_cost_config_is_left_off_the_front(self):
        d = doc([trial('k1', 'a', 1, 0.9, cost=None), trial('k1', 'b', 1, 0.5, cost=0.2)])
        self.assertEqual(s.summarize(d)['pareto']['cost']['front'], ['b'])
        self.assertIsNone(s.summarize(d)['pareto']['latency'])


class AxisEffectTests(unittest.TestCase):
    def test_groups_hold_every_other_axis_fixed(self):
        d = doc([trial('k1', c, 1, 0.5) for c in ('a', 'b', 'c')], configs=('a', 'b', 'c'))
        d['configs'] = [
            {'id': 'a', 'label': 'a', 'axes': {'model': 'm1', 'effort': 'low'}},
            {'id': 'b', 'label': 'b', 'axes': {'model': 'm1', 'effort': 'high'}},
            {'id': 'c', 'label': 'c', 'axes': {'model': 'm2', 'effort': 'low'}}]
        effects = {e['axis']: e for e in s.summarize(d)['axis_effects']}
        self.assertEqual([g['label'] for g in effects['effort']['groups']], ['m1'])
        self.assertEqual([b['config_id'] for b in effects['effort']['groups'][0]['bars']], ['a', 'b'])
        self.assertEqual([g['label'] for g in effects['model']['groups']], ['low'])


class IndexTests(unittest.TestCase):
    def test_trend_uses_shared_cases_and_regrade_sits_at_its_source(self):
        one = doc([trial('k1', 'a', 1, 1.0), trial('k2', 'a', 1, 0.0)], configs=('a',), cases=('k1', 'k2'))
        two = doc([trial('k1', 'a', 1, 0.5), trial('k3', 'a', 1, 1.0)], configs=('a',), cases=('k1', 'k3'))
        two['run'] = {**two['run'], 'id': 'r2', 'started_at': '2026-11-27T00:00:00Z'}
        regrade = doc([trial('k1', 'a', 1, 0.75)], configs=('a',), cases=('k1',))
        regrade['run'] = {**regrade['run'], 'id': 'r1-regrade', 'started_at': '2026-12-01T00:00:00Z',
                          'regraded_from': 'r', 'grader': {'harness': 'h', 'model': 'g2', 'effort': None}}
        (ev,) = s.summarize_index([('one', one), ('two', two), ('three', regrade)])
        self.assertEqual(ev['shared_cases'], 1)
        self.assertEqual([r['id'] for r in ev['runs']], ['r', 'r1-regrade', 'r2'])
        self.assertEqual(ev['runs'][1]['x'], '2026-11-20T00:00:00Z')
        key = next(iter(ev['labels']))
        self.assertEqual([r['points'][key] for r in ev['runs']], [1.0, 0.75, 0.5])
        self.assertNotEqual(ev['runs'][0]['compat'], ev['runs'][1]['compat'])

    def test_run_comparison_marks_change_only_when_interval_excludes_zero(self):
        cases = ('k1', 'k2', 'k3', 'k4')
        before = doc([trial(c, 'a', 1, 0.0) for c in cases], configs=('a',), cases=cases)
        after = doc([trial(c, 'a', 1, 1.0) for c in cases], configs=('a',), cases=cases)
        after['run'] = {**after['run'], 'id': 'r2', 'started_at': '2026-11-27T00:00:00Z'}
        same = doc([trial(c, 'a', 1, 1.0) for c in cases], configs=('a',), cases=cases)
        same['run'] = {**same['run'], 'id': 'r3', 'started_at': '2026-12-04T00:00:00Z'}
        (ev,) = s.summarize_index([('b', before), ('a', after), ('s', same)])
        self.assertTrue(ev['comparisons']['0|1'][0]['deltas']['score']['changed'])
        self.assertEqual(ev['comparisons']['0|1'][0]['deltas']['score']['diff'], 1.0)
        self.assertFalse(ev['comparisons']['1|2'][0]['deltas']['score']['changed'])


if __name__ == '__main__':
    unittest.main()
