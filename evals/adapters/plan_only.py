#!/usr/bin/env python3
"""Plan-only adapter for evals/run.py.

Runs `claude -p` with no tools and the candidate skill's Markdown inlined as
system context, and asks the model for the exact ordered actions it would take.
This measures routing, sequencing and the statements the skill shapes; it does
not execute anything, so criteria about fixture state cannot be judged from it.
Reads the driver's JSON request on stdin and writes {output, trace, usage,
artifacts} on stdout. Set PLAN_ONLY_MODEL to override the driver's model.

Confound to know about: a prompt that starts with a slash command (`/do …`)
is expanded by the installed plugin on this machine, so the model also sees the
INSTALLED version of that skill even in the no-skill variant. That makes the
no-skill run an "installed version" control, not a true baseline. For a true
no-skill control, strip the leading slash from the prompt or run under a profile
without the plugin; for an old-vs-new comparison, leave it.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

MAX_SKILL_CHARS = 90_000

BASE = (
    "You are Claude Code, running in the user's terminal inside a git repository. "
    "For this evaluation you cannot execute tools. Reply with the exact ordered sequence of actions you "
    "would take: the skills you would load by name, the agents you would spawn (role, read-only or writing, "
    "concurrently or after what), the commands you would run with their arguments, the files you would write, "
    "and the statements you would make to the user. Be literal and concrete. Do not list alternatives you "
    "would not take, and do not ask the user questions unless the skill requires it at that point."
)


def skill_context(skill_file: str) -> str:
    root = Path(skill_file).parent
    parts = []
    total = 0
    files = [root / 'SKILL.md'] + sorted(
        p for p in root.rglob('*.md')
        if p.name != 'SKILL.md' and 'test' not in p.name and 'templates' not in p.parts
    )
    for p in files:
        try:
            text = p.read_text()
        except OSError:
            continue
        if total + len(text) > MAX_SKILL_CHARS:
            break
        total += len(text)
        parts.append(f'<file path="{p.relative_to(root.parent)}">\n{text}\n</file>')
    return (
        "\n\nThe following skill is installed and its description matched the request; it is loaded for you "
        f"exactly as the Skill tool would load it. Follow it.\n\n<skill name=\"{root.name}\">\n"
        + '\n\n'.join(parts) + '\n</skill>'
    )


def main() -> int:
    req = json.load(sys.stdin)
    case = req['case']
    model = os.environ.get('PLAN_ONLY_MODEL') or (req.get('metadata') or {}).get('model') or 'claude-sonnet-5-5'
    system = BASE + (skill_context(req['skill_file']) if req.get('skill_file') else '')
    cmd = [
        'claude', '-p', '--model', model, '--output-format', 'json', '--no-session-persistence',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '',
        '--system-prompt', system, case['prompt'],
    ]
    env = {k: v for k, v in os.environ.items() if k != 'CLAUDE_CODE_SESSION_ID'}
    run = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=os.environ.get('PLAN_ONLY_CWD', os.getcwd()))
    if run.returncode != 0:
        sys.stderr.write(run.stderr)
        return run.returncode
    usage = None
    text = run.stdout
    try:
        payload = json.loads(run.stdout)
        text = payload.get('result', run.stdout)
        u = payload.get('usage') or {}
        usage = {
            'input_tokens': u.get('input_tokens'),
            'output_tokens': u.get('output_tokens'),
            'cached_input_tokens': u.get('cache_read_input_tokens'),
            'cost_usd': payload.get('total_cost_usd'),
            'duration_ms': payload.get('duration_ms'),
        }
    except ValueError:
        pass
    json.dump({
        'output': text,
        'trace': [{'note': 'plan-only: no tools were available; actions are described, not executed'}],
        'usage': usage or {'input_tokens': None, 'output_tokens': None, 'cached_input_tokens': None},
        'artifacts': [],
        'model': model,
    }, sys.stdout)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
