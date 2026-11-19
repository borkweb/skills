"""Observable snapshot, export, copy and cleanup contracts on disposable repositories."""
import ast
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import caselib
import snapshot

REPO = Path(__file__).resolve().parents[2]


def git(repo, *args, check=True):
    result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                             '-C', str(repo), *args], env=caselib.git_env(), capture_output=True)
    if check and result.returncode:
        raise AssertionError(result.stderr.decode())
    return result.stdout.decode().strip() if check else result


def init(path):
    path.mkdir()
    git(path, 'init', '-q', '-b', 'main', '--template=')
    return path


def commit(repo, name):
    (repo / (name + '.txt')).write_text(name)
    git(repo, 'add', '--', name + '.txt')
    git(repo, 'commit', '-qm', name)
    return git(repo, 'rev-parse', 'HEAD')


def fixture(root, side=False):
    src = init(root / 'source')
    for i in range(10):
        fork = commit(src, f'Z{i}')
    git(src, 'checkout', '-qb', 'side')
    commit(src, 'S1')
    git(src, 'checkout', '-q', 'main')
    for i in range(10):
        mb = commit(src, f'M{i}')
    git(src, 'checkout', '-qb', 'feature')
    commit(src, 'H1')
    if side:
        git(src, 'merge', '-q', '--no-ff', 'side', '-m', 'merge-side')
    head = commit(src, 'H2')
    git(src, 'checkout', '-qb', 'fix')
    fix = commit(src, 'FIX')
    git(src, 'tag', '-a', 'fix-tag', '-m', 'later-tag')
    tag = git(src, 'rev-parse', 'fix-tag')
    git(src, 'checkout', '-q', 'main')
    base = commit(src, 'E')
    git(src, 'checkout', '-q', '--orphan', 'unrelated')
    git(src, 'rm', '-qrf', '.')
    unrelated = commit(src, 'UNRELATED')
    git(src, 'checkout', '-q', 'main')
    return src, base, head, mb, fork, fix, tag, unrelated


