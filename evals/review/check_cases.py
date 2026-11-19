"""Check review eval cases.

    python3 evals/review/check_cases.py <cases dir | case.json> [...] [--resolve]

A case is a pointer, never code: a repo identity, two commits, and one sentence for each known defect. The format is
in docs/superpowers/specs/2026-11-19-eval-report-and-review-eval-design.md ("Case format"). With --resolve, the
checker also finds each repo through the repos map (repos.py) and checks that both commits are in the checkout.
Exit 0 when every case passes.
"""
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import repos  # noqa: E402

SKILLS = {
    'review': {'severities': ('IMPORTANT', 'NIT', 'PRE-EXISTING'),
               'verdicts': ('SAFE TO LAND', 'LAND WITH CAUTION', 'DO NOT LAND')},
    'review-security': {'severities': ('CRITICAL', 'HIGH', 'INFORMATIONAL'),
                        'verdicts': ('PASS', 'PASS WITH REMEDIATIONS', 'INCOMPLETE', 'FAIL')},
}
KINDS = ('bug', 'clean')
FIELDS = {'id', 'title', 'skill', 'repo', 'base', 'head', 'kind', 'expected_verdict', 'expected_findings',
          'provenance', 'added', 'tags'}
FINDING_FIELDS = {'id', 'file', 'lines', 'severity', 'answer'}
SHA = re.compile(r'^[0-9a-f]{40}$')
CASE_ID = re.compile(r'^[a-z0-9][a-z0-9-]{0,79}$')
FINDING_ID = re.compile(r'^[A-Z][A-Z0-9-]{0,15}$')
LINES = re.compile(r'^[1-9][0-9]*(-[1-9][0-9]*)?(, ?[1-9][0-9]*(-[1-9][0-9]*)?)*$')
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ANSWER_MAX = 400


