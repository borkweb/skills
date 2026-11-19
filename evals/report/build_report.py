"""Build the local HTML report for one eval run, and the index page across runs.

    python3 evals/report/build_report.py <run dir> [<run dir> ...] [--index <runs root>]

For each run dir, reads results.json (bork-eval-results/1; see check_results.py) and the raw files under
trials/<token>/, and writes <run dir>/report.html. With --index, also writes <runs root>/index.html for every run
directory directly under the root. A run dir may be left out when --index is given.

The page is one self-contained file: inline CSS, inline JavaScript and inline SVG, with a Content-Security-Policy
that blocks every network load. The data goes in a <script type="application/json"> block with "<", ">", "&",
U+2028 and U+2029 escaped, so model output that holds "</script>" or HTML stays data. The page writes all text
from the data with textContent. Each file is written with mode 600, because run output can hold private code.
"""
import argparse
import html
import json
import os
from pathlib import Path
import secrets
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check_results  # noqa: E402
import eval_stats  # noqa: E402

ASSETS = HERE / 'assets'
FILE_CAP = 200 * 1024
CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
       "base-uri 'none'; form-action 'none'")

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="{csp}">
<meta name="referrer" content="no-referrer">
<title>{title}</title>
<style>
{css}
</style>
</head>
<body>
<div id="app"><noscript>This report needs JavaScript to draw its tables and charts.</noscript></div>
<script type="application/json" id="report-data">{data}</script>
<script>
{js}
</script>
</body>
</html>
"""


def embed_json(data):
    """JSON that is safe inside a <script> element: no "<", ">" or "&" and no line separators survive raw."""
    text = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    for raw, escaped in (('<', '\\u003c'), ('>', '\\u003e'), ('&', '\\u0026'), (' ', '\\u2028'), (' ', '\\u2029')):
        text = text.replace(raw, escaped)
    return text


def asset(name):
    text = (ASSETS / name).read_text(encoding='utf-8')
    if '</script' in text.lower() or '<!--' in text:
        raise ValueError(f'{name} must not contain "</script" or "<!--"')
    return text


def render_page(title, data, scripts):
    return PAGE.format(csp=CSP, title=html.escape(title), css=asset('page.css'), data=embed_json(data),
                       js='\n'.join(asset(s) for s in scripts))


def write_private(path, text):
    """Write text to path with mode 600 through a temp file and a rename, so a reader never sees half a file."""
    path = Path(path)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp')
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return path


def _inside(path, root):
    try:
        path.resolve(strict=True).relative_to(root)
        return True
    except (OSError, ValueError):
        return False


def trial_files(run_dir, doc):
    """token -> [{name, text, bytes, text_bytes, truncated}] for the regular files in trials/<token>/.

    Symlinks, subdirectories and anything that resolves outside the run dir are skipped, so a link cannot pull an
    outside file into the page. Each file is capped at FILE_CAP bytes and decoded as UTF-8 with replacement.
    """
    root = Path(run_dir).resolve()
    out = {}
    for trial in doc['trials']:
        token = trial['token']
        folder = root / 'trials' / token
        if folder.is_symlink() or not folder.is_dir() or not _inside(folder, root):
            continue
        files = []
        for entry in sorted(folder.iterdir(), key=lambda p: p.name):
            if entry.is_symlink() or not entry.is_file() or not _inside(entry, root):
                continue
            size = entry.stat().st_size
            with entry.open('rb') as handle:
                raw = handle.read(FILE_CAP)
            files.append({'name': entry.name, 'text': raw.decode('utf-8', errors='replace'), 'bytes': size,
                          'text_bytes': len(raw), 'truncated': size > FILE_CAP})
        if files:
            out[token] = files
    return out


def build_run(run_dir):
    run_dir = Path(run_dir)
    doc = check_results.load(run_dir)
    data = {'kind': 'run', 'results': doc, 'stats': eval_stats.summarize(doc), 'files': trial_files(run_dir, doc)}
    title = f'{doc["run"]["eval"]} eval · {doc["run"]["id"]}'
    return write_private(run_dir / 'report.html', render_page(title, data, ['common.js', 'run.js']))


def build_index(root):
    root = Path(root)
    docs, skipped, reports = [], [], {}
    for child in sorted(root.iterdir(), key=lambda p: p.name):
        if child.is_symlink() or not child.is_dir() or not (child / 'results.json').is_file():
            continue
        try:
            docs.append((child.name, check_results.load(child)))
            reports[child.name] = (child / 'report.html').is_file()
        except check_results.CheckError as exc:
            first = exc.errors[0].split(': ', 1)[-1]
            skipped.append({'dir': child.name, 'error': first + (f' (and {len(exc.errors) - 1} more)' if len(exc.errors) > 1 else '')})
    data = {'kind': 'index', 'root_name': root.resolve().name, 'evals': eval_stats.summarize_index(docs),
            'skipped': skipped, 'reports': reports}
    return write_private(root / 'index.html', render_page('Eval runs', data, ['common.js', 'index.js']))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build the eval report for run dirs, and the index page across runs.')
    parser.add_argument('run_dirs', nargs='*', help='run directories that hold results.json')
    parser.add_argument('--index', metavar='RUNS_ROOT', help='also write RUNS_ROOT/index.html for every run under it')
    args = parser.parse_args(argv)
    if not args.run_dirs and not args.index:
        parser.error('give a run dir, --index, or both')
    status = 0
    for run_dir in args.run_dirs:
        try:
            print(build_run(run_dir))
        except check_results.CheckError as exc:
            status = 1
            print('\n'.join(exc.errors), file=sys.stderr)
    if args.index:
        print(build_index(args.index))
    return status


if __name__ == '__main__':
    sys.exit(main())
