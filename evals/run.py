#!/usr/bin/env python3
"""Drive isolated model adapters; does not supply a model or claim benchmark results."""
import argparse
import json
from pathlib import Path
import subprocess
import time


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for field in ['cases', 'skill-root', 'runtime', 'runtime-version', 'model', 'effort', 'revision', 'output']:
        p.add_argument('--' + field, required=True)
    p.add_argument('--variant', choices=['no-skill', 'current', 'revised'], required=True)
    p.add_argument('--timeout', type=float, default=600)
    p.add_argument('--runner', nargs=argparse.REMAINDER, required=True)
    args = p.parse_args()
    if not args.runner or args.timeout <= 0:
        p.error('runner and positive timeout required')
    cases = json.loads(Path(args.cases).read_text())
    metadata = {k: getattr(args, k) for k in ['runtime', 'runtime_version', 'model', 'effort', 'revision']}
    results = []
    destination = Path(args.output)
    # Refuse to overwrite a prior run; each comparison needs its original evidence.
    with destination.open('x') as output:
        for case in cases:
            skill = Path(args.skill_root).resolve() / case['skill'] / 'SKILL.md'
            if args.variant != 'no-skill' and not skill.is_file():
                raise ValueError(f'missing skill: {skill}')
            request = {'case': {k: v for k, v in case.items() if k not in {'criteria'}},
                       'skill_file': None if args.variant == 'no-skill' else str(skill),
                       'variant': args.variant, 'metadata': metadata}
            started = time.monotonic()
            record = {'id': case['id'], 'criteria': case['criteria']}
            try:
                run = subprocess.run(args.runner, input=json.dumps(request), text=True,
                                     capture_output=True, timeout=args.timeout)
                record.update(exit_code=run.returncode, stderr=run.stderr)
                if run.returncode == 0:
                    response = json.loads(run.stdout)
                    if not isinstance(response, dict) or not {'output', 'trace', 'usage'} <= response.keys():
                        raise ValueError('adapter output needs output, trace and usage')
                    record['result'] = response
                else:
                    record['stdout'] = run.stdout
            except (subprocess.TimeoutExpired, OSError, ValueError) as error:
                record['error'] = str(error)
            record['elapsed_seconds'] = round(time.monotonic() - started, 3)
            results.append(record)
            output.seek(0)
            json.dump({'metadata': metadata, 'variant': args.variant, 'results': results}, output, indent=2)
            output.truncate(); output.flush()
    return 1 if any(r.get('error') or r.get('exit_code') != 0 for r in results) else 0


if __name__ == '__main__':
    raise SystemExit(main())