def check(case, stem=None):
    """Return a list of error strings for one case dict; empty means it passes."""
    errors = []

    def err(path, message):
        errors.append(f'{path}: {message}')

    if not isinstance(case, dict):
        return ['$: must be an object']
    for key in sorted(set(case) - FIELDS):
        err(f'$.{key}', 'is not a case field (a case holds pointers and one-sentence answers, never code)')
    for key in ('id', 'title', 'skill', 'repo', 'base', 'head', 'kind', 'expected_findings', 'provenance', 'added'):
        if key not in case:
            err(f'$.{key}', 'is required')

    cid = case.get('id')
    if 'id' in case and (not isinstance(cid, str) or not CASE_ID.match(cid)):
        err('$.id', 'must be lower-case letters, digits and hyphens')
    elif stem is not None and cid != stem:
        err('$.id', f'must match the file name {stem!r}')
    if 'title' in case and (not isinstance(case['title'], str) or not case['title'].strip() or '\n' in case['title']):
        err('$.title', 'must be one line of text')

    skill = case.get('skill')
    rules = SKILLS.get(skill)
    if 'skill' in case and rules is None:
        err('$.skill', f'must be one of {", ".join(SKILLS)}')

    repo = case.get('repo')
    if 'repo' in case:
        if not isinstance(repo, dict) or set(repo) != {'identity'} or not isinstance(repo.get('identity'), str):
            err('$.repo', 'must be {"identity": "<normalized origin URL>"} and nothing else (no local path)')
        else:
            try:
                if repos.normalize_identity(repo['identity']) != repo['identity']:
                    err('$.repo.identity', f'is not normalized; use {repos.normalize_identity(repo["identity"])!r}')
            except repos.RepoError as exc:
                err('$.repo.identity', str(exc))

    for key in ('base', 'head'):
        if key in case and (not isinstance(case[key], str) or not SHA.match(case[key])):
            err(f'$.{key}', 'must be a full 40-character commit ID')
    if case.get('base') and case.get('base') == case.get('head'):
        err('$.head', 'must differ from base')

    kind = case.get('kind')
    if 'kind' in case and kind not in KINDS:
        err('$.kind', 'must be "bug" or "clean"')

    verdict = case.get('expected_verdict')
    if verdict is not None and rules and verdict not in rules['verdicts']:
        err('$.expected_verdict', f'must be one of {", ".join(rules["verdicts"])} for {skill}')

    findings = case.get('expected_findings')
    if 'expected_findings' in case:
        if not isinstance(findings, list):
            err('$.expected_findings', 'must be a list')
            findings = []
        if kind == 'bug' and not findings:
            err('$.expected_findings', 'a bug case needs at least one expected finding')
        if kind == 'clean' and findings:
            err('$.expected_findings', 'a clean case has no expected findings')
        seen = set()
        for i, f in enumerate(findings):
            path = f'$.expected_findings[{i}]'
            if not isinstance(f, dict):
                err(path, 'must be an object')
                continue
            for key in sorted(set(f) - FINDING_FIELDS):
                err(f'{path}.{key}', 'is not a finding field')
            for key in sorted(FINDING_FIELDS - set(f)):
                err(f'{path}.{key}', 'is required')
            fid = f.get('id')
            if 'id' in f and (not isinstance(fid, str) or not FINDING_ID.match(fid)):
                err(f'{path}.id', 'must look like F1')
                fid = None
            elif fid in seen:
                err(f'{path}.id', f'duplicate {fid!r}')
            seen.add(fid)
            fpath = f.get('file')
            if 'file' in f and (not isinstance(fpath, str) or not fpath or fpath.startswith('/') or '..' in fpath.split('/')):
                err(f'{path}.file', 'must be a path relative to the repo root')
            if 'lines' in f and (not isinstance(f['lines'], str) or not LINES.match(f['lines'])):
                err(f'{path}.lines', 'must be line numbers at head, like "154", "153-164" or "12, 40-41"')
            if 'severity' in f and rules and f['severity'] not in rules['severities']:
                err(f'{path}.severity', f'must be one of {", ".join(rules["severities"])} for {skill}')
            answer = f.get('answer')
            if 'answer' in f:
                if not isinstance(answer, str) or not answer.strip():
                    err(f'{path}.answer', 'must be one sentence')
                elif '\n' in answer or '```' in answer or len(answer) > ANSWER_MAX:
                    err(f'{path}.answer', f'must be one sentence of at most {ANSWER_MAX} characters, no code block')

    provenance = case.get('provenance')
    if 'provenance' in case and not (isinstance(provenance, dict) and provenance and
                                     all(isinstance(k, str) and isinstance(v, (str, int, list)) for k, v in provenance.items())):
        err('$.provenance', 'must be a non-empty object that says where the case came from')
    if 'added' in case and (not isinstance(case['added'], str) or not DATE.match(case['added'])):
        err('$.added', 'must be a date, YYYY-MM-DD')
    tags = case.get('tags', [])
    if not isinstance(tags, list) or not all(isinstance(t, str) and t and t == t.strip() for t in tags):
        err('$.tags', 'must be a list of non-empty strings')
    return errors


def resolve_errors(case, config=None):
    """Find the case's repo through the repos map and check that both commits are there."""
    try:
        checkout = repos.resolve(case['repo']['identity'], config)
    except repos.RepoError as exc:
        return [f'$.repo: {exc}']
    errors = []
    for key in ('base', 'head'):
        run = repos.caselib.git(checkout, 'cat-file', '-e', f'{case[key]}^{{commit}}', check=False)
        if run.returncode != 0:
            errors.append(f'$.{key}: commit {case[key][:12]} is not in {checkout}')
    return errors


def case_files(targets):
    for target in targets:
        target = Path(target)
        if target.is_dir():
            yield from sorted(target.glob('*.json'))
        else:
            yield target


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    resolve = '--resolve' in argv
    targets = [a for a in argv if a != '--resolve']
    if not targets or targets[0] in ('-h', '--help'):
        print(__doc__.strip())
        return 0 if targets else 2
    failed = checked = 0
    ids = {}
    for path in case_files(targets):
        checked += 1
        try:
            case = load(path)
        except (OSError, ValueError) as exc:
            failed += 1
            print(f'{path}: {exc}', file=sys.stderr)
            continue
        errors = check(case, path.stem)
        if not errors and resolve:
            errors = resolve_errors(case)
        cid = case.get('id') if isinstance(case, dict) else None
        if isinstance(cid, str):
            if cid in ids:
                errors.append(f'$.id: duplicate of {ids[cid]}')
            ids.setdefault(cid, path)
        if errors:
            failed += 1
            for e in errors:
                print(f'{path}: {e}', file=sys.stderr)
    print(f'{checked - failed} of {checked} cases pass')
    return 1 if failed or not checked else 0


if __name__ == '__main__':
    sys.exit(main())
