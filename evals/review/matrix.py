"""Validate review matrices and estimate the calls in a proposed run."""
from dataclasses import dataclass
import hashlib
import itertools
import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'report'))
import check_results


class MatrixError(ValueError):
    pass


@dataclass(frozen=True)
class Matrix:
    eval: str
    cases_dir: Path
    case_filter: dict
    case_limit: int | None
    skills_ref: str
    trials: int
    grader: dict
    budget_usd: float
    timeout_s: int
    max_parallel: dict
    skill: str
    configs: list
    raw: dict
    sha256: str


def config_key(cfg):
    return '|'.join('-' if cfg.get(k) is None else cfg[k]
                    for k in ('harness', 'model', 'effort', 'skill', 'skill_loading'))


def token(case_id, config_key, trial):
    return 't' + hashlib.sha256(f'{case_id}|{config_key}|{trial}'.encode()).hexdigest()[:12]


def _positive_int(value, field):
    if type(value) is not int or value <= 0:
        raise MatrixError(f'{field}: must be a positive integer')
    return value


def _text(value, field, nullable=False):
    if value is None and nullable:
        return value
    if not isinstance(value, str) or not value.strip() or value == '-' or '|' in value or '\n' in value:
        raise MatrixError(f'{field}: must be an unambiguous non-empty string')
    return value


def _skeleton(configs, grader):
    axes = ('harness', 'model', 'effort', 'skill_loading')
    return {'schema': 'bork-eval-results/1',
            'run': {'id': 'plan', 'eval': 'review', 'eval_version': '1', 'started_at': 'plan', 'grader': grader},
            'axes': [{'key': a, 'label': a} for a in axes],
            'metrics': [{'key': 'recall', 'label': 'Recall', 'kind': 'rate', 'better': 'higher', 'primary': True}],
            'configs': [{'id': c['key'], 'label': c['key'], 'axes': c['axes']} for c in configs],
            'cases': [], 'trials': []}


