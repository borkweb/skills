"""Statistics for the eval report. Python standard library only; every function is deterministic.

The estimator, used for both the point and its interval:

- A config's mean for a metric pools every graded trial that has a value: the sum over trials divided by the
  count. Trials that are not `graded`, and `null` values, are left out, never counted as 0.
- Its 95% interval is a cluster bootstrap over cases: resample the cases with replacement, then take the same
  pooled mean of the trials in the resampled cases. Cases are the unit, because the trials of one case are
  not independent. Fewer than 2 cases gives no interval (None).
- A paired comparison of A and B uses only the cases where both have a value. The difference for a case is
  A's case mean minus B's; the estimate is the mean of those differences, and its interval is a bootstrap of
  that mean over the paired cases.

Every bootstrap draws from its own random.Random(SEED), so the same input always gives the same interval,
whatever order the calls run in.
"""
import json
import math
import random
import statistics

SEED = 20261119
RESAMPLES = 1000
LEVEL = 0.95
TOP_CASES = 5


def _round(value):
    return None if value is None else round(value, 6)


def mean(values):
    """The mean of the values that are not None; None when there are none."""
    kept = [v for v in values if v is not None]
    return sum(kept) / len(kept) if kept else None


def quantile(ordered, q):
    """Linear-interpolation quantile of an already sorted, non-empty list (Hyndman and Fan type 7)."""
    if not ordered:
        raise ValueError('quantile of an empty list')
    pos = (len(ordered) - 1) * q
    lo = math.floor(pos)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def _interval(estimates):
    estimates.sort()
    tail = (1 - LEVEL) / 2
    return quantile(estimates, tail), quantile(estimates, 1 - tail)


def pooled_mean(groups):
    """groups: lists of values, one list per case. The pooled mean of every value, or None."""
    total = sum(sum(g) for g in groups)
    count = sum(len(g) for g in groups)
    return total / count if count else None


def cluster_ci(groups, resamples=RESAMPLES, seed=SEED):
    """Bootstrap interval of the pooled mean, resampling cases. groups: one non-empty value list per case."""
    sums = [(sum(g), len(g)) for g in groups if g]
    n = len(sums)
    if n < 2:
        return None
    rng = random.Random(seed)
    estimates = []
    for _ in range(resamples):
        total = count = 0
        for _ in range(n):
            s, c = sums[rng.randrange(n)]
            total += s
            count += c
        estimates.append(total / count)
    return _interval(estimates)


def paired(diffs, resamples=RESAMPLES, seed=SEED):
    """diffs: one A-minus-B difference per paired case. Returns diff, lo, hi and n (lo and hi need n >= 2)."""
    n = len(diffs)
    if n == 0:
        return {'diff': None, 'lo': None, 'hi': None, 'n': 0}
    estimate = sum(diffs) / n
    if n < 2:
        return {'diff': _round(estimate), 'lo': None, 'hi': None, 'n': n}
    rng = random.Random(seed)
    estimates = [sum(diffs[rng.randrange(n)] for _ in range(n)) / n for _ in range(resamples)]
    lo, hi = _interval(estimates)
    return {'diff': _round(estimate), 'lo': _round(lo), 'hi': _round(hi), 'n': n}


def rank(values, better):
    """Competition rank (1, 1, 3) of each id by value; the best value ranks 1. None values get rank None."""
    present = [(v, k) for k, v in values.items() if v is not None]
    ordered = sorted(present, key=lambda p: -p[0] if better == 'higher' else p[0])
    ranks = {k: None for k in values}
    for i, (value, key) in enumerate(ordered):
        ranks[key] = ranks[ordered[i - 1][1]] if i and ordered[i - 1][0] == value else i + 1
    return ranks


def pareto_front(points, better_x, better_y):
    """points: id -> (x, y), or None to leave the id out. Returns the ids no other point dominates, by x.

    A point dominates another when it is at least as good on both axes and better on one. Two points at the same
    place do not dominate each other, so both stay on the front.
    """
    def ge(a, b, better):
        return a >= b if better == 'higher' else a <= b

    kept = {k: p for k, p in points.items() if p is not None and None not in p}
    front = []
    for key, (x, y) in kept.items():
        dominated = any(
            ge(ox, x, better_x) and ge(oy, y, better_y) and (ox, oy) != (x, y)
            for other, (ox, oy) in kept.items() if other != key)
        if not dominated:
            front.append(key)
    return sorted(front, key=lambda k: (kept[k][0], kept[k][1], k))


