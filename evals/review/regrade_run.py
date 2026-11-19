#!/usr/bin/env python3
"""Grade frozen review output into a new run; never write to the source run."""
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_review_eval as runner


def parser():
    p = runner.Parser(description=__doc__)
    p.add_argument('run_dir', type=Path)
    p.add_argument('--grader', required=True, metavar='HARNESS:MODEL:EFFORT')
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--spend', action='store_true')
    p.add_argument('--current-cases', action='store_true')
    p.add_argument('--jobs', type=int, default=4)
    p.add_argument('--budget-usd', type=float)
    return p


def main(argv=None):
    ctx = runner.harnesses.Context(runner.caselib.scrubbed_env(), runner.procs.run_group, [],
                                  lambda msg: print(runner.one_line(msg, ctx.secrets), file=sys.stderr))
    try:
        args = parser().parse_args(argv)
        runner.positive_options(args)
        runner.procs.reset_registry()
        parts = args.grader.split(':')
        if len(parts) != 3 or any(not p or '\n' in p for p in parts):
            raise runner.harnesses.Refusal('--grader requires harness:model:effort (- for null effort)')
        grader_config = dict(zip(('harness', 'model', 'effort'), parts))
        if grader_config['effort'] == '-':
            grader_config['effort'] = None
        module = runner.harnesses.load(grader_config['harness'])
        if not callable(getattr(module, 'grade', None)):
            raise runner.harnesses.Refusal('grader harness cannot grade')
        source, dest = args.run_dir.resolve(), args.output.resolve()
        runner.output_allowed(dest)
        old = json.loads((source / 'run.json').read_text())
        state = runner.results.read_records(source / 'trials.jsonl')
        for record in state.records:
            if record['type'] != 'review':
                continue
            token = record['key']
            if not re.fullmatch(r't[0-9a-f]{12}', token) or record['text_file'] != f'trials/{token}/review.md':
                raise runner.harnesses.Refusal('unsafe source review path')
        m = runner.stored_matrix(old['matrix'])
        cases, paths = runner.load_cases(source / 'cases')
        if args.current_cases:
            current, current_paths = runner.load_cases(m.cases_dir)
            by_id = {c['id']: c for c in current}
            for case in cases:
                if case['id'] not in by_id or ({f['id'] for f in case['expected_findings']} -
                        {f['id'] for f in by_id[case['id']]['expected_findings']}):
                    raise runner.harnesses.Refusal('current case is missing a source finding ID')
            cases = [by_id[c['id']] for c in cases]
            paths = {c['id']: current_paths[c['id']] for c in cases}
        m = replace(m, grader=grader_config, raw=dict(m.raw, grader=grader_config),
                    budget_usd=args.budget_usd or m.budget_usd)
        run_id = uuid.uuid4().hex
        manifest = dict(old, run_id=run_id, regraded_from=old['run_id'], grader=grader_config,
                        matrix=runner.resolved_matrix(m), matrix_sha256=runner.matrix_hash(dict(m.raw, grader=grader_config)),
                        case_set_sha256=runner.case_hash(paths),
                        work_root=str((Path.home() / '.borkweb-skills/eval-work' / run_id).resolve()))
        if any(c.get('expected_verdict') not in (None, 'DO NOT LAND', 'FAIL', 'INCOMPLETE') for c in cases):
            manifest['notes'] = []
        runner.check_work_paths(dest, Path(manifest['work_root']), runner.deny_paths(dest, m.cases_dir))
        count = sum(r['outcome'] == 'ok' for r in state.reviews.values())
        estimated = count * runner.estimate(m.grader['model'], 'match') + len(cases) * runner.estimate(m.grader['model'], 'extras')
        print(f'Configs: {len(m.configs)}; review calls: 0; match calls: {count}; extras calls: {len(cases)}; '
              f'estimated cost: ${estimated:.6f}; budget_usd: {m.budget_usd:g}')
        if not args.spend and grader_config['harness'] != 'fake':
            return 0
        module.preflight(ctx)
        dest.mkdir(mode=0o700, parents=True)
        with runner.RunLock(dest, ctx.log):
            for name in ('cases', 'trials', 'raw'):
                (dest / name).mkdir(mode=0o700)
            for cid, path in paths.items():
                shutil.copyfile(path, dest / 'cases' / (cid + '.json'))
            runner.write_json(dest / 'run.json', manifest)
            ledger = runner.Ledger(dest / 'trials.jsonl', ctx.secrets)
            try:
                # Retain source reviews, but start this run's independent grade
                # history at attempt 1 without importing the source's rulings.
                for record in state.records:
                    if record['type'] == 'review':
                        fields = {k: v for k, v in record.items() if k not in runner.results.COMMON_FIELDS}
                        ledger.add('review', record['key'], **fields)
                for token, review in state.reviews.items():
                    src, out = source / 'trials' / token, dest / 'trials' / token
                    out.mkdir(mode=0o700)
                    for name in ('review.md', 'review-meta.json', 'stderr-tail.txt'):
                        path = src / name
                        if path.is_symlink() or (path.exists() and path.stat().st_nlink != 1):
                            raise runner.harnesses.Refusal('unsafe source trial file')
                        if path.exists():
                            shutil.copyfile(path, out / name)
            finally:
                ledger.close()
            engine = runner.Engine(dest, manifest, m, ctx, args.jobs)
            engine.run(cases, regrade=True)
            runner.finish(dest)
        return 0
    except (runner.harnesses.Refusal, runner.results.ResultsError, ValueError, OSError) as exc:
        print('refusing: ' + runner.one_line(exc, ctx.secrets), file=sys.stderr)
        return 2
    except runner.Interrupted:
        print('interrupted: regrade output retains completed work', file=sys.stderr)
        return 1
    except Exception as exc:
        print('failed: ' + runner.one_line(exc, ctx.secrets), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
