"""One-time: draft review eval cases from a blind harness-review replay.

    python3 evals/review/seed_from_replay.py <replay dir> --cases <cases dir> --report <report.json> [--added YYYY-MM-DD]

Reads manifest.json, blind/, pool-key/ and verdicts/ from the replay. In each slice, findings that the verifier put in
one duplicate group name one defect. A group with a REAL verdict becomes one expected finding, whichever review raised
it (the bork reviewer, the low or the medium harness review). So a slice is a `clean` case only when no review in the
replay found a REAL defect and it has no recorded escape.

The answers are drafts: the bork reviewer's title when it raised the defect, else the first sentence of the claim.
Matt reads and corrects each one before the cases are committed. The report holds what the cases leave out (every
claim, its verdict and the verifier's evidence, NOT_REAL and UNSURE included) for that review. It is private: it
quotes the reviewed code's behavior. Existing case files are never overwritten.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check_cases  # noqa: E402
import repos  # noqa: E402

SEVERITY = {'critical': 'IMPORTANT', 'high': 'IMPORTANT', 'important': 'IMPORTANT', 'serious': 'IMPORTANT',
            'medium': 'IMPORTANT', 'nit': 'NIT', 'minor': 'NIT', 'low': 'NIT', 'informational': 'NIT', 'info': 'NIT',
            'pre-existing': 'PRE-EXISTING'}
RANK = {'IMPORTANT': 0, 'PRE-EXISTING': 1, 'NIT': 2}
LANG = {'.php': 'php', '.js': 'js', '.mjs': 'js', '.ts': 'ts', '.tsx': 'ts', '.py': 'python', '.rb': 'ruby',
        '.md': 'markdown', '.sh': 'shell', '.json': 'json', '.sql': 'sql', '.css': 'css', '.scss': 'css'}
REPO_ROOT = HERE.parent.parent


def same_path(a, b):
    """True when one path ends with the other's whole segments: lib/x.py matches x.py, lib/index.py does not."""
    pa, pb = Path(a).parts, Path(b).parts
    short, long = (pa, pb) if len(pa) <= len(pb) else (pb, pa)
    return bool(short) and long[-len(short):] == short


def inside_repo(path):
    try:
        Path(path).resolve().relative_to(REPO_ROOT)
        return True
    except ValueError:
        return False


EVIDENCE_LOC = re.compile(r'^\s*`?([^\s:`]+):(\d+(?:-\d+)?(?:, ?\d+(?:-\d+)?)*)')


def severity_of(raw):
    """The skill label for a review's own severity: the first word decides, so "CRITICAL (major)" is IMPORTANT."""
    word = re.split(r'[\s(:]', str(raw or '').strip().lower(), maxsplit=1)[0].replace('_', '-')
    return SEVERITY.get(word)


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def groups_for(key, verdicts):
    """Duplicate groups, as score.py builds them: the verifier's groups, then every ungrouped finding on its own."""
    groups, seen = [], set()
    for g in verdicts.get('duplicate_groups', []):
        g = [f for f in g if f in key]
        if g:
            groups.append(g)
            seen |= set(g)
    return groups + [[f] for f in key if f not in seen]


def first_sentence(text):
    text = ' '.join(text.replace('```', '`').split())
    m = re.match(r'(.+?[.!?])(\s|$)', text)
    sentence = m.group(1) if m else text
    return sentence if len(sentence) <= check_cases.ANSWER_MAX else sentence[:check_cases.ANSWER_MAX - 1].rstrip() + '…'


