"""Mutation tests for scripts/validate-skills.py: each case edits a throwaway copy of the repo."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent
UV = os.environ.get('UV', 'uv')
BUDGET = 20000
OFFLOAD = 'skills/core/offload/SKILL.md'
PR_REVIEW = 'skills/core/pr-review/SKILL.md'
UNLISTED_BIG = 'skills/core/do/SKILL.md'
TEMPLATE = 'skills/core/offload/builder-template.md'
COMMAND = 'commands/pre-push.md'
PERSONAL = 'see /Users/' + 'jdoe/x/\n'
GIT = shutil.which('git')
# What uv needs to run the validator. Nothing else of this process's environment reaches it.
UV_NEEDS = ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'UV_CACHE_DIR',
            'UV_PYTHON', 'UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_DOWNLOADS', 'UV_PYTHON_PREFERENCE', 'UV_OFFLINE',
            'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE')


def git(repo, home, *args):
    env = {'PATH': os.environ.get('PATH', os.defpath), 'HOME': str(home), 'GIT_CONFIG_GLOBAL': os.devnull,
           'GIT_CONFIG_NOSYSTEM': '1'}
    return subprocess.run([GIT, '-C', str(repo), *args], env=env, capture_output=True, check=True)


def copy_repo(source, dest, home):
    """Copy the files git shows for `source`: tracked, plus untracked and not ignored. A link is copied as a link."""
    source = Path(source).resolve()
    listed = git(source, home, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').stdout
    dest.mkdir()
    for rel in (os.fsdecode(raw) for raw in listed.split(b'\0') if raw):
        path = source / rel
        # Left out: deleted and not staged, a directory, a path under a link, and a hard link.
        if path.parent.resolve() != path.parent or not (path.is_symlink() or path.is_file() and path.lstat().st_nlink == 1):
            continue
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest / rel, follow_symlinks=False)


class ValidateSkillsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.home = self.tmp / 'home'; self.home.mkdir()
        self.root = self.tmp / 'repo'
        copy_repo(REPO, self.root, self.home)

    def validate(self, **extra):
        env = {**{k: os.environ[k] for k in UV_NEEDS if k in os.environ}, **extra}
        done = subprocess.run([UV, 'run', '--quiet', '--script', str(self.root / 'scripts/validate-skills.py')], stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, universal_newlines=True, env=env)
        return done.returncode, done.stdout

    def git(self, *args): git(self.root, self.home, *args)

    def plant(self, rel, text=PERSONAL):
        (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
        (self.root / rel).write_text(text)

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
        self.edit_text('scripts/validate-skills.py', lambda t: t.replace("'" + PR_REVIEW + "':", "'skills/core/gone/SKILL.md':", 1))
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


    def test_readme_must_list_every_skill_command_and_agent_and_no_extra(self):
        cases = (
            ('README.md', lambda t: t.replace('| **dream** |', '| **dreams** |'), 'README.md: skill dream has no'),
            ('README.md', lambda t: t.replace('| `/status` |', '| `/statuz` |'), 'README.md: commands/status.md is not in the Commands table'),
            ('README.md', lambda t: t.replace('| `/status` |', '| `/status` |\n| `/offload` | x |\n|'), 'README.md: the Commands table lists offload'),
            ('README.md', lambda t: t.replace('| **triage** |', '| **triage** | a | b |\n| **helper** |'), 'README.md: the Agents table lists helper'),
            ('docs/skills.md', lambda t: t.replace('| [triage](#triage-agent)', '| [workflow-orchestrator](#x) | y |\n| [triage](#triage-agent)'),
             'docs/skills.md: the Agents table lists workflow-orchestrator'),
            ('README.md', lambda t: t.replace('`PreToolUse` (', 'PreToolUse ('), 'README.md: the Hooks section does not name the PreToolUse event'),
        )
        for rel, fn, message in cases:
            with self.subTest(message=message):
                original = self.read(rel)
                self.edit_text(rel, fn)
                self.assertNotEqual(self.read(rel), original, 'the mutation applied')
                self.assertFails(message)
                self.write(rel, original)

    def test_a_new_command_file_must_be_documented(self):
        self.write('commands/brand-new.md', b'---\ndescription: x\n---\nx\n')
        self.assertFails('README.md: commands/brand-new.md is not in the Commands table')

    def test_personal_home_paths_fail_and_placeholders_pass(self):
        self.edit_text('AGENTS.md', lambda t: '@/Users/' + 'realperson/.codex/RTK.md\n\n' + t)
        self.assertFails('AGENTS.md:1: personal path')
        self.edit_text('AGENTS.md', lambda t: t.replace('/Users/' + 'realperson/', '/home/' + 'realperson/'))
        self.assertFails('AGENTS.md:1: personal path')
        self.edit_text('AGENTS.md', lambda t: t.replace('/home/' + 'realperson/', '/Users/me/'))
        self.assertEqual(self.validate()[0], 0)

    def test_a_new_unpinned_git_spawn_fails_unless_pinned_in_a_test_or_baselined(self):
        rel, spawn = 'skills/core/do/repo-rules-key.mjs', "execFileSync('git', ['status'], { encoding: 'utf8' });\n"
        original = self.read(rel)
        line = len(original.decode('utf-8').splitlines()) + 1
        self.write(rel, original + spawn.encode('utf-8'))
        self.assertFails('%s:%d: git spawn does not pin' % (rel, line))
        self.write(rel, original + spawn.replace('{ encoding', '{ env: GIT_ENV, encoding').encode('utf-8'))
        self.assertEqual(self.validate()[0], 0)
        self.write(rel, original)
        self.write('skills/core/do/test_zz_spawn.mjs', spawn.encode('utf-8'))
        self.assertEqual(self.validate()[0], 0)
        self.edit_text('scripts/git-spawn-baseline.txt', lambda t: t + 'skills/core/desk/runs.mjs 9\n')
        self.edit_text('skills/core/desk/runs.mjs', lambda t: t + spawn)
        self.assertEqual(self.validate()[0], 0)

    def test_a_baseline_entry_with_no_unpinned_spawn_must_go(self):
        self.edit_text('scripts/git-spawn-baseline.txt', lambda t: t + 'skills/core/do/memory-store.mjs 1\n')
        self.assertFails('skills/core/do/memory-store.mjs has no unpinned git spawn; remove its entry')

    def test_copy_keeps_tracked_symlinks_as_links(self):
        for rel, target in (('plugins/bork', '..'), ('gemini-extension.json', '.claude-plugin/plugin.json')):
            self.assertEqual(os.readlink(REPO / rel), target)
            self.assertTrue(os.path.islink(self.root / rel), rel)
            self.assertEqual(os.readlink(self.root / rel), target)
        # a source tree with a symlink and a hard link to an outside file, and a tracked file deleted but not staged
        work = self.tmp / 'links'
        source, dest, outside = work / 'source', work / 'dest', work / 'outside.txt'
        source.mkdir(parents=True)
        outside.write_text('outside\n')
        (source / 'kept.md').write_text('kept\n')
        (source / 'gone.md').write_text('gone\n')
        os.symlink(outside, source / 'link')
        os.link(outside, source / 'hard')
        git(source, self.home, 'init', '-q')
        git(source, self.home, 'add', 'kept.md', 'gone.md', 'link', 'hard')
        (source / 'gone.md').unlink()
        state = lambda: (outside.read_bytes(), outside.stat().st_mode, outside.stat().st_mtime_ns, outside.stat().st_nlink)
        before = state()
        copy_repo(source, dest, self.home)
        self.assertEqual(sorted(p.name for p in dest.iterdir()), ['kept.md', 'link'])
        self.assertEqual(os.readlink(dest / 'link'), str(outside))
        self.assertEqual(state(), before)
        self.assertEqual(sorted(p.name for p in work.iterdir()), ['dest', 'outside.txt', 'source'])

    def test_gitignored_paths_are_not_scanned(self):
        self.git('init', '-q')
        self.plant('output/x/bad.md')
        self.plant('output/nested/bad.md')  # git names a repository inside an ignored dir as `output/nested/`
        git(self.root / 'output/nested', self.home, 'init', '-q')
        self.plant('scripts/output/bad.mjs', "execFileSync('git', ['status']);\n")  # the git spawn check skips it too
        code, out = self.validate()
        self.assertEqual(code, 0, out)

    def test_tracked_file_with_personal_path_still_fails_in_a_git_checkout(self):
        self.git('init', '-q')
        self.plant('zz-tracked.md')
        self.git('add', 'zz-tracked.md')
        self.assertFails('zz-tracked.md:1: personal path')

    def test_untracked_unignored_file_with_personal_path_still_fails(self):
        self.git('init', '-q')
        self.plant('scripts/zz-probe.md')
        self.assertFails('scripts/zz-probe.md:1: personal path')

    def test_force_added_file_under_an_ignored_dir_still_fails(self):
        self.git('init', '-q')
        self.plant('output/x/bad.md')
        self.git('add', '-f', 'output/x/bad.md')
        self.assertFails('output/x/bad.md:1: personal path')

    def test_git_failure_scans_everything(self):
        self.plant('scripts/zz-probe.md')
        self.plant('output/x/bad.md')
        both = ('scripts/zz-probe.md:1: personal path', 'output/x/bad.md:1: personal path')
        with self.subTest('not a git work tree'):
            self.assertFails(*both)
        with self.subTest('inside a repository that ignores this whole tree'):
            git(self.tmp, self.home, 'init', '-q')
            (self.tmp / '.gitignore').write_text('repo/\n')
            self.assertFails(*both)
        with self.subTest('git is not on PATH'):
            self.git('init', '-q')
            tools = self.tmp / 'tools'; tools.mkdir()
            os.symlink(shutil.which(UV), tools / 'uv')
            os.symlink(sys.executable, tools / 'python3')
            self.assertIsNone(shutil.which('git', path=str(tools)))
            code, out = self.validate(PATH=str(tools))
            self.assertEqual(code, 1, out)
            self.assertNotIn('Traceback', out)
            for name in both: self.assertIn(name, out)

    def test_hostile_git_env_does_not_change_what_is_scanned(self):
        self.git('init', '-q')
        self.plant('output/x/bad.md')
        # a git first on PATH that records the environment the validator gives it, then runs the real one
        spy, seen = self.tmp / 'spy', self.tmp / 'git-env.txt'
        spy.mkdir()
        (spy / 'git').write_text(f'#!/bin/sh\n/usr/bin/env > "{seen}"\nexec "{GIT}" "$@"\n')
        (spy / 'git').chmod(0o755)
        hostile = {'GIT_DIR': '/nonexistent', 'GIT_WORK_TREE': '/', 'GIT_INDEX_FILE': '/nonexistent', 'ZZ_CANARY': '1',
                   'PATH': f'{spy}{os.pathsep}{os.environ["PATH"]}'}
        code, out = self.validate(**hostile)
        self.assertEqual(code, 0, out)
        for name in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'ZZ_CANARY', 'HOME'):
            self.assertNotRegex(seen.read_text(), rf'(?m)^{name}=')
        self.plant('zz-tracked.md')
        self.git('add', 'zz-tracked.md')
        code, out = self.validate(**hostile)
        self.assertEqual(code, 1, out)
        self.assertIn('zz-tracked.md:1: personal path', out)


if __name__ == '__main__':
    unittest.main()
