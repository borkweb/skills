import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).with_name('review-scope.py').resolve()


class ReviewScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, 'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
                    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com'}
        self.git('init', '-b', 'base'); self.put('parser.txt', 'initial\n'); self.commit('initial')

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'commit.gpgsign=false', *args], cwd=self.root,
                                       env=self.env, stderr=subprocess.PIPE).decode().strip()

    def put(self, path, content): (self.root / path).write_text(content)

    def commit(self, message):
        self.git('add', '.'); self.git('commit', '-m', message)

    def capture(self, *extra):
        result = subprocess.run([sys.executable, str(HELPER), '--base', 'base', *extra],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_base_only_changes_excluded(self):
        self.git('checkout', '-b', 'feature'); self.put('parser.txt', 'fixed\n'); self.commit('parser fix')
        self.git('checkout', 'base'); self.put('new docs.txt', 'base docs\n'); self.commit('base docs')
        self.git('checkout', 'feature')
        result = self.capture()
        self.assertEqual(result['branch_files'], ['parser.txt'])
        self.assertNotIn('base docs', result['branch_patch'])

    def test_dirty_base_and_untracked_snapshot(self):
        self.put('parser.txt', 'dirty\n'); self.put('new\nfile.txt', 'new\n')
        before = self.git('status', '--porcelain')
        result = self.capture('--include-local')
        self.assertEqual(result['branch_files'], [])
        self.assertIn('+dirty', result['local_patch'])
        self.assertEqual(result['untracked'][0]['path'], 'new\nfile.txt')
        self.assertEqual(before, self.git('status', '--porcelain'))
        self.put('new\nfile.txt', 'changed\n')
        self.assertNotEqual(result['snapshot'], self.capture('--include-local')['snapshot'])

    def test_local_changes_opt_in(self):
        clean = self.capture(); self.put('parser.txt', 'dirty\n')
        self.assertEqual(clean['branch_snapshot'], self.capture()['branch_snapshot'])
        self.assertNotEqual(clean['snapshot'], self.capture()['snapshot'])
        self.assertNotIn('local_patch', self.capture())

    def test_subdirectory_invocation(self):
        (self.root / 'sub').mkdir()
        self.put('sub/new.txt', 'new\n')
        run = subprocess.run([sys.executable, str(HELPER), '--base', 'base', '--include-local'],
                             cwd=self.root / 'sub', capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)['untracked'][0]['path'], 'sub/new.txt')

    def test_staged_change_with_worktree_restored_to_head(self):
        self.put('parser.txt', 'staged\n'); self.git('add', 'parser.txt')
        self.put('parser.txt', 'initial\n')
        result = self.capture('--include-local')
        self.assertEqual(result['local_patch'], '')
        self.assertIn('+staged', result['staged_patch'])
        self.assertIn('-staged', result['unstaged_patch'])

    def test_invalid_base_fails_closed(self):
        run = subprocess.run([sys.executable, str(HELPER), '--base', 'missing'], cwd=self.root,
                             text=True, capture_output=True)
        self.assertEqual(run.returncode, 2); self.assertEqual(run.stdout, '')


if __name__ == '__main__': unittest.main()
