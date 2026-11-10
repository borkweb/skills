#!/usr/bin/env python3
"""Turn named-criterion rejections into replay case files. Read-only on every source.

Candidates come from the offload ledgers on disk (`named C<n>` in a review-only verdict). Each candidate's run dir
(the ledger's run_dir) supplies the frozen criteria (spec-review-S<id>.md), the gates (brief-S<id>.md or
block-S<id>.md) and the base commit. A source that lacks a base commit or frozen criteria builds no case; the
summary says why. Cases go to a mode 700 directory outside any git work tree.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import caselib  # noqa: E402

ID = r'C\d+(?:\.\d+)?[a-z]?'
NAMED = re.compile(rf'(?<![A-Za-z])named\s+({ID}(?:\s*[,/&]\s*{ID})*)')
ROUND = re.compile(r'\br(\d+)\b')
HEAD_BEFORE = re.compile(r'HEAD before this round:\s*([0-9a-f]{7,40})\b')
BASE_SHA = re.compile(r'(?:\bbase:\s*|@\s*)([0-9a-f]{7,40})\b')
BACKTICKED = re.compile(r'`([^`\n]+)`')


def read(path):
    try:
        return Path(path).read_text()
    except OSError:
        return None


def named_ids(verdict):
    return [i for m in NAMED.finditer(verdict) for i in re.findall(ID, m.group(1))]


def candidates(ledger):
    """(slice, verdict, round) for every review-only verdict that names a criterion."""
    for item in ledger.get('slices', []):
        verdicts = [h.get('verdict') or '' for h in item.get('history') or [] if h.get('state') == 'rejected']
        if not verdicts and item.get('state') == 'rejected':
            verdicts = [item.get('verdict') or '']
        for verdict in verdicts:
            if named_ids(verdict):
                found = ROUND.search(verdict)
                yield item, verdict, int(found.group(1)) if found else 1


def slice_tags(item):
    tags = [f"S{item.get('id')}"]
    first = (item.get('title') or '').split(' ')[0]
    if re.fullmatch(r'S\w+', first) and first not in tags:
        tags.append(first)
    return tags


def frozen_criteria(run_dir, tags, handoff):
    for tag in tags:
        text = read(Path(run_dir) / f'spec-review-{tag}.md') if run_dir else None
        if text is not None:
            return '\n'.join(contiguous(text))
    text = read(handoff) if handoff else None
    if text and '## Frozen gates' in text:
        section = text.split('## Frozen gates', 1)[1].split('\n## ', 1)[0]
        return '\n'.join(contiguous(section))
    return ''


def contiguous(text):
    """Criterion lines: each line led by an ID, plus the indented lines directly under it."""
    out, open_line = [], False
    for line in text.split('\n'):
        if caselib.line_id(line):
            out.append(line)
            open_line = True
        elif open_line and line[:1] in (' ', '\t') and line.strip():
            out.append(line)
        else:
            open_line = False
    return out


def gates_block(run_dir, tags):
    for tag in tags:
        for name in (f'brief-{tag}.md', f'block-{tag}.md'):
            text = read(Path(run_dir) / name) if run_dir else None
            if text is None:
                continue
            lines = text.split('\n')
            for i, line in enumerate(lines):
                if line.startswith('Gates'):
                    end = i + 1
                    while end < len(lines) and lines[end].strip():
                        end += 1
                    return '\n'.join(lines[i:end])
    return ''


def owned_files(run_dir, tags):
    for tag in tags:
        for name in (f'brief-{tag}.md', f'block-{tag}.md'):
            text = read(Path(run_dir) / name) if run_dir else None
            m = text and re.search(r'^Owned files:\s*(.+?)(?:\.\s+Protected paths:|$)', text, re.M)
            if m:
                return m.group(1).strip()
    return 'not recorded'


def sha_lines(text, source, keep=lambda line: True):
    """(sha, source quoting the matched line) for each `base: <sha>` or `@ <sha>` on a kept line."""
    for line in (text or '').split('\n'):
        if keep(line):
            for m in BASE_SHA.finditer(line):
                yield m.group(1), f'{source}: "{line.strip()[:160]}"'


def names_slice_or_base(line, tags):
    return (re.search(r'\bbase\b', line, re.I) is not None
            or any(re.search(rf'(?<![A-Za-z0-9]){re.escape(t)}(?![A-Za-z0-9])', line) for t in tags))


def base_candidates(run_dir, tags, item, ledger, review_round):
    """(sha, source) in preference order. A corrective's `HEAD before this round` is the output the previous
    review rejected, so it can only be the base for a verdict on a later round. A notes.md line counts only when
    it names the slice or the word base: notes cover every slice of the run."""
    if item.get('base'):
        yield str(item['base']), 'ledger row'
    if ledger.get('base'):
        yield str(ledger['base']), 'ledger'
    if not run_dir:
        return
    run_json = read(Path(run_dir) / 'run.json')
    try:
        base = json.loads(run_json).get('base') if run_json else None
    except (ValueError, AttributeError):
        base = None
    if base:
        yield str(base), 'run.json'
    for tag in tags:
        for name in (f'brief-{tag}.md', f'block-{tag}.md'):
            yield from sha_lines(read(Path(run_dir) / name), name)
    yield from sha_lines(read(Path(run_dir) / 'notes.md'), 'notes.md', lambda line: names_slice_or_base(line, tags))
    if review_round >= 2:
        for tag in tags:
            for name in (f'corrective-{tag}-r{review_round - 1}.md', f'block-{tag}-corrective-r{review_round - 1}.md'):
                for line in (read(Path(run_dir) / name) or '').split('\n'):
                    m = HEAD_BEFORE.search(line)
                    if m:
                        yield m.group(1), f'{name}: "{line.strip()[:160]}"'


def resolve_base(repo, shas):
    for sha, source in shas:
        if not re.fullmatch(r'[0-9a-f]{7,40}', sha) or not Path(repo).is_dir():
            continue
        run = caselib.git(repo, 'rev-parse', '--verify', '--quiet', sha + '^{commit}', check=False)
        if run.returncode == 0 and run.stdout.strip():
            return run.stdout.strip(), source
    return None, None


def repo_identity(repo):
    run = caselib.git(repo, 'remote', 'get-url', 'origin', check=False) if Path(repo).is_dir() else None
    url = run.stdout.strip() if run is not None and run.returncode == 0 else ''
    return re.sub(r'\.git$', '', re.sub(r'^(?:\w+://)?(?:[^@/]+@)?', '', url)).replace(':', '/') or Path(repo).name


def build_one(ledger, stem, item, verdict, review_round, out_dir):
    """Return (case or None, skip reason)."""
    tags = slice_tags(item)
    run_dir = ledger.get('run_dir') or ''
    run_dir = run_dir if run_dir and Path(run_dir).is_dir() else ''
    repo = ledger.get('cwd') or ''
    reasons = []
    base, source = resolve_base(repo, base_candidates(run_dir, tags, item, ledger, review_round))
    if not base:
        reasons.append('no base commit')
    criteria = frozen_criteria(run_dir, tags, item.get('handoff'))
    if not criteria or not caselib.criteria_ids(criteria):
        reasons.append('no frozen criteria')
    gates = gates_block(run_dir, tags)
    if not reasons and not gates:
        reasons.append('no gates')
    if reasons:
        return None, '; '.join(reasons)
    missed = named_ids(verdict)
    # No criterion ID in the id: it reaches file names, and the builder must not learn which ID was missed.
    prefix = re.sub(r'[^A-Za-z0-9._-]', '-', f"{Path(run_dir).name or stem}-{tags[0]}-r{review_round}")
    if any(re.search(rf'(?<![A-Za-z0-9]){re.escape(m)}(?![A-Za-z0-9])', prefix) for m in missed):
        prefix = re.sub(r'[^A-Za-z0-9._-]', '-', f'{tags[0]}-r{review_round}')
    digest = hashlib.sha256(f"{stem}|{tags[0]}|{review_round}|{','.join(missed)}".encode()).hexdigest()[:8]
    case_id = f'{prefix}-{digest}'
    case = {
        'id': case_id,
        'repo': {'identity': repo_identity(repo), 'path': repo},
        'base_commit': base,
        'goal': (item.get('title') or tags[0]).replace('\n', ' '),
        'owned_files': owned_files(run_dir, tags),
        'criteria': criteria,
        'gates_text': gates,
        # Proposed only. The runner runs gate_commands, which a human fills after reading these.
        'gate_command_candidates': BACKTICKED.findall(gates),
        'gate_commands': [],
        'missed_ids': missed,
        'provenance': f'ledger {stem}, slice {item.get("id")}, review round {review_round}; run dir '
                      f'{Path(run_dir).name}; base from {source}'}
    try:
        caselib.validate_case(case, case_id)
    except caselib.CaseError as error:
        return None, str(error).split(': ', 1)[-1]
    return case, None


def prepare_out(out):
    try:
        return caselib.private_dir(out)
    except ValueError as error:
        raise SystemExit(f'refusing: {error}')


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    store = caselib.store_dir()
    p.add_argument('--ledgers', default=str(store / 'offload'), help='directory of *.ledger.json files')
    p.add_argument('--out', default=str(store / 'replay-cases'))
    args = p.parse_args(argv)
    out = prepare_out(args.out)
    seen = built = 0
    skipped = {}
    for path in sorted(Path(args.ledgers).glob('*.ledger.json')):
        try:
            ledger = json.loads(path.read_text())
        except (OSError, ValueError):
            print(f'skipped {path.name}: unreadable ledger')
            continue
        stem = path.name[:-len('.ledger.json')]
        for item, verdict, review_round in candidates(ledger):
            seen += 1
            label = f'{stem}/S{item.get("id")} r{review_round}'
            case, reason = build_one(ledger, stem, item, verdict, review_round, out)
            if case is not None:
                target = out / f"{case['id']}.json"
                try:
                    with target.open('x') as handle:
                        os.fchmod(handle.fileno(), 0o600)
                        json.dump(case, handle, indent=2)
                        handle.write('\n')
                except FileExistsError:
                    case, reason = None, 'case file exists'
            if case is not None:
                built += 1
                print(f"built {case['id']} from {label}")
            else:
                first = reason.split('; ')[0]
                key = first if first in ('no base commit', 'no frozen criteria', 'no gates', 'case file exists') else 'invalid case'
                skipped[key] = skipped.get(key, 0) + 1
                print(f'skipped {label}: {reason}')
    print(f'summary: seen={seen} built={built} skipped={seen - built}')
    for reason, count in sorted(skipped.items()):
        print(f'skipped[{reason}]={count}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