def location(fid, verdict_by_fid, claim_by_fid, slice_, key):
    """(file, lines) at head: the verifier's evidence first, then the bork finding, then the review's own ref."""
    file = claim_by_fid[fid].get('file')
    m = EVIDENCE_LOC.match(verdict_by_fid.get(fid, {}).get('evidence', ''))
    if m and (file is None or same_path(m.group(1), file)):
        return (file or m.group(1)), m.group(2).replace(' ', '')
    ref = str(key[fid].get('original_ref') or '')
    if key[fid]['source'] == 'bork':
        bork = next((f for f in slice_['reviewer_findings'] if str(f['n']) == str(ref)), None)
        if bork and bork.get('line') and check_cases.LINES.match(str(bork['line'])):
            return file or bork['file'], str(bork['line'])
    m = re.search(r':(\d+(?:-\d+)?)\)?$', ref)
    return file, (m.group(1) if m else None)


def draft_slice(replay, slice_, added, identity):
    sid = slice_['id']
    key = read(replay / 'pool-key' / f'{sid}.json')
    verdicts = read(replay / 'verdicts' / f'{sid}.json')
    verdict_by_fid = {v['fid']: v for v in verdicts['verdicts']}
    claim_by_fid = {c['fid']: c for c in read(replay / 'blind' / f'{sid}.json')}
    bork_by_ref = {str(f['n']): f for f in slice_['reviewer_findings']}

    def order(group):
        bork = [int(key[f]['original_ref']) for f in group if key[f]['source'] == 'bork' and str(key[f]['original_ref']).isdigit()]
        return (0, min(bork)) if bork else (1, claim_by_fid[group[0]].get('file') or '', group[0])

    findings, report_groups, flags = [], [], []
    for group in sorted(groups_for(key, verdicts), key=order):
        verdict_set = {verdict_by_fid.get(f, {}).get('verdict', 'MISSING') for f in group}
        members = [{'fid': f, 'source': key[f]['source'], 'original_ref': key[f].get('original_ref'),
                    'original_severity': key[f].get('original_severity'),
                    'verdict': verdict_by_fid.get(f, {}).get('verdict', 'MISSING'),
                    'file': claim_by_fid[f].get('file'), 'claim': claim_by_fid[f].get('claim'),
                    'evidence': verdict_by_fid.get(f, {}).get('evidence')} for f in group]
        entry = {'verdict': 'REAL' if 'REAL' in verdict_set else ('UNSURE' if verdict_set & {'UNSURE', 'MISSING'} else 'NOT_REAL'),
                 'mixed': len(verdict_set) > 1, 'members': members, 'finding_id': None}
        report_groups.append(entry)
        if entry['verdict'] != 'REAL':
            continue
        real = [f for f in group if verdict_by_fid.get(f, {}).get('verdict') == 'REAL']
        rep = next((f for f in real if key[f]['source'] == 'bork'), real[0])
        file, lines = location(rep, verdict_by_fid, claim_by_fid, slice_, key)
        severities = [severity_of(key[f].get('original_severity')) for f in group]
        known = [s for s in severities if s]
        severity = min(known, key=RANK.get) if known else 'IMPORTANT'
        if not known:
            flags.append(f'{rep}: no known severity in {[key[f].get("original_severity") for f in group]}; drafted IMPORTANT')
        bork = bork_by_ref.get(str(key[rep].get('original_ref'))) if key[rep]['source'] == 'bork' else None
        answer = first_sentence((bork or {}).get('title') or claim_by_fid[rep].get('claim') or '')
        fid = f'F{len(findings) + 1}'
        entry['finding_id'] = fid
        if not lines:
            flags.append(f'{fid} ({rep}): no line numbers found; set "lines" by hand')
        finding = {'id': fid, 'file': file, 'lines': lines or '1', 'severity': severity, 'answer': answer}
        findings.append(finding)

    escapes = slice_.get('escapes') or []
    kind = 'bug' if findings else 'clean'
    if kind == 'clean' and escapes:
        # A defect escaped this change, so it is not clean, but the replay has no sentence for it. Write no case;
        # a person writes this one by hand.
        flags.append(f'{len(escapes)} recorded escape(s) but no REAL replay finding: no case written; write its expected findings by hand')
        report = {'id': sid, 'kind': None, 'bork_verdict': slice_.get('reviewer_verdict'), 'notes': slice_.get('notes'),
                  'escapes': escapes, 'flags': flags, 'groups': report_groups}
        return None, report
    if any(g['mixed'] for g in report_groups):
        flags.append('a duplicate group has members with different verdicts; check that the group names one defect')
    verdict = 'DO NOT LAND' if any(f['severity'] == 'IMPORTANT' for f in findings) else ('SAFE TO LAND' if kind == 'clean' else None)
    langs = sorted({LANG[Path(f['file']).suffix] for f in findings if Path(f['file']).suffix in LANG})
    case = {
        'id': sid,
        'title': sid.replace('-', ' '),
        'skill': 'review',
        'repo': {'identity': identity},
        'base': slice_['base'],
        'head': slice_['head'],
        'kind': kind,
        'expected_verdict': verdict,
        'expected_findings': findings,
        'provenance': {
            'replay': replay.name,
            'slice': sid,
            'review_run': Path(slice_['run_dir']).name if slice_.get('run_dir') else 'unknown',
            'review_date': slice_.get('review_date') or 'unknown',
            'findings': [f"{g['finding_id']}: " + ', '.join(f"{m['fid']} ({m['source']} {m['original_ref']})" for m in g['members'])
                         for g in report_groups if g['finding_id']],
        },
        'added': added,
        'tags': [slice_['repo'], 'replay-2026-11-19'] + langs,
    }
    if verdict is None:
        del case['expected_verdict']
    report = {'id': sid, 'kind': kind, 'bork_verdict': slice_.get('reviewer_verdict'), 'notes': slice_.get('notes'),
              'escapes': escapes, 'flags': flags, 'groups': report_groups}
    return case, report


