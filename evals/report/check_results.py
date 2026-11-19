"""Check a results file against the bork-eval-results/1 schema.

    python3 evals/report/check_results.py <results.json | run dir> [...]

Exit 0 when every file passes. Each error names a JSON path. The report generator calls `load` and refuses a
file with any error, so a bad file never reaches the page. The format is in
docs/superpowers/specs/2026-11-19-eval-report-and-review-eval-design.md ("Part 1").
"""
import json
import math
from pathlib import Path
import re
import sys

SCHEMA = 'bork-eval-results/1'
KINDS = ('rate', 'number', 'count', 'cost', 'duration')
BETTER = ('higher', 'lower')
ROLES = ('cost', 'latency')
OUTCOMES = ('graded', 'ungraded', 'error', 'skipped', 'env-unavailable')
# Item status colors are tokens, not hex, so the page can step each one for light and dark mode.
STATUS_COLORS = ('good', 'partial', 'bad', 'warn', 'info', 'neutral')
# A token names the trials/<token>/ directory; it must stay one plain path component.
TOKEN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')


class CheckError(ValueError):
    def __init__(self, errors):
        super().__init__('\n'.join(errors))
        self.errors = errors


def _reject_constant(name):
    raise ValueError(f'{name} is not valid JSON; write null for an unknown value')


def parse(text):
    """json.loads that refuses NaN and Infinity: the browser's JSON.parse cannot read them."""
    return json.loads(text, parse_constant=_reject_constant)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class _Checker:
    def __init__(self):
        self.errors = []

    def err(self, path, message):
        self.errors.append(f'{path}: {message}')

    def obj(self, value, path):
        if not isinstance(value, dict):
            self.err(path, 'must be an object')
            return False
        return True

    def lst(self, value, path, nonempty=False):
        if not isinstance(value, list):
            self.err(path, 'must be a list')
            return False
        if nonempty and not value:
            self.err(path, 'must not be empty')
            return False
        return True

    def text(self, parent, key, path, required=True, nullable=False):
        if key not in parent:
            if required:
                self.err(f'{path}.{key}', 'is required')
            return None
        value = parent[key]
        if value is None and nullable:
            return None
        if not isinstance(value, str) or (required and not value.strip()):
            self.err(f'{path}.{key}', 'must be a non-empty string' + (' or null' if nullable else ''))
            return None
        return value

    def unique(self, items, key, path):
        seen = set()
        for i, item in enumerate(items):
            if isinstance(item, dict) and isinstance(item.get(key), str):
                if item[key] in seen:
                    self.err(f'{path}[{i}].{key}', f'duplicate {item[key]!r}')
                seen.add(item[key])
        return seen


