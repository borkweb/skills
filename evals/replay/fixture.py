"""Build the synthetic fixture: a tiny case repo, a tiny skills repo and one case file. Nothing is committed."""
import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import caselib

HERE = Path(__file__).resolve().parent
TEMPLATE_PATH = 'skills/core/offload/builder-template.md'


def make_repo(path, files, message='base'):
    path.mkdir(parents=True)
    caselib.git(path, 'init', '-q')
    for name, text in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    caselib.git(path, 'add', '-A')
    caselib.git(path, 'commit', '-q', '-m', message)
    return caselib.git(path, 'rev-parse', 'HEAD')


def build(root, gates=('echo GATE-OK-STRING', 'pwd'), criteria=None, missing_commit=False, setup_commands=(),
          template=None, case_id='synthetic', reviewed=True):
    """Create <root>/{repo,skills-revised,cases}. `{repo}` in a gate or setup command is the repo path.
    missing_commit makes the case name a commit that exists only in a second repo."""
    root = Path(root)
    repo = root / 'repo'
    base = make_repo(repo, {'app.txt': 'one\n'})
    case = json.loads((HERE / 'fixtures' / 'synthetic-case.json').read_text())
    if missing_commit:
        elsewhere = root / 'remote'
        base = make_repo(elsewhere, {'other.txt': 'elsewhere\n'}, message='only in the remote')
        caselib.git(repo, 'remote', 'add', 'origin', str(elsewhere))
    skills = root / 'skills-revised'
    make_repo(skills, {TEMPLATE_PATH: template if template is not None
                       else (HERE / 'fixtures' / 'revised-template.md').read_text()}, message='revised template')
    commands = [g.format(repo=repo) for g in gates]
    case['id'] = case_id
    case['repo']['path'] = str(repo)
    case['base_commit'] = base
    case['gate_commands'] = commands
    if reviewed:
        case['gate_commands_reviewed'] = True
    else:
        case.pop('gate_commands_reviewed', None)
    case['gates_text'] = 'Gates (run once after the last edit):\n' + ''.join(f'- G{i} `{c}`\n' for i, c in enumerate(commands, 1)).rstrip('\n')
    if setup_commands:
        case['setup_commands'] = [c.format(repo=repo) for c in setup_commands]
    if criteria is not None:
        case['criteria'] = criteria
    cases = root / 'cases'
    cases.mkdir()
    path = cases / f'{case_id}.json'
    path.write_text(json.dumps(case, indent=2) + '\n')
    return SimpleNamespace(root=root, repo=repo, base=base, skills_repo=skills, cases_dir=cases, case_path=path,
                           case=case)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', help='a directory that does not exist yet')
    print(build(parser.parse_args().root).case_path)


if __name__ == '__main__':
    main()
