import hashlib
import json
import os
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

SPEC_REVIEW = '''# Spec review: S1

- **C1.** First criterion text.
- **C2.** Second criterion.
  continuation of the second criterion.
Some prose that is not a criterion.
C3: third.
C5a: fifth, sub-id.
C10: tenth.
C41: forty-first.
'''
CRITERIA_LINES = [l for l in SPEC_REVIEW.splitlines() if re.match(r'^(- \*\*C|  cont|C\d)', l)]
BRIEF = '''Execute slice S1 "Fixture goal" in a worktree.
Owned files: src/a.py, src/b.py. Protected paths: everything else.

Gates (run once after the last edit):
- G1 `echo GATE-OK-STRING`
- G2 `pwd`

Result: the handoff.
'''
GATES = '\n'.join(BRIEF.splitlines()[3:6])


def snapshot(root):
    out = {}
    for path in sorted(Path(root).rglob('*')):
        if path.is_file():
            st = path.stat()
            out[str(path)] = (st.st_size, hashlib.sha256(path.read_bytes()).hexdigest(), st.st_mtime_ns)
    return out


class BuilderCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='replay-build-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.store = self.tmp / 'store'
        (self.store / 'offload').mkdir(parents=True)
        self.fx = fixture.build(self.tmp / 'fx')
        self.run_dir = self.store / 'runs' / 'fixture-run'
        self.run_dir.mkdir(parents=True)
        self.slices = []

    def add_slice(self, sid, verdict, **extra):
        item = {'id': str(sid), 'title': f'S{sid} fixture', 'state': 'rejected', 'verdict': '',
                'history': [{'state': 'dispatched', 'at': 'x'}, {'state': 'rejected', 'at': 'y', 'verdict': verdict}]}
        item.update(extra)
        self.slices.append(item)

    def write_ledger(self, **extra):
        ledger = {'session': 'fixture-session', 'cwd': str(self.fx.repo), 'goal': 'fixture goal',
                  'run_dir': str(self.run_dir), 'created': '2026-01-01T00:00:00Z', 'slices': self.slices}
        ledger.update(extra)
        (self.store / 'offload' / 'aaaa--fixture-session.ledger.json').write_text(json.dumps(ledger))

    def write_run_file(self, name, text):
        (self.run_dir / name).write_text(text)

    def full_source(self, sid=1):
        self.write_run_file(f'spec-review-S{sid}.md', SPEC_REVIEW)
        self.write_run_file(f'brief-S{sid}.md', BRIEF + f'base: {self.fx.base[:9]}\n')

    def build(self, *extra, env=None):
        out = self.store / 'replay-cases'
        run = support.run_cli(support.BUILDER, ['--ledgers', self.store / 'offload', '--out', out, *extra],
                              env=dict({'AGENT_HANDOFFS_DIR': str(self.store)}, **(env or {})))
        return run, out

    def cases(self, out):
        return sorted(Path(out).glob('*.json')) if Path(out).exists() else []

    def counts(self, run):
        m = re.search(r'summary: seen=(\d+) built=(\d+) skipped=(\d+)', run.stdout)
        self.assertIsNotNone(m, run.stdout + run.stderr)
        return tuple(map(int, m.groups()))


