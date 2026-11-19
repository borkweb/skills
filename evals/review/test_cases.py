import copy
import json
import os
import stat
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check_cases  # noqa: E402
import repos  # noqa: E402
import seed_from_replay as seed  # noqa: E402

git = repos.caselib.git

CASE = {
    'id': 'shop-retry', 'title': 'Retry resends invoices', 'skill': 'review',
    'repo': {'identity': 'github.com/example/shop'},
    'base': 'a' * 40, 'head': 'b' * 40, 'kind': 'bug', 'expected_verdict': 'DO NOT LAND',
    'expected_findings': [{'id': 'F1', 'file': 'src/retry.php', 'lines': '40-44', 'severity': 'IMPORTANT',
                           'answer': 'The retry path resends invoices that already went out.'}],
    'provenance': {'source': 'reverted PR #12'}, 'added': '2026-11-19', 'tags': ['php'],
}


def case(**changes):
    out = copy.deepcopy(CASE)
    out.update(changes)
    return out


class IdentityTests(unittest.TestCase):
    def test_every_url_form_normalizes_to_one_identity(self):
        for url in ('git@github.com:Example/Shop.git', 'ssh://git@github.com:22/Example/Shop', 'https://github.com/Example/Shop/',
                    'https://token@GitHub.com/Example/Shop.git', 'github.com/Example/Shop'):
            with self.subTest(url=url):
                self.assertEqual(repos.normalize_identity(url), 'github.com/Example/Shop')
        self.assertEqual(repos.normalize_identity('git@github.a8c.com:Automattic/wpcom.git'), 'github.a8c.com/Automattic/wpcom')

    def test_unreadable_urls_are_refused(self):
        for url in ('', 'not a url', '/Users/me/repo', 'https://github.com/../etc'):
            with self.subTest(url=url), self.assertRaises(repos.RepoError):
                repos.normalize_identity(url)


class CheckTests(unittest.TestCase):
    def rejects(self, c, needle):
        errors = check_cases.check(c, c.get('id'))
        self.assertTrue(any(needle in e for e in errors), f'{needle!r} not in {errors}')

    def test_valid_case_passes(self):
        self.assertEqual(check_cases.check(case(), 'shop-retry'), [])
        clean = case(kind='clean', expected_findings=[], expected_verdict='SAFE TO LAND')
        self.assertEqual(check_cases.check(clean, 'shop-retry'), [])

    def test_a_case_holds_no_code_or_local_path(self):
        self.rejects(case(diff='--- a/x'), '$.diff: is not a case field')
        self.rejects(case(repo={'identity': 'github.com/example/shop', 'path': '/Users/me/shop'}), 'no local path')
        bad = case()
        bad['expected_findings'][0]['answer'] = 'Line one.\nLine two.'
        self.rejects(bad, 'one sentence')
        bad['expected_findings'][0]['answer'] = 'See ```php echo $x; ```'
        self.rejects(bad, 'no code block')
        bad['expected_findings'][0]['patch'] = 'x'
        self.rejects(bad, 'patch: is not a finding field')
        bad = case()
        bad['expected_findings'][0]['id'] = ['F1']
        self.rejects(bad, 'must look like F1')
        bad['expected_findings'][0]['patch'] = 'x'
        self.rejects(bad, 'patch: is not a finding field')

    def test_field_rules(self):
        self.rejects(case(base='abc'), '$.base: must be a full 40-character commit ID')
        self.rejects(case(head='a' * 40), '$.head: must differ from base')
        self.rejects(case(kind='bug', expected_findings=[]), 'a bug case needs at least one expected finding')
        self.rejects(case(kind='clean'), 'a clean case has no expected findings')
        self.rejects(case(expected_verdict='FAIL'), 'must be one of SAFE TO LAND')
        self.rejects(case(repo={'identity': 'git@github.com:example/shop.git'}), "is not normalized; use 'github.com/example/shop'")
        self.rejects(case(added='Nov 19'), 'YYYY-MM-DD')
        self.assertTrue(any('must match the file name' in e for e in check_cases.check(case(), 'other-name')))

    def test_severity_labels_follow_the_skill(self):
        bad = case()
        bad['expected_findings'][0]['severity'] = 'CRITICAL'
        self.rejects(bad, 'must be one of IMPORTANT, NIT, PRE-EXISTING for review')
        sec = case(skill='review-security', expected_verdict='FAIL')
        sec['expected_findings'][0]['severity'] = 'CRITICAL'
        self.assertEqual(check_cases.check(sec, 'shop-retry'), [])
        sec['expected_findings'][0]['severity'] = 'IMPORTANT'
        self.rejects(sec, 'for review-security')
        bad = case()
        bad['expected_findings'][0]['lines'] = 'about 40'
        self.rejects(bad, 'must be line numbers at head')


class RepoFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='review-cases-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = self.tmp / 'shop'
        self.repo.mkdir()
        git(self.repo, 'init', '-q')
        git(self.repo, 'remote', 'add', 'origin', 'git@github.com:example/shop.git')
        (self.repo / 'retry.php').write_text('<?php\n', encoding='utf-8')
        git(self.repo, 'add', 'retry.php')
        git(self.repo, 'commit', '-q', '-m', 'base')
        self.base = git(self.repo, 'rev-parse', 'HEAD')
        (self.repo / 'retry.php').write_text('<?php\nresend();\n', encoding='utf-8')
        git(self.repo, 'commit', '-q', '-am', 'head')
        self.head = git(self.repo, 'rev-parse', 'HEAD')
        self.config = self.tmp / 'config.json'
        self.config.write_text(json.dumps({'dispatch': {'keep': True}}), encoding='utf-8')
        old = os.environ.get('BORKWEB_SKILLS_CONFIG')
        os.environ['BORKWEB_SKILLS_CONFIG'] = str(self.config)
        self.addCleanup(lambda: os.environ.pop('BORKWEB_SKILLS_CONFIG') if old is None else os.environ.__setitem__('BORKWEB_SKILLS_CONFIG', old))


class RepoMapTests(RepoFixture):
    def test_add_keeps_other_config_and_resolve_checks_origin_and_commits(self):
        self.assertEqual(repos.add([self.repo]), {'github.com/example/shop': str(self.repo.resolve())})
        data = json.loads(self.config.read_text(encoding='utf-8'))
        self.assertEqual(data['dispatch'], {'keep': True})
        self.assertEqual(repos.resolve('github.com/example/shop'), self.repo.resolve())
        good = case(base=self.base, head=self.head)
        self.assertEqual(check_cases.resolve_errors(good), [])
        missing = case(base=self.base, head='c' * 40)
        self.assertEqual(len(check_cases.resolve_errors(missing)), 1)
        git(self.repo, 'remote', 'set-url', 'origin', 'https://github.com/someone/else')
        with self.assertRaisesRegex(repos.RepoError, 'has origin github.com/someone/else'):
            repos.resolve('github.com/example/shop')

    def test_bad_config_is_an_error_not_a_crash(self):
        self.config.write_text('{"repos": [', encoding='utf-8')
        with self.assertRaisesRegex(repos.RepoError, 'not valid JSON'):
            repos.resolve('github.com/example/shop')
        self.assertTrue(check_cases.resolve_errors(case())[0].startswith('$.repo:'))
        self.config.write_text('{"repos": []}', encoding='utf-8')
        with self.assertRaisesRegex(repos.RepoError, 'must be an object'):
            repos.add([self.repo])

    def test_unmapped_identity_says_how_to_add_it(self):
        with self.assertRaisesRegex(repos.RepoError, 'repos.py add'):
            repos.resolve('github.com/example/unknown')


