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


class GraderSealTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-seal-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / 'out'
        self.fx = fixture.build(self.tmp / 'fx', gates=('echo GATE-OK-STRING',))
        run = support.replay(self.fx, self.out)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.raw = (support.trial_dir(self.out, 'current') / 'grader-stdin.json').read_text()
        self.data = json.loads(self.raw)

    def test_commit_message_and_work_summary_sentinels_never_reach_the_grader(self):
        self.assertNotIn(fake_adapter.SENTINEL_COMMIT, self.raw)
        self.assertNotIn(fake_adapter.SENTINEL_SUMMARY, self.raw)
        # the sentinels do exist on disk, so the absence above is meaningful
        trial = support.trial_dir(self.out, 'current')
        self.assertIn(fake_adapter.SENTINEL_SUMMARY, (trial / 'result.md').read_text())
        self.assertIn(fake_adapter.SENTINEL_SUMMARY, (trial / 'handoff.md').read_text())
        self.assertIn('## Work summary', (trial / 'handoff.md').read_text())

    def test_input_holds_the_diff_the_criteria_and_the_gate_output(self):
        self.assertIn(fake_adapter.ADDED_LINE, self.data['diff'])
        for line in json.loads(self.fx.case_path.read_text())['criteria'].splitlines():
            self.assertIn(line, self.data['criteria'])
        self.assertIn('GATE-OK-STRING', self.data['gate_output'])

    def test_input_keys_are_exactly_the_documented_set(self):
        self.assertEqual(set(self.data), {'id', 'diff', 'criteria', 'gate_output'})


if __name__ == '__main__':
    unittest.main()