class ExtractionTests(BuilderCase):
    def test_named_tag_is_found_in_every_real_spelling(self):
        table = [('DO NOT LAND r1 named C41: B1 redirect host too long', ['C41']),
                 ('LAND WITH CAUTION (named C2)', ['C2']),
                 ('DO NOT LAND r1 named C5a)', ['C5a']),
                 ('r1 fixes accepted; unnamed: replay survivors', None),
                 ('plain verdict with no tag', None),
                 ('DO NOT LAND r1 named C10: x', ['C10']),
                 ('DO NOT LAND r1 named CP-01: x', None)]
        for verdict, expected in table:
            with self.subTest(verdict=verdict):
                self.setUp()
                self.add_slice(1, verdict)
                self.write_ledger()
                self.full_source()
                run, out = self.build()
                self.assertEqual(run.returncode, 0, run.stderr)
                cases = self.cases(out)
                if expected is None:
                    self.assertEqual(cases, [])
                    self.assertEqual(self.counts(run)[0], 0)
                else:
                    self.assertEqual(json.loads(cases[0].read_text())['missed_ids'], expected)

    def test_candidate_is_found_in_the_on_disk_ledger_not_via_a_json_report_command(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.full_source()
        run, out = self.build()
        self.assertEqual(self.counts(run)[0], 1)


class SkipTests(BuilderCase):
    def test_no_base_commit_builds_nothing_and_names_the_reason(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.write_run_file('spec-review-S1.md', SPEC_REVIEW)
        self.write_run_file('brief-S1.md', BRIEF + 'base: BASE_REF\n')
        run, out = self.build()
        self.assertEqual(self.cases(out), [])
        self.assertRegex(run.stdout, r'skipped .*S1.*no base commit')

    def test_no_frozen_criteria_builds_nothing_and_names_the_reason(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.write_run_file('brief-S1.md', BRIEF + f'base: {self.fx.base}\n')
        run, out = self.build()
        self.assertEqual(self.cases(out), [])
        self.assertRegex(run.stdout, r'skipped .*S1.*no frozen criteria')

    def test_source_with_both_builds_one_case_with_verbatim_lines(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.full_source()
        run, out = self.build()
        (path,) = self.cases(out)
        case = json.loads(path.read_text())
        self.assertEqual(case['criteria'], '\n'.join(CRITERIA_LINES))
        self.assertIn('- **C2.** Second criterion.\n  continuation of the second criterion.', case['criteria'])
        self.assertEqual(case['gates_text'], GATES)
        self.assertEqual(case['gate_commands'], ['echo GATE-OK-STRING', 'pwd'])
        self.assertEqual(case['missed_ids'], ['C3'])
        self.assertEqual(case['base_commit'], self.fx.base)
        self.assertEqual(case['repo']['path'], str(self.fx.repo))
        self.assertEqual(case['owned_files'], 'src/a.py, src/b.py')
        self.assertTrue(case['provenance'])
        # the case the builder writes must pass the runner's parser
        check = support.run_cli(support.RUNNER, ['--check', '--cases', out])
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_built_plus_skipped_equals_seen(self):
        for sid in (1, 2, 3):
            self.add_slice(sid, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.full_source(1)
        self.write_run_file('spec-review-S2.md', SPEC_REVIEW)
        self.write_run_file('brief-S3.md', BRIEF + f'base: {self.fx.base}\n')
        run, out = self.build()
        self.assertEqual(self.counts(run), (3, 1, 2))
        self.assertIn('skipped[no base commit]=1', run.stdout)
        self.assertIn('skipped[no frozen criteria]=1', run.stdout)

    def test_missed_id_absent_from_the_criteria_is_skipped(self):
        self.add_slice(1, 'DO NOT LAND r1 named C99: x')
        self.write_ledger()
        self.full_source()
        run, out = self.build()
        self.assertEqual(self.cases(out), [])
        self.assertIn('C99', run.stdout)

    def test_replay_files_in_the_run_dir_are_never_read(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.write_run_file('brief-S1.md', BRIEF + f'base: {self.fx.base}\n')
        self.write_run_file('replay-S1.md', 'C3: REPLAY-NOISE\n')
        (self.run_dir / 'replay-S1-artifacts').mkdir()
        (self.run_dir / 'replay-S1-artifacts' / 'spec-review-S1.md').write_text('C3: REPLAY-NOISE\n')
        run, out = self.build()
        self.assertEqual(self.cases(out), [])

    def test_handoff_frozen_gates_section_is_the_criteria_fallback(self):
        doc = self.store / 'offload' / 'doc.md'
        doc.write_text('---\ntitle: x\n---\n\n## Frozen gates\nC3: from the handoff.\nC4: also.\n\n## Gate results\nC9: no\n')
        self.add_slice(1, 'DO NOT LAND r1 named C3: x', handoff=str(doc))
        self.write_ledger()
        self.write_run_file('brief-S1.md', BRIEF + f'base: {self.fx.base}\n')
        run, out = self.build()
        (path,) = self.cases(out)
        self.assertEqual(json.loads(path.read_text())['criteria'], 'C3: from the handoff.\nC4: also.')


class BaseSourceTests(BuilderCase):
    def one(self, verdict='DO NOT LAND r1 named C3: x', **ledger):
        self.add_slice(1, verdict, **ledger.pop('slice', {}))
        self.write_ledger(**ledger)
        run, out = self.build()
        return run, self.cases(out)

    def test_base_in_a_brief_notes_run_json_ledger_row_and_at_sha(self):
        shapes = {
            'brief base:': lambda: self.write_run_file('brief-S1.md', BRIEF + f'base: {self.fx.base[:8]}\n'),
            'notes @ sha': lambda: self.write_run_file('notes.md', f'S1 stack on main @ {self.fx.base[:8]} today\n'),
            'block base:': lambda: self.write_run_file('block-S1.md', BRIEF + f'base: {self.fx.base}\n'),
            'run.json': lambda: self.write_run_file('run.json', json.dumps({'base': self.fx.base})),
        }
        for name, setup in shapes.items():
            with self.subTest(shape=name):
                self.setUp()
                self.write_run_file('spec-review-S1.md', SPEC_REVIEW)
                if name != 'brief base:':
                    self.write_run_file('brief-S1.md', BRIEF)
                setup()
                run, cases = self.one()
                self.assertEqual(len(cases), 1, run.stdout)
                self.assertEqual(json.loads(cases[0].read_text())['base_commit'], self.fx.base)
        with self.subTest(shape='ledger row'):
            self.setUp()
            self.write_run_file('spec-review-S1.md', SPEC_REVIEW)
            self.write_run_file('brief-S1.md', BRIEF)
            run, cases = self.one(slice={'base': self.fx.base})
            self.assertEqual(len(cases), 1, run.stdout)

    def test_head_before_this_round_gives_the_base_only_for_a_later_review_round(self):
        corrective = f'Corrective round 1 for slice S1 in a worktree. HEAD before this round: {self.fx.base[:7]}. Add commits.\n'
        self.write_run_file('spec-review-S1.md', SPEC_REVIEW)
        self.write_run_file('brief-S1.md', BRIEF)
        self.write_run_file('corrective-S1-r1.md', corrective)
        run, cases = self.one('DO NOT LAND r1 named C3: x')
        self.assertEqual(cases, [], 'a corrective head is the output a round-1 review rejected, not its base')
        self.assertIn('no base commit', run.stdout)
        self.setUp()
        self.write_run_file('spec-review-S1.md', SPEC_REVIEW)
        self.write_run_file('brief-S1.md', BRIEF)
        self.write_run_file('corrective-S1-r1.md', corrective)
        run, cases = self.one('DO NOT LAND r2 named C3: x')
        self.assertEqual(len(cases), 1, run.stdout)
        self.assertEqual(json.loads(cases[0].read_text())['base_commit'], self.fx.base)

    def test_unresolvable_short_sha_is_no_base_commit(self):
        self.write_run_file('spec-review-S1.md', SPEC_REVIEW)
        self.write_run_file('brief-S1.md', BRIEF + 'base: deadbee\n')
        run, cases = self.one()
        self.assertEqual(cases, [])
        self.assertIn('no base commit', run.stdout)


class SafetyTests(BuilderCase):
    def test_sources_are_not_modified(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        doc = self.store / 'offload' / 'doc.md'
        doc.write_text('## Frozen gates\nC3: x\n')
        self.slices[0]['handoff'] = str(doc)
        self.write_ledger()
        self.full_source()
        self.write_run_file('review-S1-r1.md', 'review\n')
        self.write_run_file('corrective-S1-r1.md', 'Corrective\n')
        self.write_run_file('notes.md', 'notes\n')
        before = snapshot(self.store)
        run, out = self.build()
        self.assertEqual(run.returncode, 0, run.stderr)
        after = {k: v for k, v in snapshot(self.store).items() if '/replay-cases/' not in k}
        self.assertEqual(after, before)

    def test_default_output_dir_is_replay_cases_under_the_store_with_mode_700(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.full_source()
        run = support.run_cli(support.BUILDER, ['--ledgers', self.store / 'offload'], env={'AGENT_HANDOFFS_DIR': str(self.store)})
        self.assertEqual(run.returncode, 0, run.stderr)
        target = self.store / 'replay-cases'
        self.assertEqual(target.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len(list(target.glob('*.json'))), 1)

    def test_unset_store_variable_falls_back_to_the_home_directory(self):
        home = self.tmp / 'home'
        (home / '.agent-handoffs' / 'offload').mkdir(parents=True)
        run = support.run_cli(support.BUILDER, [], env={'AGENT_HANDOFFS_DIR': None, 'HOME': str(home)})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual((home / '.agent-handoffs' / 'replay-cases').stat().st_mode & 0o777, 0o700)

    def test_existing_group_readable_dir_is_tightened_before_writing(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.full_source()
        out = self.store / 'replay-cases'
        out.mkdir(mode=0o755)
        out.chmod(0o755)
        run, _ = self.build()
        self.assertEqual(out.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len(self.cases(out)), 1)

    def test_output_dir_inside_a_git_work_tree_is_refused(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.full_source()
        target = self.fx.repo / 'cases'
        run = support.run_cli(support.BUILDER, ['--ledgers', self.store / 'offload', '--out', target])
        self.assertNotEqual(run.returncode, 0)
        self.assertFalse(target.exists())

    def test_existing_case_file_is_never_overwritten(self):
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.full_source()
        run, out = self.build()
        (path,) = self.cases(out)
        before = path.read_bytes()
        run, out = self.build()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.counts(run), (1, 0, 1))
        self.assertIn('case file exists', run.stdout)

    def test_the_test_suite_leaves_the_real_store_alone(self):
        real = Path.home() / '.agent-handoffs' / 'replay-cases'
        self.assertEqual(os.environ.get('AGENT_HANDOFFS_DIR') != str(real.parent), True)
        before = sorted(p.name for p in real.glob('*')) if real.exists() else None
        self.add_slice(1, 'DO NOT LAND r1 named C3: x')
        self.write_ledger()
        self.full_source()
        self.build()
        after = sorted(p.name for p in real.glob('*')) if real.exists() else None
        self.assertEqual(before, after)


if __name__ == '__main__':
    unittest.main()