def load(path):
    path = Path(path)
    try:
        data = path.read_bytes()
        raw = json.loads(data)
    except (OSError, ValueError) as exc:
        raise MatrixError(f'matrix: {exc}') from exc
    if not isinstance(raw, dict):
        raise MatrixError('matrix: must be an object')
    allowed = {'eval', 'cases', 'case_filter', 'case_limit', 'skills_ref', 'trials', 'grader',
               'budget_usd', 'timeout_s', 'max_parallel', 'configs'}
    if unknown := raw.keys() - allowed:
        raise MatrixError(f'{sorted(unknown)[0]}: unknown field')
    if raw.get('eval') != 'review':
        raise MatrixError('eval: must be review')
    cases = _text(raw.get('cases'), 'cases')
    skills_ref = _text(raw.get('skills_ref'), 'skills_ref')
    if skills_ref.startswith('-'):
        raise MatrixError('skills_ref: cannot start with -')
    trials = _positive_int(raw.get('trials'), 'trials')
    budget = raw.get('budget_usd')
    if type(budget) not in (int, float) or not math.isfinite(budget) or budget <= 0:
        raise MatrixError('budget_usd: must be a finite positive number')
    limit = raw.get('case_limit')
    if 'case_limit' in raw:
        _positive_int(limit, 'case_limit')
    filt = raw.get('case_filter')
    if not isinstance(filt, dict) or filt.keys() - {'skill', 'tags_any'}:
        raise MatrixError('case_filter: requires skill and tags_any')
    if filt.get('skill') not in (['review'], ['review-security']):
        raise MatrixError('case_filter.skill: exactly one review skill is required')
    tags = filt.get('tags_any', [])
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        raise MatrixError('case_filter.tags_any: must be a list of strings')
    filt = {'skill': filt['skill'], 'tags_any': tags}
    harnesses = ('fake', 'claude', 'codex', 'antigravity', 'grok')
    grader = raw.get('grader')
    if not isinstance(grader, dict):
        raise MatrixError('grader: must be an object')
    for field in ('harness', 'model', 'effort'):
        if field not in grader:
            raise MatrixError(f'grader.{field}: required')
        _text(grader[field], f'grader.{field}', nullable=field == 'effort')
    if grader['harness'] not in harnesses:
        raise MatrixError('grader.harness: unknown harness')
    configs = raw.get('configs')
    if not isinstance(configs, list) or not configs:
        raise MatrixError('configs: must be a non-empty list')
    expanded = []
    for cfg in configs:
        if not isinstance(cfg, dict) or cfg.keys() - {'harness', 'model', 'effort', 'skill_loading'}:
            raise MatrixError('configs: unknown field or not an object')
        fields = ('harness', 'model', 'effort', 'skill_loading')
        values = []
        for field in fields:
            val = cfg.get(field, 'plugin' if field == 'skill_loading' else None)
            vals = val if isinstance(val, list) else [val]
            if not vals:
                raise MatrixError(f'configs.{field}: list must not be empty')
            for v in vals:
                _text(v, f'configs.{field}', nullable=field == 'effort')
                if field == 'harness' and v not in harnesses:
                    raise MatrixError('configs.harness: unknown harness')
                if field == 'skill_loading' and v not in ('plugin', 'inline'):
                    raise MatrixError('configs.skill_loading: must be plugin or inline')
            values.append(vals)
        for combination in itertools.product(*values):
            item = dict(zip(fields, combination))
            item['skill'] = filt['skill'][0]
            item['key'] = config_key(item)
            item['axes'] = {f: item[f] for f in fields}
            expanded.append(item)
    errors = check_results.check(_skeleton(expanded, grader))
    if errors:
        raise MatrixError('; '.join(errors))
    parallel = raw.get('max_parallel', {})
    if not isinstance(parallel, dict) or parallel.keys() - set(harnesses):
        raise MatrixError('max_parallel: must be a harness to integer map')
    for h, value in parallel.items():
        _positive_int(value, 'max_parallel.' + h)
    parallel = {h: parallel.get(h, 2) for h in {c['harness'] for c in expanded}}
    return Matrix('review', Path(cases).expanduser(), filt, limit, skills_ref, trials, grader, budget,
                  _positive_int(raw.get('timeout_s', 2700), 'timeout_s'), parallel, filt['skill'][0],
                  expanded, raw, hashlib.sha256(data).hexdigest())


def select_cases(m, cases, case_ids=None):
    if case_ids is not None:
        selected = [c for c in cases if c['id'] in case_ids]
    else:
        selected = [c for c in cases if c['skill'] in m.case_filter['skill']]
        tags = m.case_filter['tags_any']
        selected = [c for c in selected if not tags or set(tags).intersection(c.get('tags', []))]
    selected = sorted(selected, key=lambda c: c['id'])
    return selected if case_ids is not None or m.case_limit is None else selected[:m.case_limit]


def _prices():
    return json.loads(Path(__file__).with_name('prices.json').read_text())


def cost(model, usage):
    price = _prices()['models'].get(model)
    if price is None or all(usage.get(k) is None for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')):
        return None
    return sum((usage.get(k) or 0) * price[p] for k, p in (
        ('input_tokens', 'input'), ('cached_input_tokens', 'cached_input'), ('output_tokens', 'output'))) / 1e6


def plan(m, selected_cases):
    prices = _prices()
    highest = max(prices['models'], key=lambda name: sum(prices['models'][name][k]
                                                      for k in ('input', 'cached_input', 'output')))

    def estimate(model, kind):
        return cost(model if model in prices['models'] else highest, prices['estimates'][kind])

    n = len(selected_cases)
    calls = len(m.configs) * n * m.trials
    estimated = sum(estimate(c['model'], 'review') * n * m.trials for c in m.configs)
    estimated += calls * estimate(m.grader['model'], 'match') + n * estimate(m.grader['model'], 'extras')
    result = {'configs': len(m.configs), 'review_calls': calls, 'match_calls': calls, 'extras_calls': n,
              'estimated_cost_usd': estimated, 'budget_usd': m.budget_usd}
    print(f"Configs: {result['configs']}; review calls: {calls}; match calls: {calls}; extras calls: {n}; "
          f"estimated cost: ${estimated:.6f}; budget_usd: {m.budget_usd:g}")
    return result