class SeedTests(RepoFixture):
    def write_replay(self, slices):
        replay = self.tmp / 'replay'
        for sub in ('blind', 'pool-key', 'verdicts'):
            (replay / sub).mkdir(parents=True, exist_ok=True)
        manifest = []
        for sid, s in slices.items():
            manifest.append({'id': sid, 'repo': 'shop', 'checkout': str(self.repo), 'base': self.base, 'head': self.head,
                             'run_dir': '/runs/2026-11-13-shop-x', 'review_date': '2026-11-13', 'reviewer_verdict': 'DO NOT LAND',
                             'notes': None, 'escapes': s.get('escapes', []),
                             'reviewer_findings': [{'n': 1, 'severity': 'critical', 'file': 'retry.php', 'line': '2',
                                                    'title': 'Retry resends sent invoices'}]})
            (replay / 'blind' / f'{sid}.json').write_text(json.dumps(s['blind']), encoding='utf-8')
            (replay / 'pool-key' / f'{sid}.json').write_text(json.dumps(s['key']), encoding='utf-8')
            (replay / 'verdicts' / f'{sid}.json').write_text(json.dumps(s['verdicts']), encoding='utf-8')
        (replay / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        return replay

    def slices(self):
        return {
            'shop-bug': {
                'blind': [{'fid': 'a', 'file': 'retry.php', 'claim': 'Retry resends invoices. More detail.'},
                          {'fid': 'b', 'file': 'retry.php', 'claim': 'Resend runs twice on retry.'},
                          {'fid': 'c', 'file': 'retry.php', 'claim': 'Unused variable.'},
                          {'fid': 'd', 'file': 'retry.php', 'claim': 'Missing <?php close tag? Not sure.'},
                          {'fid': 'e', 'file': 'retry.php', 'claim': 'Old helper also double-sends.'}],
                'key': {'a': {'source': 'bork', 'original_ref': '1', 'original_severity': 'CRITICAL'},
                        'b': {'source': 'medium', 'original_ref': '1 (retry.php:2)', 'original_severity': 'important'},
                        'c': {'source': 'medium', 'original_ref': '2', 'original_severity': 'nit'},
                        'd': {'source': 'low', 'original_ref': '1', 'original_severity': 'INFORMATIONAL (minor)'},
                        'e': {'source': 'medium', 'original_ref': '3 (retry.php:1)', 'original_severity': 'pre_existing'}},
                'verdicts': {'duplicate_groups': [['a', 'b']], 'verdicts': [
                    {'fid': 'a', 'verdict': 'REAL', 'evidence': 'retry.php:2 — resend() runs on every retry.'},
                    {'fid': 'b', 'verdict': 'REAL', 'evidence': 'retry.php:2 — same.'},
                    {'fid': 'c', 'verdict': 'NOT_REAL', 'evidence': 'retry.php:1 — no such variable.'},
                    {'fid': 'd', 'verdict': 'UNSURE', 'evidence': 'cannot tell'},
                    {'fid': 'e', 'verdict': 'REAL', 'evidence': 'no location here'}]},
            },
            'shop-clean': {
                'blind': [{'fid': 'x', 'file': 'retry.php', 'claim': 'Wrong claim.'}],
                'key': {'x': {'source': 'medium', 'original_ref': '1', 'original_severity': 'important'}},
                'verdicts': {'verdicts': [{'fid': 'x', 'verdict': 'NOT_REAL', 'evidence': 'retry.php:1 — fine.'}]},
            },
            'shop-escape': {
                'blind': [], 'key': {}, 'verdicts': {'verdicts': []}, 'escapes': [{'what': 'double charge in prod'}],
            },
        }

    def test_seed_drafts_cases_from_real_groups_across_all_reviews(self):
        replay = self.write_replay(self.slices())
        cases_dir, report = self.tmp / 'cases', self.tmp / 'report.json'
        self.assertEqual(seed.main([str(replay), '--cases', str(cases_dir), '--report', str(report), '--added', '2026-11-19']), 0)
        bug = json.loads((cases_dir / 'shop-bug.json').read_text(encoding='utf-8'))
        self.assertEqual(check_cases.check(bug, 'shop-bug'), [])
        self.assertEqual(bug['repo'], {'identity': 'github.com/example/shop'})
        self.assertEqual(bug['kind'], 'bug')
        self.assertEqual(bug['expected_verdict'], 'DO NOT LAND')
        found = [(f['id'], f['lines'], f['severity'], f['answer']) for f in bug['expected_findings']]
        self.assertEqual(found, [('F1', '2', 'IMPORTANT', 'Retry resends sent invoices'),
                                 ('F2', '1', 'PRE-EXISTING', 'Old helper also double-sends.')])
        self.assertIn('F1: a (bork 1), b (medium 1 (retry.php:2))', bug['provenance']['findings'])
        clean = json.loads((cases_dir / 'shop-clean.json').read_text(encoding='utf-8'))
        self.assertEqual((clean['kind'], clean['expected_findings'], clean['expected_verdict']), ('clean', [], 'SAFE TO LAND'))
        data = json.loads(report.read_text(encoding='utf-8'))
        by_id = {s['id']: s for s in data['slices']}
        self.assertEqual([g['verdict'] for g in by_id['shop-bug']['groups']], ['REAL', 'NOT_REAL', 'UNSURE', 'REAL'])
        self.assertTrue(any('recorded escape' in f for f in by_id['shop-escape']['flags']))
        # A slice with an escape and no REAL finding is not clean: no case is written for it.
        self.assertFalse((cases_dir / 'shop-escape.json').exists())
        self.assertEqual(stat.S_IMODE(report.stat().st_mode), 0o600)
        self.assertEqual(by_id['shop-bug']['flags'], [])

    def test_seed_never_overwrites_a_case(self):
        replay = self.write_replay(self.slices())
        cases_dir = self.tmp / 'cases'
        cases_dir.mkdir()
        (cases_dir / 'shop-bug.json').write_text('{"edited": true}', encoding='utf-8')
        with self.assertRaisesRegex(SystemExit, 'refusing to overwrite'):
            seed.main([str(replay), '--cases', str(cases_dir), '--report', str(self.tmp / 'r.json')])
        self.assertEqual((cases_dir / 'shop-bug.json').read_text(encoding='utf-8'), '{"edited": true}')

    def test_seed_refuses_to_write_inside_the_public_repo(self):
        replay = self.write_replay(self.slices())
        with self.assertRaisesRegex(SystemExit, 'inside the public skills repo'):
            seed.main([str(replay), '--cases', str(seed.REPO_ROOT / 'evals' / 'review' / 'cases-tmp'), '--report', str(self.tmp / 'r.json')])
        self.assertFalse((seed.REPO_ROOT / 'evals' / 'review' / 'cases-tmp').exists())

    def test_whole_path_segments_must_match(self):
        self.assertTrue(seed.same_path('wp-content/lib/x.php', 'lib/x.php'))
        self.assertTrue(seed.same_path('x.py', 'lib/x.py'))
        self.assertFalse(seed.same_path('lib/index.py', 'x.py'))

    def test_integer_ref_and_missing_title_do_not_crash(self):
        slices = self.slices()
        slices['shop-bug']['key']['a']['original_ref'] = 1
        replay = self.write_replay(slices)
        manifest = json.loads((replay / 'manifest.json').read_text(encoding='utf-8'))
        for s in manifest:
            s['reviewer_findings'][0]['title'] = None
        (replay / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        self.assertEqual(seed.main([str(replay), '--cases', str(self.tmp / 'c'), '--report', str(self.tmp / 'r.json')]), 0)
        bug = json.loads((self.tmp / 'c' / 'shop-bug.json').read_text(encoding='utf-8'))
        self.assertEqual(bug['expected_findings'][0]['answer'], 'Retry resends invoices.')

    def test_severity_words(self):
        for raw, label in (('CRITICAL (major)', 'IMPORTANT'), ('INFORMATIONAL (minor)', 'NIT'), ('pre_existing', 'PRE-EXISTING'),
                           ('nit', 'NIT'), ('weird', None), (None, None)):
            with self.subTest(raw=raw):
                self.assertEqual(seed.severity_of(raw), label)


if __name__ == '__main__':
    unittest.main()
