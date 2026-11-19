from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / 'fixtures'))
import build_report as br  # noqa: E402
import make_synthetic  # noqa: E402

sys.path.insert(0, str(HERE.parent / 'replay'))
import caselib  # noqa: E402

ASSETS = HERE / 'assets'


class Scripts(HTMLParser):
    """Collect every <script> element, its attributes and its raw text, and every src/href value."""

    def __init__(self):
        super().__init__()
        self.scripts, self.urls, self.meta = [], [], []
        self._in = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for name in ('src', 'href', 'action', 'srcset'):
            if name in attrs:
                self.urls.append(attrs[name])
        if tag == 'meta':
            self.meta.append(attrs)
        if tag == 'script':
            self._in = {'attrs': attrs, 'text': ''}

    def handle_data(self, data):
        if self._in is not None:
            self._in['text'] += data

    def handle_endtag(self, tag):
        if tag == 'script' and self._in is not None:
            self.scripts.append(self._in)
            self._in = None


def parse(text):
    p = Scripts()
    p.feed(text)
    p.close()
    return p


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='build-report-'))
        cls.bundle = json.loads(make_synthetic.FIXTURE.read_text(encoding='utf-8'))
        cls.dirs = {d.name: d for d in make_synthetic.materialize(cls.tmp / 'runs', cls.bundle)}
        for d in cls.dirs.values():
            br.build_run(d)
        br.build_index(cls.tmp / 'runs')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, True)

    def page(self, name):
        return (self.dirs[name] / 'report.html').read_text(encoding='utf-8')

    def test_hostile_text_round_trips_as_data(self):
        text = self.page('review-1')
        parsed = parse(text)
        self.assertEqual(len(parsed.scripts), 2, 'only the data block and the page script')
        data_block = next(s for s in parsed.scripts if s['attrs'].get('type') == 'application/json')
        data = json.loads(data_block['text'])
        source = next(r for r in self.bundle['runs'] if r['dir'] == 'review-1')
        self.assertEqual(data['results'], source['results'])
        files = {t: {f['name']: f['text'] for f in fs} for t, fs in data['files'].items()}
        self.assertEqual(files, source['files'])
        hostile = [f['text'] for fs in data['files'].values() for f in fs if '</script>' in f['text']]
        self.assertTrue(hostile, 'the fixture must carry </script> in model output')
        for needle in ('</script><script>window.__pwned = 1</script>', '<!-- admin -->', ' ', ' ', '<?php'):
            self.assertIn(needle, hostile[0])
        titles = [c['title'] for c in data['results']['cases']]
        self.assertIn('Admin notice prints </script> and <b>raw</b> titles', titles)
        # Escaping is what makes this hold: the raw page text has no data-borne markup at all.
        self.assertEqual(text.lower().count('</script'), 2)
        self.assertNotIn('<!--', text)
        self.assertNotIn('<img', text)
        self.assertNotIn('<?php', text)
        for raw in (' ', ' '):
            self.assertNotIn(raw, text)

    def test_embed_json_escapes(self):
        out = br.embed_json({'a': '</script><b>& '})
        self.assertNotRegex(out, r'[<>&  ]')
        self.assertEqual(json.loads(out), {'a': '</script><b>& '})
        with self.assertRaises(ValueError):
            br.embed_json({'a': float('nan')})

    def test_no_network_loads_and_csp(self):
        for name in list(self.dirs) + ['index']:
            text = (self.tmp / 'runs' / 'index.html').read_text(encoding='utf-8') if name == 'index' else self.page(name)
            parsed = parse(text)
            with self.subTest(page=name):
                csp = [m for m in parsed.meta if m.get('http-equiv') == 'Content-Security-Policy']
                self.assertEqual(len(csp), 1)
                self.assertIn("default-src 'none'", csp[0]['content'])
                self.assertEqual(parsed.urls, [], 'no src or href in the static page')
                self.assertTrue(all('src' not in s['attrs'] for s in parsed.scripts))
                # The SVG namespace is an identifier, not a load.
                bare = text.replace('http://www.w3.org/2000/svg', '')
                self.assertNotRegex(bare, r'(?i)(https?:)?//[a-z0-9.-]+\.[a-z]{2,}/', 'no absolute URL anywhere')
                self.assertNotRegex(text, r'@import|url\(')

    def test_mode_600_for_every_page(self):
        for path in [d / 'report.html' for d in self.dirs.values()] + [self.tmp / 'runs' / 'index.html']:
            with self.subTest(path=path.name):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        leftovers = [p for p in (self.tmp / 'runs').rglob('*.tmp')]
        self.assertEqual(leftovers, [])

    def test_rebuild_keeps_mode_600_over_an_existing_wider_file(self):
        target = self.dirs['triage-1'] / 'report.html'
        os.chmod(target, 0o644)
        br.build_run(self.dirs['triage-1'])
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    def test_index_lists_every_eval_and_links_reports(self):
        parsed = parse((self.tmp / 'runs' / 'index.html').read_text(encoding='utf-8'))
        data = json.loads(next(s for s in parsed.scripts if s['attrs'].get('type') == 'application/json')['text'])
        self.assertEqual([e['eval'] for e in data['evals']], ['replay', 'review', 'triage'])
        self.assertTrue(all(data['reports'].values()))
        review = next(e for e in data['evals'] if e['eval'] == 'review')
        self.assertEqual(review['shared_cases'], 8)
        self.assertEqual(len({r['compat'] for r in review['runs']}), 2)
        self.assertEqual([r['id'] for r in review['runs']][:2], ['2026-11-20-review-a1b2', '2026-12-05-review-regrade-a1b2'])
        self.assertEqual(len(review['comparisons']), 6)

    def test_index_skips_invalid_runs_and_symlinked_dirs(self):
        root = self.tmp / 'mixed'
        (root / 'bad').mkdir(parents=True)
        (root / 'bad' / 'results.json').write_text('{"schema": "nope"}', encoding='utf-8')
        os.symlink(self.dirs['triage-1'], root / 'linked')
        br.build_index(root)
        text = (root / 'index.html').read_text(encoding='utf-8')
        data = json.loads(next(s for s in parse(text).scripts if s['attrs'].get('type') == 'application/json')['text'])
        self.assertEqual(data['evals'], [])
        self.assertEqual([s['dir'] for s in data['skipped']], ['bad'])


class TrialFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='build-report-files-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        bundle = json.loads(make_synthetic.FIXTURE.read_text(encoding='utf-8'))
        triage = next(r for r in bundle['runs'] if r['dir'] == 'triage-1')
        (self.run_dir,) = make_synthetic.materialize(self.tmp / 'runs', {'runs': [triage]})
        self.doc = triage['results']
        self.token = self.doc['trials'][0]['token']

    def test_symlinks_and_outside_files_are_not_embedded(self):
        secret = self.tmp / 'secret.txt'
        secret.write_text('outside the run', encoding='utf-8')
        folder = self.run_dir / 'trials' / self.token
        os.symlink(secret, folder / 'link.txt')
        (folder / 'sub').mkdir()
        (folder / 'sub' / 'nested.txt').write_text('nested', encoding='utf-8')
        other = self.doc['trials'][1]['token']
        shutil.rmtree(self.run_dir / 'trials' / other)
        os.symlink(self.tmp, self.run_dir / 'trials' / other)
        files = br.trial_files(self.run_dir, self.doc)
        self.assertEqual([f['name'] for f in files[self.token]], ['answer.txt'])
        self.assertNotIn(other, files)

    def test_a_hard_link_to_an_outside_file_is_not_embedded(self):
        # link-safe-tree-walk rule: a hard link to a file outside the run has nlink 2 and must be skipped.
        secret = self.tmp / 'secret.txt'
        secret.write_text('OUTSIDE-SECRET', encoding='utf-8')
        os.link(secret, self.run_dir / 'trials' / self.token / 'linked.txt')
        files = br.trial_files(self.run_dir, self.doc)
        self.assertEqual([f['name'] for f in files[self.token]], ['answer.txt'])
        br.build_run(self.run_dir)
        self.assertNotIn('OUTSIDE-SECRET', (self.run_dir / 'report.html').read_text(encoding='utf-8'))
        self.assertEqual(secret.read_text(encoding='utf-8'), 'OUTSIDE-SECRET')

    def test_file_count_and_run_size_are_capped(self):
        folder = self.run_dir / 'trials' / self.token
        for i in range(br.FILES_PER_TRIAL + 5):
            (folder / f'extra-{i:02}.txt').write_text('x', encoding='utf-8')
        files = br.trial_files(self.run_dir, self.doc)[self.token]
        self.assertEqual(len(files), br.FILES_PER_TRIAL + 1)
        self.assertEqual(files[-1]['name'], '(more files)')
        old = br.RUN_FILES_CAP
        br.RUN_FILES_CAP = 0
        try:
            capped = br.trial_files(self.run_dir, self.doc)[self.token]
        finally:
            br.RUN_FILES_CAP = old
        self.assertTrue(all(f['text_bytes'] == 0 for f in capped))

    def test_a_lone_surrogate_and_a_broken_run_do_not_stop_the_build(self):
        results = json.loads((self.run_dir / 'results.json').read_text(encoding='utf-8'))
        results['trials'][0]['reason'] = '\ud800 cut mid-emoji'
        (self.run_dir / 'results.json').write_text(json.dumps(results), encoding='utf-8')
        self.assertEqual(br.main([str(self.run_dir)]), 0)
        page = (self.run_dir / 'report.html').read_text(encoding='utf-8')
        self.assertIn('\\ud800', page)
        broken = self.tmp / 'runs' / 'broken'
        broken.mkdir()
        (broken / 'results.json').write_text('{}', encoding='utf-8')
        real_load = br.check_results.load
        def load(target):
            if Path(target).name == 'broken':
                raise RuntimeError('unexpected')
            return real_load(target)
        br.check_results.load = load
        try:
            self.assertEqual(br.main([str(broken), str(self.run_dir), '--index', str(self.tmp / 'runs')]), 1)
        finally:
            br.check_results.load = real_load
        index = (self.tmp / 'runs' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('RuntimeError: unexpected', index)

    def test_large_and_binary_files_are_capped_and_decoded(self):
        folder = self.run_dir / 'trials' / self.token
        (folder / 'big.txt').write_bytes(b'a' * (br.FILE_CAP + 10))
        (folder / 'bin.dat').write_bytes(b'\xff\xfe\x00ok')
        files = {f['name']: f for f in br.trial_files(self.run_dir, self.doc)[self.token]}
        self.assertTrue(files['big.txt']['truncated'])
        self.assertEqual(len(files['big.txt']['text']), br.FILE_CAP)
        self.assertEqual(files['big.txt']['bytes'], br.FILE_CAP + 10)
        self.assertIn('�', files['bin.dat']['text'])
        self.assertFalse(files['bin.dat']['truncated'])

    def test_invalid_results_are_refused(self):
        (self.run_dir / 'results.json').write_text('{"schema": "bork-eval-results/1"}', encoding='utf-8')
        self.assertEqual(br.main([str(self.run_dir)]), 1)
        self.assertFalse((self.run_dir / 'report.html').exists())


class AssetTests(unittest.TestCase):
    def assets(self):
        return {p.name: p.read_text(encoding='utf-8') for p in ASSETS.iterdir()}

    def test_page_scripts_never_parse_markup_or_eval(self):
        banned = re.compile(r'innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|'
                            r'createContextualFragment|DOMParser|srcdoc|setTimeout\(\s*[\'"`]|fetch\(|XMLHttpRequest|'
                            r'WebSocket|EventSource|sendBeacon|import\(')
        for name, text in self.assets().items():
            with self.subTest(asset=name):
                self.assertIsNone(banned.search(text))
                self.assertNotIn('</script', text.lower())

    def test_report_code_knows_nothing_about_one_eval(self):
        # run.grader.harness is a field of the results format itself, so "harness" is allowed.
        words = re.compile(r'(?i)\b(recall|findings?|verdicts?|reviews?|grok|codex|claude|gemini|antigravity|agy)\b')
        sources = {**self.assets(), 'build_report.py': (HERE / 'build_report.py').read_text(encoding='utf-8'),
                   'eval_stats.py': (HERE / 'eval_stats.py').read_text(encoding='utf-8')}
        for name, text in sources.items():
            with self.subTest(source=name):
                self.assertEqual(words.findall(text), [])

    def test_every_spec_empty_state_has_a_marker(self):
        # The spec's empty states: no graded trials for a config, one config only, no items, no cost data and a run
        # where all trials failed. Each must carry a stable data-empty marker for the Chrome check to find.
        text = self.assets()['run.js']
        for marker in ('no-graded', 'one-config', 'no-items', 'no-cost-data', 'all-failed'):
            with self.subTest(marker=marker):
                self.assertRegex(text, r"""['"]""" + re.escape(marker) + r"""['"]""")


class FixtureDriftTests(unittest.TestCase):
    def test_fixture_matches_generator(self):
        self.assertEqual(make_synthetic.dumps_bundle(make_synthetic.bundle()),
                         make_synthetic.FIXTURE.read_text(encoding='utf-8'),
                         'synthetic-results.json drifted: rerun fixtures/make_synthetic.py')


def child_env():
    """The CLI child gets an allowlisted environment (spawned-process-env-allowlist rule), never os.environ."""
    return caselib.scrubbed_env()


class CliTests(unittest.TestCase):
    def test_child_env_drops_unlisted_variables(self):
        os.environ['BORK_HOSTILE_PROBE'] = 'leak'
        self.addCleanup(os.environ.pop, 'BORK_HOSTILE_PROBE', None)
        env = child_env()
        self.assertNotIn('BORK_HOSTILE_PROBE', env)
        proc = subprocess.run([sys.executable, '-c', 'import os; print(os.environ.get("BORK_HOSTILE_PROBE"))'],
                              capture_output=True, text=True, env=env)
        self.assertEqual(proc.stdout.strip(), 'None')

    def test_cli_needs_a_target(self):
        proc = subprocess.run([sys.executable, str(HERE / 'build_report.py')], capture_output=True, text=True, env=child_env())
        self.assertEqual(proc.returncode, 2)
        self.assertIn('give a run dir, --index, or both', proc.stderr)


if __name__ == '__main__':
    unittest.main()