# ---- one run -------------------------------------------------------------------------------------------


def _graded(doc):
    return [t for t in doc['trials'] if t['outcome'] == 'graded']


def case_values(trials, config_id, key):
    """case_id -> the graded, non-null values of one metric for one config."""
    out = {}
    for t in trials:
        if t['config_id'] == config_id:
            value = t['metrics'].get(key)
            if value is not None:
                out.setdefault(t['case_id'], []).append(value)
    return out


def metric_summary(groups):
    values = list(groups.values())
    point = pooled_mean(values)
    ci = cluster_ci(values)
    return {'mean': _round(point), 'lo': _round(ci[0]) if ci else None, 'hi': _round(ci[1]) if ci else None,
            'n_trials': sum(len(v) for v in values), 'n_cases': len(values)}


def primary_metric(doc):
    return next(m for m in doc['metrics'] if m.get('primary'))


def role_metric(doc, role):
    return next((m for m in doc['metrics'] if m.get('role') == role), None)


def _axis_value(config, axis):
    return config['axes'].get(axis)


def axis_effects(doc, means):
    """For each axis, compare configs that are the same on every other axis.

    A group is the configs that share every other axis value; a group shows only when it has 2 or more values
    of the axis. means: config id -> the primary metric summary.
    """
    out = []
    axes = [a['key'] for a in doc['axes']]
    for axis in doc['axes']:
        key = axis['key']
        order = []
        for config in doc['configs']:
            value = _axis_value(config, key)
            if value not in order:
                order.append(value)
        if len(order) < 2:
            continue
        groups = {}
        for config in doc['configs']:
            rest = tuple((a, _axis_value(config, a)) for a in axes if a != key)
            groups.setdefault(rest, []).append(config)
        shown = []
        for rest, members in groups.items():
            if len({_axis_value(c, key) for c in members}) < 2:
                continue
            members = sorted(members, key=lambda c: order.index(_axis_value(c, key)))
            label = ' · '.join(v for _, v in rest if v is not None) or 'all'
            shown.append({'label': label, 'bars': [
                {'value': _axis_value(c, key), 'config_id': c['id'], **{k: means[c['id']][k] for k in ('mean', 'lo', 'hi')}}
                for c in members]})
        out.append({'axis': key, 'label': axis['label'], 'values': order, 'groups': shown})
    return out


def band_layout(doc):
    """The heatmap row groups: one per band, in first-seen order, each with the metric it shows."""
    primary = primary_metric(doc)['key']
    declared = {b['key']: b for b in doc.get('bands') or []}
    order = []
    for case in doc['cases']:
        band = case.get('band')
        if band not in order:
            order.append(band)
    layout = []
    for band in order:
        spec = declared.get(band, {})
        layout.append({'key': band, 'label': spec.get('label') or band or 'All cases',
                       'metric': spec.get('band_metric') or primary,
                       'case_ids': [c['id'] for c in doc['cases'] if c.get('band') == band]})
    return layout


