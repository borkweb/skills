"""The repos map: a case names its repo by a normalized origin URL, and each computer maps that to a checkout.

    python3 evals/review/repos.py add <checkout> [...]    record each checkout under its origin identity
    python3 evals/review/repos.py list                    print the map

The map is the `repos` object in $BORKWEB_SKILLS_CONFIG or ~/.borkweb-skills/config.json, so a case never holds a
local path. Every other key in the config file is kept. Nothing here fetches from the network.
"""
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'replay'))
import caselib  # noqa: E402


class RepoError(ValueError):
    pass


def config_path():
    return Path(os.environ.get('BORKWEB_SKILLS_CONFIG') or Path.home() / '.borkweb-skills' / 'config.json')


def normalize_identity(url):
    """host/owner/repo, lower-case host, no scheme, user, port, trailing .git or slash.

    git@github.com:Org/Repo.git, ssh://git@github.com:22/Org/Repo and https://github.com/Org/Repo/ all give
    github.com/Org/Repo. Owner and repo keep their case: some hosts treat them as case-sensitive.
    """
    url = url.strip()
    bare = re.match(r'^([a-z0-9.-]+\.[a-z]{2,})/(.+)$', url, re.I)
    if bare and '://' not in url and '@' not in url:
        host, path = bare.group(1), bare.group(2).strip('/')
        path = path[:-4] if path.endswith('.git') else path
        if '..' in path.split('/') or not path:
            raise RepoError(f'cannot read a host and path from {url!r}')
        return f'{host.lower()}/{path}'
    scp = re.match(r'^(?:[^@/]+@)?([^:/]+):(?!//)(.+)$', url)
    if scp and '://' not in url:
        host, path = scp.group(1), scp.group(2)
    else:
        m = re.match(r'^[a-z][a-z0-9+.-]*://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+)$', url, re.I)
        if not m:
            raise RepoError(f'cannot read a host and path from {url!r}')
        host, path = m.group(1), m.group(2)
    path = path.strip('/')
    if path.endswith('.git'):
        path = path[:-4]
    if not host or not path or '..' in path.split('/'):
        raise RepoError(f'cannot read a host and path from {url!r}')
    return f'{host.lower()}/{path}'


def identity_of(checkout):
    return normalize_identity(caselib.git(checkout, 'remote', 'get-url', 'origin'))


def load_config(path=None):
    path = path or config_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except ValueError as exc:
        raise RepoError(f'{path} is not valid JSON: {exc}') from exc
    if not isinstance(data, dict):
        raise RepoError(f'{path} must hold a JSON object')
    return data


def repos_map(path=None):
    repos = load_config(path).get('repos', {})
    if not isinstance(repos, dict):
        raise RepoError('config "repos" must be an object of identity -> checkout path')
    return repos


def resolve(identity, path=None):
    """The checkout for an identity. Raises RepoError when it is unmapped, missing, or its origin moved."""
    checkout = repos_map(path).get(identity)
    if not checkout:
        raise RepoError(f'no checkout for {identity}: run `python3 evals/review/repos.py add <checkout>`')
    checkout = Path(checkout).expanduser()
    if not (checkout / '.git').exists():
        raise RepoError(f'{identity} maps to {checkout}, which is not a git checkout')
    found = identity_of(checkout)
    if found != identity:
        raise RepoError(f'{checkout} has origin {found}, not {identity}')
    return checkout


def add(checkouts, path=None):
    """Record each checkout under its origin identity; write the config back with every other key kept."""
    path = path or config_path()
    data = load_config(path)
    repos = data.setdefault('repos', {})
    if not isinstance(repos, dict):
        raise RepoError(f'{path}: "repos" must be an object of identity -> checkout path')
    added = {}
    for checkout in checkouts:
        checkout = Path(checkout).expanduser().resolve()
        identity = identity_of(checkout)
        repos[identity] = str(checkout)
        added[identity] = str(checkout)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, path)
    return added


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['add'] and len(argv) > 1:
        for identity, checkout in add(argv[1:]).items():
            print(f'{identity} -> {checkout}')
        return 0
    if argv == ['list']:
        for identity, checkout in sorted(repos_map().items()):
            print(f'{identity} -> {checkout}')
        return 0
    print(__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
