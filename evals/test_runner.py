import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DRIVER = Path(__file__).with_name('run.py')


class RunnerTests(unittest.TestCase):
    def test_adapter_receives_task_without_grading_criteria(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cases = root / 'cases.json'
            cases.write_text(json.dumps([{'id': 'one', 'skill': 'example', 'prompt': 'Rewrite this.',
                                         'criteria': ['secret grading criterion']}]))
            adapter = root / 'adapter with spaces.py'
            adapter.write_text('''import json, sys
data=json.load(sys.stdin)
assert 'criteria' not in data['case']
assert data['skill_file'] is None
assert data['metadata']['model'] == 'test-model'
print(json.dumps({'output':'result', 'trace':[], 'usage':{'input_tokens':None}}))
''')
            output = root / 'output.json'
            command = [sys.executable, str(DRIVER), '--cases', str(cases), '--skill-root', str(root),
                       '--runtime', 'test', '--runtime-version', '1', '--model', 'test-model',
                       '--effort', 'default', '--revision', 'fixture', '--variant', 'no-skill',
                       '--output', str(output), '--runner', sys.executable, str(adapter)]
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads(output.read_text())['results'][0]
            self.assertEqual(result['result']['output'], 'result')
            self.assertEqual(result['criteria'], ['secret grading criterion'])
            self.assertIsNone(result['result']['usage']['input_tokens'])
            # Evidence is never silently overwritten by a second comparison run.
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_failed_adapter_is_not_a_successful_eval(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'cases.json').write_text(json.dumps([{'id':'bad','skill':'example','prompt':'task','criteria':[]}]))
            output = root / 'out.json'
            run = subprocess.run([sys.executable, str(DRIVER), '--cases', str(root/'cases.json'),
                                  '--skill-root', str(root), '--runtime', 'test', '--runtime-version', '1',
                                  '--model', 'test', '--effort', 'default', '--revision', 'fixture',
                                  '--variant', 'no-skill', '--output', str(output), '--runner',
                                  sys.executable, '-c', 'raise SystemExit(7)'], capture_output=True)
            self.assertEqual(run.returncode, 1)
            result = json.loads(output.read_text())['results'][0]
            self.assertEqual(result['exit_code'], 7)
            self.assertNotIn('result', result)


if __name__ == '__main__':
    unittest.main()
