"""Build the synthetic eval-report fixture. Deterministic: the same code always writes the same bytes.

    python3 evals/report/fixtures/make_synthetic.py               rewrite synthetic-results.json
    python3 evals/report/fixtures/make_synthetic.py --materialize <runs root>
                                                                 write each run as <root>/<dir>/results.json
                                                                 plus trials/<token>/ files

synthetic-results.json is a bundle (format bork-eval-fixture/1), not a results file: each member's `results`
is one bork-eval-results/1 document, and `files` holds its raw trial files. All data is made up.

The bundle covers three evals, so the report is exercised on more than one shape:
  review   items, bands with their own metrics, 4 runs (a case added, a grader change, a regrade),
           a config with no graded trials, ungraded and skipped trials, and model output with </script>,
           HTML tags, "<!--" and U+2028 in it
  replay   no items, no bands, different metric keys
  triage   cost declared but always null; one run with one config only, one run where every trial failed
"""
import argparse
import json
import os
from pathlib import Path
import random
import sys

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'synthetic-results.json'
SEED = 7

# Model output that must reach the page as text, never as markup or script.
HOSTILE = ('Finding F1: the notice prints the title raw.\n'
           '```php\n<?php echo $title; ?></div></script><script>window.__pwned = 1</script>\n```\n'
           'Quote from the template: <!-- admin --> <img src=x onerror="window.__pwned = 2"> & done.\n'
           'Line separator here: and paragraph separator here: end.\n')


def _id(rng):
    return ''.join(rng.choice('0123456789abcdef') for _ in range(12))


def _clip(v):
    return max(0.0, min(1.0, v))