def main(argv=None):
    parser = argparse.ArgumentParser(description='Draft review eval cases from a harness-review replay.')
    parser.add_argument('replay', type=Path)
    parser.add_argument('--cases', type=Path, required=True, help='directory for the draft case files')
    parser.add_argument('--report', type=Path, required=True, help='private JSON with every claim and verdict, for review')
    parser.add_argument('--added', default=datetime.date.today().isoformat())
    args = parser.parse_args(argv)

    for target in (args.cases, args.report):
        if inside_repo(target):
            raise SystemExit(f'refusing to write {target} inside the public skills repo: cases and the report are private')
    manifest = read(args.replay / 'manifest.json')
    identities = {}
    cases, reports = [], []
    for slice_ in manifest:
        checkout = slice_['checkout']
        if checkout not in identities:
            identities[checkout] = repos.identity_of(checkout)
        case, report = draft_slice(args.replay, slice_, args.added, identities[checkout])
        reports.append(report)
        if case is None:
            continue
        errors = check_cases.check(case, case['id'])
        if errors:
            raise SystemExit(f'{case["id"]}: the draft fails the case check:\n' + '\n'.join(errors))
        cases.append(case)

    args.cases.mkdir(parents=True, exist_ok=True)
    existing = [c['id'] for c in cases if (args.cases / f"{c['id']}.json").exists()]
    if existing:
        raise SystemExit(f'refusing to overwrite existing cases: {", ".join(existing)}')
    for case in cases:
        # 'x' fails if the file appeared since the check above: a case is never overwritten.
        with open(args.cases / f"{case['id']}.json", 'x', encoding='utf-8') as handle:
            handle.write(json.dumps(case, indent=2, ensure_ascii=False) + '\n')
    args.report.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(args.report, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps({'replay': str(args.replay), 'cases': cases, 'slices': reports}, indent=1, ensure_ascii=False) + '\n')
    by_id = {c['id']: c for c in cases}
    for report in reports:
        case = by_id.get(report['id'])
        status = f"{case['kind']}, {len(case['expected_findings'])} expected" if case else 'no case written'
        print(f"{report['id']}: {status}" + (f"; {len(report['flags'])} flag(s)" if report['flags'] else ''))
    print(f'repos: {", ".join(sorted(set(identities.values())))}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