class Scratch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='snapshot-test-')
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.env = patch.dict(os.environ, {**caselib.scrubbed_env(), 'HOME': str(self.home)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def wrapper(self, body):
        bindir = self.root / 'bin'
        bindir.mkdir(exist_ok=True)
        real = shutil.which('git')
        wrapper = bindir / 'git'
        wrapper.write_text(f'#!{sys.executable}\nimport os,sys,time,json\n' + body +
                           f'\nos.execve({real!r}, [{real!r}] + sys.argv[1:], dict(os.environ))\n')
        wrapper.chmod(0o755)
        return str(bindir) + os.pathsep + os.environ['PATH']


class ReplayMoveTests(unittest.TestCase):
    def test_run_replay_uses_snapshot_make_clone(self):
        import run_replay
        self.assertIs(run_replay.make_clone, snapshot.make_clone)
        old = subprocess.run(['git', 'show', '234ccd7:evals/replay/run_replay.py'],
                             capture_output=True, text=True, env=caselib.git_env(), check=True).stdout
        current = (REPO / 'evals/replay/run_replay.py').read_text()
        def functions(text):
            return {n.name: ast.get_source_segment(text, n) for n in ast.parse(text).body
                    if isinstance(n, ast.FunctionDef)}
        self.assertEqual(functions(old)['remove_tree'], functions(current)['remove_tree'])


class MakeSnapshotTests(Scratch):
    def setUp(self):
        super().setUp()
        self.src, self.base, self.head, self.mb, _, self.fix, self.tag, self.other = fixture(self.root)
        self.dest = self.root / 'snapshot'

    def build(self, base=None, head=None):
        result = snapshot.make_snapshot(self.src, base or self.base, head or self.head, self.dest, 10)
        self.assertEqual(result, (self.mb, None))
        return self.dest

    def test_linear_snapshot_has_merge_base_and_range(self):
        dest = self.build()
        self.assertRegex(self.mb, r'^[0-9a-f]{40}$')
        self.assertEqual(self.mb, git(self.src, 'merge-base', self.base, self.head))
        self.assertEqual(git(dest, 'merge-base', 'review-base', 'review-target'), self.mb)
        self.assertEqual(git(dest, 'rev-list', '--count', 'review-base..review-target'), '2')
        self.assertEqual(git(dest, 'rev-list', '--count', 'review-base..review-target'),
                         git(self.src, 'rev-list', '--count', self.base + '..' + self.head))

    def test_snapshot_holds_only_review_refs(self):
        dest = self.build()
        self.assertEqual(git(dest, 'for-each-ref', '--format=%(refname) %(objectname)').splitlines(),
                         [f'refs/heads/review-base {self.base}', f'refs/heads/review-target {self.head}'])
        self.assertEqual(git(dest, 'symbolic-ref', 'HEAD'), 'refs/heads/review-target')
        self.assertEqual(git(dest, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual(git(dest, 'status', '--porcelain'), '')

    def test_snapshot_has_no_remote_reflog_fetch_head_alternates_or_hooks(self):
        dot = self.build() / '.git'
        self.assertEqual(git(self.dest, 'remote'), '')
        for name in ('FETCH_HEAD', 'objects/info/alternates'):
            self.assertFalse((dot / name).exists(), name)
        self.assertTrue(all(p.stat().st_size == 0 for p in (dot / 'logs').rglob('*') if p.is_file()))
        self.assertTrue(all(p.name.endswith('.sample') for p in (dot / 'hooks').glob('*')))
        self.assertEqual((dot / 'shallow').read_text().splitlines(), [self.mb])

    def test_snapshot_omits_later_commits_and_tags(self):
        dest = self.build()
        for sha in (self.fix, self.tag, self.other):
            self.assertNotEqual(git(dest, 'cat-file', '-e', sha, check=False).returncode, 0)
        self.assertEqual(git(dest, 'tag'), '')

    def source_state(self):
        return [git(self.src, *args) for args in [('for-each-ref',), ('config', '--local', '--list'),
                ('worktree', 'list', '--porcelain')]] + [sorted(p.name for p in (self.src / '.git').iterdir())]

    def test_source_repo_unchanged(self):
        before = self.source_state()
        self.build()
        self.assertEqual(self.source_state(), before)

    def test_base_equal_to_merge_base(self):
        self.build(base=self.mb)
        self.assertEqual(git(self.dest, 'merge-base', 'review-base', 'review-target'), self.mb)

    def test_refuses_multiple_merge_bases(self):
        a = git(self.src, 'commit-tree', self.mb + '^{tree}', '-p', self.mb, '-m', 'a')
        b = git(self.src, 'commit-tree', self.mb + '^{tree}', '-p', self.mb, '-m', 'b')
        left = git(self.src, 'commit-tree', self.mb + '^{tree}', '-p', a, '-p', b, '-m', 'left')
        right = git(self.src, 'commit-tree', self.mb + '^{tree}', '-p', b, '-p', a, '-m', 'right')
        self.assertEqual(len(git(self.src, 'merge-base', '--all', left, right).splitlines()), 2)
        mb, error = snapshot.make_snapshot(self.src, left, right, self.dest, 10)
        self.assertIsNone(mb)
        self.assertRegex(error, r'^snapshot: merge-base: .*more than one')
        self.assertFalse(self.dest.exists())

    def test_refuses_no_merge_base(self):
        mb, error = snapshot.make_snapshot(self.src, self.base, self.other, self.dest, 10)
        self.assertIsNone(mb)
        self.assertTrue(error.startswith('snapshot: merge-base'))
        self.assertFalse(self.dest.exists())

    def test_missing_commit_is_a_snapshot_error(self):
        for base, head in [('0'*40, self.head), (self.base, '0'*40)]:
            with self.subTest(base=base, head=head):
                mb, error = snapshot.make_snapshot(self.src, base, head, self.dest, 10)
                self.assertIsNone(mb)
                self.assertRegex(error, r'^snapshot: [^:]+: .+')
                self.assertFalse(self.dest.exists())

    def test_refuses_too_deep(self):
        root = self.root / 'side'; root.mkdir()
        src, base, head, *_ = fixture(root, side=True)
        boundary = [s[1:] for s in git(src, 'rev-list', '--boundary', head, '^'+base).splitlines()
                    if s.startswith('-')]
        depth = 1 + max(int(git(src, 'rev-list', '--count', s+'..'+base)) for s in boundary)
        self.assertEqual(snapshot.make_snapshot(src, base, head, self.dest, 10, max_depth=depth-1),
                         (None, f'snapshot: too deep (D={depth})'))
        self.assertFalse(self.dest.exists())

    def test_timeout_is_a_snapshot_error(self):
        path = self.wrapper("if 'init' in sys.argv: time.sleep(2)")
        with patch.dict(os.environ, {'PATH': path}):
            mb, error = snapshot.make_snapshot(self.src, self.base, self.head, self.dest, .5)
        self.assertIsNone(mb)
        self.assertRegex(error, r'^snapshot: init: timeout after 0.5s$')
        self.assertFalse(self.dest.exists())

    def test_side_branch_merge_shape(self):
        root = self.root / 'side'; root.mkdir()
        src, _, head, base, *_ = fixture(root, side=True)
        boundary = [s[1:] for s in git(src, 'rev-list', '--boundary', head, '^'+base).splitlines()
                    if s.startswith('-')]
        depth = 1 + max(int(git(src, 'rev-list', '--count', s+'..'+base)) for s in boundary)
        count = int(git(src, 'rev-list', '--count', base+'..'+head))
        self.assertEqual(snapshot.make_snapshot(src, base, head, self.dest, 10), (base, None))
        self.assertEqual(git(self.dest, 'merge-base', 'review-base', 'review-target'), base)
        self.assertEqual(git(self.dest, 'diff', 'review-base...review-target', check=False).stdout,
                         git(src, 'diff', base+'...'+head, check=False).stdout)
        self.assertEqual(int(git(self.dest, 'rev-list', '--count', 'review-base..review-target')), count)
        self.assertLessEqual(int(git(self.dest, 'rev-list', '--all', '--count')), depth+count+1)

    def test_failure_leaves_no_dest(self):
        self.test_missing_commit_is_a_snapshot_error()
        self.test_refuses_too_deep()
        self.test_timeout_is_a_snapshot_error()
        # A real git executable wrapper corrupts the observed post-fetch count.
        path = self.wrapper("if '--count' in sys.argv and os.path.exists(os.path.join(sys.argv[sys.argv.index('-C')+1], '.git/shallow')):\n print('999'); sys.exit(0)")
        with patch.dict(os.environ, {'PATH': path}):
            mb, error = snapshot.make_snapshot(self.src, self.base, self.head, self.dest, 10)
        self.assertIsNone(mb)
        self.assertTrue(error.startswith('snapshot: assert:'), error)
        self.assertFalse(self.dest.exists())
        self.dest.mkdir(); (self.dest/'keep').write_text('keep')
        mb, error = snapshot.make_snapshot(self.src, self.base, self.head, self.dest, 10)
        self.assertIsNone(mb); self.assertTrue(error.startswith('snapshot: dest:'))
        self.assertEqual(list(self.dest.iterdir()), [self.dest/'keep'])
        self.assertEqual((self.dest/'keep').read_text(), 'keep')


class CloneCopyTests(Scratch):
    def test_copy_is_a_working_snapshot(self):
        src, base, head, mb, *_ = fixture(self.root)
        snap = self.root/'snap'; dest = self.root/'copy'
        self.assertEqual(snapshot.make_snapshot(src, base, head, snap, 10), (mb, None))
        snapshot.clone_copy(snap, dest)
        self.assertEqual(sorted(str(p.relative_to(snap)) for p in snap.rglob('*')),
                         sorted(str(p.relative_to(dest)) for p in dest.rglob('*')))
        self.assertEqual(git(dest, 'merge-base', 'review-base', 'review-target'), mb)
        self.assertEqual(git(dest, 'status', '--porcelain'), '')

    def test_refuses_existing_dest(self):
        src = self.root/'src'; src.mkdir(); dest = self.root/'dest'; dest.mkdir()
        (dest/'keep').write_text('keep')
        with self.assertRaises(snapshot.SnapshotError): snapshot.clone_copy(src, dest)
        self.assertEqual((dest/'keep').read_text(), 'keep')
        self.assertEqual(list(dest.iterdir()), [dest/'keep'])

    def test_copy_keeps_links_as_links(self):
        src = self.root/'src'; src.mkdir(); dest = self.root/'dest'
        outside = self.root/'outside'; outside.mkdir(); (outside/'file').write_text('outside')
        (src/'file').symlink_to(outside/'file'); (src/'directory').symlink_to(outside)
        before = ((outside/'file').stat(), outside.stat(), sorted(outside.iterdir()))
        snapshot.clone_copy(src, dest)
        self.assertTrue((dest/'file').is_symlink()); self.assertTrue((dest/'directory').is_symlink())
        self.assertEqual((outside/'file').read_text(), 'outside')
        self.assertEqual(((outside/'file').stat().st_mode, outside.stat().st_mode, sorted(outside.iterdir())),
                         (before[0].st_mode, before[1].st_mode, before[2]))

    def test_failed_copy_leaves_no_dest(self):
        src = self.root/'src'; src.mkdir(); (src/'ok').write_text('ok')
        unreadable = src/'unreadable'; unreadable.write_text('private'); unreadable.chmod(0)
        self.addCleanup(unreadable.chmod, 0o600)
        dest = self.root/'dest'
        with self.assertRaises(snapshot.SnapshotError): snapshot.clone_copy(src, dest)
        self.assertFalse(dest.exists())


class RealExport:
    temp = None
    @classmethod
    def get(cls):
        if cls.temp is None:
            cls.temp = tempfile.TemporaryDirectory(prefix='shared-skills-export-')
            cls.root = Path(cls.temp.name).resolve()
            cls.ref = git(REPO, 'rev-parse', 'HEAD')
            cls.dest = cls.root/'export'
            cls.before = sorted(cls.root.iterdir())
            snapshot.export_skills(REPO, cls.ref, cls.dest)
            cls.after = sorted(cls.root.iterdir())
        return cls


def tearDownModule():
    if RealExport.temp:
        RealExport.temp.cleanup()


class ExportSkillsTests(Scratch):
    @classmethod
    def setUpClass(cls):
        cls.export = RealExport.get()

    def test_exports_this_repo_without_root_hooks(self):
        dest = self.export.dest
        self.assertFalse((dest/'hooks/hooks.json').exists())
        self.assertEqual((dest/'skills/gstack/review/SKILL.md').read_bytes(),
                         git(REPO, 'show', self.export.ref+':skills/gstack/review/SKILL.md', check=False).stdout)
        self.assertTrue((dest/'.claude-plugin/plugin.json').is_file())
        self.assertFalse((dest/'.git').exists())

    def test_exports_ref_not_worktree(self):
        src = init(self.root/'source'); ref = commit(src, 'OLD'); commit(src, 'NEW')
        (src/'OLD.txt').write_text('dirty')
        dest = self.root/'dest'; snapshot.export_skills(src, ref, dest)
        self.assertEqual((dest/'OLD.txt').read_text(), 'OLD')
        self.assertFalse((dest/'NEW.txt').exists())

    def test_refuses_manifest_hooks_key(self):
        paths = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.grok-plugin/plugin.json',
                 'gemini-extension.json', 'skills/core/desk/board/.claude-plugin/plugin.json', 'symlink']
        for i, name in enumerate(paths):
            with self.subTest(name=name):
                src = init(self.root/f'src{i}'); p = src/(name if name != 'symlink' else '.claude-plugin/plugin.json')
                p.parent.mkdir(parents=True, exist_ok=True); p.write_text('{"hooks": {}}')
                if name == 'symlink': (src/'gemini-extension.json').symlink_to('.claude-plugin/plugin.json')
                git(src, 'add', '.'); git(src, 'commit', '-qm', 'manifest')
                dest = self.root/'dest'
                with self.assertRaisesRegex(snapshot.SnapshotError, 'hooks'):
                    snapshot.export_skills(src, 'HEAD', dest)
                self.assertFalse(dest.exists())

    def test_export_keeps_links_inside_dest(self):
        dest = self.export.dest
        for name in ('gemini-extension.json', 'plugins/bork'):
            self.assertTrue((dest/name).is_symlink())
            self.assertEqual(os.readlink(dest/name), git(REPO, 'show', self.export.ref+':'+name))
        self.assertEqual(self.export.after, sorted(self.export.before+[dest]))

    def test_refuses_option_like_ref(self):
        target = self.root/'x'
        # No git executable exists: a process start would turn the refusal into FileNotFoundError.
        with patch.dict(os.environ, {'PATH': str(self.root/'empty')}):
            with self.assertRaisesRegex(snapshot.SnapshotError, 'option-like'):
                snapshot.export_skills(REPO, '--output='+str(target), self.root/'dest')
        self.assertFalse(target.exists())

    def test_no_hooks_json_under_any_hooks_dir(self):
        self.assertEqual([p for p in self.export.dest.rglob('hooks.json') if p.parent.name == 'hooks'], [])

    def test_failure_leaves_no_dest(self):
        dest = self.root/'dest'
        with self.assertRaises(snapshot.SnapshotError): snapshot.export_skills(REPO, 'missing-ref-for-test', dest)
        self.assertFalse(dest.exists())
        path = self.wrapper("if 'archive' in sys.argv: sys.exit(9)")
        with patch.dict(os.environ, {'PATH': path}):
            with self.assertRaises(snapshot.SnapshotError): snapshot.export_skills(REPO, 'HEAD', dest)
        self.assertFalse(dest.exists())
        dest.mkdir(); (dest/'keep').write_text('keep')
        with self.assertRaises(snapshot.SnapshotError): snapshot.export_skills(REPO, 'HEAD', dest)
        self.assertEqual((dest/'keep').read_text(), 'keep')
        self.assertEqual(list(dest.iterdir()), [dest/'keep'])

    def test_returns_ref_commit(self):
        src = init(self.root/'src'); ref = commit(src, 'REF')
        self.assertEqual(snapshot.export_skills(src, 'main', self.root/'dest'), ref)


class RemoveTreeTests(Scratch):
    @classmethod
    def setUpClass(cls):
        cls.export = RealExport.get()

    def test_link_safe_removal(self):
        owned = self.root/'owned'; owned.mkdir(); tree = owned/'tree'; tree.mkdir()
        outside = self.root/'outside'; outside.mkdir(); file = outside/'file'; file.write_text('outside'); file.chmod(0o444)
        (tree/'file').symlink_to(file); (tree/'directory').symlink_to(outside)
        sub = tree/'sub'; sub.mkdir(); (sub/'up').symlink_to('..')
        os.link(file, tree/'hardlink')
        before = (file.read_bytes(), stat.S_IMODE(file.stat().st_mode), outside.stat().st_mode, sorted(outside.iterdir()))
        snapshot.remove_tree(tree, owned)
        self.assertFalse(tree.exists()); self.assertTrue(owned.is_dir())
        self.assertEqual((file.read_bytes(), stat.S_IMODE(file.stat().st_mode), outside.stat().st_mode,
                          sorted(outside.iterdir())), before)

    def test_hard_linked_outside_file_keeps_mode(self):
        tree = self.root/'tree'; tree.mkdir(); outside = self.root/'outside'; outside.write_text('outside')
        outside.chmod(0o444); os.link(outside, tree/'hard'); tree.chmod(0o500)
        snapshot.remove_tree(tree, self.root)
        self.assertFalse(tree.exists()); self.assertEqual(outside.read_text(), 'outside')
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o444)

    def test_removes_read_only_tree(self):
        src, base, head, mb, *_ = fixture(self.root); tree = self.root/'tree'
        self.assertEqual(snapshot.make_snapshot(src, base, head, tree, 10), (mb, None))
        for where, dirs, files in os.walk(tree, topdown=False):
            for name in files: (Path(where)/name).chmod(0o444)
            Path(where).chmod(0o500)
        snapshot.remove_tree(tree, self.root); self.assertFalse(tree.exists())

    def test_refuses_outside_root(self):
        root = self.root/'owned'; root.mkdir(); outside = self.root/'x'; outside.mkdir()
        (outside/'keep').write_text('keep'); link = root/'link'; link.symlink_to(outside)
        for path in (outside, root, root/'..'/'x', link, root/'..'):
            with self.subTest(path=path):
                with self.assertRaises(snapshot.SnapshotError): snapshot.remove_tree(path, root)
                self.assertTrue(root.is_dir()); self.assertTrue(link.is_symlink())
                self.assertEqual((outside/'keep').read_text(), 'keep')

    def test_root_under_symlinked_tmp(self):
        for prefix in ('/var', '/private/var'):
            with self.subTest(prefix=prefix):
                spelling = Path(str(self.root).replace('/private/var', prefix, 1))
                tree = spelling/'tree'; tree.mkdir(); (tree/'file').write_text('x')
                snapshot.remove_tree(tree, spelling); self.assertFalse(tree.exists())

    def test_removes_real_export(self):
        dest = self.export.dest; parent = self.export.root
        before = sorted(p for p in parent.iterdir() if p != dest)
        snapshot.remove_tree(dest, parent)
        self.assertFalse(dest.exists())
        self.assertEqual(sorted(parent.iterdir()), before)


class SnapshotEnvTests(Scratch):
    def hostile(self, src):
        return {'GIT_DIR': str(src/'.git'), 'GIT_WORK_TREE': str(src),
                'GIT_ALTERNATE_OBJECT_DIRECTORIES': str(src/'.git/objects'),
                'GIT_CONFIG_PARAMETERS': "'core.hooksPath'='/DO-NOT-USE-MARKER'", 'GIT_INDEX_FILE': str(src/'bad-index'),
                'ANTHROPIC_API_KEY': 'SECRET-MARKER', 'BORK_RUN_DIR': 'RUN-MARKER', 'HERDR_PANE_ID': 'PANE-MARKER'}

    def test_hostile_ambient_env_does_not_steer_git(self):
        src, base, head, mb, *_ = fixture(self.root)
        before = git(src, 'for-each-ref'); dest = self.root/'snapshot'; copy = self.root/'copy'; export = self.root/'export'
        with patch.dict(os.environ, self.hostile(src)):
            self.assertEqual(snapshot.make_snapshot(src, base, head, dest, 10), (mb, None))
            snapshot.clone_copy(dest, copy)
            snapshot.export_skills(src, head, export)
        for repo in (dest, copy):
            self.assertFalse((repo/'.git/objects/info/alternates').exists())
            self.assertEqual(git(repo, 'fsck', '--connectivity-only', check=False).returncode, 0)
            self.assertEqual(git(repo, 'merge-base', 'review-base', 'review-target'), mb)
            self.assertEqual(git(repo, 'status', '--porcelain'), '')
        self.assertTrue((export/'H2.txt').is_file()); self.assertFalse((src/'bad-index').exists())
        self.assertEqual(git(src, 'for-each-ref'), before)

    def test_children_get_allowlisted_env(self):
        src, base, head, mb, *_ = fixture(self.root); log = self.root/'env.jsonl'
        path = self.wrapper(f"with open({str(log)!r}, 'a') as out: out.write(json.dumps(dict(os.environ))+'\\n')")
        with patch.dict(os.environ, {**self.hostile(src), 'PATH': path}):
            self.assertEqual(snapshot.make_snapshot(src, base, head, self.root/'snapshot', 10), (mb, None))
            snapshot.export_skills(src, head, self.root/'export')
        records = [json.loads(s) for s in log.read_text().splitlines()]
        self.assertGreater(len(records), 5)
        # macOS Python adds this value itself, even with an empty input environment.
        baseline = subprocess.run([sys.executable, '-c', 'import os,json; print(json.dumps(dict(os.environ)))'],
                                  env={}, capture_output=True, text=True, check=True)
        runtime = json.loads(baseline.stdout)
        allowed = set(caselib.ENV_PASS) | set(caselib.git_env()) | set(runtime)
        for record in records:
            self.assertTrue(all(k in allowed or k.startswith('LC_') for k in record), record.keys())
            self.assertNotIn('MARKER', json.dumps(record))
