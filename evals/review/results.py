"""Read the append-only review ledger and publish report-compatible results."""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'report'))
import check_results  # noqa: E402

SCHEMA = 'bork-review-trial/1'
AXES = ('harness', 'model', 'effort', 'skill_loading')
METRICS = [
    {'key': 'recall', 'label': 'Recall', 'kind': 'rate', 'better': 'higher', 'primary': True},
    {'key': 'recall_important', 'label': 'Important recall', 'kind': 'rate', 'better': 'higher'},
    {'key': 'precision', 'label': 'Precision', 'kind': 'rate', 'better': 'higher'},
    {'key': 'verdict_block_ok', 'label': 'Verdict accuracy', 'kind': 'rate', 'better': 'higher'},
    {'key': 'clean_false_alarm', 'label': 'Clean false alarm', 'kind': 'rate', 'better': 'lower'},
    {'key': 'cost_usd', 'label': 'Review cost', 'kind': 'cost', 'better': 'lower', 'role': 'cost', 'estimated': True},
    {'key': 'duration_s', 'label': 'Duration', 'kind': 'duration', 'better': 'lower', 'role': 'latency'},
    {'key': 'rounds', 'label': 'Rounds', 'kind': 'count', 'better': 'lower'},
]
STATUS_COLORS = {'hit': 'good', 'partial': 'partial', 'miss': 'bad',
                 'extra-real': 'good', 'extra-not-real': 'bad', 'extra-unsure': 'neutral'}


class ResultsError(ValueError):
    pass


@dataclass
class State:
    records: list
    reviews: dict
    matches: dict
    extras: dict


def read_records(path):
    """Highest attempt wins, with later lines breaking ties. Filter stale grades."""
    records, winners = [], {}
    lines = Path(path).read_text(encoding='utf-8').splitlines()
    for i, line in enumerate(lines, 1):
        try:
            record = check_results.parse(line)
        except (ValueError, RecursionError) as exc:
            if i == len(lines):
                break
            raise ResultsError(f'line {i}: malformed JSON') from exc
        if not isinstance(record, dict) or record.get('schema') != SCHEMA:
            raise ResultsError(f'line {i}: expected schema {SCHEMA}')
        if not isinstance(record.get('type'), str) or record['type'] not in ('review', 'match', 'extras'):
            raise ResultsError(f'line {i}: unknown type')
        if not isinstance(record.get('key'), str) or not record['key']:
            raise ResultsError(f'line {i}: missing key')
        if type(record.get('attempt')) is not int or record['attempt'] < 1:
            raise ResultsError(f'line {i}: invalid attempt')
        records.append(record)
        key = record['type'], record['key']
        if key not in winners or record['attempt'] >= winners[key]['attempt']:
            winners[key] = record
    reviews = {key: r for (kind, key), r in winners.items() if kind == 'review'}
    matches = {key: r for (kind, key), r in winners.items() if kind == 'match'
               and key in reviews and r.get('review_attempt') == reviews[key]['attempt']}
    terminal = {}
    for token, review in reviews.items():
        if review['outcome'] == 'ok':
            terminal.setdefault(review['case_id'], []).append(token)
    extras = {key: r for (kind, key), r in winners.items() if kind == 'extras'
              and r.get('tokens') == sorted(terminal.get(key, []))}
    return State(records, reviews, matches, extras)


def _blocker(severity, skill):
    return severity in (('IMPORTANT',) if skill == 'review' else ('CRITICAL', 'HIGH'))


def _blocks(token):
    return token in ('DO NOT LAND', 'FAIL')


def _metrics(case, review, match, rulings, extras_ready):
    values = {m['key']: None for m in METRICS}
    for key in ('cost_usd', 'duration_s', 'rounds'):
        values[key] = review.get(key)
    if review['outcome'] != 'ok' or match is None or match['outcome'] != 'graded':
        return values
    expected, reported = case['expected_findings'], match['reported']

    def recall(findings):
        return (sum({'hit': 1, 'partial': .5, 'miss': 0}[match['expected'][f['id']]] for f in findings)
                / len(findings)) if findings else None

    if case['kind'] == 'bug':
        values['recall'] = recall(expected)
        values['recall_important'] = recall([f for f in expected if _blocker(f['severity'], case['skill'])])
    if extras_ready:
        matched = sum(1 for f in reported if f['names'] != ['extra'])
        real = sum(rulings.get((review['key'], f['n'])) == 'real' for f in reported if f['names'] == ['extra'])
        false = sum(rulings.get((review['key'], f['n'])) == 'not-real' for f in reported if f['names'] == ['extra'])
        denominator = matched + real + false
        values['precision'] = (matched + real) / denominator if denominator else None
        if case['kind'] == 'clean':
            values['clean_false_alarm'] = int(any(
                _blocker(f['severity'], case['skill']) and rulings.get((review['key'], f['n'])) == 'not-real'
                for f in reported if f['names'] == ['extra']))
    expected_verdict, actual = case.get('expected_verdict'), match.get('verdict')
    if expected_verdict is not None and expected_verdict != 'INCOMPLETE' and actual != 'INCOMPLETE':
        values['verdict_block_ok'] = int(actual is not None and _blocks(expected_verdict) == _blocks(actual))
    return values


