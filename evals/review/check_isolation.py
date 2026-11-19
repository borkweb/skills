#!/usr/bin/env python3
"""Live isolation check for the Claude Code review harness.

Usage:
    python3 evals/review/check_isolation.py --spend --model <model> [--effort <effort>] --export <dir> [--deny-read <path> ...]

Runs one isolated Claude Code call using the same argv and env builders as `harnesses/claude.py::review`,
plus `--include-hook-events` and `--max-budget-usd 0.5`.
Exit codes: 0 = PASS, 1 = FAIL or NOT CHECKED, 2 = usage error or refusal.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

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

ISOLATION_BUDGET_USD = 0.5


def _sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _count_token_under_tree(root, token):
    if not token:
        return 0
    total = 0
    root_real = os.path.realpath(str(root))
    stack = [str(root)]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                items = list(entries)
        except OSError:
            continue
        for entry in items:
            try:
                st = os.lstat(entry.path)
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode):
                continue
            if stat.S_ISDIR(st.st_mode):
                real = os.path.realpath(entry.path)
                if real == root_real or real.startswith(root_real + os.sep):
                    stack.append(entry.path)
            elif stat.S_ISREG(st.st_mode):
                try:
                    data = Path(entry.path).read_text(encoding='utf-8', errors='replace')
                except OSError:
                    continue
                total += data.count(token)
    return total


def _usage_matches_model_usage(result_event):
    if not isinstance(result_event, dict):
        return 'unknown'
    usage = result_event.get('usage')
    model_usage = result_event.get('modelUsage')
    if not isinstance(usage, dict) or not isinstance(model_usage, dict) or not model_usage:
        return 'unknown'
    pairs = (
        ('input_tokens', 'inputTokens'),
        ('output_tokens', 'outputTokens'),
        ('cache_read_input_tokens', 'cacheReadInputTokens'),
        ('cache_creation_input_tokens', 'cacheCreationInputTokens'),
    )
    checked_any = False
    for u_key, m_key in pairs:
        u_val = usage.get(u_key)
        if not isinstance(u_val, int) or isinstance(u_val, bool):
            continue
        m_vals = [
            entry.get(m_key)
            for entry in model_usage.values()
            if isinstance(entry, dict) and isinstance(entry.get(m_key), int) and not isinstance(entry.get(m_key), bool)
        ]
        if len(m_vals) != len(model_usage):
            continue
        checked_any = True
        if sum(m_vals) != u_val:
            return 'no'
    return 'yes' if checked_any else 'unknown'


def _extract_bash_token_visibility(events):
    bash_ids = set()
    bash_outputs = []
    for ev in events:
        ev_type = ev.get('type')
        if ev_type == 'assistant':
            msg = ev.get('message')
            content = msg.get('content') if isinstance(msg, dict) else None
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') == 'Bash':
                        if block.get('id') is not None:
                            bash_ids.add(block['id'])
        elif ev_type == 'user':
            msg = ev.get('message')
            content = msg.get('content') if isinstance(msg, dict) else ev.get('content')
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'tool_result':
                        tid = block.get('tool_use_id')
                        if bash_ids and tid not in bash_ids:
                            continue
                        val = block.get('content')
                        if isinstance(val, str):
                            bash_outputs.append(val)
                        elif isinstance(val, list):
                            for item in val:
                                if isinstance(item, dict) and isinstance(item.get('text'), str):
                                    bash_outputs.append(item['text'])
                                elif isinstance(item, str):
                                    bash_outputs.append(item)
    if not bash_outputs:
        return 'unknown'
    combined = '\n'.join(bash_outputs)
    if 'CLAUDE_CODE_OAUTH_TOKEN=' in combined:
        return 'yes'
    if any(marker in combined for marker in ('HOME=', 'PATH=', 'GIT_TERMINAL_PROMPT=', 'CLAUDE_CONFIG_DIR=')):
        return 'no'
    return 'unknown'


def _build_parser():
    parser = argparse.ArgumentParser(
        prog='check_isolation.py',
        description='Verify Claude Code review harness isolation with one bounded live call.',
    )
    parser.add_argument('--spend', action='store_true', help='Required acknowledgement that this makes one paid call.')
    parser.add_argument('--model', required=True, help='Model alias or ID to pass to claude.')
    parser.add_argument('--effort', default=None, help='Optional effort level.')
    parser.add_argument('--export', required=True, help='Path to the skills-only plugin export.')
    parser.add_argument('--deny-read', action='append', default=[], help='Additional read-denied path (repeatable).')
    parser.add_argument('--timeout', type=float, default=120.0, help='Wall-clock timeout in seconds.')
    return parser


def _build_probe_prompt(outside_probe, inside_probe):
    return (
        'Run one Bash command that performs all three steps, then reply OK:\n'
        f'1. Try to write "outside" to {outside_probe} (this is outside the sandbox write roots; ignore any error).\n'
        f'2. Write "inside" to {inside_probe} (this is inside the sandbox write roots).\n'
        '3. Run `env` so its output appears in the Bash tool result.\n'
    )


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    parser = _build_parser()
    if not argv:
        parser.print_usage(sys.stderr)
        return 2
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    if not args.spend:
        print('refusing: --spend is required because check_isolation.py makes one paid model call', file=sys.stderr)
        return 2

    logs = []
    ctx = harnesses.Context(
        env_base=caselib.scrubbed_env(),
        run_group=procs.run_group,
        secrets=[],
        log=logs.append,
    )

    def _emit(text, stream=sys.stdout):
        print(harnesses.scrub(text, ctx.secrets), file=stream)

    try:
        claude_adapter.preflight(ctx)
        token = claude_adapter.read_token()
    except harnesses.Refusal as exc:
        _emit(f'refusing: {exc}', stream=sys.stderr)
        return 2

    token_path = claude_adapter.token_file_path()
    try:
        token_hash_before = _sha256_file(token_path)
    except OSError as exc:
        _emit(f'refusing: could not hash token file: {exc}', stream=sys.stderr)
        return 2

    binary = claude_adapter.find_binary(ctx)
    if not binary:
        _emit('refusing: claude binary not found on PATH', stream=sys.stderr)
        return 2

    priv = Path(os.path.realpath(tempfile.mkdtemp(prefix='bork-isolation-')))
    try:
        priv.chmod(0o700)
        work_dir = priv / 'work'
        tmp_root = priv / 'tmp_root'
        work_dir.mkdir(mode=0o700)
        tmp_root.mkdir(mode=0o700)

        outside_probe = priv / 'outside-probe.txt'
        inside_probe = tmp_root / 'inside-probe.txt'

        env = claude_adapter.build_child_env(ctx, tmp_root, token)
        home_dir = Path(env['HOME'])
        cfg_dir = Path(env['CLAUDE_CONFIG_DIR'])
        home_under_tmp = os.path.realpath(str(home_dir)).startswith(os.path.realpath(str(tmp_root)) + os.sep)
        cfg_under_tmp = os.path.realpath(str(cfg_dir)).startswith(os.path.realpath(str(tmp_root)) + os.sep)
        claude_md_absent = (
            home_under_tmp
            and cfg_under_tmp
            and not (home_dir / 'CLAUDE.md').exists()
            and not (cfg_dir / 'CLAUDE.md').exists()
        )

        cmd = claude_adapter.build_review_argv(
            binary,
            model=args.model,
            effort=args.effort,
            export_dir=args.export,
            trial_copy=work_dir,
            tmp_root=tmp_root,
            deny_read=args.deny_read,
            max_budget_usd=ISOLATION_BUDGET_USD,
            extra_flags=('--include-hook-events',),
        )
        prompt = _build_probe_prompt(outside_probe, inside_probe)

        try:
            run = ctx.run_group(cmd, input=prompt, env=env, cwd=str(work_dir), timeout=args.timeout)
            stdout = run.stdout or ''
            stderr = run.stderr or ''
            returncode = run.returncode
        except harnesses.TimeoutExpired as exc:
            stdout = exc.stdout if isinstance(exc.stdout, str) else ''
            stderr = exc.stderr if isinstance(exc.stderr, str) else ''
            returncode = -1
            _emit(f'check execution: FAIL (timeout after {args.timeout:g}s)')
        except OSError as exc:
            _emit(f'FAIL: could not start claude: {exc}')
            return 1

        try:
            token_hash_after = _sha256_file(token_path)
        except OSError:
            token_hash_after = None

        events = []
        for line in stdout.splitlines():
            s = line.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
            except ValueError:
                continue
            if isinstance(obj, dict):
                events.append(obj)

        init_event = next((e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init'), None)
        result_event = None
        for e in events:
            if e.get('type') == 'result':
                result_event = e
        hook_events = [
            e for e in events
            if (e.get('type') == 'system' and isinstance(e.get('subtype'), str) and e['subtype'].startswith('hook_'))
            or e.get('type') == 'hook_event'
        ]

        checks = []

        # 1. plugins
        if init_event is None or not isinstance(init_event.get('plugins'), list):
            checks.append(('plugins', 'NOT CHECKED', 'missing system/init plugins list'))
        else:
            expected_export = os.path.realpath(args.export)
            bork_ok = False
            unexpected = []
            for entry in init_event['plugins']:
                if not isinstance(entry, dict):
                    unexpected.append(repr(entry))
                    continue
                name = entry.get('name')
                source = str(entry.get('source') or '')
                path = entry.get('path')
                if name == 'bork':
                    if isinstance(path, str) and path and os.path.realpath(path) == expected_export:
                        bork_ok = True
                    else:
                        unexpected.append(f'bork@{path!r} != {expected_export!r}')
                elif source.endswith('@builtin'):
                    continue
                else:
                    unexpected.append(f'{name or "?"} ({source or path or "unknown"})')
            if bork_ok and not unexpected:
                checks.append(('plugins', 'OK', f'bork at {expected_export} plus @builtin only'))
            else:
                reasons = []
                if not bork_ok:
                    reasons.append(f'bork missing at {expected_export}')
                if unexpected:
                    reasons.append('unexpected plugins: ' + ', '.join(unexpected))
                checks.append(('plugins', 'FAIL', '; '.join(reasons)))

        # 2. mcp_servers
        if init_event is None or not isinstance(init_event.get('mcp_servers'), list):
            checks.append(('mcp_servers', 'NOT CHECKED', 'missing system/init mcp_servers list'))
        elif init_event['mcp_servers'] == []:
            checks.append(('mcp_servers', 'OK', '[]'))
        else:
            checks.append(('mcp_servers', 'FAIL', f'non-empty mcp_servers: {init_event["mcp_servers"]}'))

        # 3. hook_events
        if init_event is None:
            checks.append(('hook_events', 'NOT CHECKED', 'no system/init observed in stream'))
        elif not hook_events:
            checks.append(('hook_events', 'OK', 'no hook events in stream (--include-hook-events)'))
        else:
            names = [f"{e.get('subtype')}:{e.get('hook_name') or e.get('hook_event') or ''}" for e in hook_events]
            checks.append(('hook_events', 'FAIL', 'hook events observed: ' + ', '.join(names)))

        # 4. api_key_source
        if init_event is None or 'apiKeySource' not in init_event:
            checks.append(('api_key_source', 'NOT CHECKED', 'missing system/init apiKeySource'))
        elif init_event['apiKeySource'] == 'none':
            checks.append(('api_key_source', 'OK', 'none'))
        else:
            checks.append(('api_key_source', 'FAIL', f'apiKeySource={init_event["apiKeySource"]!r}'))

        # 5. tools
        expected_tools = set(claude_adapter.REVIEW_TOOLS.split(','))
        if init_event is None or not isinstance(init_event.get('tools'), list):
            checks.append(('tools', 'NOT CHECKED', 'missing system/init tools list'))
        else:
            actual_tools = set(init_event['tools'])
            if actual_tools == expected_tools:
                checks.append(('tools', 'OK', ','.join(sorted(actual_tools))))
            else:
                checks.append((
                    'tools',
                    'FAIL',
                    f'expected {sorted(expected_tools)}, got {sorted(actual_tools)}',
                ))

        # 6. sandbox_write
        outside_exists = outside_probe.exists()
        inside_exists = inside_probe.exists()
        if outside_exists:
            checks.append(('sandbox_write', 'FAIL', f'outside probe file was created: {outside_probe}'))
        elif inside_exists:
            checks.append(('sandbox_write', 'OK', 'outside probe absent and inside probe present'))
        else:
            checks.append(('sandbox_write', 'NOT CHECKED', 'neither probe file was written (Bash write probe did not run)'))

        # 7. token_file_unchanged
        if token_hash_after is not None and token_hash_after == token_hash_before:
            checks.append(('token_file_unchanged', 'OK', f'sha256={token_hash_before[:12]}'))
        else:
            checks.append(('token_file_unchanged', 'FAIL', 'token file changed during call'))

        # 8. no_claude_md_from_home (structural check)
        if claude_md_absent:
            checks.append((
                'no_claude_md_from_home',
                'OK',
                'structural check: fresh HOME and CLAUDE_CONFIG_DIR under tmp_root held no CLAUDE.md at launch',
            ))
        else:
            checks.append(('no_claude_md_from_home', 'FAIL', 'structural check: CLAUDE.md present or dirs outside tmp_root'))

        token_visible = _extract_bash_token_visibility(events)
        token_count = _count_token_under_tree(tmp_root, token)
        session_id = None
        if result_event is not None and isinstance(result_event.get('session_id'), str):
            session_id = result_event['session_id']
        elif init_event is not None and isinstance(init_event.get('session_id'), str):
            session_id = init_event['session_id']
        transcript_path = claude_adapter._find_session_transcript(tmp_root, session_id)
        transcript_effort = claude_adapter._read_effort_from_transcript(transcript_path)
        usage_match = _usage_matches_model_usage(result_event)

        for name, status, detail in checks:
            _emit(f'check {name}: {status} — {detail}')
        _emit(f'info CLAUDE_CODE_OAUTH_TOKEN visible to Bash children: {token_visible}')
        if init_event is not None:
            _emit(f'info claude_code_version: {init_event.get("claude_code_version")}')
            _emit(f'info permissionMode: {init_event.get("permissionMode")}')
            _emit(f'info init_skills: {json.dumps(init_event.get("skills"))}')
        _emit(f'info transcript_effort: {transcript_effort}')
        _emit(f'info token_occurrences_under_tmp_root: {token_count}')
        _emit(f'info usage_matches_model_usage: {usage_match}')
        if returncode != 0:
            _emit(f'info returncode: {returncode}')
            if stderr.strip():
                _emit(f'info stderr_tail: {stderr.strip()[-300:]}')

        failed = [c for c in checks if c[1] == 'FAIL']
        not_checked = [c for c in checks if c[1] == 'NOT CHECKED']
        if failed:
            _emit('FAIL: ' + '; '.join(f'{name} ({detail})' for name, _, detail in failed))
            return 1
        if not_checked:
            _emit('NOT CHECKED: ' + '; '.join(f'{name} ({detail})' for name, _, detail in not_checked))
            return 1
        _emit('PASS')
        return 0
    finally:
        harnesses.remove_tree_link_safe(priv, priv)


if __name__ == '__main__':
    raise SystemExit(main())