def summarize(doc):
    """Every statistic the run report shows, precomputed so the page only draws it."""
    graded = _graded(doc)
    metrics = doc['metrics']
    primary = primary_metric(doc)
    config_ids = [c['id'] for c in doc['configs']]

    configs = {}
    for cid in config_ids:
        own = [t for t in doc['trials'] if t['config_id'] == cid]
        outcomes, reasons = {}, {}
        for t in own:
            outcomes[t['outcome']] = outcomes.get(t['outcome'], 0) + 1
            if t['outcome'] != 'graded':
                reason = (t['outcome'], t.get('reason') or '')
                reasons[reason] = reasons.get(reason, 0) + 1
        configs[cid] = {
            'trials': len(own),
            'outcomes': outcomes,
            'reasons': [{'outcome': o, 'reason': r or None, 'count': n} for (o, r), n in sorted(reasons.items())],
            'metrics': {m['key']: metric_summary(case_values(graded, cid, m['key'])) for m in metrics},
        }

    ranks = {m['key']: rank({cid: configs[cid]['metrics'][m['key']]['mean'] for cid in config_ids}, m['better'])
             for m in metrics}

    pareto = {}
    for role in ('cost', 'latency'):
        metric = role_metric(doc, role)
        if metric is None:
            pareto[role] = None
            continue
        points = {}
        for cid in config_ids:
            x = configs[cid]['metrics'][metric['key']]['mean']
            y = configs[cid]['metrics'][primary['key']]['mean']
            points[cid] = None if x is None or y is None else (x, y)
        pareto[role] = {'metric': metric['key'], 'front': pareto_front(points, metric['better'], primary['better'])}

    layout = band_layout(doc)
    heatmap = []
    for band in layout:
        cells = {}
        for case_id in band['case_ids']:
            row = {}
            for cid in config_ids:
                values = [t['metrics'].get(band['metric']) for t in graded
                          if t['case_id'] == case_id and t['config_id'] == cid]
                values = [v for v in values if v is not None]
                row[cid] = {'mean': _round(mean(values)), 'n': len(values)}
            cells[case_id] = row
        heatmap.append({**band, 'cells': cells})

    items = []
    index = {}
    case_order = {c['id']: i for i, c in enumerate(doc['cases'])}
    graded_count = {}
    for t in graded:
        graded_count[(t['case_id'], t['config_id'])] = graded_count.get((t['case_id'], t['config_id']), 0) + 1
    for t in sorted(graded, key=lambda t: (case_order[t['case_id']], config_ids.index(t['config_id']), t['trial'])):
        for item in t.get('items') or []:
            key = (t['case_id'], item['id'])
            if key not in index:
                index[key] = {'case_id': t['case_id'], 'item_id': item['id'], 'label': item['label'], 'cells': {}}
                items.append(index[key])
            cell = index[key]['cells'].setdefault(
                t['config_id'], {'total': graded_count[(t['case_id'], t['config_id'])], 'counts': {}})
            cell['counts'][item['status']] = cell['counts'].get(item['status'], 0) + 1

    stability = {}
    for cid in config_ids:
        spreads = []
        for case_id, values in case_values(graded, cid, primary['key']).items():
            if len(values) >= 2:
                spreads.append({'case_id': case_id, 'sd': _round(statistics.stdev(values)),
                                'min': _round(min(values)), 'max': _round(max(values)), 'n': len(values)})
        spreads.sort(key=lambda s: (-s['sd'], case_order[s['case_id']]))
        stability[cid] = {'cases': spreads, 'mean_sd': _round(mean([s['sd'] for s in spreads])),
                          'max_sd': spreads[0]['sd'] if spreads else None}

    pairs = {}
    for i, a in enumerate(config_ids):
        for b in config_ids[i + 1:]:
            per_metric, top = {}, []
            for m in metrics:
                va, vb = case_values(graded, a, m['key']), case_values(graded, b, m['key'])
                shared = [c['id'] for c in doc['cases'] if c['id'] in va and c['id'] in vb]
                diffs = [mean(va[c]) - mean(vb[c]) for c in shared]
                per_metric[m['key']] = paired(diffs)
                if m is primary:
                    top = sorted(({'case_id': c, 'a': _round(mean(va[c])), 'b': _round(mean(vb[c])), 'diff': _round(d)}
                                  for c, d in zip(shared, diffs) if d != 0),
                                 key=lambda r: (-abs(r['diff']), case_order[r['case_id']]))[:TOP_CASES]
            pairs[f'{a}|{b}'] = {'metrics': per_metric, 'top_cases': top}

    cost = role_metric(doc, 'cost')
    cost_values = [t['metrics'].get(cost['key']) for t in doc['trials']] if cost else []
    cost_values = [v for v in cost_values if v is not None]
    outcomes = {}
    for t in doc['trials']:
        outcomes[t['outcome']] = outcomes.get(t['outcome'], 0) + 1
    totals = {'trials': len(doc['trials']), 'outcomes': outcomes,
              'cost': _round(sum(cost_values)) if cost_values else None,
              'cost_trials': len(cost_values)}

    return {'primary': primary['key'], 'configs': configs, 'ranks': ranks, 'pareto': pareto,
            'axis_effects': axis_effects(doc, {cid: configs[cid]['metrics'][primary['key']] for cid in config_ids}),
            'heatmap': heatmap, 'items': items, 'stability': stability, 'pairs': pairs, 'totals': totals}


