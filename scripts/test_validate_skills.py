"""Mutation tests for scripts/validate-skills.rb: each case edits a throwaway copy of the repo."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent
RUBY = os.environ.get('RUBY', 'ruby')
BUDGET = 20000
OFFLOAD = 'skills/core/offload/SKILL.md'
PR_REVIEW = 'skills/core/pr-review/SKILL.md'
UNLISTED_BIG = 'skills/core/do/SKILL.md'
TEMPLATE = 'skills/core/offload/builder-template.md'
COMMAND = 'commands/pre-push.md'


class ValidateSkillsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / 'repo'
        shutil.copytree(REPO, self.root, symlinks=True, ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__'))

    def validate(self):
        done = subprocess.run([RUBY, str(self.root / 'scripts/validate-skills.rb')], stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, universal_newlines=True)
        return done.returncode, done.stdout

    def read(self, rel): return (self.root / rel).read_bytes()
    def write(self, rel, data): (self.root / rel).write_bytes(data)

    def edit_text(self, rel, fn):
        self.write(rel, fn(self.read(rel).decode('utf-8')).encode('utf-8'))

    def pad_to(self, rel, size):
        data = self.read(rel)
        self.assertLessEqual(len(data), size)
        self.write(rel, data + b'x' * (size - len(data)))

    def rename_label(self, old, new):
        def swap(text):
            start = text.index('```text\n'); end = text.index('\n```', start + 8)
            body = re.sub('^' + re.escape(old), new, text[start:end], count=1, flags=re.M)
            return text[:start] + body + text[end:]
        self.edit_text(TEMPLATE, swap)

    def assertFails(self, expect, *names):
        code, out = self.validate()
        self.assertEqual(code, 1, out)
        for name in (expect,) + names: self.assertIn(name, out)
        return out

    def test_clean_tree_passes_and_names_no_allowlisted_file(self):
        code, out = self.validate()
        self.assertEqual(code, 0, out)
        self.assertNotIn(OFFLOAD, out); self.assertNotIn(PR_REVIEW, out)

    def test_unlisted_skill_over_budget_fails_at_one_byte_over_only(self):
        self.pad_to(UNLISTED_BIG, BUDGET)
        self.assertEqual(self.validate()[0], 0)
        self.pad_to(UNLISTED_BIG, BUDGET + 1)
        self.assertFails(UNLISTED_BIG)

    def test_budget_counts_bytes_not_characters(self):
        data = self.read(UNLISTED_BIG)
        pad = 'é' * ((BUDGET + 1 - len(data) + 1) // 2)
        self.write(UNLISTED_BIG, data + pad.encode('utf-8'))
        self.assertLessEqual(len(self.read(UNLISTED_BIG).decode('utf-8')), BUDGET)
        self.assertFails(UNLISTED_BIG)

    def test_skill_outside_the_manifest_has_no_budget(self):
        d = self.root / 'skills/core/zz-unlisted'; d.mkdir()
        (d / 'SKILL.md').write_text('---\nname: zz-unlisted\ndescription: x\n---\n' + 'x' * 30000)
        self.assertEqual(self.validate()[0], 0)

    def test_allowlisted_skill_fails_when_it_grows(self):
        for rel in (OFFLOAD, PR_REVIEW):
            with self.subTest(rel=rel):
                original = self.read(rel)
                self.write(rel, original + b'x')
                self.assertFails(rel)
                self.write(rel, original)

    def test_allowlisted_skill_at_budget_says_remove_from_allowlist(self):
        text = self.read(OFFLOAD)[:BUDGET].decode('utf-8', 'ignore')
        self.write(OFFLOAD, (text + ' ' * (BUDGET - len(text.encode('utf-8')))).encode('utf-8'))
        self.assertFails('remove from allowlist', OFFLOAD)

    def test_allowlisted_skill_that_shrank_prints_a_note_with_its_new_size(self):
        data = self.read(OFFLOAD)[:-1]
        self.write(OFFLOAD, data)
        code, out = self.validate()
        self.assertEqual(code, 0, out)
        self.assertIn(OFFLOAD, out); self.assertIn(str(len(data)), out)

    def test_allowlist_entry_that_is_not_a_manifest_skill_fails(self):
        self.edit_text('scripts/validate-skills.rb', lambda t: t.replace("'" + PR_REVIEW + "' =>", "'skills/core/gone/SKILL.md' =>", 1))
        self.assertFails('skills/core/gone/SKILL.md')

    def test_builder_template_labels_must_start_a_line_inside_the_fence(self):
        for old, new in (('Acceptance:', 'Criteria:'), ('Gates:', 'Checks:'), ('Result file:', 'Output file:')):
            with self.subTest(label=old):
                original = self.read(TEMPLATE)
                self.rename_label(old, new)
                self.assertFails(TEMPLATE, old)
                self.write(TEMPLATE, original)

    def test_builder_template_needs_exactly_one_text_fence(self):
        original = self.read(TEMPLATE)
        self.write(TEMPLATE, original + b'\n```text\nextra\n```\n')
        self.assertFails(TEMPLATE)
        self.write(TEMPLATE, original.replace(b'```text\n', b'```\n', 1))
        self.assertFails(TEMPLATE)

    def test_removing_a_pinned_phrase_names_it(self):
        for rel, phrase in ((COMMAND, 'Gate Integrity'), (TEMPLATE, 'RED chronology')):
            with self.subTest(rel=rel):
                original = self.read(rel)
                self.edit_text(rel, lambda t: t.replace(phrase, ''))
                self.assertFails('%s: frozen phrase missing: "%s"' % (rel, phrase))
                self.write(rel, original)


if __name__ == '__main__':
    unittest.main()
