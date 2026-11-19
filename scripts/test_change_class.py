import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).with_name('change-class.py').resolve()


class ChangeClassTests(unittest.TestCase):
    def run_helper(self, paths, rules=None, separator='\0'):
        args = [sys.executable, str(HELPER)]
        if rules is not None:
            temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
            (Path(temp.name) / 'risk-paths.txt').write_text(rules)
            args += ['--rules-dir', temp.name]
        done = subprocess.run(args, input=separator.join(paths), capture_output=True, text=True)
        return done, (json.loads(done.stdout) if done.returncode == 0 else None)

    def classes(self, result):
        return {entry['path']: entry['class'] for entry in result['files']}

    def test_prose_only_change_skips_security_and_is_low(self):
        _, result = self.run_helper(['README.md', 'docs/guide.rst', 'LICENSE', 'docs/shot.png'])
        self.assertEqual(result['security_pass'], 'SKIP')
        self.assertEqual(result['tier_floor'], 'LOW')
        self.assertFalse(result['person_required'])

    def test_instruction_markdown_is_not_prose(self):
        paths = ['skills/core/do/SKILL.md', 'AGENTS.md', 'commands/pre-push.md', '.claude/notes.md']
        _, result = self.run_helper(paths)
        self.assertEqual(set(self.classes(result).values()), {'instructions'})
        self.assertEqual(result['security_pass'], 'REQUIRED')
        self.assertEqual(result['tier_floor'], 'MEDIUM')

    def test_one_code_file_makes_the_pass_required(self):
        _, result = self.run_helper(['README.md', 'src/app.py'])
        self.assertEqual(result['security_pass'], 'REQUIRED')
        self.assertEqual(result['tier_floor'], 'MEDIUM')

    def test_requirements_txt_is_a_dependency_not_prose(self):
        _, result = self.run_helper(['requirements-dev.txt', 'package-lock.json'])
        self.assertEqual(set(self.classes(result).values()), {'dependencies'})
        self.assertEqual(result['security_pass'], 'REQUIRED')

    def test_ci_migration_and_path_words_need_a_person(self):
        for path in ['.github/workflows/ci.yml', 'db/migrations/001_add.rb', 'src/billing/send.ts']:
            _, result = self.run_helper([path])
            self.assertTrue(result['person_required'], path)
            self.assertEqual(result['tier_floor'], 'MEDIUM', path)

    def test_a_path_word_in_prose_does_not_need_a_person(self):
        _, result = self.run_helper(['docs/authentication.md'])
        self.assertFalse(result['person_required'])
        self.assertEqual(result['tier_floor'], 'LOW')

    def test_owner_high_rule_sets_the_floor(self):
        _, result = self.run_helper(['src/ledger/post.py', 'README.md'], rules='high src/ledger/*\n')
        self.assertEqual(result['tier_floor'], 'HIGH')
        self.assertTrue(result['person_required'])

    def test_owner_low_rule_lowers_code_but_never_instructions_or_sensitive_paths(self):
        rules = '# internal tools\nlow tools/*\nlow skills/*\nlow src/auth/*\n'
        _, result = self.run_helper(['tools/report.py'], rules=rules)
        self.assertEqual(result['tier_floor'], 'LOW')
        self.assertEqual(result['security_pass'], 'REQUIRED')
        _, result = self.run_helper(['skills/x/SKILL.md'], rules=rules)
        self.assertEqual(result['tier_floor'], 'MEDIUM')
        _, result = self.run_helper(['src/auth/login.py'], rules=rules)
        self.assertEqual(result['tier_floor'], 'MEDIUM')
        self.assertTrue(result['person_required'])

    def test_high_wins_over_low_for_the_same_path(self):
        _, result = self.run_helper(['tools/pay.py'], rules='low tools/*\nhigh tools/pay.py\n')
        self.assertEqual(result['tier_floor'], 'HIGH')

    def test_bad_rule_line_is_reported_and_skipped(self):
        _, result = self.run_helper(['src/app.py'], rules='urgent src/*\nhigh\n')
        self.assertEqual(len(result['rule_problems']), 2)
        self.assertEqual(result['tier_floor'], 'MEDIUM')

    def test_newline_input_and_missing_rules_file(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        done = subprocess.run([sys.executable, str(HELPER), '--rules-dir', temp.name],
                              input='a.py\nb.md\n', capture_output=True, text=True)
        result = json.loads(done.stdout)
        self.assertEqual(len(result['files']), 2)
        self.assertEqual(result['rule_problems'], [])

    def test_empty_input_exits_2(self):
        done, _ = self.run_helper([])
        self.assertEqual(done.returncode, 2)


if __name__ == '__main__':
    unittest.main()