def _config(cfg, skill):
    axes = {k: cfg.get(k) for k in AXES}
    axes['skill_loading'] = cfg.get('skill_loading', 'plugin')
    key = '|'.join('-' if v is None else str(v) for v in
                   (axes['harness'], axes['model'], axes['effort'], cfg.get('skill', skill), axes['skill_loading']))
    return {'id': key, 'label': key, 'axes': axes}


def build(run_dir):
    """Use frozen inputs in this run directory only. Never modify them."""
    run_dir = Path(run_dir)
    manifest = check_results.parse((run_dir / 'run.json').read_text(encoding='utf-8'))
    state = read_records(run_dir / 'trials.jsonl')
    cases = [check_results.parse(p.read_text(encoding='utf-8')) for p in sorted((run_dir / 'cases').glob('*.json'))]
    by_id = {c['id']: c for c in cases}
    matrix = manifest['matrix']
    configs = [_config(c, matrix['skill']) for c in matrix['configs']]
    config_ids = {c['id'] for c in configs}
    calls = [r for r in state.records if r['type'] in ('match', 'extras')]
    costs = [r['grader_cost_usd'] for r in calls if r.get('grader_cost_usd') is not None]
    run = {'id': manifest['run_id'], 'eval': 'review', 'eval_version': manifest['eval_version'],
           'started_at': manifest['started_at'], 'context': manifest['context'],
           'subject': {k: manifest[k] for k in ('skills_sha', 'skills_ref')},
           'case_set': {'sha': manifest['case_set_sha256']},
           'grader': dict(manifest['grader'], cost_usd=sum(costs) if costs else None,
                          calls=len(calls), cost_complete=all(r.get('grader_cost_usd') is not None for r in calls))}
    if 'regraded_from' in manifest:
        run['regraded_from'] = manifest['regraded_from']
    trials = []
    for case_id, case in by_id.items():
        reviews = [r for r in state.reviews.values() if r['case_id'] == case_id]
        extra_pairs = set()
        for review in reviews:
            match = state.matches.get(review['key'])
            if review['outcome'] == 'ok' and match and match['outcome'] == 'graded':
                extra_pairs.update((review['key'], f['n']) for f in match['reported'] if f['names'] == ['extra'])
        extra = state.extras.get(case_id)
        groups = extra['groups'] if extra and extra['outcome'] == 'graded' else []
        rulings = {tuple(member): group['ruling'] for group in groups for member in group['members']}
        extras_ready = not extra_pairs or (extra is not None and extra['outcome'] == 'graded'
                                            and set(rulings) == extra_pairs)
        for review in reviews:
            token = review['key']
            if review['config_key'] not in config_ids:
                raise ResultsError(f'{token}: undeclared config {review["config_key"]}')
            invoked = review.get('skill_invoked')
            if invoked is not None and type(invoked) is not bool:
                raise ResultsError(f'{token}: skill_invoked must be true, false or null')
            match = state.matches.get(token)
            outcome = review['outcome']
            if outcome == 'ok':
                outcome = 'graded' if match and match['outcome'] == 'graded' else 'ungraded'
            items = []
            if outcome == 'graded':
                items = [{'id': f['id'], 'label': f['answer'], 'status': match['expected'][f['id']]}
                         for f in case['expected_findings']]
                for group in groups:
                    members = {n for t, n in group['members'] if t == token}
                    if members:
                        finding = next(f for f in match['reported'] if f['n'] in members)
                        items.append({'id': 'extra:' + group['group'],
                                      'label': finding['summary'].strip() or f'{finding["file"]}:{finding["lines"]}',
                                      'status': 'extra-' + group['ruling']})
            trials.append({'case_id': case_id, 'config_id': review['config_key'], 'trial': review['trial'],
                           'token': token, 'outcome': outcome, 'reason': review.get('reason'),
                           'metrics': _metrics(case, review, match, rulings, extras_ready),
                           'usage': review.get('usage'), 'items': items})
    doc = {'schema': check_results.SCHEMA, 'run': run,
           'axes': [{'key': k, 'label': k.replace('_', ' ').title()} for k in AXES],
           'configs': configs, 'metrics': METRICS,
           'bands': [{'key': 'bug', 'label': 'Bug', 'band_metric': 'recall'},
                     {'key': 'clean', 'label': 'Clean', 'band_metric': 'clean_false_alarm'}],
           'item_statuses': [{'key': k, 'label': k, 'color': v} for k, v in STATUS_COLORS.items()],
           'cases': [{'id': c['id'], 'title': c['title'], 'band': c['kind'], 'tags': c.get('tags', [])} for c in cases],
           'trials': trials}
    errors = check_results.check(doc)
    if errors:
        raise ResultsError('\n'.join(errors))
    return doc


def write(run_dir):
    """Serialize before replacing, keeping an earlier result intact on any failure."""
    doc = build(run_dir)
    text = json.dumps(doc, ensure_ascii=True, indent=2, allow_nan=False) + '\n'
    fd, name = tempfile.mkstemp(prefix='.results-', suffix='.tmp', dir=run_dir)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, Path(run_dir) / 'results.json')
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return doc