def check(doc):
    """Return a list of error strings; an empty list means the document passes."""
    c = _Checker()
    if not c.obj(doc, '$'):
        return c.errors
    if doc.get('schema') != SCHEMA:
        c.err('$.schema', f'must be {SCHEMA!r}')

    run = doc.get('run')
    if run is None:
        c.err('$.run', 'is required')
    elif c.obj(run, '$.run'):
        for key in ('id', 'eval', 'eval_version', 'started_at'):
            c.text(run, key, '$.run')
        c.text(run, 'finished_at', '$.run', required=False, nullable=True)
        c.text(run, 'notes', '$.run', required=False, nullable=True)
        c.text(run, 'regraded_from', '$.run', required=False, nullable=True)
        c.text(run, 'context', '$.run', required=False, nullable=True)
        grader = run.get('grader')
        if grader is None:
            c.err('$.run.grader', 'is required')
        elif c.obj(grader, '$.run.grader'):
            for key in ('harness', 'model', 'effort'):
                c.text(grader, key, '$.run.grader', nullable=True)
        for key in ('subject', 'case_set'):
            if key in run and run[key] is not None:
                c.obj(run[key], f'$.run.{key}')

    axes = doc.get('axes')
    axis_keys = set()
    if axes is None:
        c.err('$.axes', 'is required')
    elif c.lst(axes, '$.axes'):
        for i, axis in enumerate(axes):
            if c.obj(axis, f'$.axes[{i}]'):
                c.text(axis, 'key', f'$.axes[{i}]')
                c.text(axis, 'label', f'$.axes[{i}]')
        axis_keys = c.unique(axes, 'key', '$.axes')

    metrics = doc.get('metrics')
    metric_kind = {}
    if metrics is None:
        c.err('$.metrics', 'is required')
    elif c.lst(metrics, '$.metrics', nonempty=True):
        primaries, roles = 0, {}
        for i, metric in enumerate(metrics):
            path = f'$.metrics[{i}]'
            if not c.obj(metric, path):
                continue
            key = c.text(metric, 'key', path)
            c.text(metric, 'label', path)
            kind = metric.get('kind')
            if kind not in KINDS:
                c.err(f'{path}.kind', f'unknown kind {kind!r}; expected one of {", ".join(KINDS)}')
            if metric.get('better') not in BETTER:
                c.err(f'{path}.better', 'must be "higher" or "lower"')
            if 'primary' in metric and not isinstance(metric['primary'], bool):
                c.err(f'{path}.primary', 'must be true or false')
            if metric.get('primary') is True:
                primaries += 1
            if 'estimated' in metric and not isinstance(metric['estimated'], bool):
                c.err(f'{path}.estimated', 'must be true or false')
            role = metric.get('role')
            if role is not None:
                if role not in ROLES:
                    c.err(f'{path}.role', f'unknown role {role!r}; expected cost or latency')
                elif role in roles:
                    c.err(f'{path}.role', f'role {role!r} is already on metric {roles[role]!r}')
                else:
                    roles[role] = key
            if key is not None and kind in KINDS:
                metric_kind[key] = kind
        c.unique(metrics, 'key', '$.metrics')
        if primaries != 1:
            c.err('$.metrics', f'exactly one metric must have primary: true, found {primaries}')

    bands = doc.get('bands')
    if bands is not None and c.lst(bands, '$.bands'):
        for i, band in enumerate(bands):
            path = f'$.bands[{i}]'
            if c.obj(band, path):
                c.text(band, 'key', path)
                c.text(band, 'label', path, required=False)
                band_metric = band.get('band_metric')
                if band_metric is not None and band_metric not in metric_kind:
                    c.err(f'{path}.band_metric', f'unknown metric {band_metric!r}')
        c.unique(bands, 'key', '$.bands')

    statuses = doc.get('item_statuses')
    if statuses is not None and c.lst(statuses, '$.item_statuses'):
        for i, status in enumerate(statuses):
            path = f'$.item_statuses[{i}]'
            if c.obj(status, path):
                c.text(status, 'key', path)
                c.text(status, 'label', path, required=False)
                if status.get('color') not in STATUS_COLORS:
                    c.err(f'{path}.color', f'must be one of {", ".join(STATUS_COLORS)}')
        c.unique(statuses, 'key', '$.item_statuses')

    configs = doc.get('configs')
    config_ids = set()
    if configs is None:
        c.err('$.configs', 'is required')
    elif c.lst(configs, '$.configs'):
        for i, config in enumerate(configs):
            path = f'$.configs[{i}]'
            if not c.obj(config, path):
                continue
            c.text(config, 'id', path)
            c.text(config, 'label', path)
            values = config.get('axes')
            if values is None:
                c.err(f'{path}.axes', 'is required')
            elif c.obj(values, f'{path}.axes'):
                for name, value in values.items():
                    if name not in axis_keys:
                        c.err(f'{path}.axes.{name}', 'is not a declared axis')
                    elif value is not None and not isinstance(value, str):
                        c.err(f'{path}.axes.{name}', 'must be a string or null')
        config_ids = c.unique(configs, 'id', '$.configs')

    cases = doc.get('cases')
    case_ids = set()
    if cases is None:
        c.err('$.cases', 'is required')
    elif c.lst(cases, '$.cases'):
        for i, case in enumerate(cases):
            path = f'$.cases[{i}]'
            if not c.obj(case, path):
                continue
            c.text(case, 'id', path)
            c.text(case, 'title', path)
            c.text(case, 'band', path, required=False, nullable=True)
            tags = case.get('tags', [])
            if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
                c.err(f'{path}.tags', 'must be a list of strings')
        case_ids = c.unique(cases, 'id', '$.cases')

    trials = doc.get('trials')
    if trials is None:
        c.err('$.trials', 'is required')
    elif c.lst(trials, '$.trials'):
        seen, tokens = set(), set()
        for i, trial in enumerate(trials):
            path = f'$.trials[{i}]'
            if not c.obj(trial, path):
                continue
            case_id = c.text(trial, 'case_id', path)
            config_id = c.text(trial, 'config_id', path)
            if case_id is not None and case_id not in case_ids:
                c.err(f'{path}.case_id', f'unknown case {case_id!r}')
            if config_id is not None and config_id not in config_ids:
                c.err(f'{path}.config_id', f'unknown config {config_id!r}')
            number = trial.get('trial')
            if not isinstance(number, int) or isinstance(number, bool) or number < 1:
                c.err(f'{path}.trial', 'must be an integer of 1 or more')
            elif (case_id, config_id, number) in seen:
                c.err(path, f'duplicate trial {number} for case {case_id!r} and config {config_id!r}')
            else:
                seen.add((case_id, config_id, number))
            token = trial.get('token')
            if not isinstance(token, str) or not TOKEN.match(token) or token in ('.', '..'):
                c.err(f'{path}.token', 'must be one path component of letters, digits, ".", "_" or "-"')
            elif token in tokens:
                c.err(f'{path}.token', f'duplicate token {token!r}')
            else:
                tokens.add(token)
            if trial.get('outcome') not in OUTCOMES:
                c.err(f'{path}.outcome', f'unknown outcome {trial.get("outcome")!r}; expected one of {", ".join(OUTCOMES)}')
            if 'reason' not in trial:
                c.err(f'{path}.reason', 'is required (null when there is none)')
            elif trial['reason'] is not None and not isinstance(trial['reason'], str):
                c.err(f'{path}.reason', 'must be a string or null')
            values = trial.get('metrics')
            if values is None:
                c.err(f'{path}.metrics', 'is required')
            elif c.obj(values, f'{path}.metrics'):
                for key, value in values.items():
                    if key not in metric_kind:
                        c.err(f'{path}.metrics.{key}', 'is not a declared metric')
                    elif value is None:
                        continue
                    elif not is_number(value):
                        c.err(f'{path}.metrics.{key}', 'must be a finite number or null')
                    elif metric_kind[key] == 'rate' and not 0 <= value <= 1:
                        c.err(f'{path}.metrics.{key}', f'rate {value} is outside 0 to 1')
                    elif metric_kind[key] in ('count', 'cost', 'duration') and value < 0:
                        c.err(f'{path}.metrics.{key}', f'{metric_kind[key]} {value} is negative')
            usage = trial.get('usage')
            if usage is not None and c.obj(usage, f'{path}.usage'):
                for key, value in usage.items():
                    if value is not None and not is_number(value):
                        c.err(f'{path}.usage.{key}', 'must be a finite number or null')
            items = trial.get('items')
            if items is not None and c.lst(items, f'{path}.items'):
                for j, item in enumerate(items):
                    ipath = f'{path}.items[{j}]'
                    if c.obj(item, ipath):
                        c.text(item, 'id', ipath)
                        c.text(item, 'label', ipath)
                        c.text(item, 'status', ipath)
                c.unique(items, 'id', f'{path}.items')
    return c.errors


def results_path(target):
    target = Path(target)
    return target / 'results.json' if target.is_dir() else target


def load(target):
    """Read and check one results file (or a run dir); raise CheckError with every problem."""
    path = results_path(target)
    try:
        doc = parse(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise CheckError([f'{path}: {exc}']) from exc
    errors = check(doc)
    if errors:
        raise CheckError([f'{path}: {e}' for e in errors])
    return doc


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] in ('-h', '--help'):
        print(__doc__.strip())
        return 0 if argv else 2
    failed = 0
    for target in argv:
        try:
            load(target)
            print(f'ok {results_path(target)}')
        except CheckError as exc:
            failed += 1
            for line in exc.errors:
                print(line, file=sys.stderr)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
