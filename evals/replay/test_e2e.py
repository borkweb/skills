from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support  # noqa: E402

REAL_STORE = Path.home() / '.agent-handoffs'


def replay_entries():
    """Every replay* entry in the real store, recursively, with size, hash and mtime."""
    return support.store_snapshot(REAL_STORE)


def demo_args(root):
    """The command documented in evals/replay/README.md, minus the interpreter and script."""
    return ['--demo', root / 'fx', '--fake', '--trials', '2', '--current-ref', support.BASE_REF,
            '--output', root / 'out']


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-e2e-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_documented_demo_command_runs_both_arms_and_leaves_no_worktree(self):
        before = replay_entries()
        scratch = self.tmp / 'scratch'
        scratch.mkdir()
        run = support.run_cli(support.RUNNER, demo_args(self.tmp), env={'TMPDIR': str(scratch)})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(list(scratch.glob('replay-*')), [], 'no trial clone dir is left behind')
        out = self.tmp / 'out'
        self.assertTrue((out / 'summary.json').is_file())
        record = support.case_record(out)
        self.assertEqual(len(record['trials']), 4)
        arms = support.load(out / 'summary.json')['arms']
        self.assertEqual(sorted(arms), ['current', 'revised'])
        listing = support.git(self.tmp / 'fx' / 'repo', 'worktree', 'list', '--porcelain')
        self.assertEqual(listing.count('worktree '), 1)
        self.assertEqual(replay_entries(), before)

    def test_readme_records_the_same_command(self):
        readme = (support.HERE / 'README.md').read_text()
        self.assertIn('python3 evals/replay/run_replay.py --demo', readme)
        self.assertIn('--fake --trials 2 --current-ref 94bdb26', readme)

    def test_with_home_in_a_temp_dir_and_no_store_variable_it_writes_only_there(self):
        before = replay_entries()
        home = self.tmp / 'home'
        home.mkdir()
        run = support.run_cli(support.RUNNER, ['--demo', home / 'fx', '--fake', '--trials', '2', '--current-ref',
                                               support.BASE_REF, '--output', home / 'out'],
                              env={'AGENT_HANDOFFS_DIR': None, 'HOME': str(home), 'TMPDIR': str(home)})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue((home / 'out' / 'summary.json').is_file())
        self.assertEqual(replay_entries(), before)


if __name__ == '__main__':
    unittest.main()
