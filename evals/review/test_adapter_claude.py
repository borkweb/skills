"""Tests for the Claude Code review harness adapter and isolation CLI."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
REPLAY_DIR = HERE.parent / 'replay'
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
if str(REPLAY_DIR) not in sys.path:
    sys.path.insert(0, str(REPLAY_DIR))

import caselib  # noqa: E402
import harnesses  # noqa: E402
from harnesses import claude as claude_adapter  # noqa: E402
import procs  # noqa: E402
import support  # noqa: E402

STUB_SRC = HERE / 'stubs' / 'claude'
ISOLATION_CLI = HERE / 'check_isolation.py'
FAKE_TOKEN = 'FAKETOKEN-0001-ABCDEFGHIJ'
REVIEW_KEYS = {
    'text',
    'usage',
    'rounds',
    'duration_s',
    'resolved_model',
    'resolved_effort',
    'skill_invoked',
    'skill_evidence',
    'skill_loading',
    'rate_limited',
    'error',
    'argv',
    'raw_files',
    'harness_version',
}
GRADE_KEYS = {'parsed', 'text', 'usage', 'cost_usd', 'error', 'rate_limited'}


def _walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _walk_strings(item)
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _walk_strings(k)
            yield from _walk_strings(v)


def _parse_flags(argv):
    flags = {}
    i = 1
    while i < len(argv):
        tok = argv[i]
        if tok in ('-p', '--verbose', '--strict-mcp-config', '--include-hook-events', '--version'):
            flags[tok] = True
            i += 1
        elif tok.startswith('--'):
            if '=' in tok:
                k, v = tok.split('=', 1)
                flags[k] = v
                i += 1
            elif i + 1 < len(argv):
                flags[tok] = argv[i + 1]
                i += 2
            else:
                flags[tok] = True
                i += 1
        else:
            i += 1
    return flags


def _make_stub_env(tmp_dir, config=None, token=FAKE_TOKEN):
    stub_dir = Path(tmp_dir) / 'stubbin'
    stub_dir.mkdir(parents=True, exist_ok=True)
    stub_exe = stub_dir / 'claude'
    src_text = STUB_SRC.read_text(encoding='utf-8')
    if src_text.startswith('#!/usr/bin/env python3\n'):
        src_text = f'#!{sys.executable}\n' + src_text.split('\n', 1)[1]
    stub_exe.write_text(src_text, encoding='utf-8')
    stub_exe.chmod(0o755)
    (stub_dir / 'stub_config.json').write_text(json.dumps(config or {}), encoding='utf-8')
    token_file = Path(tmp_dir) / 'claude-oauth-token'
    token_file.write_text(token + '\n', encoding='utf-8')
    token_file.chmod(0o600)
    return stub_dir, token_file


def _set_stub_config(stub_dir, config):
    (Path(stub_dir) / 'stub_config.json').write_text(json.dumps(config), encoding='utf-8')


def _read_calls(stub_dir):
    path = Path(stub_dir) / 'calls.jsonl'
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def _clear_calls(stub_dir):
    path = Path(stub_dir) / 'calls.jsonl'
    if path.exists():
        path.unlink()


def _make_ctx(stub_dir, env_base=None, run_group=None, logs=None):
    base = dict(env_base) if env_base is not None else caselib.scrubbed_env()
    base['PATH'] = support.safe_path(stub_dir)
    return harnesses.Context(
        env_base=base,
        run_group=run_group or procs.run_group,
        secrets=[],
        log=(logs.append if logs is not None else (lambda _msg: None)),
    )


def _make_review_req(root, **overrides):
    root = Path(root)
    trial_copy = root / 'trial_copy'
    export_dir = root / 'export_dir'
    tmp_root = root / 'tmp_root'
    raw_dir = root / 'raw_dir'
    deny_a = root / 'run_dir'
    deny_b = root / 'cases_dir'
    for d in (trial_copy, export_dir, tmp_root, raw_dir, deny_a, deny_b):
        d.mkdir(parents=True, exist_ok=True)
    req = {
        'trial_copy': str(trial_copy),
        'base': 'a' * 40,
        'head': 'b' * 40,
        'merge_base': 'c' * 40,
        'skill': 'review',
        'export_dir': str(export_dir),
        'model': 'claude-sonnet-5-5',
        'effort': 'low',
        'timeout_s': 20,
        'tmp_root': str(tmp_root),
        'raw_dir': str(raw_dir),
        'deny_read': [str(deny_a), str(deny_b)],
        'max_budget_usd': 5.0,
    }
    req.update(overrides)
    return req


def _make_grade_req(root, **overrides):
    root = Path(root)
    cwd = root / 'grade_cwd'
    tmp_root = root / 'grade_tmp'
    deny_dir = root / 'grade_deny'
    for d in (cwd, tmp_root, deny_dir):
        d.mkdir(parents=True, exist_ok=True)
    req = {
        'prompt': 'Grade this review output.',
        'schema': {
            'type': 'object',
            'properties': {'ok': {'type': 'boolean'}, 'note': {'type': 'string'}},
            'required': ['ok'],
            'additionalProperties': False,
        },
        'tools': 'none',
        'cwd': str(cwd),
        'model': 'claude-sonnet-5-5',
        'effort': 'low',
        'timeout_s': 20,
        'tmp_root': str(tmp_root),
        'deny_read': [str(deny_dir)],
    }
    req.update(overrides)
    return req


class _ClaudeTestBase(unittest.TestCase):
    def _init_box(self, config=None, token=FAKE_TOKEN):
        self.tmp = Path(tempfile.mkdtemp(prefix='claude-adapter-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.stub_dir, self.token_file = _make_stub_env(self.tmp, config=config, token=token)
        self._env_patch = mock.patch.dict(os.environ, {'BORK_EVAL_CLAUDE_TOKEN_FILE': str(self.token_file)})
        self._env_patch.start()
        self.addCleanup(self._env_patch.stop)


class PreflightTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_each_token_file_fault_refuses(self):
        good_target = self.tmp / 'real-token'
        good_target.write_text(FAKE_TOKEN + '\n', encoding='utf-8')
        good_target.chmod(0o600)

        missing = self.tmp / 'does-not-exist'
        empty = self.tmp / 'empty-token'
        empty.write_text('', encoding='utf-8')
        empty.chmod(0o600)
        ws_only = self.tmp / 'ws-token'
        ws_only.write_text('   \n\t \n', encoding='utf-8')
        ws_only.chmod(0o600)
        as_dir = self.tmp / 'dir-token'
        as_dir.mkdir(mode=0o700)
        as_fifo = self.tmp / 'fifo-token'
        os.mkfifo(as_fifo, 0o600)
        as_link = self.tmp / 'link-token'
        os.symlink(str(good_target), str(as_link))
        mode_640 = self.tmp / 'mode-640'
        mode_640.write_text(FAKE_TOKEN + '\n', encoding='utf-8')
        mode_640.chmod(0o640)
        mode_604 = self.tmp / 'mode-604'
        mode_604.write_text(FAKE_TOKEN + '\n', encoding='utf-8')
        mode_604.chmod(0o604)
        short_19 = self.tmp / 'short-19'
        short_19.write_text('A' * 19 + '\n', encoding='utf-8')
        short_19.chmod(0o600)

        faults = [
            ('missing', missing),
            ('empty', empty),
            ('whitespace', ws_only),
            ('directory', as_dir),
            ('fifo', as_fifo),
            ('symlink', as_link),
            ('mode-0640', mode_640),
            ('mode-0604', mode_604),
            ('short-19', short_19),
        ]
        for label, path in faults:
            with self.subTest(fault=label):
                _clear_calls(self.stub_dir)
                ctx = _make_ctx(self.stub_dir)
                with mock.patch.dict(os.environ, {'BORK_EVAL_CLAUDE_TOKEN_FILE': str(path)}):
                    with self.assertRaises(harnesses.Refusal):
                        claude_adapter.preflight(ctx)
                self.assertEqual(_read_calls(self.stub_dir), [])

    def test_group_or_other_readable_refuses(self):
        for mode in (0o640, 0o604):
            with self.subTest(mode=oct(mode)):
                bad = self.tmp / f'tok-{mode:o}'
                bad.write_text(FAKE_TOKEN + '\n', encoding='utf-8')
                bad.chmod(mode)
                _clear_calls(self.stub_dir)
                ctx = _make_ctx(self.stub_dir)
                with mock.patch.dict(os.environ, {'BORK_EVAL_CLAUDE_TOKEN_FILE': str(bad)}):
                    with self.assertRaises(harnesses.Refusal):
                        claude_adapter.preflight(ctx)
                self.assertEqual(_read_calls(self.stub_dir), [])

    def test_symlink_refuses(self):
        target = self.tmp / 'sym-target'
        target.write_text(FAKE_TOKEN + '\n', encoding='utf-8')
        target.chmod(0o600)
        link = self.tmp / 'sym-link'
        os.symlink(str(target), str(link))
        _clear_calls(self.stub_dir)
        ctx = _make_ctx(self.stub_dir)
        with mock.patch.dict(os.environ, {'BORK_EVAL_CLAUDE_TOKEN_FILE': str(link)}):
            with self.assertRaises(harnesses.Refusal):
                claude_adapter.preflight(ctx)
        self.assertEqual(_read_calls(self.stub_dir), [])

    def test_binary_comes_from_the_child_path(self):
        decoy_dir = self.tmp / 'decoybin'
        decoy_dir.mkdir()
        marker = self.tmp / 'decoy-called'
        decoy = decoy_dir / 'claude'
        decoy.write_text(
            f'#!/usr/bin/env python3\nfrom pathlib import Path\nPath({str(marker)!r}).write_text("hit")\n',
            encoding='utf-8',
        )
        decoy.chmod(0o755)
        with mock.patch.dict(os.environ, {'PATH': f'{decoy_dir}:{os.environ.get("PATH", "")}'}):
            ctx = _make_ctx(self.stub_dir)
            claude_adapter.preflight(ctx)
            req = _make_review_req(self.tmp / 'case1')
            reply = claude_adapter.review(req, ctx)
            self.assertIsNone(reply['error'])
            self.assertFalse(marker.exists())

            empty_dir = self.tmp / 'emptybin'
            empty_dir.mkdir()
            ctx_missing = _make_ctx(self.stub_dir)
            ctx_missing.env_base['PATH'] = str(empty_dir)
            with self.assertRaises(harnesses.Refusal):
                claude_adapter.preflight(ctx_missing)
            self.assertFalse(marker.exists())

    def test_preflight_makes_no_model_call(self):
        _clear_calls(self.stub_dir)
        ctx = _make_ctx(self.stub_dir)
        claude_adapter.preflight(ctx)
        calls = _read_calls(self.stub_dir)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['argv'], ['--version'])
        self.assertNotIn('-p', calls[0]['argv'])

    def test_default_token_path_is_under_home(self):
        fake_home = self.tmp / 'fake-home'
        fake_home.mkdir()
        default_path = fake_home / '.borkweb-skills' / 'evals' / 'claude-oauth-token'
        env_patch = {'HOME': str(fake_home)}
        with mock.patch.dict(os.environ, env_patch):
            os.environ.pop('BORK_EVAL_CLAUDE_TOKEN_FILE', None)
            ctx = _make_ctx(self.stub_dir)
            with self.assertRaises(harnesses.Refusal):
                claude_adapter.preflight(ctx)
            default_path.parent.mkdir(parents=True, exist_ok=True)
            default_path.write_text(FAKE_TOKEN + '\n', encoding='utf-8')
            default_path.chmod(0o600)
            claude_adapter.preflight(ctx)
            self.assertIn(FAKE_TOKEN, ctx.secrets)

    def test_token_whitespace_is_stripped(self):
        expected_hash = hashlib.sha256(FAKE_TOKEN.encode('utf-8')).hexdigest()
        for raw in (f'{FAKE_TOKEN}\n', f' {FAKE_TOKEN} \n'):
            with self.subTest(raw=raw):
                tok_file = self.tmp / f'ws-{hashlib.md5(raw.encode()).hexdigest()[:6]}'
                tok_file.write_text(raw, encoding='utf-8')
                tok_file.chmod(0o600)
                _clear_calls(self.stub_dir)
                ctx = _make_ctx(self.stub_dir)
                with mock.patch.dict(os.environ, {'BORK_EVAL_CLAUDE_TOKEN_FILE': str(tok_file)}):
                    claude_adapter.preflight(ctx)
                    self.assertIn(FAKE_TOKEN, ctx.secrets)
                    self.assertNotIn(raw, ctx.secrets)
                    claude_adapter.review(_make_review_req(self.tmp / f'rev-{tok_file.name}'), ctx)
                review_calls = [c for c in _read_calls(self.stub_dir) if '-p' in c['argv']]
                self.assertEqual(len(review_calls), 1)
                self.assertEqual(review_calls[0]['token_sha256'], expected_hash)

    def test_token_file_is_never_modified(self):
        before_bytes = self.token_file.read_bytes()
        before_stat = os.lstat(self.token_file)
        ctx = _make_ctx(self.stub_dir)
        claude_adapter.preflight(ctx)
        claude_adapter.review(_make_review_req(self.tmp / 'rev'), ctx)
        claude_adapter.grade(_make_grade_req(self.tmp / 'grd'), ctx)
        after_bytes = self.token_file.read_bytes()
        after_stat = os.lstat(self.token_file)
        self.assertEqual(after_bytes, before_bytes)
        self.assertEqual(stat.S_IMODE(after_stat.st_mode), stat.S_IMODE(before_stat.st_mode))
        self.assertEqual(after_stat.st_mtime_ns, before_stat.st_mtime_ns)

    def test_token_minimum_length(self):
        tok19 = self.tmp / 'tok19'
        tok19.write_text('X' * 19 + '\n', encoding='utf-8')
        tok19.chmod(0o600)
        tok20 = self.tmp / 'tok20'
        tok20.write_text('X' * 20 + '\n', encoding='utf-8')
        tok20.chmod(0o600)
        ctx = _make_ctx(self.stub_dir)
        with mock.patch.dict(os.environ, {'BORK_EVAL_CLAUDE_TOKEN_FILE': str(tok19)}):
            with self.assertRaises(harnesses.Refusal):
                claude_adapter.preflight(ctx)
        with mock.patch.dict(os.environ, {'BORK_EVAL_CLAUDE_TOKEN_FILE': str(tok20)}):
            claude_adapter.preflight(ctx)


class EnvTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def _hostile_env(self):
        watched = self.tmp / 'watched-hostile'
        watched.mkdir(exist_ok=True)
        hostile = support.hostile_user_env(watched)
        hostile.update({
            'ANTHROPIC_API_KEY': 'sk-ant-hostile-999999999',
            'ANTHROPIC_AUTH_TOKEN': 'aat-hostile-999999999',
            'ANTHROPIC_BASE_URL': 'https://evil.invalid',
            'CLAUDE_CONFIG_DIR': str(watched / 'claude-cfg'),
            'CLAUDE_EFFORT': 'max',
            'CLAUDE_PLUGIN_DATA': str(watched / 'plugin-data'),
            'CLAUDE_CODE_CHILD_SESSION': '1',
            'CLAUDE_CODE_MESSAGING_EXTRA': 'msg-hostile',
            'CLAUDE_CODE_OAUTH_TOKEN': 'oauth-123456',
            'BORK_EVAL_CLAUDE_TOKEN_FILE': str(self.token_file),
        })
        return hostile

    def _expected_env_names(self, env_base):
        expected = set(env_base) | {
            'HOME',
            'CLAUDE_CONFIG_DIR',
            'AGENT_HANDOFFS_DIR',
            'BORK_REPO_RULES_DIR',
            'CLAUDE_CODE_OAUTH_TOKEN',
            'GIT_TERMINAL_PROMPT',
            'TMPDIR',
        }
        if claude_adapter.DISABLE_BUNDLED_SKILLS:
            expected.add('CLAUDE_CODE_DISABLE_BUNDLED_SKILLS')
        return expected

    def test_review_child_env_is_exactly_the_allowlist(self):
        seen_envs = []

        def recording_run_group(*args, **kwargs):
            seen_envs.append(dict(kwargs['env']))
            return procs.run_group(*args, **kwargs)

        with mock.patch.dict(os.environ, self._hostile_env()):
            env_base = caselib.scrubbed_env()
            ctx = _make_ctx(self.stub_dir, env_base=env_base, run_group=recording_run_group)
            _clear_calls(self.stub_dir)
            req = _make_review_req(self.tmp / 'rev')
            reply = claude_adapter.review(req, ctx)
            self.assertIsNone(reply['error'])
        expected = self._expected_env_names(ctx.env_base)
        self.assertEqual(len(seen_envs), 1)
        self.assertEqual(set(seen_envs[0].keys()), expected)
        calls = _read_calls(self.stub_dir)
        self.assertEqual(len(calls), 1)
        # macOS CoreFoundation injects __CF_USER_TEXT_ENCODING into Python on startup (see test_runner_hardening.py).
        self.assertEqual(set(calls[0]['env_names']) - {'__CF_USER_TEXT_ENCODING'}, expected)

    def test_token_comes_from_the_file_not_the_ambient_env(self):
        with mock.patch.dict(os.environ, self._hostile_env()):
            env_base = caselib.scrubbed_env()
            ctx = _make_ctx(self.stub_dir, env_base=env_base)
            _clear_calls(self.stub_dir)
            claude_adapter.review(_make_review_req(self.tmp / 'rev-tok'), ctx)
        calls = _read_calls(self.stub_dir)
        expected = hashlib.sha256(FAKE_TOKEN.encode('utf-8')).hexdigest()
        wrong = hashlib.sha256(b'oauth-123456').hexdigest()
        self.assertEqual(calls[0]['token_sha256'], expected)
        self.assertNotEqual(calls[0]['token_sha256'], wrong)

    def test_review_dirs_are_under_tmp_root(self):
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'dirs')
        tmp_root = Path(req['tmp_root'])
        _clear_calls(self.stub_dir)
        claude_adapter.review(req, ctx)
        call = _read_calls(self.stub_dir)[0]
        sub = call['env_subset']
        self.assertEqual(sub['HOME'], str(tmp_root / 'home'))
        self.assertEqual(sub['CLAUDE_CONFIG_DIR'], str(tmp_root / 'claude-config'))
        self.assertEqual(sub['AGENT_HANDOFFS_DIR'], str(tmp_root / 'handoffs'))
        self.assertEqual(sub['BORK_REPO_RULES_DIR'], str(tmp_root / 'rules'))
        self.assertEqual(sub['TMPDIR'], str(tmp_root / 'tmp'))
        self.assertEqual(sub['GIT_TERMINAL_PROMPT'], '0')
        self.assertTrue(call['home_is_dir'])
        self.assertTrue(call['config_is_dir'])
        for name in ('home', 'claude-config', 'handoffs', 'rules', 'tmp'):
            self.assertTrue((tmp_root / name).is_dir())

    def test_grade_child_env_is_exactly_the_allowlist(self):
        seen_envs = []

        def recording_run_group(*args, **kwargs):
            seen_envs.append(dict(kwargs['env']))
            return procs.run_group(*args, **kwargs)

        with mock.patch.dict(os.environ, self._hostile_env()):
            env_base = caselib.scrubbed_env()
            ctx = _make_ctx(self.stub_dir, env_base=env_base, run_group=recording_run_group)
            _clear_calls(self.stub_dir)
            reply = claude_adapter.grade(_make_grade_req(self.tmp / 'grd'), ctx)
            self.assertIsNone(reply['error'])
        expected = self._expected_env_names(ctx.env_base)
        self.assertEqual(len(seen_envs), 1)
        self.assertEqual(set(seen_envs[0].keys()), expected)
        calls = _read_calls(self.stub_dir)
        self.assertEqual(len(calls), 1)
        self.assertEqual(set(calls[0]['env_names']) - {'__CF_USER_TEXT_ENCODING'}, expected)


class ScrubTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_token_never_reaches_any_output(self):
        modes = (
            ('ok', 20),
            ('no-skill', 20),
            ('no-plugin', 20),
            ('rate-limit', 20),
            ('error', 20),
            ('fallback-model', 20),
            ('command-markup', 20),
            ('sleep', 1.0),
        )
        for mode, timeout_s in modes:
            with self.subTest(mode=mode):
                _set_stub_config(self.stub_dir, {'mode': mode, 'echo_token': True})
                logs = []
                ctx = _make_ctx(self.stub_dir, logs=logs)
                req = _make_review_req(self.tmp / f'scrub-{mode}', timeout_s=timeout_s)
                reply = claude_adapter.review(req, ctx)
                for s in _walk_strings(reply):
                    self.assertNotIn(FAKE_TOKEN, s)
                for entry in logs:
                    self.assertNotIn(FAKE_TOKEN, entry)
                raw_dir = Path(req['raw_dir'])
                stream_file = raw_dir / 'stream.jsonl'
                self.assertTrue(stream_file.is_file())
                self.assertGreater(stream_file.stat().st_size, 0)
                for raw_file in raw_dir.rglob('*'):
                    if raw_file.is_file():
                        self.assertNotIn(FAKE_TOKEN, raw_file.read_text(encoding='utf-8', errors='replace'))

        # Also check grade() with token echoed in structured_output, result, and stderr.
        _set_stub_config(self.stub_dir, {'grade_mode': 'ok', 'echo_token': True})
        logs = []
        ctx = _make_ctx(self.stub_dir, logs=logs)
        greply = claude_adapter.grade(_make_grade_req(self.tmp / 'scrub-grade'), ctx)
        for s in _walk_strings(greply):
            self.assertNotIn(FAKE_TOKEN, s)
        for entry in logs:
            self.assertNotIn(FAKE_TOKEN, entry)

    def test_preflight_registers_the_secret(self):
        ctx = _make_ctx(self.stub_dir)
        self.assertEqual(ctx.secrets, [])
        claude_adapter.preflight(ctx)
        self.assertIn(FAKE_TOKEN, ctx.secrets)

    def test_files_copied_out_of_tmp_root_are_scrubbed(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'echo_token': True})
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'transcript-scrub')
        reply = claude_adapter.review(req, ctx)
        self.assertIn('transcript.jsonl', reply['raw_files'])
        raw_dir = Path(req['raw_dir'])
        copied = (raw_dir / 'transcript.jsonl').read_text(encoding='utf-8')
        self.assertIn('[redacted]', copied)
        for raw_file in raw_dir.rglob('*'):
            if raw_file.is_file():
                self.assertNotIn(FAKE_TOKEN, raw_file.read_text(encoding='utf-8', errors='replace'))


class ReviewArgvTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_argv_shape(self):
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'argv-shape', model='claude-opus-5-5', effort='high', max_budget_usd=7.5)
        _clear_calls(self.stub_dir)
        claude_adapter.review(req, ctx)
        call = _read_calls(self.stub_dir)[0]
        flags = _parse_flags(['claude'] + call['argv'])
        self.assertTrue(flags.get('-p'))
        self.assertEqual(flags.get('--output-format'), 'stream-json')
        self.assertTrue(flags.get('--verbose'))
        self.assertEqual(flags.get('--model'), 'claude-opus-5-5')
        self.assertEqual(flags.get('--effort'), 'high')
        self.assertEqual(flags.get('--plugin-dir'), req['export_dir'])
        self.assertEqual(flags.get('--setting-sources'), 'user')
        self.assertTrue(flags.get('--strict-mcp-config'))
        self.assertEqual(flags.get('--tools'), 'Bash,Read,Grep,Glob,Skill')
        self.assertEqual(flags.get('--permission-mode'), 'dontAsk')
        self.assertIn('--settings', flags)
        self.assertAlmostEqual(float(flags['--max-budget-usd']), 7.5)
        self.assertEqual(os.path.realpath(call['cwd']), os.path.realpath(req['trial_copy']))
        self.assertNotIn(req['base'], ' '.join(call['argv']))
        self.assertIn(req['base'], call['stdin'])

    def test_forbidden_flags_absent(self):
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'forbidden')
        _clear_calls(self.stub_dir)
        claude_adapter.review(req, ctx)
        argv = _read_calls(self.stub_dir)[0]['argv']
        forbidden = (
            '--bare',
            '--fallback-model',
            '--no-session-persistence',
            '--dangerously-skip-permissions',
            '--allow-dangerously-skip-permissions',
            '--mcp-config',
            '--resume',
            '--continue',
            '--agents',
            '--plugin-url',
            '--include-hook-events',
        )
        for flag in forbidden:
            self.assertNotIn(flag, argv)

    def test_no_effort_flag_when_effort_is_none(self):
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'no-effort', effort=None)
        _clear_calls(self.stub_dir)
        claude_adapter.review(req, ctx)
        argv = _read_calls(self.stub_dir)[0]['argv']
        self.assertNotIn('--effort', argv)
        self.assertNotIn('None', argv)

    def test_settings_json(self):
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'settings')
        _clear_calls(self.stub_dir)
        claude_adapter.review(req, ctx)
        flags = _parse_flags(['claude'] + _read_calls(self.stub_dir)[0]['argv'])
        settings = json.loads(flags['--settings'])
        sb = settings['sandbox']
        self.assertIs(sb['enabled'], True)
        self.assertIs(sb['autoAllowBashIfSandboxed'], True)
        self.assertIs(sb['allowUnsandboxedCommands'], False)
        self.assertIs(sb['failIfUnavailable'], True)
        self.assertEqual(sb['filesystem']['allowWrite'], [req['trial_copy'], req['tmp_root']])
        self.assertEqual(sb['network']['allowedDomains'], [])
        self.assertIs(sb['network']['strictAllowlist'], True)

    def test_prompt_on_stdin(self):
        ctx = _make_ctx(self.stub_dir)
        cases = (
            ('review', 'Use the Skill tool to run the `bork:review` skill'),
            ('review-security', 'Use the Skill tool to run the `bork:review-security` skill'),
        )
        for skill, invoke in cases:
            with self.subTest(skill=skill):
                _clear_calls(self.stub_dir)
                req = _make_review_req(self.tmp / f'prompt-{skill}', skill=skill)
                claude_adapter.review(req, ctx)
                stdin = _read_calls(self.stub_dir)[0]['stdin']
                self.assertEqual(stdin, harnesses.review_prompt(req, invoke))
                self.assertNotEqual(stdin.lstrip()[:1], '/')
                for line in stdin.splitlines():
                    self.assertFalse(line.lstrip().startswith('/bork:'))

    def test_deny_read_rules(self):
        ctx = _make_ctx(self.stub_dir)
        deny_paths = [str(self.tmp / 'secret-run'), str(self.tmp / 'secret-cases')]
        req = _make_review_req(self.tmp / 'deny-read', deny_read=deny_paths)
        _clear_calls(self.stub_dir)
        claude_adapter.review(req, ctx)
        flags = _parse_flags(['claude'] + _read_calls(self.stub_dir)[0]['argv'])
        settings = json.loads(flags['--settings'])
        self.assertEqual(settings['sandbox']['filesystem']['denyRead'], deny_paths)
        deny_rules = settings['permissions']['deny']
        for path in deny_paths:
            self.assertTrue(path.startswith('/'))
            self.assertIn(f'Read(/{path}/**)', deny_rules)
            self.assertIn(f'Grep(/{path}/**)', deny_rules)
            self.assertIn(f'Glob(/{path}/**)', deny_rules)
            self.assertNotIn(f'Read({path}/**)', deny_rules)


class PluginCheckTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_missing_plugin(self):
        _set_stub_config(self.stub_dir, {'mode': 'no-plugin'})
        ctx = _make_ctx(self.stub_dir)
        reply = claude_adapter.review(_make_review_req(self.tmp / 'no-plug'), ctx)
        self.assertEqual(reply['error'], 'plugin loading unavailable')

    def test_missing_skill(self):
        cases = (
            ('review-security', ['bork:review']),
            ('review', ['bork:review-security']),
        )
        for skill, init_skills in cases:
            with self.subTest(skill=skill):
                _set_stub_config(self.stub_dir, {'mode': 'ok', 'init_skills': init_skills})
                ctx = _make_ctx(self.stub_dir)
                reply = claude_adapter.review(_make_review_req(self.tmp / f'ms-{skill}', skill=skill), ctx)
                self.assertEqual(reply['error'], 'plugin loading unavailable')

    def test_installed_bork_is_not_the_export(self):
        wrong_dir = self.tmp / 'wrong-cache-bork'
        wrong_dir.mkdir()
        _set_stub_config(self.stub_dir, {
            'mode': 'ok',
            'init_plugins': [
                {'name': 'bork', 'path': str(wrong_dir), 'source': 'bork@skills'},
                {'name': 'cc-plugin-agents-md', 'path': '/builtin/a', 'source': 'cc-plugin-agents-md@builtin'},
            ],
        })
        ctx = _make_ctx(self.stub_dir)
        reply = claude_adapter.review(_make_review_req(self.tmp / 'wrong-bork'), ctx)
        self.assertEqual(reply['error'], 'plugin loading unavailable')

    def test_init_record_written(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok'})
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'init-rec')
        reply = claude_adapter.review(req, ctx)
        self.assertIn('init.json', reply['raw_files'])
        data = json.loads((Path(req['raw_dir']) / 'init.json').read_text(encoding='utf-8'))
        for key in ('plugins', 'skills', 'mcp_servers', 'tools'):
            self.assertIn(key, data)

    def test_missing_plugin_kills_at_init(self):
        pidfile = self.tmp / 'no-plug-pid.json'
        marker = self.tmp / 'no-plug-after-init.marker'
        _set_stub_config(self.stub_dir, {
            'mode': 'no-plugin',
            'sleep_after_init': 15,
            'pidfile': str(pidfile),
            'after_init_marker': str(marker),
        })
        ctx = _make_ctx(self.stub_dir)
        started = time.monotonic()
        reply = claude_adapter.review(_make_review_req(self.tmp / 'kill-init', timeout_s=30), ctx)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 6.0)
        self.assertEqual(reply['error'], 'plugin loading unavailable')
        self.assertEqual(reply['skill_loading'], 'plugin')
        self.assertFalse(marker.exists())
        calls = _read_calls(self.stub_dir)
        self.assertTrue(calls)
        self.assertTrue(support.pid_dead(calls[-1]['pid']))


class MappingTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_ok_stream_maps_to_reply(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'num_turns': 3, 'result_text': 'SAFE TO LAND'})
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'ok-map', model='claude-sonnet-5-5')
        reply = claude_adapter.review(req, ctx)
        self.assertEqual(reply['usage'], {'input_tokens': 2195, 'cached_input_tokens': 3223, 'output_tokens': 4})
        self.assertEqual(reply['rounds'], 3)
        self.assertEqual(reply['text'], 'SAFE TO LAND')
        self.assertEqual(reply['resolved_model'], 'claude-sonnet-5-5')
        self.assertIs(reply['rate_limited'], False)
        self.assertIsNone(reply['error'])
        self.assertIs(reply['skill_invoked'], True)
        self.assertTrue(reply['skill_evidence'].startswith('tool-use:'))

    def test_allowed_warning_is_not_rate_limited(self):
        _set_stub_config(self.stub_dir, {
            'mode': 'ok',
            'rate_limit_info': {
                'status': 'allowed_warning',
                'unifiedWindows': [{'window': '5h', 'status': 'rejected'}],
            },
        })
        ctx = _make_ctx(self.stub_dir)
        reply = claude_adapter.review(_make_review_req(self.tmp / 'rl-warn'), ctx)
        self.assertIs(reply['rate_limited'], False)
        self.assertIsNone(reply['error'])

    def test_rate_limit_mode(self):
        _set_stub_config(self.stub_dir, {'mode': 'rate-limit'})
        ctx = _make_ctx(self.stub_dir)
        reply = claude_adapter.review(_make_review_req(self.tmp / 'rl-mode'), ctx)
        self.assertIs(reply['rate_limited'], True)
        self.assertIsNotNone(reply['error'])

    def test_denied_or_other_skill_is_not_invoked(self):
        cases = (
            ('code-review', {'mode': 'ok', 'invoked_skill': 'code-review'}),
            ('other-bork-skill', {'mode': 'ok', 'invoked_skill': 'bork:review-security'}),
            ('denied-permission', {'mode': 'ok', 'invoked_skill': 'bork:review', 'deny_skill': True}),
            ('tool-result-error', {'mode': 'ok', 'invoked_skill': 'bork:review', 'skill_tool_result_error': True}),
        )
        ctx = _make_ctx(self.stub_dir)
        for label, cfg in cases:
            with self.subTest(case=label):
                _set_stub_config(self.stub_dir, cfg)
                reply = claude_adapter.review(_make_review_req(self.tmp / f'sk-{label}', skill='review'), ctx)
                self.assertIs(reply['skill_invoked'], False)
                self.assertTrue(reply['skill_evidence'].startswith('none'))

    def test_no_skill_and_truncated_stream(self):
        ctx = _make_ctx(self.stub_dir)
        _set_stub_config(self.stub_dir, {'mode': 'no-skill'})
        r_noskill = claude_adapter.review(_make_review_req(self.tmp / 'no-sk'), ctx)
        self.assertIs(r_noskill['skill_invoked'], False)
        self.assertTrue(r_noskill['skill_evidence'].startswith('none'))

        _set_stub_config(self.stub_dir, {'mode': 'ok', 'truncated': True})
        r_trunc = claude_adapter.review(_make_review_req(self.tmp / 'trunc'), ctx)
        self.assertIsNone(r_trunc['skill_invoked'])
        self.assertIsNotNone(r_trunc['error'])

    def test_effort_comes_from_this_sessions_transcript(self):
        ctx = _make_ctx(self.stub_dir)
        _set_stub_config(self.stub_dir, {
            'mode': 'ok',
            'session_id': 'sess-ours-9999',
            'transcript_effort': 'high',
            'other_session_transcript': {'session_id': '0000-aaa-first', 'effort': 'low'},
        })
        reply = claude_adapter.review(_make_review_req(self.tmp / 'eff-ours', effort='high'), ctx)
        self.assertEqual(reply['resolved_effort'], 'high')

        _set_stub_config(self.stub_dir, {'mode': 'ok', 'no_transcript': True})
        reply_none = claude_adapter.review(_make_review_req(self.tmp / 'eff-none'), ctx)
        self.assertIsNone(reply_none['resolved_effort'])

    def test_missing_usage_is_none(self):
        ctx = _make_ctx(self.stub_dir)
        for label, cfg in (
            ('no-usage', {'mode': 'ok', 'omit_usage': True}),
            ('truncated', {'mode': 'ok', 'truncated': True}),
        ):
            with self.subTest(case=label):
                _set_stub_config(self.stub_dir, cfg)
                reply = claude_adapter.review(_make_review_req(self.tmp / f'usage-{label}'), ctx)
                self.assertEqual(
                    reply['usage'],
                    {'input_tokens': None, 'output_tokens': None, 'cached_input_tokens': None},
                )

    def test_cost_only_in_raw(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok'})
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'cost-raw')
        reply = claude_adapter.review(req, ctx)
        self.assertNotIn('cost_usd', reply)
        self.assertNotIn('total_cost_usd', reply)
        raw_dir = Path(req['raw_dir'])
        found_cost = any('total_cost_usd' in (raw_dir / name).read_text(encoding='utf-8') for name in reply['raw_files'])
        self.assertTrue(found_cost)

    def test_fallback_model_mode(self):
        _set_stub_config(self.stub_dir, {
            'mode': 'fallback-model',
            'init_model': 'claude-opus-5-5',
            'served_model': 'claude-sonnet-5-5',
        })
        ctx = _make_ctx(self.stub_dir)
        req = _make_review_req(self.tmp / 'fb-model', model='claude-opus-5-5')
        reply = claude_adapter.review(req, ctx)
        self.assertEqual(reply['resolved_model'], 'claude-sonnet-5-5')
        meta = json.loads((Path(req['raw_dir']) / 'result-meta.json').read_text(encoding='utf-8'))
        self.assertEqual(meta['init_model'], 'claude-opus-5-5')
        self.assertIn('claude-sonnet-5-5', meta['modelUsage'])

        _set_stub_config(self.stub_dir, {'mode': 'ok', 'omit_assistant': True})
        reply_no_asst = claude_adapter.review(_make_review_req(self.tmp / 'no-asst'), ctx)
        self.assertIsNone(reply_no_asst['resolved_model'])

    def test_command_name_markup_counts(self):
        ctx = _make_ctx(self.stub_dir)
        _set_stub_config(self.stub_dir, {'mode': 'ok'})
        tool_reply = claude_adapter.review(_make_review_req(self.tmp / 'tool-form', skill='review'), ctx)

        _set_stub_config(self.stub_dir, {'mode': 'command-markup', 'command_name': '/bork:review'})
        cmd_reply = claude_adapter.review(_make_review_req(self.tmp / 'cmd-form', skill='review'), ctx)
        self.assertIs(cmd_reply['skill_invoked'], True)
        self.assertTrue(cmd_reply['skill_evidence'].startswith('tool-use:'))
        self.assertIn('command-name', cmd_reply['skill_evidence'])
        self.assertNotEqual(cmd_reply['skill_evidence'], tool_reply['skill_evidence'])

        _set_stub_config(self.stub_dir, {'mode': 'command-markup', 'command_name': '/bork:review-security'})
        wrong_reply = claude_adapter.review(_make_review_req(self.tmp / 'cmd-wrong', skill='review'), ctx)
        self.assertIs(wrong_reply['skill_invoked'], False)
        self.assertTrue(wrong_reply['skill_evidence'].startswith('none'))

    def test_tool_result_markup_does_not_count(self):
        ctx = _make_ctx(self.stub_dir)
        _set_stub_config(self.stub_dir, {'mode': 'tool-result-markup', 'command_name': '/bork:review'})
        reply = claude_adapter.review(_make_review_req(self.tmp / 'trm-mode', skill='review'), ctx)
        self.assertIs(reply['skill_invoked'], False)
        self.assertTrue(reply['skill_evidence'].startswith('none'))

        # Mid-sentence user text containing <command-name> (not at start) also does not count.
        exp = self.tmp / 'trm-mid-exp'
        exp.mkdir()
        lines = [
            {
                'type': 'system', 'subtype': 'init', 'session_id': 's-mid', 'model': 'm',
                'plugins': [{'name': 'bork', 'path': str(exp), 'source': 'bork@inline'}],
                'skills': ['bork:review'], 'tools': [], 'mcp_servers': [],
            },
            {
                'type': 'user',
                'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'Quoted: <command-name>/bork:review</command-name>'}]},
            },
            {
                'type': 'result', 'subtype': 'success', 'is_error': False, 'result': 'done',
                'num_turns': 1, 'session_id': 's-mid', 'usage': {'input_tokens': 1, 'output_tokens': 1},
                'permission_denials': [],
            },
        ]
        stream = ''.join(json.dumps(ev) + '\n' for ev in lines)

        def fake_run_group(argv, **kw):
            cb = kw.get('on_stdout_line')
            if cb:
                for ln in stream.splitlines(True):
                    if cb(ln) is False:
                        break
            return subprocess.CompletedProcess(argv, 0, stream, '')

        ctx_mid = _make_ctx(self.stub_dir, run_group=fake_run_group)
        r_mid = claude_adapter.review(_make_review_req(self.tmp / 'trm-mid', export_dir=str(exp), skill='review'), ctx_mid)
        self.assertIs(r_mid['skill_invoked'], False)
        self.assertTrue(r_mid['skill_evidence'].startswith('none'))


class FailureTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_every_launch_goes_through_ctx_run_group(self):
        seen = []

        def recording_run_group(*args, **kwargs):
            seen.append(list(args[0]))
            return procs.run_group(*args, **kwargs)

        ctx = _make_ctx(self.stub_dir, run_group=recording_run_group)
        claude_adapter.preflight(ctx)
        claude_adapter.review(_make_review_req(self.tmp / 'rec-rev'), ctx)
        claude_adapter.grade(_make_grade_req(self.tmp / 'rec-grd'), ctx)
        self.assertEqual(len(seen), 3)
        self.assertIn('--version', seen[0])
        self.assertIn('stream-json', seen[1])
        self.assertIn('--json-schema', seen[2])

    def test_timeout_kills_the_group(self):
        pidfile = self.tmp / 'sleep-pids.json'
        _set_stub_config(self.stub_dir, {'mode': 'sleep', 'pidfile': str(pidfile)})
        ctx = _make_ctx(self.stub_dir)
        started = time.monotonic()
        reply = claude_adapter.review(_make_review_req(self.tmp / 'timeout-box', timeout_s=2), ctx)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 9.0)
        self.assertEqual(set(reply.keys()), REVIEW_KEYS)
        self.assertIn('timeout', (reply['error'] or '').lower())
        pids = support.read_pids(pidfile, wait=5.0)
        self.assertTrue(support.pid_dead(pids['stub']))
        self.assertTrue(support.pid_dead(pids['child']))

    def test_failures_return_a_full_reply(self):
        ctx = _make_ctx(self.stub_dir)
        claude_adapter.preflight(ctx)
        cases = (
            ('error-mode', {'mode': 'error'}),
            ('empty-nonzero', {'mode': 'empty', 'exit_code': 2}),
            ('non-json', {'mode': 'non-json', 'exit_code': 0}),
        )
        for label, cfg in cases:
            with self.subTest(failure=label):
                _set_stub_config(self.stub_dir, cfg)
                reply = claude_adapter.review(_make_review_req(self.tmp / f'fail-{label}'), ctx)
                self.assertEqual(set(reply.keys()), REVIEW_KEYS)
                self.assertIsInstance(reply['error'], str)
                self.assertTrue(reply['error'])
                self.assertNotIn('\n', reply['error'])

        with self.subTest(failure='oserror-at-launch'):
            (self.stub_dir / 'claude').unlink()
            reply = claude_adapter.review(_make_review_req(self.tmp / 'fail-oserror'), ctx)
            self.assertEqual(set(reply.keys()), REVIEW_KEYS)
            self.assertIsInstance(reply['error'], str)
            self.assertTrue(reply['error'])
            self.assertNotIn('\n', reply['error'])

    def test_interrupt_propagates(self):
        def raise_interrupt(*_args, **_kwargs):
            raise KeyboardInterrupt('stop now')

        ctx = _make_ctx(self.stub_dir, run_group=raise_interrupt)
        with self.assertRaises(KeyboardInterrupt):
            claude_adapter.review(_make_review_req(self.tmp / 'int-rev'), ctx)
        with self.assertRaises(KeyboardInterrupt):
            claude_adapter.grade(_make_grade_req(self.tmp / 'int-grd'), ctx)


class ContractTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_every_mode_returns_every_key(self):
        ctx = _make_ctx(self.stub_dir)
        claude_adapter.preflight(ctx)
        modes = (
            ('ok', 20),
            ('no-skill', 20),
            ('no-plugin', 20),
            ('rate-limit', 20),
            ('error', 20),
            ('sleep', 1.0),
            ('fallback-model', 20),
            ('command-markup', 20),
        )
        for mode, timeout_s in modes:
            with self.subTest(mode=mode):
                _set_stub_config(self.stub_dir, {'mode': mode})
                req = _make_review_req(self.tmp / f'contract-{mode}', timeout_s=timeout_s)
                reply = claude_adapter.review(req, ctx)
                self.assertEqual(set(reply.keys()), REVIEW_KEYS)
                self.assertIsInstance(reply['text'], str)
                self.assertEqual(set(reply['usage'].keys()), {'input_tokens', 'output_tokens', 'cached_input_tokens'})
                for val in reply['usage'].values():
                    self.assertTrue(val is None or (isinstance(val, int) and not isinstance(val, bool)))
                self.assertTrue(reply['rounds'] is None or (isinstance(reply['rounds'], int) and not isinstance(reply['rounds'], bool)))
                self.assertIsInstance(reply['duration_s'], float)
                self.assertTrue(reply['resolved_model'] is None or isinstance(reply['resolved_model'], str))
                self.assertTrue(reply['resolved_effort'] is None or isinstance(reply['resolved_effort'], str))
                self.assertIn(reply['skill_invoked'], (True, False, None))
                self.assertIsInstance(reply['skill_evidence'], str)
                self.assertIn(reply['skill_loading'], ('plugin', 'inline'))
                self.assertIsInstance(reply['rate_limited'], bool)
                self.assertTrue(reply['error'] is None or isinstance(reply['error'], str))
                self.assertIsInstance(reply['argv'], list)
                self.assertTrue(all(isinstance(a, str) for a in reply['argv']))
                self.assertIsInstance(reply['raw_files'], list)
                raw_dir = Path(req['raw_dir'])
                for name in reply['raw_files']:
                    self.assertIsInstance(name, str)
                    self.assertNotIn('/', name)
                    self.assertTrue((raw_dir / name).is_file())
                self.assertTrue(reply['harness_version'] is None or isinstance(reply['harness_version'], str))

    def test_grade_keys(self):
        ctx = _make_ctx(self.stub_dir)
        reply = claude_adapter.grade(_make_grade_req(self.tmp / 'grd-keys'), ctx)
        self.assertEqual(set(reply.keys()), GRADE_KEYS)
        self.assertTrue(reply['parsed'] is None or isinstance(reply['parsed'], dict))
        self.assertIsNone(reply['cost_usd'])

    def test_harness_version_from_preflight(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'version': '2.1.328 (Claude Code)'})
        ctx = _make_ctx(self.stub_dir)
        claude_adapter.preflight(ctx)
        reply = claude_adapter.review(_make_review_req(self.tmp / 'ver-check'), ctx)
        self.assertEqual(reply['harness_version'], '2.1.328 (Claude Code)')


class GradeTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_grade_argv(self):
        ctx = _make_ctx(self.stub_dir)
        for tools, expected_tools in (('none', ''), ('read-only', 'Read,Grep,Glob')):
            with self.subTest(tools=tools):
                _clear_calls(self.stub_dir)
                req = _make_grade_req(self.tmp / f'gargv-{tools}', tools=tools)
                claude_adapter.grade(req, ctx)
                call = _read_calls(self.stub_dir)[0]
                flags = _parse_flags(['claude'] + call['argv'])
                self.assertNotIn('--plugin-dir', flags)
                self.assertEqual(flags.get('--tools'), expected_tools)
                self.assertEqual(flags.get('--output-format'), 'json')
                self.assertEqual(json.loads(flags['--json-schema']), req['schema'])
                self.assertEqual(flags.get('--setting-sources'), 'user')
                self.assertTrue(flags.get('--strict-mcp-config'))
                self.assertEqual(flags.get('--permission-mode'), 'dontAsk')
                self.assertAlmostEqual(float(flags['--max-budget-usd']), 2.0)
                self.assertEqual(os.path.realpath(call['cwd']), os.path.realpath(req['cwd']))

        with self.assertRaises(harnesses.Refusal):
            claude_adapter.grade(_make_grade_req(self.tmp / 'gargv-bad', tools='write-all'), ctx)

    def test_grade_deny_read_rules(self):
        ctx = _make_ctx(self.stub_dir)
        deny_paths = [str(self.tmp / 'run-secret'), str(self.tmp / 'cases-secret')]
        req = _make_grade_req(self.tmp / 'gdeny', deny_read=deny_paths)
        _clear_calls(self.stub_dir)
        claude_adapter.grade(req, ctx)
        flags = _parse_flags(['claude'] + _read_calls(self.stub_dir)[0]['argv'])
        settings = json.loads(flags['--settings'])
        deny_rules = settings['permissions']['deny']
        for path in deny_paths:
            self.assertTrue(path.startswith('/'))
            self.assertIn(f'Read(/{path}/**)', deny_rules)
            self.assertIn(f'Grep(/{path}/**)', deny_rules)
            self.assertIn(f'Glob(/{path}/**)', deny_rules)
            self.assertNotIn(f'Read({path}/**)', deny_rules)

    def test_grade_sees_no_case_or_config_markers(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'record_full_env': True})
        ambient = {
            'BORK_EVAL_CASE_ID': 'MARKER-CASE-77',
            'CLAUDE_EFFORT': 'MARK-AMBIENT-EFFORT',
            'BORK_EVAL_CONFIG_KEY': 'claude|MARKMODEL|high|review|plugin',
            'BORK_EVAL_CLAUDE_TOKEN_FILE': str(self.token_file),
        }
        with mock.patch.dict(os.environ, ambient):
            ctx = _make_ctx(self.stub_dir, env_base=caselib.scrubbed_env())
            rev_req = _make_review_req(
                self.tmp / 'rev-MARK-ROOT',
                model='MARKMODEL',
                effort='high',
                trial_copy=str(self.tmp / 'MARK-TRIAL-COPY'),
                export_dir=str(self.tmp / 'MARK-EXPORT-DIR'),
            )
            Path(rev_req['trial_copy']).mkdir(exist_ok=True)
            Path(rev_req['export_dir']).mkdir(exist_ok=True)
            claude_adapter.review(rev_req, ctx)

            _clear_calls(self.stub_dir)
            grd_req = _make_grade_req(self.tmp / 'grd-clean', model='claude-sonnet-5-5', effort='low')
            claude_adapter.grade(grd_req, ctx)

        call = _read_calls(self.stub_dir)[0]
        grade_tmp = os.path.realpath(grd_req['tmp_root'])
        self.assertTrue(os.path.realpath(call['env_subset']['HOME']).startswith(grade_tmp + os.sep))
        self.assertTrue(os.path.realpath(call['env_subset']['CLAUDE_CONFIG_DIR']).startswith(grade_tmp + os.sep))
        blob = json.dumps({
            'argv': call['argv'],
            'cwd': call['cwd'],
            'env': call.get('env', {}),
            'stdin': call['stdin'],
        })
        for marker in (
            'MARKMODEL',
            'MARK-TRIAL-COPY',
            'MARK-EXPORT-DIR',
            'MARK-ROOT',
            'MARKER-CASE-77',
            'MARK-AMBIENT-EFFORT',
            'claude|MARKMODEL|high|review|plugin',
        ):
            self.assertNotIn(marker, blob)

    def test_grade_parsing(self):
        ctx = _make_ctx(self.stub_dir)
        _set_stub_config(self.stub_dir, {'grade_mode': 'ok', 'structured_output': {'ok': True, 'note': 'yes'}})
        r_ok = claude_adapter.grade(_make_grade_req(self.tmp / 'gp-ok'), ctx)
        self.assertEqual(r_ok['parsed'], {'ok': True, 'note': 'yes'})
        self.assertIsNone(r_ok['error'])

        for gmode in ('bad-structured', 'text-non-json', 'text-list'):
            with self.subTest(grade_mode=gmode):
                _set_stub_config(self.stub_dir, {'grade_mode': gmode})
                r_bad = claude_adapter.grade(_make_grade_req(self.tmp / f'gp-{gmode}'), ctx)
                self.assertIsNone(r_bad['parsed'])
                self.assertIsNotNone(r_bad['error'])

    def test_grade_failures(self):
        ctx = _make_ctx(self.stub_dir)
        for label, cfg, timeout_s in (
            ('timeout', {'grade_mode': 'sleep'}, 1.0),
            ('is_error', {'grade_mode': 'is_error'}, 20),
            ('non-json', {'grade_mode': 'non-json'}, 20),
            ('empty', {'grade_mode': 'empty'}, 20),
        ):
            with self.subTest(failure=label):
                _set_stub_config(self.stub_dir, cfg)
                reply = claude_adapter.grade(_make_grade_req(self.tmp / f'gf-{label}', timeout_s=timeout_s), ctx)
                self.assertIsNone(reply['parsed'])
                self.assertIsInstance(reply['error'], str)
                self.assertTrue(reply['error'])
                self.assertNotIn('\n', reply['error'])


class IsolationCliTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box(config={'mode': 'ok', 'isolation': True})
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)
        self.export_dir = self.tmp / 'skills-export'
        self.export_dir.mkdir()

    def _run_cli(self, args, extra_env=None):
        env = {
            'PATH': support.safe_path(self.stub_dir),
            'BORK_EVAL_CLAUDE_TOKEN_FILE': str(self.token_file),
            'HOME': str(self.tmp / 'caller-home'),
            'TMPDIR': str(self.tmp),
        }
        if extra_env:
            for k, v in extra_env.items():
                if v is None:
                    env.pop(k, None)
                else:
                    env[k] = v
        run = subprocess.run(
            [sys.executable, str(ISOLATION_CLI), *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(self.tmp),
            timeout=30,
        )
        self.assertNotIn(FAKE_TOKEN, run.stdout)
        self.assertNotIn(FAKE_TOKEN, run.stderr)
        return run

    def test_cli_refusals(self):
        _clear_calls(self.stub_dir)
        r_noargs = self._run_cli([])
        self.assertEqual(r_noargs.returncode, 2)
        self.assertIn('usage:', r_noargs.stderr.lower())

        r_nospend = self._run_cli(['--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir)])
        self.assertEqual(r_nospend.returncode, 2)
        self.assertIn('--spend', r_nospend.stderr)
        self.assertEqual(_read_calls(self.stub_dir), [])

        bad_tok = self.tmp / 'missing-token'
        unsafe_tok = self.tmp / 'unsafe-token'
        unsafe_tok.write_text(FAKE_TOKEN + '\n', encoding='utf-8')
        unsafe_tok.chmod(0o644)
        for label, tok_path in (('missing', bad_tok), ('unsafe-0644', unsafe_tok)):
            with self.subTest(token_fault=label):
                _clear_calls(self.stub_dir)
                r_bad = self._run_cli(
                    ['--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir)],
                    extra_env={'BORK_EVAL_CLAUDE_TOKEN_FILE': str(tok_path)},
                )
                self.assertEqual(r_bad.returncode, 2)
                self.assertNotIn('Traceback', r_bad.stderr)
                self.assertEqual(_read_calls(self.stub_dir), [])

    def test_clean_init_passes(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'isolation': True, 'echo_token': True})
        run = self._run_cli(['--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir)])
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('PASS', run.stdout.splitlines())

    def test_each_violation_fails(self):
        wrong_export = self.tmp / 'wrong-export'
        wrong_export.mkdir()
        cases = (
            ('extra-non-builtin-plugin', 'plugins', {
                'mode': 'ok', 'isolation': True,
                'init_plugins': [
                    {'name': 'bork', 'path': str(self.export_dir), 'source': 'bork@inline'},
                    {'name': 'evil-plugin', 'path': '/tmp/evil', 'source': 'evil@user'},
                ],
            }),
            ('bork-wrong-path', 'plugins', {
                'mode': 'ok', 'isolation': True,
                'init_plugins': [
                    {'name': 'bork', 'path': str(wrong_export), 'source': 'bork@skills'},
                ],
            }),
            ('non-empty-mcp', 'mcp_servers', {
                'mode': 'ok', 'isolation': True,
                'mcp_servers': [{'name': 'rogue', 'status': 'connected'}],
            }),
            ('hook-event', 'hook_events', {
                'mode': 'ok', 'isolation': True,
                'emit_hook_event': True,
            }),
            ('non-none-api-key-source', 'api_key_source', {
                'mode': 'ok', 'isolation': True,
                'api_key_source': 'ANTHROPIC_API_KEY',
            }),
            ('token-modified', 'token_file_unchanged', {
                'mode': 'ok', 'isolation': True,
                'mutate_token_file': str(self.token_file),
            }),
            ('tools-mismatch', 'tools', {
                'mode': 'ok', 'isolation': True,
                'init_tools': ['Bash', 'Read', 'Grep', 'Glob', 'Skill', 'Agent'],
            }),
            ('outside-probe-written', 'sandbox_write', {
                'mode': 'ok', 'isolation': True,
                'write_outside_probe': True,
            }),
        )
        for label, check_name, cfg in cases:
            with self.subTest(violation=label):
                # Restore token file before each subtest
                self.token_file.write_text(FAKE_TOKEN + '\n', encoding='utf-8')
                self.token_file.chmod(0o600)
                _set_stub_config(self.stub_dir, cfg)
                run = self._run_cli([
                    '--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir),
                ])
                self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
                self.assertIn('FAIL', run.stdout)
                self.assertIn(f'check {check_name}: FAIL', run.stdout)

    def test_same_argv_and_env_as_review(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'isolation': True})
        deny = str(self.tmp / 'denied-dir')
        Path(deny).mkdir()
        _clear_calls(self.stub_dir)
        run = self._run_cli([
            '--spend', '--model', 'claude-sonnet-5-5', '--effort', 'low',
            '--export', str(self.export_dir), '--deny-read', deny,
        ])
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        calls = [c for c in _read_calls(self.stub_dir) if '-p' in c['argv']]
        self.assertEqual(len(calls), 1)
        cli_call = calls[0]

        # Child cwd and tmp_root must be inside a fresh private temp dir, never caller's cwd.
        self.assertNotEqual(os.path.realpath(cli_call['cwd']), os.path.realpath(str(self.tmp)))

        # Compare against shared builder for the same model, effort, export, cwd, tmp_root, deny_read.
        tmp_root = str(Path(cli_call['env_subset']['HOME']).parent)
        review_argv = claude_adapter.build_review_argv(
            str(self.stub_dir / 'claude'),
            model='claude-sonnet-5-5',
            effort='low',
            export_dir=str(self.export_dir),
            trial_copy=cli_call['cwd'],
            tmp_root=tmp_root,
            deny_read=[deny],
            max_budget_usd=9.0,
        )[1:]
        cli_argv = cli_call['argv']
        self.assertIn('--include-hook-events', cli_argv)
        self.assertNotIn('--include-hook-events', review_argv)
        cli_flags = _parse_flags(['claude'] + cli_argv)
        rev_flags = _parse_flags(['claude'] + review_argv)
        self.assertAlmostEqual(float(cli_flags['--max-budget-usd']), 0.5)
        self.assertAlmostEqual(float(rev_flags['--max-budget-usd']), 9.0)
        cli_flags.pop('--include-hook-events')
        cli_flags.pop('--max-budget-usd')
        rev_flags.pop('--max-budget-usd')
        self.assertEqual(cli_flags, rev_flags)

        # Env names equal review()'s under the same env_base.
        _clear_calls(self.stub_dir)
        env_base = caselib.scrubbed_env()
        ctx = _make_ctx(self.stub_dir, env_base=env_base)
        claude_adapter.review(_make_review_req(self.tmp / 'rev-cmp', deny_read=[deny]), ctx)
        rev_call = [c for c in _read_calls(self.stub_dir) if '-p' in c['argv']][0]
        # Both use caselib.scrubbed_env() + the exact same adapter keys.
        cli_only_base = set(cli_call['env_names']) - set(rev_call['env_names'])
        rev_only_base = set(rev_call['env_names']) - set(cli_call['env_names'])
        # Only differences allowed are standard ENV_PASS keys present in one parent env and not the other.
        allowed_pass = set(caselib.ENV_PASS)
        self.assertTrue(all(k in allowed_pass or k.startswith('LC_') for k in cli_only_base), cli_only_base)
        self.assertTrue(all(k in allowed_pass or k.startswith('LC_') for k in rev_only_base), rev_only_base)

    def test_cleanup_is_link_safe(self):
        outside = self.tmp / 'outside-protected.txt'
        outside.write_text('ORIGINAL-PROTECTED-CONTENT\n', encoding='utf-8')
        outside.chmod(0o444)
        before_stat = os.lstat(outside)
        _set_stub_config(self.stub_dir, {
            'mode': 'ok',
            'isolation': True,
            'plant_links_to': str(outside),
        })
        run = self._run_cli(['--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir)])
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(outside.read_text(encoding='utf-8'), 'ORIGINAL-PROTECTED-CONTENT\n')
        after_stat = os.lstat(outside)
        self.assertEqual(stat.S_IMODE(after_stat.st_mode), stat.S_IMODE(before_stat.st_mode))
        self.assertEqual(after_stat.st_mtime_ns, before_stat.st_mtime_ns)
        outside.chmod(0o600)


    def test_unobservable_conditions_are_not_checked(self):
        _set_stub_config(self.stub_dir, {
            'mode': 'ok',
            'isolation': True,
            'skip_inside_write': True,
        })
        run = self._run_cli(['--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir)])
        self.assertNotEqual(run.returncode, 0)
        self.assertNotIn('PASS', run.stdout.splitlines())
        self.assertIn('sandbox_write', run.stdout)
        self.assertIn('NOT CHECKED', run.stdout)

    def test_write_probe(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'isolation': True})
        _clear_calls(self.stub_dir)
        ok_run = self._run_cli(['--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir)])
        self.assertEqual(ok_run.returncode, 0, ok_run.stdout + ok_run.stderr)
        call = [c for c in _read_calls(self.stub_dir) if '-p' in c['argv']][0]
        self.assertIn('outside-probe.txt', call['stdin'])
        self.assertIn('inside-probe.txt', call['stdin'])

        _set_stub_config(self.stub_dir, {'mode': 'ok', 'isolation': True, 'write_outside_probe': True})
        fail_run = self._run_cli(['--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir)])
        self.assertEqual(fail_run.returncode, 1)
        self.assertIn('FAIL', fail_run.stdout)
        self.assertIn('sandbox_write', fail_run.stdout)

    def test_claude_md_check_is_structural(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'isolation': True})
        _clear_calls(self.stub_dir)
        run = self._run_cli(['--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir)])
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        call = [c for c in _read_calls(self.stub_dir) if '-p' in c['argv']][0]
        self.assertTrue(call['home_is_dir'])
        self.assertTrue(call['config_is_dir'])
        self.assertFalse(call['home_has_claude_md'])
        self.assertFalse(call['config_has_claude_md'])
        self.assertIn('structural check', run.stdout.lower())

    def test_token_visibility_is_recorded(self):
        for visible, expected in ((True, 'yes'), (False, 'no')):
            with self.subTest(visible=visible):
                _set_stub_config(self.stub_dir, {
                    'mode': 'ok',
                    'isolation': True,
                    'bash_echo_token_in_env': visible,
                })
                run = self._run_cli([
                    '--spend', '--model', 'sonnet', '--effort', 'low', '--export', str(self.export_dir),
                ])
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertIn('PASS', run.stdout.splitlines())
                self.assertIn(f'CLAUDE_CODE_OAUTH_TOKEN visible to Bash children: {expected}', run.stdout)


class ProcsCallbackTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_on_stdout_line_early_kill_leaves_no_live_child(self):
        pidfile = self.tmp / 'procs-cb-pids.json'
        script = (
            'import json, os, subprocess, sys, time\n'
            'child = subprocess.Popen(["sleep", "60"])\n'
            f'open({str(pidfile)!r}, "w").write(json.dumps({{"parent": os.getpid(), "child": child.pid}}))\n'
            'print("line-one", flush=True)\n'
            'time.sleep(60)\n'
            'print("line-two", flush=True)\n'
        )
        seen = []

        def stop_on_first(line):
            seen.append(line)
            return False

        started = time.monotonic()
        res = procs.run_group([sys.executable, '-c', script], timeout=20, on_stdout_line=stop_on_first)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 6.0)
        self.assertEqual(seen, ['line-one\n'])
        self.assertEqual(res.stdout, 'line-one\n')
        self.assertNotIn('line-two', res.stdout)
        self.assertNotEqual(res.returncode, 0)
        pids = support.read_pids(pidfile, wait=5.0)
        self.assertTrue(support.pid_dead(pids['parent']))
        self.assertTrue(support.pid_dead(pids['child']))

    def test_on_stdout_line_tight_loop_times_out(self):
        script = 'import sys\nwhile True:\n    sys.stdout.write("tick\\n"); sys.stdout.flush()\n'
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            procs.run_group(
                [sys.executable, '-c', script],
                timeout=1.0,
                on_stdout_line=lambda _line: True,
            )
        self.assertLess(time.monotonic() - started, 6.0)


class SkillPermissionTests(_ClaudeTestBase):
    def setUp(self):
        self._init_box()
        os.environ['BORK_EVAL_CLAUDE_TOKEN_FILE'] = str(self.token_file)

    def test_review_settings_allow_rules(self):
        trial_copy = str(self.tmp / 'trial_copy')
        tmp_root = str(self.tmp / 'tmp_root')
        deny_paths = [str(self.tmp / 'secret-run'), str(self.tmp / 'secret-cases')]
        expected_deny = []
        for path in deny_paths:
            expected_deny.extend([
                f'Read(/{path}/**)',
                f'Grep(/{path}/**)',
                f'Glob(/{path}/**)',
            ])

        for skill, qualified in (
            ('review', 'bork:review'),
            ('review-security', 'bork:review-security'),
        ):
            with self.subTest(skill=skill):
                settings = claude_adapter.build_review_settings(
                    trial_copy,
                    tmp_root,
                    deny_paths,
                    skill=skill,
                )
                self.assertEqual(
                    settings['permissions']['allow'],
                    [f'Skill({qualified})', 'Read', 'Grep', 'Glob'],
                )
                self.assertEqual(settings['permissions']['deny'], expected_deny)
                self.assertEqual(settings['sandbox']['filesystem']['denyRead'], deny_paths)
                self.assertEqual(
                    settings['sandbox']['filesystem']['allowWrite'],
                    [trial_copy, tmp_root],
                )

        with self.assertRaises(harnesses.Refusal):
            claude_adapter.build_review_settings(trial_copy, tmp_root, deny_paths, skill='unknown-skill')

    def test_grade_settings_allow_rules(self):
        deny_paths = [str(self.tmp / 'run-secret'), str(self.tmp / 'cases-secret')]
        expected_deny = []
        for path in deny_paths:
            expected_deny.extend([
                f'Read(/{path}/**)',
                f'Grep(/{path}/**)',
                f'Glob(/{path}/**)',
            ])

        ro_settings = claude_adapter.build_grade_settings(deny_paths, tools='read-only')
        self.assertEqual(ro_settings['permissions']['allow'], ['Read', 'Grep', 'Glob'])
        self.assertEqual(ro_settings['permissions']['deny'], expected_deny)

        none_settings = claude_adapter.build_grade_settings(deny_paths, tools='none')
        self.assertNotIn('allow', none_settings['permissions'])
        self.assertEqual(none_settings['permissions']['deny'], expected_deny)

        with self.assertRaises(harnesses.Refusal):
            claude_adapter.build_grade_settings(deny_paths, tools='write-all')

        # End-to-end through grade() argv for both tools modes.
        ctx = _make_ctx(self.stub_dir)
        for tools, expected_allow in (
            ('read-only', ['Read', 'Grep', 'Glob']),
            ('none', None),
        ):
            with self.subTest(grade_tools=tools):
                _clear_calls(self.stub_dir)
                req = _make_grade_req(self.tmp / f'gperm-{tools}', tools=tools, deny_read=deny_paths)
                reply = claude_adapter.grade(req, ctx)
                self.assertIsNone(reply['error'])
                flags = _parse_flags(['claude'] + _read_calls(self.stub_dir)[0]['argv'])
                parsed = json.loads(flags['--settings'])
                if expected_allow is None:
                    self.assertNotIn('allow', parsed['permissions'])
                else:
                    self.assertEqual(parsed['permissions']['allow'], expected_allow)
                self.assertEqual(parsed['permissions']['deny'], expected_deny)

    def test_review_argv_carries_allow_rules(self):
        _set_stub_config(self.stub_dir, {'mode': 'ok', 'enforce_skill_permission': True})
        deny_paths = [str(self.tmp / 'secret-run'), str(self.tmp / 'secret-cases')]
        expected_deny = []
        for path in deny_paths:
            expected_deny.extend([
                f'Read(/{path}/**)',
                f'Grep(/{path}/**)',
                f'Glob(/{path}/**)',
            ])

        for skill, qualified in (
            ('review', 'bork:review'),
            ('review-security', 'bork:review-security'),
        ):
            with self.subTest(skill=skill):
                seen_argvs = []

                def recording_run_group(*args, **kwargs):
                    seen_argvs.append(list(args[0]))
                    return procs.run_group(*args, **kwargs)

                _clear_calls(self.stub_dir)
                ctx = _make_ctx(self.stub_dir, run_group=recording_run_group)
                req = _make_review_req(
                    self.tmp / f'rev-perm-{skill}',
                    skill=skill,
                    deny_read=deny_paths,
                )
                reply = claude_adapter.review(req, ctx)
                self.assertIsNone(reply['error'])
                self.assertIs(reply['skill_invoked'], True)
                self.assertEqual(reply['skill_evidence'], f'tool-use:Skill({qualified})')

                self.assertEqual(len(seen_argvs), 1)
                calls = _read_calls(self.stub_dir)
                self.assertEqual(len(calls), 1)
                self.assertEqual(seen_argvs[0][1:], calls[0]['argv'])
                flags = _parse_flags(seen_argvs[0])
                settings = json.loads(flags['--settings'])
                self.assertEqual(
                    settings['permissions']['allow'],
                    [f'Skill({qualified})', 'Read', 'Grep', 'Glob'],
                )
                self.assertEqual(settings['permissions']['deny'], expected_deny)

        # Verify the stub actually enforces the Skill allow rule under dontAsk when absent.
        def strip_skill_allow_run_group(argv, **kwargs):
            mutated = list(argv)
            idx = mutated.index('--settings') + 1
            settings = json.loads(mutated[idx])
            settings['permissions']['allow'] = [
                r for r in settings['permissions']['allow'] if not r.startswith('Skill(')
            ]
            mutated[idx] = json.dumps(settings, separators=(',', ':'))
            return procs.run_group(mutated, **kwargs)

        ctx_stripped = _make_ctx(self.stub_dir, run_group=strip_skill_allow_run_group)
        denied_reply = claude_adapter.review(
            _make_review_req(self.tmp / 'rev-perm-denied', skill='review', deny_read=deny_paths),
            ctx_stripped,
        )
        self.assertIs(denied_reply['skill_invoked'], False)
        self.assertEqual(denied_reply['skill_evidence'], 'none:Skill(bork:review) denied')


if __name__ == '__main__':
    unittest.main()