# ---- across runs (index page) --------------------------------------------------------------------------


def config_key(doc, config):
    """A config's identity across runs: every declared axis value, missing axes as null."""
    return json.dumps({a['key']: config['axes'].get(a['key']) for a in doc['axes']}, sort_keys=True)


def compat_key(doc):
    """Scores are comparable only within one eval_version and one grader."""
    grader = doc['run']['grader']
    return json.dumps([doc['run']['eval_version'], grader.get('harness'), grader.get('model'), grader.get('effort')])


def run_case_values(doc):
    """config key -> metric -> case_id -> graded non-null values."""
    by_id = {c['id']: config_key(doc, c) for c in doc['configs']}
    out = {}
    for t in _graded(doc):
        per_metric = out.setdefault(by_id[t['config_id']], {})
        for key, value in t['metrics'].items():
            if value is not None:
                per_metric.setdefault(key, {}).setdefault(t['case_id'], []).append(value)
    return out


def summarize_index(docs):
    """docs: (run dir name, results doc). Returns the evals on the index page: runs, trends and comparisons.

    A run with run.regraded_from that names another run under the root sits at that run's date and SHA, so a
    regrade lines up under the change it measured.
    """
    by_id = {doc['run']['id']: doc for _, doc in docs}
    evals = {}
    for name, doc in docs:
        evals.setdefault(doc['run']['eval'], []).append((name, doc))

    def position(doc):
        source = by_id.get(doc['run'].get('regraded_from') or '')
        anchor = source or doc
        return anchor['run']['started_at'], (anchor['run'].get('subject') or {}).get('skills_sha')

    out = []
    for eval_name in sorted(evals):
        members = sorted(evals[eval_name], key=lambda nd: (position(nd[1])[0], nd[1]['run']['id']))
        latest = members[-1][1]
        primary = primary_metric(latest)
        metric_defs = {}
        for _, doc in members:
            for m in doc['metrics']:
                metric_defs[m['key']] = m
        values = [run_case_values(doc) for _, doc in members]
        cases_per_run = [{c['id'] for c in doc['cases']} for _, doc in members]
        shared = set.intersection(*cases_per_run) if cases_per_run else set()

        labels = {}
        for _, doc in members:
            for c in doc['configs']:
                labels[config_key(doc, c)] = c['label']

        runs = []
        for (name, doc), vals in zip(members, values):
            at, sha = position(doc)
            points = {}
            for key, per_metric in vals.items():
                groups = [v for case, v in per_metric.get(primary['key'], {}).items() if case in shared]
                points[key] = _round(pooled_mean(groups))
            runs.append({'dir': name, 'id': doc['run']['id'], 'x': at, 'sha': sha,
                         'started_at': doc['run']['started_at'], 'eval_version': doc['run']['eval_version'],
                         'grader': doc['run']['grader'], 'compat': compat_key(doc),
                         'regraded_from': doc['run'].get('regraded_from'), 'notes': doc['run'].get('notes'),
                         'cases': len(doc['cases']), 'trials': len(doc['trials']),
                         'configs': [config_key(doc, c) for c in doc['configs']], 'points': points})

        comparisons = {}
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                a, b = values[i], values[j]
                rows = []
                for key in sorted(set(a) & set(b), key=lambda k: labels[k]):
                    deltas = {}
                    for metric in sorted(set(a[key]) | set(b[key])):
                        va, vb = a[key].get(metric, {}), b[key].get(metric, {})
                        common = sorted(set(va) & set(vb))
                        result = paired([mean(vb[c]) - mean(va[c]) for c in common])
                        result['changed'] = result['lo'] is not None and (result['lo'] > 0 or result['hi'] < 0)
                        deltas[metric] = result
                    rows.append({'key': key, 'deltas': deltas})
                comparisons[f'{i}|{j}'] = rows

        out.append({'eval': eval_name, 'primary': primary['key'], 'metrics': list(metric_defs.values()),
                    'shared_cases': len(shared), 'labels': labels, 'runs': runs, 'comparisons': comparisons})
    return out
