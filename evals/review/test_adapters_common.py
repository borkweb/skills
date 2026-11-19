"""Tests for the shared review-eval harness package (`evals/review/harnesses/__init__.py`)."""
import dataclasses
import os
from pathlib import Path
import sys
import types
import unittest

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import harnesses  # noqa: E402


class LoadTests(unittest.TestCase):
    def test_load_claude(self):
        mod = harnesses.load('claude')
        self.assertEqual(mod.HARNESS, 'claude')
        self.assertTrue(callable(mod.preflight))
        self.assertTrue(callable(mod.review))
        self.assertTrue(callable(mod.grade))

    def test_unknown_harness_refuses(self):
        for bad in ('nope', '', 'claude.x', '../claude', '__init__', 'zz-never-a-harness'):
            with self.subTest(harness=bad):
                with self.assertRaises(harnesses.Refusal):
                    harnesses.load(bad)

    def test_harness_mismatch_refuses(self):
        key = 'harnesses.grok'
        previous = sys.modules.get(key)

        def _restore():
            if previous is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = previous

        self.addCleanup(_restore)
        fake_mod = types.ModuleType(key)
        fake_mod.HARNESS = 'claude'
        sys.modules[key] = fake_mod
        with self.assertRaises(harnesses.Refusal):
            harnesses.load('grok')

    def test_harnesses_is_the_review_package(self):
        expected = os.path.realpath(str(HERE / 'harnesses' / '__init__.py'))
        self.assertEqual(os.path.realpath(harnesses.__file__), expected)
        self.assertFalse((HERE / 'adapters').exists())

    def test_context_fields(self):
        self.assertTrue(dataclasses.is_dataclass(harnesses.Context))
        names = [f.name for f in dataclasses.fields(harnesses.Context)]
        self.assertEqual(names, ['env_base', 'run_group', 'secrets', 'log'])


class ScrubTests(unittest.TestCase):
    def test_scrub_rules(self):
        self.assertEqual(harnesses.scrub('tok=12345678 end', ['12345678']), 'tok=[redacted] end')
        self.assertEqual(harnesses.scrub('tok=1234567 end', ['1234567']), 'tok=1234567 end')
        self.assertEqual(harnesses.scrub('nothing here', []), 'nothing here')

    def test_overlapping_secrets_leave_no_fragment(self):
        result = harnesses.scrub('abcdefghIJKLMNOP', ['abcdefgh', 'abcdefghIJKLMNOP'])
        self.assertEqual(result, '[redacted]')
        self.assertNotIn('IJKLMNOP', result)


class PromptTests(unittest.TestCase):
    def _sample_req(self, **extra):
        req = {
            'base': '1' * 40,
            'head': '2' * 40,
            'merge_base': '3' * 40,
            'trial_copy': '/tmp/MARKER-TRIAL-COPY',
            'export_dir': '/tmp/MARKER-EXPORT-DIR',
            'tmp_root': '/tmp/MARKER-TMP-ROOT',
            'raw_dir': '/tmp/MARKER-RAW-DIR',
            'deny_read': ['/tmp/MARKER-DENY-READ-A', '/tmp/MARKER-DENY-READ-B'],
            'model': 'MARKER-MODEL',
            'effort': 'MARKER-EFFORT',
            'skill': 'review',
            'timeout_s': 60,
            'max_budget_usd': 5.0,
        }
        req.update(extra)
        return req

    def test_prompt_names_refs_and_shas(self):
        invoke = 'Use the Skill tool to run the `bork:review` skill'
        req = self._sample_req()
        prompt = harnesses.review_prompt(req, invoke)
        self.assertIn(invoke, prompt)
        self.assertIn('review-base', prompt)
        self.assertIn('review-target', prompt)
        self.assertIn(req['base'], prompt)
        self.assertIn(req['head'], prompt)
        self.assertIn(req['merge_base'], prompt)

    def test_report_only_and_no_subagent_lines(self):
        prompt = harnesses.review_prompt(self._sample_req(), 'Use the Skill tool to run the `bork:review` skill')
        lower = prompt.lower()
        self.assertIn('report only', lower)
        self.assertIn('do not edit', lower)
        self.assertIn('commit', lower)
        self.assertIn('push', lower)
        self.assertIn('do not dispatch subagents', lower)
        self.assertIn('independent reviewer', lower)

    def test_prompt_carries_no_case_or_config_data(self):
        req = self._sample_req(
            case_id='MARKER-CASE-ID',
            title='MARKER-CASE-TITLE',
            repo='MARKER-REPO-NAME',
        )
        prompt = harnesses.review_prompt(req, 'Use the Skill tool to run the `bork:review` skill')
        for marker in (
            'MARKER-TRIAL-COPY',
            'MARKER-EXPORT-DIR',
            'MARKER-TMP-ROOT',
            'MARKER-RAW-DIR',
            'MARKER-DENY-READ-A',
            'MARKER-DENY-READ-B',
            'MARKER-MODEL',
            'MARKER-EFFORT',
            'MARKER-CASE-ID',
            'MARKER-CASE-TITLE',
            'MARKER-REPO-NAME',
        ):
            self.assertNotIn(marker, prompt)

    def test_delegation_limit_line(self):
        expected = (
            'This request sets a delegation limit: no subagent or independent reviewer is available in this run. '
            'Record the independent review as unavailable in the Coverage table. '
            'Under this limit, an unavailable independent review is a coverage gap, not missing required evidence. '
            'Base the verdict on the findings and the other gates.'
        )
        invokes = (
            'Use the Skill tool to run the `bork:review` skill',
            'Use the Skill tool to run the `bork:review-security` skill',
        )
        for invoke in invokes:
            with self.subTest(invoke=invoke):
                prompt = harnesses.review_prompt(self._sample_req(), invoke)
                no_sub_idx = prompt.lower().find('do not dispatch subagents')
                limit_idx = prompt.find(expected)
                self.assertGreaterEqual(no_sub_idx, 0)
                self.assertGreater(limit_idx, no_sub_idx)


if __name__ == '__main__':
    unittest.main()
