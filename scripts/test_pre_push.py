"""Runs the shell blocks of commands/pre-push.md (Steps 1 and 2) in a fixture repo with a bare origin."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

COMMAND = Path(__file__).resolve().parent.parent / 'commands/pre-push.md'


def shell_blocks():
    text = COMMAND.read_text(encoding='utf-8')
    steps = text.split('## Step 1:')[1].split('## Step 3:')[0]
    return '\n'.join(re.findall(r'^```bash\n(.*?)^```', steps, re.M | re.S))


class PrePushDiffTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.env = {**os.environ, 'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
                    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com'}
        self.git(self.dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
        self.work = self.clone('work')
        self.commit(self.work, 'test_x.py', 'init')
        self.git(self.work, 'push', '-q', '-u', 'origin', 'main')
        self.git(self.work, 'remote', 'set-head', 'origin', 'main')
        # Another developer pushes to the base branch after the clone, so the command's fetch moves the upstream.
        other = self.clone('other')
        self.commit(other, 'test_y.py', 'upstream adds a test')
        self.git(other, 'push', '-q', 'origin', 'main')

    def git(self, cwd, *args):
        return subprocess.check_output(['git', '-c', 'commit.gpgsign=false', *args], cwd=cwd, env=self.env,
                                       stderr=subprocess.PIPE, universal_newlines=True)

    def clone(self, name):
        self.git(self.dir, 'clone', '-q', 'origin.git', name)
        return self.dir / name

    def commit(self, repo, name, message):
        (repo / name).write_text(name + '\n'); self.git(repo, 'add', name); self.git(repo, 'commit', '-q', '-m', message)

    def run_blocks(self):
        done = subprocess.run(['bash', '-c', shell_blocks()], cwd=self.work, env=self.env, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, universal_newlines=True)
        return done.stdout

    def test_feature_branch_diff_lists_only_the_local_change(self):
        self.git(self.work, 'checkout', '-q', '-b', 'feature')
        self.commit(self.work, 'app.py', 'local change')
        out = self.run_blocks()
        self.assertIn('app.py', out); self.assertNotIn('test_y.py', out)

    def test_base_branch_diff_lists_only_the_unpushed_change_when_upstream_moved(self):
        self.commit(self.work, 'app.py', 'local unpushed')
        out = self.run_blocks()
        self.assertIn('app.py', out); self.assertNotIn('test_y.py', out)


if __name__ == '__main__':
    unittest.main()