def review_run(run_id, started, *, grader, cases, configs, trials, rng, notes, regraded_from=None, drift=0.0):
    statuses = [
        {'key': 'hit', 'label': 'Hit', 'color': 'good'},
        {'key': 'partial', 'label': 'Partial', 'color': 'partial'},
        {'key': 'miss', 'label': 'Miss', 'color': 'bad'},
        {'key': 'extra-real', 'label': 'Extra, real', 'color': 'info'},
        {'key': 'extra-not-real', 'label': 'Extra, not real', 'color': 'warn'},
        {'key': 'extra-unsure', 'label': 'Extra, unsure', 'color': 'neutral'},
    ]
    doc = {
        'schema': 'bork-eval-results/1',
        'run': {'id': run_id, 'eval': 'review', 'eval_version': '1', 'started_at': started,
                'finished_at': started.replace('T09', 'T13'),
                'subject': {'skills_sha': _id(rng) + _id(rng) + _id(rng)[:16], 'skills_ref': 'main'},
                'grader': grader, 'case_set': {'source': 'synthetic', 'sha': None, 'count': len(cases)},
                'context': 'skill-only', 'notes': notes},
        'axes': [{'key': 'harness', 'label': 'Harness'}, {'key': 'model', 'label': 'Model'},
                 {'key': 'effort', 'label': 'Effort'}, {'key': 'skill', 'label': 'Skill'}],
        'metrics': [
            {'key': 'recall', 'label': 'Recall', 'kind': 'rate', 'better': 'higher', 'primary': True},
            {'key': 'precision', 'label': 'Precision', 'kind': 'rate', 'better': 'higher'},
            {'key': 'verdict_block_ok', 'label': 'Verdict accuracy', 'kind': 'rate', 'better': 'higher'},
            {'key': 'clean_false_alarm', 'label': 'False alarm on clean', 'kind': 'rate', 'better': 'lower'},
            {'key': 'cost_usd', 'label': 'Cost per trial', 'kind': 'cost', 'better': 'lower', 'role': 'cost',
             'estimated': True},
            {'key': 'duration_s', 'label': 'Time per trial', 'kind': 'duration', 'better': 'lower', 'role': 'latency'},
            {'key': 'rounds', 'label': 'Rounds', 'kind': 'count', 'better': 'lower'},
        ],
        'bands': [{'key': 'bug', 'label': 'Bug cases', 'band_metric': 'recall'},
                  {'key': 'clean', 'label': 'Clean cases', 'band_metric': 'clean_false_alarm'}],
        'item_statuses': statuses,
        'configs': [{'id': c['id'], 'label': c['label'], 'axes': c['axes']} for c in configs],
        'cases': [{k: v for k, v in c.items() if k != 'findings'} for c in cases],
        'trials': [],
    }
    if regraded_from:
        doc['run']['regraded_from'] = regraded_from
    files = {}
    for case in cases:
        for config in configs:
            for n in range(1, trials + 1):
                token = 't' + _id(rng)
                trial = {'case_id': case['id'], 'config_id': config['id'], 'trial': n, 'token': token,
                         'outcome': 'graded', 'reason': None, 'metrics': {}, 'usage': {}, 'items': []}
                doc['trials'].append(trial)
                if config.get('broken'):
                    trial.update(outcome='error', reason=config['broken'], items=[])
                    trial['metrics'] = {'recall': None, 'precision': None, 'verdict_block_ok': None,
                                        'clean_false_alarm': None, 'cost_usd': None, 'duration_s': None,
                                        'rounds': None}
                    trial['usage'] = {'input_tokens': None, 'output_tokens': None, 'cached_input_tokens': None}
                    files[token] = {'stderr.txt': f'{config["broken"]}\n'}
                    continue
                skill = _clip(config['q'] + drift)
                out_tokens = int(rng.uniform(2000, 9000) * config['verbosity'])
                in_tokens = int(rng.uniform(40000, 160000))
                cost = round((in_tokens * config['price'][0] + out_tokens * config['price'][1]) / 1e6, 4)
                duration = round(rng.uniform(60, 240) * config['speed'], 1)
                rounds = max(1, int(rng.gauss(8, 3) * config['verbosity']))
                trial['usage'] = {'input_tokens': in_tokens, 'output_tokens': out_tokens,
                                  'cached_input_tokens': None if config['axes']['harness'] == 'codex' else in_tokens // 3}
                if (case['id'], config['id'], n) in SKIPPED:
                    trial.update(outcome='skipped', reason='budget', usage={}, items=[])
                    trial['metrics'] = {'recall': None, 'precision': None, 'verdict_block_ok': None,
                                        'clean_false_alarm': None, 'cost_usd': None, 'duration_s': None,
                                        'rounds': None}
                    continue
                hits = partials = 0
                for f in case['findings']:
                    roll = rng.random() - (skill - case['difficulty'])
                    status = 'hit' if roll < 0.35 else 'partial' if roll < 0.55 else 'miss'
                    hits += status == 'hit'
                    partials += status == 'partial'
                    trial['items'].append({'id': f[0], 'label': f[1], 'status': status})
                extras = []
                for x, label in (('X1', 'Unused import in the changed file'),
                                 ('X2', 'Retry loop has no upper bound'),
                                 ('X3', 'Cache key ignores the locale')):
                    if rng.random() < 0.35 * config['verbosity']:
                        status = rng.choice(['extra-real', 'extra-not-real', 'extra-unsure', 'extra-real'])
                        extras.append(status)
                        trial['items'].append({'id': x, 'label': label, 'status': status})
                matched = hits + partials
                real = extras.count('extra-real')
                wrong = extras.count('extra-not-real')
                precision = None if matched + real + wrong == 0 else round((matched + real) / (matched + real + wrong), 4)
                blocks = case['band'] == 'bug' and (hits > 0 or rng.random() < 0.2)
                if case['band'] == 'bug':
                    recall = round((hits + partials / 2) / len(case['findings']), 4)
                    false_alarm = None
                    verdict_ok = 1 if blocks else 0
                else:
                    recall = None
                    false_alarm = 1 if wrong and rng.random() < 0.6 else 0
                    verdict_ok = 0 if false_alarm else 1
                trial['metrics'] = {'recall': recall, 'precision': precision, 'verdict_block_ok': verdict_ok,
                                    'clean_false_alarm': false_alarm,
                                    'cost_usd': cost if config['price'][0] else None, 'duration_s': duration,
                                    'rounds': rounds}
                verdict = 'DO NOT LAND' if blocks or false_alarm else 'SAFE TO LAND'
                body = HOSTILE if case['id'] == 'admin-notice-escape' else (
                    f'Reviewed {case["id"]} at head.\n' + ''.join(
                        f'- {i["id"]}: {i["label"]} ({i["status"]})\n' for i in trial['items']))
                files[token] = {
                    'review.md': f'{body}\nVerdict: {verdict}\n',
                    'grader-reply.json': json.dumps(
                        {'verdict': verdict, 'items': [{'id': i['id'], 'status': i['status']} for i in trial['items']]},
                        separators=(', ', ': ')) + '\n',
                }
                if (case['id'], config['id'], n) in UNGRADED:
                    trial.update(outcome='ungraded', reason='grader reply did not parse', items=[])
                    trial['metrics'] = {k: (v if k in ('cost_usd', 'duration_s', 'rounds') else None)
                                        for k, v in trial['metrics'].items()}
                    files[token]['grader-reply.json'] = 'The review looks fine to me {not json\n'
    return doc, files


SKIPPED = {('cache-locale', 'c5', 3)}
UNGRADED = {('invoice-retry', 'c3', 2), ('admin-notice-escape', 'c1', 1)}

REVIEW_CASES = [
    {'id': 'invoice-retry', 'title': 'Retry resends invoices that already went out', 'tags': ['php', 'billing'],
     'band': 'bug', 'kind': 'bug', 'difficulty': 0.3,
     'findings': [('F1', 'Retry resends sent invoices'), ('F2', 'Idempotency key dropped on retry')]},
    {'id': 'admin-notice-escape', 'title': 'Admin notice prints </script> and <b>raw</b> titles',
     'tags': ['php', 'xss'], 'band': 'bug', 'kind': 'bug', 'difficulty': 0.45,
     'findings': [('F1', 'Title echoed without esc_html: <img src=x onerror="window.__pwned=3">')]},
    {'id': 'cache-locale', 'title': 'Page cache serves the wrong locale', 'tags': ['cache'], 'band': 'bug',
     'kind': 'bug', 'difficulty': 0.5,
     'findings': [('F1', 'Cache key omits locale'), ('F2', 'Purge misses translated pages'),
                  ('F3', 'Fallback locale hard-coded')]},
    {'id': 'auth-scope', 'title': 'Token scope check skipped for batch requests', 'tags': ['auth', 'public-known'],
     'band': 'bug', 'kind': 'bug', 'difficulty': 0.6,
     'findings': [('F1', 'Batch path skips scope check')]},
    {'id': 'migration-lock', 'title': 'Migration holds a table lock during backfill', 'tags': ['sql'],
     'band': 'bug', 'kind': 'bug', 'difficulty': 0.4,
     'findings': [('F1', 'ALTER TABLE without online DDL'), ('F2', 'Backfill in one transaction')]},
    {'id': 'webhook-order', 'title': 'Webhooks can arrive out of order', 'tags': ['queue'], 'band': 'bug',
     'kind': 'bug', 'difficulty': 0.7, 'findings': [('F1', 'No sequence check on webhook apply')]},
    {'id': 'clean-copy-change', 'title': 'Copy change in the onboarding modal', 'tags': ['js'], 'band': 'clean',
     'kind': 'clean', 'difficulty': 0.0, 'findings': []},
    {'id': 'clean-refactor', 'title': 'Rename a private helper', 'tags': ['php'], 'band': 'clean',
     'kind': 'clean', 'difficulty': 0.0, 'findings': []},
]
ADDED_CASE = {'id': 'feature-flag-default', 'title': 'Feature flag defaults to on in production',
              'tags': ['config'], 'band': 'bug', 'kind': 'bug', 'difficulty': 0.35,
              'findings': [('F1', 'Default flips to true when the option is missing')]}


def review_configs(include_broken=True):
    configs = [
        {'id': 'c1', 'label': 'claude · opus-5-5 · high', 'q': 0.62, 'price': (5, 25), 'speed': 1.2, 'verbosity': 1.1,
         'axes': {'harness': 'claude', 'model': 'claude-opus-5-5', 'effort': 'high', 'skill': 'review'}},
        {'id': 'c2', 'label': 'claude · opus-5-5 · medium', 'q': 0.55, 'price': (5, 25), 'speed': 0.9, 'verbosity': 1.0,
         'axes': {'harness': 'claude', 'model': 'claude-opus-5-5', 'effort': 'medium', 'skill': 'review'}},
        {'id': 'c3', 'label': 'claude · sonnet-5-5 · medium', 'q': 0.45, 'price': (1.5, 7.5), 'speed': 0.6,
         'verbosity': 0.9,
         'axes': {'harness': 'claude', 'model': 'claude-sonnet-5-5', 'effort': 'medium', 'skill': 'review'}},
        {'id': 'c4', 'label': 'codex · gpt-6.1-sol · high', 'q': 0.58, 'price': (3, 18), 'speed': 1.5, 'verbosity': 0.8,
         'axes': {'harness': 'codex', 'model': 'gpt-6.1-sol', 'effort': 'high', 'skill': 'review'}},
        {'id': 'c5', 'label': 'codex · gpt-6.1-sol · medium', 'q': 0.5, 'price': (3, 18), 'speed': 1.0, 'verbosity': 0.8,
         'axes': {'harness': 'codex', 'model': 'gpt-6.1-sol', 'effort': 'medium', 'skill': 'review'}},
    ]
    if include_broken:
        configs.append({'id': 'c6', 'label': 'antigravity · gemini-3.8-flash-high', 'q': 0, 'price': (0, 0), 'speed': 1,
                        'verbosity': 1, 'broken': 'adapter refused: no clean session with a copied login',
                        'axes': {'harness': 'antigravity', 'model': 'gemini-3.8-flash-high', 'effort': 'high', 'skill': 'review'}})
    return configs


GRADER_A = {'harness': 'claude', 'model': 'claude-opus-5-5', 'effort': 'high'}
GRADER_B = {'harness': 'claude', 'model': 'claude-opus-5-5', 'effort': 'max'}


def replay_run(rng):
    configs = [
        {'id': 'cur-claude', 'label': 'current · claude', 'axes': {'arm': 'current', 'harness': 'claude'}, 'q': 0.55},
        {'id': 'rev-claude', 'label': 'revised · claude', 'axes': {'arm': 'revised', 'harness': 'claude'}, 'q': 0.7},
        {'id': 'rev-codex', 'label': 'revised · codex', 'axes': {'arm': 'revised', 'harness': 'codex'}, 'q': 0.6},
    ]
    cases = [{'id': f'slice-{i}', 'title': f'Builder slice {i}: {t}', 'tags': ['replay']}
             for i, t in enumerate(['parser flags', 'hook timeout', 'board column', 'ledger report', 'json schema',
                                    'retry budget'], 1)]
    doc = {
        'schema': 'bork-eval-results/1',
        'run': {'id': '2026-11-21-replay-77c1', 'eval': 'replay', 'eval_version': '2',
                'started_at': '2026-11-21T09:00:00Z', 'finished_at': '2026-11-21T11:40:00Z',
                'subject': {'skills_sha': _id(rng) * 3 + _id(rng)[:4], 'skills_ref': 'feat/x'},
                'grader': {'harness': 'codex', 'model': 'gpt-6.1-sol', 'effort': 'high'}, 'notes': None},
        'axes': [{'key': 'arm', 'label': 'Arm'}, {'key': 'harness', 'label': 'Builder'}],
        'metrics': [
            {'key': 'gates_pass', 'label': 'Gates pass', 'kind': 'rate', 'better': 'higher', 'primary': True},
            {'key': 'rework_rounds', 'label': 'Rework rounds', 'kind': 'count', 'better': 'lower'},
            {'key': 'diff_lines', 'label': 'Diff size', 'kind': 'number', 'better': 'lower'},
            {'key': 'usd', 'label': 'Spend', 'kind': 'cost', 'better': 'lower', 'role': 'cost'},
            {'key': 'wall_s', 'label': 'Wall time', 'kind': 'duration', 'better': 'lower', 'role': 'latency'},
        ],
        'configs': [{k: c[k] for k in ('id', 'label', 'axes')} for c in configs],
        'cases': cases, 'trials': [],
    }
    files = {}
    for case in cases:
        for config in configs:
            for n in (1, 2, 3):
                token = 'r' + _id(rng)
                passed = 1 if rng.random() < config['q'] else 0
                doc['trials'].append({
                    'case_id': case['id'], 'config_id': config['id'], 'trial': n, 'token': token,
                    'outcome': 'graded', 'reason': None,
                    'metrics': {'gates_pass': passed, 'rework_rounds': rng.randint(0, 3 - passed),
                                'diff_lines': rng.randint(40, 400), 'usd': round(rng.uniform(0.3, 2.4), 3),
                                'wall_s': round(rng.uniform(300, 1500), 1)},
                    'usage': {'input_tokens': rng.randint(10 ** 5, 10 ** 6), 'output_tokens': rng.randint(10 ** 4, 10 ** 5)}})
                files[token] = {'builder.log': f'slice {case["id"]} trial {n}: gates {"pass" if passed else "fail"}\n'}
    return doc, files


def triage_runs(rng):
    base = {
        'schema': 'bork-eval-results/1',
        'axes': [{'key': 'model', 'label': 'Model'}],
        'metrics': [
            {'key': 'routed_ok', 'label': 'Routed right', 'kind': 'rate', 'better': 'higher', 'primary': True},
            {'key': 'tokens', 'label': 'Tokens', 'kind': 'number', 'better': 'lower'},
            {'key': 'cost_usd', 'label': 'Cost', 'kind': 'cost', 'better': 'lower', 'role': 'cost'},
            {'key': 'seconds', 'label': 'Time', 'kind': 'duration', 'better': 'lower', 'role': 'latency'},
        ],
        'cases': [{'id': f'incident-{i}', 'title': f'Incident {i}', 'tags': []} for i in range(1, 6)],
    }
    one = {**base, 'run': {'id': '2026-11-22-triage-0a0a', 'eval': 'triage', 'eval_version': '1',
                           'started_at': '2026-11-22T09:00:00Z', 'finished_at': '2026-11-22T09:20:00Z',
                           'grader': {'harness': None, 'model': None, 'effort': None},
                           'notes': 'One config; no price table, so cost is unknown.'},
           'configs': [{'id': 'only', 'label': 'haiku-5-5', 'axes': {'model': 'claude-haiku-5-5'}}], 'trials': []}
    files = {}
    for case in one['cases']:
        for n in (1, 2):
            token = 'g' + _id(rng)
            one['trials'].append({'case_id': case['id'], 'config_id': 'only', 'trial': n, 'token': token,
                                  'outcome': 'graded', 'reason': None,
                                  'metrics': {'routed_ok': rng.choice([0, 1, 1]), 'tokens': rng.randint(900, 4000),
                                              'cost_usd': None, 'seconds': round(rng.uniform(4, 30), 1)}})
            files[token] = {'answer.txt': 'Route: investigate\n'}
    failed = {**base, 'run': {'id': '2026-11-29-triage-0b0b', 'eval': 'triage', 'eval_version': '1',
                              'started_at': '2026-11-29T09:00:00Z', 'finished_at': '2026-11-29T09:01:00Z',
                              'grader': {'harness': None, 'model': None, 'effort': None},
                              'notes': 'Every trial failed: the harness was not installed.'},
              'configs': [{'id': 'h', 'label': 'haiku-5-5', 'axes': {'model': 'claude-haiku-5-5'}},
                          {'id': 's', 'label': 'sonnet-5-5', 'axes': {'model': 'claude-sonnet-5-5'}}],
              'trials': []}
    failed_files = {}
    for case in failed['cases']:
        for config in ('h', 's'):
            token = 'f' + _id(rng)
            outcome = 'env-unavailable' if config == 'h' else 'error'
            reason = 'claude: command not found' if config == 'h' else 'exit 1 before any output'
            failed['trials'].append({'case_id': case['id'], 'config_id': config, 'trial': 1, 'token': token,
                                     'outcome': outcome, 'reason': reason,
                                     'metrics': {'routed_ok': None, 'tokens': None, 'cost_usd': None, 'seconds': None}})
            failed_files[token] = {'stderr.txt': reason + '\n'}
    return (one, files), (failed, failed_files)


def bundle():
    rng = random.Random(SEED)
    runs = []
    first, files = review_run('2026-11-20-review-a1b2', '2026-11-20T09:00:00Z', grader=GRADER_A, cases=REVIEW_CASES,
                              configs=review_configs(), trials=3, rng=rng,
                              notes='Baseline. Case titles and model output include </script> on purpose.')
    runs.append(('review-1', first, files))
    doc, files = review_run('2026-11-27-review-c3d4', '2026-11-27T09:00:00Z', grader=GRADER_A,
                            cases=REVIEW_CASES + [ADDED_CASE], configs=review_configs(False), trials=2, rng=rng,
                            notes='One case added.', drift=0.05)
    runs.append(('review-2', doc, {}))  # later runs keep no raw files: the drill-down shows that empty state
    doc, files = review_run('2026-12-04-review-e5f6', '2026-12-04T09:00:00Z', grader=GRADER_B,
                            cases=REVIEW_CASES + [ADDED_CASE], configs=review_configs(False), trials=2, rng=rng,
                            notes='Grader effort raised to max: the trend line breaks here.', drift=0.08)
    runs.append(('review-3', doc, {}))
    doc, files = review_run('2026-12-05-review-regrade-a1b2', '2026-12-05T09:00:00Z', grader=GRADER_B,
                            cases=REVIEW_CASES, configs=review_configs(False), trials=2, rng=random.Random(SEED + 1),
                            notes='Regrade of the baseline with the current grader.', regraded_from=first['run']['id'])
    runs.append(('review-1-regrade', doc, {}))
    doc, files = replay_run(rng)
    runs.append(('replay-1', doc, files))
    (one, one_files), (failed, failed_files) = triage_runs(rng)
    runs.append(('triage-1', one, one_files))
    runs.append(('triage-2-failed', failed, failed_files))
    return {'format': 'bork-eval-fixture/1',
            'note': 'Synthetic data for the eval report. Rewrite with make_synthetic.py; do not edit by hand.',
            'runs': [{'dir': name, 'results': doc, 'files': files} for name, doc, files in runs]}


def dumps(data):
    return json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n'


def dumps_bundle(data):
    """One run's results per line, so a regenerated fixture still diffs by run."""
    head = {k: v for k, v in data.items() if k != 'runs'}
    lines = [dumps(run).rstrip('\n') for run in data['runs']]
    return dumps(head)[:-2] + ',"runs":[\n' + ',\n'.join(lines) + '\n]}\n'


def materialize(root, data=None):
    """Write each run as <root>/<dir>/ with results.json and trials/<token>/<file>. Returns the run dirs."""
    data = data or json.loads(FIXTURE.read_text(encoding='utf-8'))
    root = Path(root)
    dirs = []
    for run in data['runs']:
        run_dir = root / run['dir']
        (run_dir / 'trials').mkdir(parents=True, exist_ok=True)
        os.chmod(run_dir, 0o700)
        (run_dir / 'results.json').write_text(dumps(run['results']), encoding='utf-8')
        for token, named in run['files'].items():
            (run_dir / 'trials' / token).mkdir(exist_ok=True)
            for name, text in named.items():
                (run_dir / 'trials' / token / name).write_text(text, encoding='utf-8')
        dirs.append(run_dir)
    return dirs


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--materialize', metavar='RUNS_ROOT', help='write the runs under this directory')
    args = parser.parse_args(argv)
    if args.materialize:
        for run_dir in materialize(args.materialize):
            print(run_dir)
        return 0
    FIXTURE.write_text(dumps_bundle(bundle()), encoding='utf-8')
    print(f'wrote {FIXTURE}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
