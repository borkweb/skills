import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture  # noqa: E402
import support  # noqa: E402

REQUIRED = ['id', 'repo', 'base_commit', 'goal', 'owned_files', 'criteria', 'gates_text', 'gate_commands',
            'missed_ids', 'provenance']


class CaseFormatTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-case-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fx = fixture.build(self.tmp / 'fx')

    def edit_case(self, mutate):
        case = json.loads(self.fx.case_path.read_text())
        mutate(case)
        self.fx.case_path.write_text(json.dumps(case))

    def check(self):
        return support.run_cli(support.RUNNER, ['--check', '--cases', self.fx.cases_dir])

    def test_synthetic_case_parses_with_the_runner_parser(self):
        run = self.check()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn('synthetic', run.stdout)

    def test_missing_required_field_is_rejected_by_name_without_adapter_call(self):
        for field in REQUIRED:
            with self.subTest(field=field):
                self.setUp()
                self.edit_case(lambda c: c.pop(field))
                marker = self.tmp / 'marker'
                builder = support.write_stub(self.tmp / 'b.py', support.STUB_BUILDER)
                grader = support.write_stub(self.tmp / 'g.py', support.STUB_GRADER)
                run = support.run_cli(support.RUNNER, [
                    '--cases', self.fx.cases_dir, '--output', self.tmp / 'out', '--current-ref', support.BASE_REF,
                    '--revised-ref', 'HEAD', '--revised-skills-repo', self.fx.skills_repo, '--spend',
                    '--builder-adapter', builder, '--grader-adapter', grader, '--gate-env', 'STUB_MARKER'],
                    env={'STUB_MARKER': str(marker)})
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(f'missing required field {field}', run.stderr)
                self.assertFalse(marker.exists())

    def test_base_commit_must_be_a_full_hex_object_id(self):
        for bad in ['HEAD', 'main', '', 'abc']:
            with self.subTest(base=bad):
                self.edit_case(lambda c: c.update(base_commit=bad))
                run = self.check()
                self.assertNotEqual(run.returncode, 0)
                self.assertIn('base_commit', run.stderr)

    def test_missed_id_must_lead_a_criteria_line(self):
        self.edit_case(lambda c: c.update(missed_ids=['C9']))
        run = self.check()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('C9', run.stderr)

    def test_missed_id_inside_a_longer_id_does_not_count(self):
        self.edit_case(lambda c: c.update(criteria='C10: only ten.\nC2: two.', missed_ids=['C1']))
        self.assertNotEqual(self.check().returncode, 0)

    def test_criteria_without_any_id_are_rejected(self):
        self.edit_case(lambda c: c.update(criteria='The code works.\nIt is fast.', missed_ids=[]))
        run = self.check()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('criteria', run.stderr)

    def test_repo_path_must_exist_and_be_a_git_repo(self):
        plain = self.tmp / 'plain'
        plain.mkdir()
        for path in [str(self.tmp / 'nowhere'), str(plain)]:
            with self.subTest(path=path):
                self.edit_case(lambda c: c['repo'].update(path=path))
                run = self.check()
                self.assertNotEqual(run.returncode, 0)
                self.assertIn('repo', run.stderr)

    def test_gate_command_must_come_from_gates_text(self):
        self.edit_case(lambda c: c.update(gate_commands=['rm -rf nothing']))
        run = self.check()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('gate_commands', run.stderr)

    def test_multi_id_first_tokens_count_for_no_id(self):
        self.edit_case(lambda c: c.update(criteria='C3, C5b: both.\nC1/C2: pair.\nC1 and C2: pair.', missed_ids=[]))
        self.assertNotEqual(self.check().returncode, 0)

    def test_markdown_markers_before_an_id_are_skipped(self):
        self.edit_case(lambda c: c.update(criteria='- **C1.1** one\n| `C2a` | two |\n3. C4: four', missed_ids=['C1.1', 'C2a', 'C4']))
        self.assertEqual(self.check().returncode, 0)


if __name__ == '__main__':
    unittest.main()
