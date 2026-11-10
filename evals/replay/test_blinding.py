"""The builder must not learn which criterion was missed; the grader must see only the sealed input."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_adapter  # noqa: E402
import fixture  # noqa: E402
import support  # noqa: E402

CASE_ID = 'somerun-S1-r1-C2'  # the shape build_cases.py used to write: <run>-<slice>-r<round>-<missed ID>
DUMP = '''
report = {'cwd': os.getcwd(), 'listing': sorted(os.listdir('.')), 'env': dict(os.environ),
          'stdin': sys.stdin.read(), 'argv': sys.argv}
import subprocess
repo = os.environ.get('STUB_REPO')
if repo:
    report['worktrees'] = subprocess.run(['git', '-C', repo, 'worktree', 'list', '--porcelain'],
                                         capture_output=True, text=True).stdout
open(os.environ['STUB_REPORT'], 'w').write(json.dumps(report))
'''


class BlindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-blind-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / 'out'
        self.fx = fixture.build(self.tmp / 'fx', case_id=CASE_ID)

    def trial_dirs(self):
        return sorted(p for p in (self.out / 'trials').iterdir())

    def test_missed_id_stays_out_of_the_brief_branch_paths_request_env_and_grader_id(self):
        report = self.tmp / 'builder-report.json'
        builder = support.write_stub(self.tmp / 'b.py', DUMP + 'print(json.dumps({"status": "ok"}))\n')
        args = [a for a in support.std_args(self.fx, self.out) if a != '--fake']
        run = support.run_cli(support.RUNNER, args + ['--spend', '--builder-adapter', builder, '--fake-grader'],
                              env={'STUB_REPORT': str(report)})
        seen = json.loads(report.read_text())
        # the builder's request, minus the brief, and its environment
        request = json.loads(seen['stdin'])
        brief = request.pop('brief')
        self.assertNotIn('C2', json.dumps(request))
        self.assertFalse([k for k, v in seen['env'].items() if 'C2' in v or 'C2' in k], 'missed ID in env')
        self.assertNotIn(CASE_ID, json.dumps(request))
        self.assertNotIn('C2', request['branch'])
        # the brief names the ID only inside the Acceptance block
        lines = brief.split('\n')
        acceptance, gates = lines.index('Acceptance:'), lines.index('Gates:')
        outside = [l for i, l in enumerate(lines) if not acceptance < i < gates and 'C2' in l]
        self.assertEqual(outside, [])
        self.assertTrue(any('C2' in l for l in lines[acceptance:gates]))
        # no trial directory, result path or sealed grader field carries it
        for path in self.out.joinpath('trials').rglob('*'):
            self.assertNotIn('C2', path.relative_to(self.out / 'trials').as_posix())
        self.assertEqual(sorted(p.name for p in self.trial_dirs() if 'C2' in p.name), [])

    def test_sealed_grader_input_names_neither_the_case_nor_the_missed_id_outside_criteria(self):
        run = support.replay(self.fx, self.out)
        self.assertEqual(run.returncode, 0, run.stderr)
        for trial in self.trial_dirs():
            sealed = json.loads((trial / 'grader-stdin.json').read_text())
            for field in ('id', 'diff', 'gate_output'):
                self.assertNotIn('C2', sealed[field], field)
                self.assertNotIn(CASE_ID, sealed[field], field)
                self.assertNotRegex(sealed[field], r'current|revised', field)

    def test_grader_process_cannot_reach_the_narration_the_worktree_or_the_arm(self):
        report = self.tmp / 'grader-report.json'
        grader = support.write_stub(self.tmp / 'g.py', DUMP + 'print(json.dumps({"grades": {"C1": "MET", "C2": "MET", "C3": "MET"}}))\n')
        args = [a for a in support.std_args(self.fx, self.out) if a != '--fake']
        run = support.run_cli(support.RUNNER, args + ['--spend', '--fake-builder', '--grader-adapter', grader],
                              env={'STUB_REPORT': str(report), 'STUB_REPO': str(self.fx.repo),
                                   'OFFLOAD_HANDOFF': '/nowhere/handoff.md', 'REPLAY_TRIAL_DIR': '/nowhere'})
        self.assertEqual(run.returncode, 0, run.stderr)
        seen = json.loads(report.read_text())
        self.assertEqual(seen['listing'], [], 'the grader starts in an empty directory')
        self.assertFalse(Path(seen['cwd']).is_relative_to(self.out))
        for name in ('OFFLOAD_HANDOFF', 'REPLAY_TRIAL_DIR', 'AGENT_HANDOFFS_DIR', 'REPLAY_FAKE_KEY'):
            self.assertNotIn(name, seen['env'])
        blob = json.dumps(seen['env'])
        for forbidden in (fake_adapter.SENTINEL_SUMMARY, fake_adapter.SENTINEL_COMMIT, 'trials/'):
            self.assertNotIn(forbidden, blob)
        self.assertNotRegex(blob, r'/(current|revised)[/-]\d|synthetic/(current|revised)')
        # the diff is captured and the worktree is gone before the grader starts
        self.assertEqual(seen['worktrees'].count('worktree '), 1, seen['worktrees'])
        self.assertNotRegex(seen['stdin'], r'current|revised')


if __name__ == '__main__':
    unittest.main()
