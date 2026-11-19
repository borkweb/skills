"""Deterministic, process-free review and grading for local dry runs."""
import json

HARNESS = 'fake'
SKILL_LOADING = ('plugin', 'inline')


def preflight(ctx):
    """The fake has no runtime or credentials to check."""


def review(req, ctx):
    text = (f'Reviewed {req["base"]}..{req["head"]}\n'
            '| Coverage | 1/1 |\n| Independent review | unavailable: delegation limit |\n'
            'Verdict basis: readiness unverified\n'
            + ('SAFE TO LAND' if req['skill'] == 'review' else 'PASS'))
    return {'text': text, 'usage': {'input_tokens': 10, 'output_tokens': 10, 'cached_input_tokens': 0},
            'rounds': 1, 'duration_s': 0.0, 'resolved_model': req['model'],
            'resolved_effort': req['effort'], 'skill_invoked': True, 'skill_evidence': 'tool-use:fake',
            'skill_loading': req.get('skill_loading', 'plugin'), 'rate_limited': False, 'error': None,
            'argv': [], 'raw_files': [], 'harness_version': 'fake/1'}


def grade(req, ctx):
    props = req['schema']['properties']
    if 'expected' in props:
        parsed = {'reported': [], 'expected': {k: 'miss' for k in props['expected']['properties']},
                  'verdict': None}
    else:
        labels = props['groups']['items']['properties']['members']['items']['enum']
        parsed = {'groups': [{'group': f'G{i}', 'ruling': 'unsure', 'members': [label]}
                             for i, label in enumerate(labels, 1)]}
    return {'parsed': parsed, 'text': json.dumps(parsed),
            'usage': {'input_tokens': 10, 'output_tokens': 10, 'cached_input_tokens': 0},
            'cost_usd': None, 'error': None, 'rate_limited': False}
