"""Claude Code adapter for the review evaluation harness."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import threading
import time

import harnesses

HARNESS = 'claude'
REVIEW_TOOLS = 'Bash,Read,Grep,Glob,Skill'
SKILL_INVOKES = {
    'review': 'Use the Skill tool to run the `bork:review` skill',
    'review-security': 'Use the Skill tool to run the `bork:review-security` skill',
}
MIN_TOKEN_LEN = 20
DISABLE_BUNDLED_SKILLS = True

_LIMIT_TEXT = re.compile(
    r'rate[\s_-]*limit|usage[\s_-]*limit|too many requests|\b429\b|quota|limit reached|hit your limit',
    re.IGNORECASE,
)
_COMMAND_NAME_RE = re.compile(r'<command-name>\s*([^<\s]+)\s*</command-name>')

_CACHE_LOCK = threading.Lock()
_PREFLIGHT_CACHE = {}


def _empty_usage():
    return {'input_tokens': None, 'output_tokens': None, 'cached_input_tokens': None}


def _one_line(text):
    return ' '.join(str(text or '').split())


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _scrub_value(value, secrets):
    if isinstance(value, str):
        return harnesses.scrub(value, secrets)
    if isinstance(value, list):
        return [_scrub_value(v, secrets) for v in value]
    if isinstance(value, dict):
        return {_scrub_value(k, secrets): _scrub_value(v, secrets) for k, v in value.items()}
    return value


def _log(ctx, message):
    if ctx.log is not None:
        ctx.log(harnesses.scrub(str(message), ctx.secrets))


def token_file_path():
    """Return the configured Claude OAuth token path without reading or modifying it."""
    override = os.environ.get('BORK_EVAL_CLAUDE_TOKEN_FILE')
    if override:
        return Path(override)
    home = os.environ.get('HOME')
    base = Path(home) if home else Path.home()
    return base / '.borkweb-skills' / 'evals' / 'claude-oauth-token'


def read_token():
    """Validate the token file with lstat + O_NOFOLLOW and return the stripped token."""
    path = token_file_path()
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise harnesses.Refusal(f'claude token file missing or unreadable ({path}): {exc}') from None
    if stat.S_ISLNK(st.st_mode):
        raise harnesses.Refusal(f'claude token file must not be a symlink: {path}')
    if not stat.S_ISREG(st.st_mode):
        raise harnesses.Refusal(f'claude token file must be a regular file: {path}')
    if st.st_mode & 0o077:
        mode = stat.S_IMODE(st.st_mode)
        raise harnesses.Refusal(
            f'claude token file must not be accessible by group or other (mode {mode:04o}): {path}'
        )
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            raw = handle.read()
    except OSError as exc:
        raise harnesses.Refusal(f'claude token file could not be read ({path}): {exc}') from None
    token = raw.strip()
    if not token:
        raise harnesses.Refusal(f'claude token file is empty: {path}')
    if len(token) < MIN_TOKEN_LEN:
        raise harnesses.Refusal(
            f'claude token is shorter than {MIN_TOKEN_LEN} characters ({len(token)} chars): {path}'
        )
    return token


def _register_secret(ctx, token):
    if token and token not in ctx.secrets:
        ctx.secrets.append(token)


def find_binary(ctx):
    """Locate `claude` on `ctx.env_base['PATH']` only (never ambient os.environ['PATH'])."""
    path_env = ctx.env_base.get('PATH', '')
    return shutil.which('claude', path=path_env)


def _resolve_binary_and_version(ctx):
    path_env = ctx.env_base.get('PATH', '')
    with _CACHE_LOCK:
        cached = _PREFLIGHT_CACHE.get(path_env)
    binary = find_binary(ctx)
    if binary is None:
        if cached is not None:
            return cached[0], cached[1]
        return 'claude', None
    version = cached[1] if (cached is not None and cached[0] == binary) else None
    return binary, version


def preflight(ctx):
    """Verify the token file and claude binary without making any model call."""
    token = read_token()
    binary = find_binary(ctx)
    if not binary:
        raise harnesses.Refusal('claude binary not found on PATH')
    _register_secret(ctx, token)

    probe_root = Path(tempfile.mkdtemp(prefix='bork-claude-preflight-'))
    try:
        probe_root.chmod(0o700)
        home_dir = probe_root / 'home'
        cfg_dir = probe_root / 'claude-config'
        home_dir.mkdir(mode=0o700)
        cfg_dir.mkdir(mode=0o700)
        env = dict(ctx.env_base)
        env.update({
            'HOME': str(home_dir),
            'CLAUDE_CONFIG_DIR': str(cfg_dir),
            'GIT_TERMINAL_PROMPT': '0',
        })
        try:
            run = ctx.run_group([binary, '--version'], env=env, timeout=15)
        except harnesses.TimeoutExpired:
            raise harnesses.Refusal('claude --version timed out') from None
        except OSError as exc:
            raise harnesses.Refusal(
                harnesses.scrub(f'could not execute {binary}: {exc}', ctx.secrets)
            ) from None
    finally:
        harnesses.remove_tree_link_safe(probe_root, probe_root)

    if run.returncode != 0:
        detail = _one_line(harnesses.scrub(run.stderr or run.stdout, ctx.secrets))
        raise harnesses.Refusal(f'claude --version failed (exit {run.returncode}): {detail}')
    version = harnesses.scrub((run.stdout or '').strip(), ctx.secrets) or None
    with _CACHE_LOCK:
        _PREFLIGHT_CACHE[ctx.env_base.get('PATH', '')] = (binary, version)
    _log(ctx, f'claude preflight ok: {version or "unknown"}')


def prepare_trial_dirs(tmp_root):
    """Create the isolated per-trial subdirectories under `tmp_root`."""
    root = Path(tmp_root)
    dirs = {
        'home': root / 'home',
        'claude-config': root / 'claude-config',
        'handoffs': root / 'handoffs',
        'rules': root / 'rules',
        'reports': root / 'reports',
        'tmp': root / 'tmp',
    }
    for path in dirs.values():
        path.mkdir(parents=True, exist_ok=True)
    return dirs


def build_child_env(ctx, tmp_root, token):
    """Build the allowlisted child environment from `ctx.env_base` plus explicit isolated vars."""
    dirs = prepare_trial_dirs(tmp_root)
    env = dict(ctx.env_base)
    env.update({
        'HOME': str(dirs['home']),
        'CLAUDE_CONFIG_DIR': str(dirs['claude-config']),
        'AGENT_HANDOFFS_DIR': str(dirs['handoffs']),
        'BORK_REPO_RULES_DIR': str(dirs['rules']),
        'TMPDIR': str(dirs['tmp']),
        'CLAUDE_CODE_OAUTH_TOKEN': token,
        'GIT_TERMINAL_PROMPT': '0',
    })
    if DISABLE_BUNDLED_SKILLS:
        env['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'] = '1'
    return env


def _deny_read_rules(deny_read):
    rules = []
    for raw_path in (deny_read or ()):
        clean = str(raw_path).rstrip('/')
        rules.extend([
            f'Read({clean}/**)',
            f'Grep({clean}/**)',
            f'Glob({clean}/**)',
        ])
    return rules


def build_review_settings(trial_copy, tmp_root, deny_read):
    """Build the sandbox and read-denial settings JSON object for a review session."""
    deny_list = [str(p) for p in (deny_read or ())]
    return {
        'sandbox': {
            'enabled': True,
            'autoAllowBashIfSandboxed': True,
            'allowUnsandboxedCommands': False,
            'failIfUnavailable': True,
            'filesystem': {
                'allowWrite': [str(trial_copy), str(tmp_root)],
                'denyRead': deny_list,
            },
            'network': {
                'allowedDomains': [],
                'strictAllowlist': True,
            },
        },
        'permissions': {
            'deny': _deny_read_rules(deny_list),
        },
    }


def build_grade_settings(deny_read):
    """Build the read-denial settings JSON object for a grader session (no Bash)."""
    return {
        'permissions': {
            'deny': _deny_read_rules(deny_read or ()),
        },
    }


def build_review_argv(
    binary,
    *,
    model,
    effort,
    export_dir,
    trial_copy,
    tmp_root,
    deny_read,
    max_budget_usd,
    extra_flags=(),
):
    """Shared argv builder for both `review()` and `check_isolation.py`."""
    settings = build_review_settings(trial_copy, tmp_root, deny_read)
    argv = [
        str(binary),
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', str(model),
    ]
    if effort is not None:
        argv.extend(['--effort', str(effort)])
    argv.extend([
        '--plugin-dir', str(export_dir),
        '--setting-sources', 'user',
        '--strict-mcp-config',
        '--tools', REVIEW_TOOLS,
        '--permission-mode', 'dontAsk',
        '--settings', json.dumps(settings, separators=(',', ':')),
        '--max-budget-usd', f'{float(max_budget_usd):g}',
    ])
    if extra_flags:
        argv.extend(extra_flags)
    return argv


def _check_init_plugin(init_event, export_dir, skill):
    expected_export = os.path.realpath(str(export_dir))
    expected_skill = f'bork:{skill}'
    plugins = init_event.get('plugins')
    skills = init_event.get('skills')
    if not isinstance(plugins, list) or not isinstance(skills, list):
        return False
    has_export_bork = False
    for entry in plugins:
        if not isinstance(entry, dict):
            continue
        if entry.get('name') != 'bork':
            continue
        plugin_path = entry.get('path')
        if isinstance(plugin_path, str) and plugin_path and os.path.realpath(plugin_path) == expected_export:
            has_export_bork = True
            break
    return has_export_bork and (expected_skill in skills)


def _extract_usage(raw_usage):
    if not isinstance(raw_usage, dict):
        return _empty_usage()
    in_tok = raw_usage.get('input_tokens')
    cache_create = raw_usage.get('cache_creation_input_tokens')
    cache_read = raw_usage.get('cache_read_input_tokens')
    out_tok = raw_usage.get('output_tokens')

    if _is_int(in_tok) or _is_int(cache_create):
        input_tokens = (in_tok if _is_int(in_tok) else 0) + (cache_create if _is_int(cache_create) else 0)
    else:
        input_tokens = None
    cached_input_tokens = cache_read if _is_int(cache_read) else None
    output_tokens = out_tok if _is_int(out_tok) else None
    return {
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'cached_input_tokens': cached_input_tokens,
    }


def _extract_command_names(event):
    texts = []
    msg = event.get('message')
    content = msg.get('content') if isinstance(msg, dict) else event.get('content')
    if isinstance(content, str):
        texts.append(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                texts.append(block)
            elif isinstance(block, dict):
                for key in ('text', 'content'):
                    val = block.get(key)
                    if isinstance(val, str):
                        texts.append(val)
    found = []
    for chunk in texts:
        found.extend(_COMMAND_NAME_RE.findall(chunk))
    return found


def _find_session_transcript(tmp_root, session_id):
    if not isinstance(session_id, str) or not session_id:
        return None
    if '/' in session_id or '\\' in session_id or session_id in ('.', '..'):
        return None
    projects_dir = Path(tmp_root) / 'claude-config' / 'projects'
    if not projects_dir.is_dir():
        return None
    target_name = f'{session_id}.jsonl'
    for candidate in sorted(projects_dir.glob(f'*/{target_name}')):
        if candidate.name == target_name and candidate.is_file() and not candidate.is_symlink():
            return candidate
    return None


def _read_effort_from_transcript(transcript_path):
    if transcript_path is None:
        return None
    effort = None
    try:
        text = transcript_path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        cand = obj.get('effort')
        if not isinstance(cand, str) and isinstance(obj.get('message'), dict):
            cand = obj['message'].get('effort')
        if isinstance(cand, str) and cand.strip():
            effort = cand.strip()
    return effort


def _write_raw_file(raw_dir, name, content, secrets, raw_files):
    path = Path(raw_dir) / name
    path.write_text(harnesses.scrub(content, secrets), encoding='utf-8')
    raw_files.append(name)


def review(req, ctx):
    """Run one headless Claude Code review session and return a C-ADAPTER reply dict."""
    skill = req['skill']
    if skill not in SKILL_INVOKES:
        raise harnesses.Refusal(f'unknown skill {skill!r}')

    token = read_token()
    _register_secret(ctx, token)
    binary, harness_version = _resolve_binary_and_version(ctx)
    prompt = harnesses.review_prompt(req, SKILL_INVOKES[skill])
    env = build_child_env(ctx, req['tmp_root'], token)
    argv = build_review_argv(
        binary,
        model=req['model'],
        effort=req.get('effort'),
        export_dir=req['export_dir'],
        trial_copy=req['trial_copy'],
        tmp_root=req['tmp_root'],
        deny_read=req.get('deny_read', ()),
        max_budget_usd=req['max_budget_usd'],
    )

    init_checked = False
    plugin_missing = False

    def _on_line(line):
        nonlocal init_checked, plugin_missing
        if init_checked:
            return True
        stripped = line.strip()
        if not stripped:
            return True
        try:
            ev = json.loads(stripped)
        except ValueError:
            return True
        if isinstance(ev, dict) and ev.get('type') == 'system' and ev.get('subtype') == 'init':
            init_checked = True
            if not _check_init_plugin(ev, req['export_dir'], skill):
                plugin_missing = True
                return False
        return True

    started = time.monotonic()
    stdout = ''
    stderr = ''
    returncode = None
    timed_out = False
    launch_error = None
    timeout_s = req['timeout_s']

    try:
        run = ctx.run_group(
            argv,
            input=prompt,
            env=env,
            cwd=str(req['trial_copy']),
            timeout=timeout_s,
            on_stdout_line=_on_line,
        )
        stdout = run.stdout or ''
        stderr = run.stderr or ''
        returncode = run.returncode
    except harnesses.TimeoutExpired as exc:
        timed_out = True
        raw_out = exc.stdout
        raw_err = exc.stderr
        stdout = raw_out.decode('utf-8', 'replace') if isinstance(raw_out, bytes) else (raw_out or '')
        stderr = raw_err.decode('utf-8', 'replace') if isinstance(raw_err, bytes) else (raw_err or '')
        _log(ctx, f'claude review timed out after {timeout_s:g}s')
    except OSError as exc:
        launch_error = str(exc)
        _log(ctx, f'claude review launch failed: {exc}')

    duration_s = float(time.monotonic() - started)

    init_event = None
    result_event = None
    first_assistant_model = None
    rate_limited_event = False
    skill_calls = []
    error_tool_results = set()
    command_markup_names = []
    parsed_events = 0

    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            ev = json.loads(stripped)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        parsed_events += 1
        ev_type = ev.get('type')
        if ev_type == 'system' and ev.get('subtype') == 'init' and init_event is None:
            init_event = ev
            if not init_checked:
                init_checked = True
                if not _check_init_plugin(ev, req['export_dir'], skill):
                    plugin_missing = True
        elif ev_type == 'assistant':
            msg = ev.get('message')
            if isinstance(msg, dict):
                if first_assistant_model is None and isinstance(msg.get('model'), str):
                    first_assistant_model = msg['model']
                content = msg.get('content')
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') == 'Skill':
                            inp = block.get('input')
                            sname = inp.get('skill') if isinstance(inp, dict) else None
                            skill_calls.append((block.get('id'), sname))
        elif ev_type == 'user':
            msg = ev.get('message')
            content = msg.get('content') if isinstance(msg, dict) else ev.get('content')
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('is_error') is True:
                        tid = block.get('tool_use_id')
                        if tid is not None:
                            error_tool_results.add(tid)
            command_markup_names.extend(_extract_command_names(ev))
        elif ev_type == 'rate_limit_event':
            info = ev.get('rate_limit_info')
            if isinstance(info, dict) and info.get('status') == 'rejected':
                rate_limited_event = True
        elif ev_type == 'result':
            result_event = ev

    raw_dir = Path(req['raw_dir'])
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_files = []

    stream_content = stdout if stdout else (stderr if stderr else f'# empty stdout (exit={returncode})\n')
    _write_raw_file(raw_dir, 'stream.jsonl', stream_content, ctx.secrets, raw_files)
    if stderr:
        _write_raw_file(raw_dir, 'stderr.txt', stderr, ctx.secrets, raw_files)
    if init_event is not None:
        init_record = {
            'plugins': init_event.get('plugins'),
            'skills': init_event.get('skills'),
            'mcp_servers': init_event.get('mcp_servers'),
            'tools': init_event.get('tools'),
            'model': init_event.get('model'),
            'permissionMode': init_event.get('permissionMode'),
            'apiKeySource': init_event.get('apiKeySource'),
            'claude_code_version': init_event.get('claude_code_version'),
        }
        _write_raw_file(raw_dir, 'init.json', json.dumps(init_record, indent=2) + '\n', ctx.secrets, raw_files)
    if init_event is not None or result_event is not None:
        meta_record = {
            'init_model': init_event.get('model') if init_event is not None else None,
            'total_cost_usd': result_event.get('total_cost_usd') if result_event is not None else None,
            'modelUsage': result_event.get('modelUsage') if result_event is not None else None,
            'subtype': result_event.get('subtype') if result_event is not None else None,
            'is_error': result_event.get('is_error') if result_event is not None else None,
            'terminal_reason': result_event.get('terminal_reason') if result_event is not None else None,
        }
        _write_raw_file(raw_dir, 'result-meta.json', json.dumps(meta_record, indent=2) + '\n', ctx.secrets, raw_files)

    session_id = None
    if result_event is not None and isinstance(result_event.get('session_id'), str):
        session_id = result_event['session_id']
    elif init_event is not None and isinstance(init_event.get('session_id'), str):
        session_id = init_event['session_id']

    transcript_path = _find_session_transcript(req['tmp_root'], session_id)
    resolved_effort = _read_effort_from_transcript(transcript_path)
    if transcript_path is not None:
        try:
            transcript_text = transcript_path.read_text(encoding='utf-8', errors='replace')
            _write_raw_file(raw_dir, 'transcript.jsonl', transcript_text, ctx.secrets, raw_files)
        except OSError:
            pass

    usage = _extract_usage(result_event.get('usage')) if result_event is not None else _empty_usage()
    rounds = result_event.get('num_turns') if (result_event is not None and _is_int(result_event.get('num_turns'))) else None
    text = str(result_event.get('result') or '') if result_event is not None else ''

    rate_limited = rate_limited_event
    if result_event is not None and result_event.get('is_error') is True:
        err_blob = f"{result_event.get('result') or ''} {result_event.get('subtype') or ''}"
        if _LIMIT_TEXT.search(err_blob):
            rate_limited = True

    expected_skill = f'bork:{skill}'
    expected_cmd = f'/{expected_skill}'
    if plugin_missing:
        skill_invoked = None
        skill_evidence = 'none:plugin loading unavailable'
    elif result_event is None:
        skill_invoked = None
        skill_evidence = 'none:stream incomplete'
    else:
        denied_ids = set()
        denied_names_no_id = set()
        for denial in (result_event.get('permission_denials') or ()):
            if not isinstance(denial, dict):
                continue
            tid = denial.get('tool_use_id')
            if tid is not None:
                denied_ids.add(tid)
            elif denial.get('tool_name') == 'Skill':
                ti = denial.get('tool_input')
                if isinstance(ti, dict) and isinstance(ti.get('skill'), str):
                    denied_names_no_id.add(ti['skill'])

        matched_tool_use = False
        had_denied_match = False
        for tid, sname in skill_calls:
            if sname != expected_skill:
                continue
            if tid in error_tool_results or tid in denied_ids or sname in denied_names_no_id:
                had_denied_match = True
                continue
            matched_tool_use = True
            break

        if matched_tool_use:
            skill_invoked = True
            skill_evidence = f'tool-use:Skill({expected_skill})'
        elif expected_cmd in command_markup_names:
            skill_invoked = True
            skill_evidence = f'tool-use:command-name({expected_cmd})'
        elif had_denied_match:
            skill_invoked = False
            skill_evidence = f'none:Skill({expected_skill}) denied'
        else:
            skill_invoked = False
            skill_evidence = 'none:no matching Skill call'

    if plugin_missing:
        error = 'plugin loading unavailable'
    elif timed_out:
        error = f'timeout after {timeout_s:g}s'
    elif launch_error is not None:
        error = f'launch failed: {_one_line(launch_error)}'
    elif result_event is None:
        if not stdout.strip():
            tail = _one_line(stderr.strip()[-300:])
            error = f'empty stdout (exit {returncode}): {tail}' if tail else f'empty stdout (exit {returncode})'
        elif parsed_events == 0:
            error = f'non-JSON stdout (exit {returncode})'
        else:
            error = f'incomplete stream: missing result line (exit {returncode})'
    elif result_event.get('is_error') is True:
        detail = _one_line(result_event.get('result') or result_event.get('subtype') or 'unknown error')
        error = f'claude error: {detail}'
    elif returncode != 0:
        tail = _one_line(stderr.strip()[-300:])
        error = f'claude exited {returncode}: {tail}' if tail else f'claude exited {returncode}'
    else:
        error = None

    reply = {
        'text': text,
        'usage': usage,
        'rounds': rounds,
        'duration_s': duration_s,
        'resolved_model': first_assistant_model,
        'resolved_effort': resolved_effort,
        'skill_invoked': skill_invoked,
        'skill_evidence': skill_evidence,
        'skill_loading': 'plugin',
        'rate_limited': bool(rate_limited),
        'error': _one_line(error) if error is not None else None,
        'argv': list(argv),
        'raw_files': list(raw_files),
        'harness_version': harness_version,
    }
    return _scrub_value(reply, ctx.secrets)


def grade(req, ctx):
    """Run one headless Claude Code grader call with structured JSON output."""
    tools = req.get('tools')
    if tools == 'none':
        tools_arg = ''
    elif tools == 'read-only':
        tools_arg = 'Read,Grep,Glob'
    else:
        raise harnesses.Refusal(f'invalid grade tools {tools!r}: expected "none" or "read-only"')

    token = read_token()
    _register_secret(ctx, token)
    binary, _ = _resolve_binary_and_version(ctx)
    env = build_child_env(ctx, req['tmp_root'], token)
    settings = build_grade_settings(req.get('deny_read', ()))

    argv = [
        str(binary),
        '-p',
        '--output-format', 'json',
        '--json-schema', json.dumps(req['schema'], separators=(',', ':')),
        '--model', str(req['model']),
    ]
    if req.get('effort') is not None:
        argv.extend(['--effort', str(req['effort'])])
    argv.extend([
        '--setting-sources', 'user',
        '--strict-mcp-config',
        '--tools', tools_arg,
        '--permission-mode', 'dontAsk',
        '--settings', json.dumps(settings, separators=(',', ':')),
        '--max-budget-usd', '2',
    ])

    timeout_s = req['timeout_s']
    try:
        run = ctx.run_group(
            argv,
            input=req['prompt'],
            env=env,
            cwd=str(req['cwd']),
            timeout=timeout_s,
        )
    except harnesses.TimeoutExpired:
        _log(ctx, f'claude grade timed out after {timeout_s:g}s')
        return _scrub_value({
            'parsed': None,
            'text': '',
            'usage': _empty_usage(),
            'cost_usd': None,
            'error': f'timeout after {timeout_s:g}s',
            'rate_limited': False,
        }, ctx.secrets)
    except OSError as exc:
        _log(ctx, f'claude grade launch failed: {exc}')
        return _scrub_value({
            'parsed': None,
            'text': '',
            'usage': _empty_usage(),
            'cost_usd': None,
            'error': _one_line(f'launch failed: {exc}'),
            'rate_limited': False,
        }, ctx.secrets)

    stdout = run.stdout or ''
    stderr = run.stderr or ''

    if not stdout.strip():
        tail = _one_line(stderr.strip()[-300:])
        err = f'empty stdout (exit {run.returncode}): {tail}' if tail else f'empty stdout (exit {run.returncode})'
        return _scrub_value({
            'parsed': None,
            'text': '',
            'usage': _empty_usage(),
            'cost_usd': None,
            'error': _one_line(err),
            'rate_limited': False,
        }, ctx.secrets)

    try:
        data = json.loads(stdout)
    except ValueError:
        return _scrub_value({
            'parsed': None,
            'text': stdout,
            'usage': _empty_usage(),
            'cost_usd': None,
            'error': f'non-JSON stdout (exit {run.returncode})',
            'rate_limited': False,
        }, ctx.secrets)

    if not isinstance(data, dict):
        return _scrub_value({
            'parsed': None,
            'text': stdout,
            'usage': _empty_usage(),
            'cost_usd': None,
            'error': 'grader envelope is not a JSON object',
            'rate_limited': False,
        }, ctx.secrets)

    usage = _extract_usage(data.get('usage'))
    text = str(data.get('result') or '')
    is_error = data.get('is_error') is True
    rate_limited = bool(is_error and _LIMIT_TEXT.search(f"{text} {data.get('subtype') or ''}"))

    if is_error:
        detail = _one_line(text or data.get('subtype') or 'grader error')
        return _scrub_value({
            'parsed': None,
            'text': text,
            'usage': usage,
            'cost_usd': None,
            'error': f'claude error: {detail}',
            'rate_limited': rate_limited,
        }, ctx.secrets)

    if run.returncode != 0:
        tail = _one_line(stderr.strip()[-300:])
        err = f'claude exited {run.returncode}: {tail}' if tail else f'claude exited {run.returncode}'
        return _scrub_value({
            'parsed': None,
            'text': text,
            'usage': usage,
            'cost_usd': None,
            'error': _one_line(err),
            'rate_limited': rate_limited,
        }, ctx.secrets)

    parsed = None
    error = None
    if 'structured_output' in data:
        if isinstance(data['structured_output'], dict):
            parsed = data['structured_output']
        else:
            error = 'structured_output is not a JSON object'
    else:
        try:
            candidate = json.loads(text)
        except ValueError:
            error = 'grader result is not valid JSON'
        else:
            if isinstance(candidate, dict):
                parsed = candidate
            else:
                error = 'grader result JSON is not an object'

    return _scrub_value({
        'parsed': parsed,
        'text': text,
        'usage': usage,
        'cost_usd': None,
        'error': _one_line(error) if error is not None else None,
        'rate_limited': rate_limited,
    }, ctx.secrets)
