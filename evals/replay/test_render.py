import json
from pathlib import Path
import re
import subprocess
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture  # noqa: E402
import support  # noqa: E402

FENCE = re.compile(r'^```text\n(.*?)^```$', re.S | re.M)


def fence_lines(template):
    return FENCE.search(template).group(1).splitlines()


def real_template():
    return subprocess.run(['git', 'show', f'{support.BASE_REF}:{support.TEMPLATE_PATH}'], cwd=support.ROOT,
                          capture_output=True, text=True, check=True).stdout


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-render-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fx = fixture.build(self.tmp / 'fx')
        self.case = json.loads(self.fx.case_path.read_text())

    def run_fake(self, **kw):
        out = self.tmp / 'out'
        run = support.replay(self.fx, out, **kw)
        return run, out

    def brief(self, out, arm):
        return (support.trial_dir(out, arm) / 'brief.md').read_text()

    def test_94bdb26_template_renders_only_the_labeled_lines(self):
        run, out = self.run_fake()
        self.assertEqual(run.returncode, 0, run.stderr)
        template = fence_lines(real_template())
        rendered = self.brief(out, 'current').splitlines()
        # a: the output is the fence content, not the file around it
        self.assertNotIn('# Builder brief', rendered)
        self.assertFalse(any(line.startswith('```') for line in rendered))
        # b: exactly the template fence with the five labeled lines filled, nothing added or dropped
        self.assertEqual(rendered, self.expected(out, 'current', template))

    def expected(self, out, arm, template):
        record = support.load(support.trial_dir(out, arm) / 'builder-record.json')
        result = str(support.trial_dir(out, arm) / 'result.md')
        expect = []
        for line in template:
            if line.startswith('Execute <slice goal>'):
                expect.append(line.replace('<slice goal>', self.case['goal']).replace('<absolute worktree>', record['cwd'])
                              .replace('<branch>', record['branch']))
            elif line.startswith('Owned files: '):
                expect.append(line.replace('<paths>', self.case['owned_files'], 1))
            elif line.startswith('Acceptance:'):
                expect += ['Acceptance:', *self.case['criteria'].split('\n')]
            elif line.startswith('Gates:'):
                expect += ['Gates:', *self.case['gates_text'].split('\n')]
            elif line.startswith('Result file:'):
                expect.append(line.replace('<path>', result))
            else:
                expect.append(line)
        return expect

    def test_acceptance_and_gates_hold_the_case_text_verbatim(self):
        run, out = self.run_fake()
        text = self.brief(out, 'current')
        self.assertIn('Acceptance:\n' + self.case['criteria'] + '\n', text)
        self.assertIn('Gates:\n' + self.case['gates_text'] + '\n', text)

    def test_execute_owned_and_result_lines_are_filled(self):
        run, out = self.run_fake()
        lines = self.brief(out, 'current').splitlines()
        record = support.load(support.trial_dir(out, 'current') / 'builder-record.json')
        execute = lines[0]
        self.assertTrue(execute.startswith('Execute ' + self.case['goal'] + ' in '), execute)
        self.assertIn(record['cwd'], execute)
        self.assertIn(record['branch'], execute)
        self.assertEqual(lines[1], 'Owned files: ' + self.case['owned_files'] + '. Protected paths: <paths>.')
        result = [line for line in lines if line.startswith('Result file:')]
        self.assertEqual(result, [f"Result file: {support.trial_dir(out, 'current') / 'result.md'}. Handoff: $OFFLOAD_HANDOFF."])

    def test_fixture_template_with_extra_paragraph_keeps_it_byte_identical(self):
        run, out = self.run_fake()
        template = fence_lines((self.fx.skills_repo / support.TEMPLATE_PATH).read_text())
        rendered = self.brief(out, 'revised').splitlines()
        self.assertEqual(rendered, self.expected(out, 'revised', template))
        self.assertTrue(any('mentions Acceptance: mid-line' in line for line in rendered))
        self.assertIn('\nResult file: ' + str(support.trial_dir(out, 'revised') / 'result.md') + '\n', self.brief(out, 'revised'))

    def refused(self, template, hint=''):
        self.count = getattr(self, 'count', 0) + 1
        fx = fixture.build(self.tmp / f'bad{self.count}', template=template)
        marker = self.tmp / f'marker{self.count}'
        builder = support.write_stub(self.tmp / 'b.py', support.STUB_BUILDER)
        run = support.run_cli(support.RUNNER, [
            '--cases', fx.cases_dir, '--output', self.tmp / f'out-bad{self.count}', '--current-ref', support.BASE_REF,
            '--revised-ref', 'HEAD', '--revised-skills-repo', fx.skills_repo, '--spend',
            '--builder-adapter', builder, '--fake-grader', '--gate-env', 'STUB_MARKER'], env={'STUB_MARKER': str(marker)})
        self.assertEqual(run.returncode, 2, hint + run.stderr)
        self.assertIn('refusing', run.stderr)
        self.assertFalse(marker.exists(), hint)
        return run

    def good(self):
        return (self.fx.skills_repo / support.TEMPLATE_PATH).read_text()

    def test_template_with_no_text_fence_is_refused(self):
        self.refused('# t\n\nno fence here\n')

    def test_template_with_two_text_fences_is_refused(self):
        self.refused(self.good() + '\n' + self.good())

    def test_template_missing_a_label_is_refused(self):
        for label in ['Execute <slice goal>', 'Owned files: <paths>', 'Acceptance:', 'Gates:', 'Result file:']:
            with self.subTest(label=label):
                lines = [line for line in self.good().split('\n') if not line.startswith(label)]
                self.refused('\n'.join(lines), label)

    def test_template_with_a_duplicated_label_is_refused(self):
        for label in ['Execute <slice goal>', 'Owned files:', 'Acceptance:', 'Gates:', 'Result file:']:
            with self.subTest(label=label):
                text = self.good()
                line = next(l for l in text.split('\n') if l.startswith(label))
                self.refused(text.replace(line, line + '\n' + line, 1), label)


if __name__ == '__main__':
    unittest.main()
