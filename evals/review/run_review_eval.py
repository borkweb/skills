#!/usr/bin/env python3
"""Run isolated review trials, or resume an append-only run without repeating paid reviews."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import sys
import threading
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'replay'))
sys.path.insert(0, str(HERE.parent / 'report'))
import build_report
import caselib
import check_cases
import grader
import harnesses
import matrix
import procs
import repos
import results
import snapshot


def now():
    return datetime.now(timezone.utc).isoformat()


def one_line(value, secrets=()):
    return ' '.join(harnesses.scrub(str(value), secrets).split())


def scrub_value(value, secrets):
    if isinstance(value, str):
        return harnesses.scrub(value, secrets)
    if isinstance(value, dict):
        return {k: scrub_value(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_value(v, secrets) for v in value]
    return value


def write_json(path, value):
    tmp = path.with_name('.' + path.name + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=True, allow_nan=False, indent=2) + '\n')
    tmp.chmod(0o600)
    os.replace(tmp, path)


def clean(path, root, ctx):
    try:
        snapshot.remove_tree(path, root)
    except snapshot.SnapshotError as exc:
        ctx.log(one_line(f'cleanup: {exc}', ctx.secrets))


def usage(value):
    value = value if isinstance(value, dict) else {}
    return {k: min(v, 10**15) if type(v := value.get(k)) is int and v >= 0 else None
            for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')}


def price(model, tokens):
    prices = matrix._prices()['models']
    candidates = [model] if model in prices else list(prices)
    values = [matrix.cost(name, usage(tokens)) for name in candidates]
    values = [v for v in values if v is not None]
    return float(min(1e6, max(values))) if values else None


def estimate(model, kind):
    return price(model, matrix._prices()['estimates'][kind])


MODEL_ALIASES = {'claude': {'sonnet': 'claude-sonnet-5-5', 'opus': 'claude-opus-5-5'}}


def classify_reply(reply, cfg, case, secrets=()):
    """Classify the adapter reply used by the production review path."""
    evidence = reply.get('skill_evidence') or 'none'
    if not re.match(r'^(tool-use|output-evidence|none)(:.*)?$', evidence):
        evidence = 'none'
    evidence = one_line(evidence, secrets)
    if reply.get('rate_limited'):
        return 'env-unavailable', 'rate-limit', evidence
    error = reply.get('error')
    if error:
        reason = one_line(error, secrets)
        return ('env-unavailable' if reason == 'plugin loading unavailable' else 'error'), reason, evidence
    aliases = MODEL_ALIASES.get(cfg['harness'], {})
    resolved = reply.get('resolved_model')
    if resolved is not None and aliases.get(resolved, resolved) != aliases.get(cfg['model'], cfg['model']):
        return 'env-unavailable', one_line(f'model fell back to {resolved}', secrets), evidence
    effort = reply.get('resolved_effort')
    if effort is not None and effort != cfg['effort']:
        return 'env-unavailable', one_line(f'effort fell back to {effort}', secrets), evidence
    if reply.get('skill_invoked') is True:
        return 'ok', None, evidence
    if reply.get('skill_invoked') is None and grader.output_evidence(
            reply.get('text', ''), case['skill'], case['base'], case['head']):
        return 'ok', None, 'output-evidence:verdict, refs and Coverage'
    return 'error', 'skill not invoked', evidence


def review_needed(record, retry_errors=False):
    if record is None:
        return True
    outcome, reason = record['outcome'], record.get('reason') or ''
    return ((outcome == 'error' and retry_errors) or
            (outcome == 'skipped' and reason == 'budget') or
            (outcome == 'env-unavailable' and (reason == 'rate-limit' or reason.startswith('snapshot: '))))


def metadata(text, secrets):
    row = re.search(r'^\s*\|\s*Independent review\s*\|([^|]*)\|', text, re.M | re.I)
    basis = re.search(r'\b(defect found|readiness unverified)\b', text, re.I)
    return {'independent_review': one_line(row[1], secrets) if row else None,
            'verdict_basis': basis[1].lower() if basis else None}


def diff_over_200(text):
    return sum(int(n) for n in re.findall(r'(\d+) (?:insertion|deletion)s?\(', text)) > 200


def matrix_hash(raw):
    return hashlib.sha256(json.dumps({k: v for k, v in raw.items() if k != 'budget_usd'},
                                    sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def case_hash(paths):
    pairs = sorted([[cid, hashlib.sha256(path.read_bytes()).hexdigest()] for cid, path in paths.items()])
    return hashlib.sha256(json.dumps(pairs, separators=(',', ':')).encode()).hexdigest()


def resolved_matrix(m):
    data = asdict(m)
    data['cases_dir'] = str(m.cases_dir.resolve())
    return data


def stored_matrix(data):
    values = dict(data)
    values['cases_dir'] = Path(values['cases_dir'])
    return matrix.Matrix(**values)


def load_cases(directory):
    paths, cases = {}, []
    for path in sorted(Path(directory).glob('*.json')):
        case = check_cases.load(path)
        errors = check_cases.check(case, path.stem)
        if errors:
            raise harnesses.Refusal(f'{path.name}: {errors[0]}')
        paths[case['id']] = path
        cases.append(case)
    return cases, paths


def output_allowed(path, new=True):
    if new and os.path.lexists(path):
        raise harnesses.Refusal('output exists')
    probe = path
    while not probe.exists():
        probe = probe.parent
    if caselib.git(probe, 'rev-parse', '--is-inside-work-tree', check=False).stdout.strip() == 'true':
        raise harnesses.Refusal('output is inside a git work tree')


def deny_paths(run_dir, cases_dir):
    token = Path(os.environ.get('BORK_EVAL_CLAUDE_TOKEN_FILE') or
                 Path.home() / '.borkweb-skills/evals/claude-oauth-token').expanduser().resolve()
    return [run_dir.resolve(), Path(cases_dir).resolve(), token.parent,
            (Path.home() / 'git/skills-private').resolve()]


def check_work_paths(run_dir, work_root, deny_read):
    for denied in deny_read[1:]:
        for path in (run_dir, work_root):
            if path == denied or denied in path.parents:
                raise harnesses.Refusal(f'{path} is inside deny_read {denied}')


class RunLock:
    def __init__(self, run_dir, log):
        self.path = run_dir / '.lock'
        self.log = log
        self.owned = False

    def __enter__(self):
        for _ in range(3):
            try:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                try:
                    pid = int(self.path.read_text())
                    if pid <= 0:
                        raise ValueError('invalid lock pid')
                    os.kill(pid, 0)
                except ProcessLookupError:
                    self.path.unlink()
                    self.log('replaced stale run lock')
                    continue
                except (OSError, ValueError):
                    raise harnesses.Refusal('run lock is unreadable or cannot be verified') from None
                raise harnesses.Refusal('run lock is held by a live process')
            else:
                with os.fdopen(fd, 'w') as stream:
                    stream.write(str(os.getpid()))
                self.owned = True
                return self
        raise harnesses.Refusal('could not acquire run lock')

    def __exit__(self, *exc):
        if self.owned:
            self.path.unlink()


def repair_tail(path):
    if not path.exists():
        path.touch(mode=0o600)
        return
    data = path.read_bytes()
    if not data or data.endswith(b'\n'):
        return
    tail = data.rsplit(b'\n', 1)[-1]
    try:
        json.loads(tail)
    except (ValueError, UnicodeError):
        with path.open('r+b') as stream:
            stream.truncate(len(data) - len(tail))
    else:
        with path.open('ab') as stream:
            stream.write(b'\n')


class Ledger:
    """Only this thread appends records; each caller waits for its durable ordering point."""
    def __init__(self, path, secrets):
        repair_tail(path)
        self.path, self.secrets = path, secrets
        self.attempts = {}
        for r in results.read_records(path).records:
            key = r['type'], r['key']
            self.attempts[key] = max(self.attempts.get(key, 0), r['attempt'])
        self.queue = queue.Queue()
        self.stream = self.path.open('a', encoding='utf-8')
        self.thread = threading.Thread(target=self._write, name='review-ledger')
        self.thread.start()

    def _write(self):
        with self.stream as stream:
            while (item := self.queue.get()) is not None:
                record, event, reply = item
                try:
                    key = record['type'], record['key']
                    record = scrub_value(dict(record, schema=results.SCHEMA, at=now(),
                                              attempt=self.attempts.get(key, 0) + 1), self.secrets)
                    line = json.dumps(record, ensure_ascii=True, allow_nan=False) + '\n'
                    stream.write(line)
                    stream.flush()
                    self.attempts[key] = record['attempt']
                    reply.append(record)
                except Exception as exc:
                    reply.append(exc)
                finally:
                    event.set()

    def add(self, kind, key, **fields):
        event, reply = threading.Event(), []
        self.queue.put((dict(fields, type=kind, key=key), event, reply))
        event.wait()
        if isinstance(reply[0], Exception):
            raise reply[0]
        return reply[0]

    def close(self):
        self.queue.put(None)
        self.thread.join()


class Budget:
    def __init__(self, limit, records, configs, grade_model):
        models = {c['key']: c['model'] for c in configs}
        self.spent = sum((r.get('cost_usd') if r.get('cost_usd') is not None else
                          price(models.get(r['config_key'], ''), r.get('usage'))) or 0
                         if r['type'] == 'review' else
                         (r.get('grader_cost_usd') if r.get('grader_cost_usd') is not None else
                          price(grade_model, r.get('grader_usage'))) or 0 for r in records)
        self.limit, self.reserved = limit, {}
        self.measured = {}
        self.lock = threading.Lock()

    def reserve(self, token, estimate_cost):
        with self.lock:
            if self.spent + sum(self.reserved.values()) + estimate_cost > self.limit + 1e-12:
                return False
            self.reserved[token] = estimate_cost
            return True

    def charge(self, token, cost):
        with self.lock:
            self.spent += cost or 0
            self.reserved[token] = max(0, self.reserved.get(token, 0) - (cost or 0))

    def finish(self, token, cfg_key, cost, extras_share):
        with self.lock:
            self.reserved[token] = extras_share
            self.measured.setdefault(cfg_key, []).append(cost)

    def trial_estimate(self, cfg, grade_model, extras_share, review=True):
        with self.lock:
            measured = self.measured.get(cfg['key'], [])
            if review and measured:
                return sum(measured) / len(measured) + extras_share
        return ((estimate(cfg['model'], 'review') if review else 0) +
                estimate(grade_model, 'match') + extras_share)


class Interrupted(Exception):
    pass


class Engine:
    def __init__(self, run_dir, manifest, m, ctx, jobs, retry_errors=False):
        self.run_dir, self.manifest, self.m, self.ctx = run_dir, manifest, m, ctx
        self.work = Path(manifest['work_root'])
        self.jobs, self.retry_errors = jobs, retry_errors
        self.stopped = threading.Event()
        self.condition = threading.Condition()
        self.active, self.broken = {}, set()
        self.deny_read = [str(p) for p in deny_paths(run_dir, m.cases_dir)]
        self.ledger = None
        self.largest = 0

    def call(self, harness, method, req):
        with self.condition:
            limit = self.m.raw.get('max_parallel', {}).get(harness, 2)
            while self.active.get(harness, 0) >= limit and not self.stopped.is_set():
                self.condition.wait(.05)
            if self.stopped.is_set():
                raise Interrupted()
            if harness in self.broken:
                return {'rate_limited': True, 'usage': {}}
            self.active[harness] = self.active.get(harness, 0) + 1
        try:
            try:
                reply = getattr(harnesses.load(harness), method)(req, self.ctx)
            except Exception as exc:
                if self.stopped.is_set():
                    raise Interrupted() from None
                reply = {'error': one_line(exc, self.ctx.secrets), 'usage': {}}
            with self.condition:
                if reply.get('rate_limited'):
                    self.broken.add(harness)
            if self.stopped.is_set():
                raise Interrupted()
            return reply
        finally:
            with self.condition:
                self.active[harness] -= 1
                self.condition.notify_all()

    def request(self, tmp, **fields):
        return dict(timeout_s=self.m.timeout_s, tmp_root=tmp, deny_read=self.deny_read,
                    max_budget_usd=float(min(10, self.m.budget_usd)), **fields)

    def review_record(self, case, cfg, trial, token, reply=None, outcome=None, reason=None):
        reply = reply or {}
        if outcome is None:
            outcome, reason, evidence = classify_reply(reply, cfg, case, self.ctx.secrets)
        else:
            evidence = 'none'
        invoked = reply.get('skill_invoked')
        return self.ledger.add('review', token, case_id=case['id'], config_key=cfg['key'], trial=trial,
                               outcome=outcome, reason=reason, text_file=f'trials/{token}/review.md',
                               usage=usage(reply.get('usage')), rounds=reply.get('rounds'),
                               duration_s=reply.get('duration_s'), cost_usd=price(cfg['model'], reply.get('usage')),
                               resolved_model=reply.get('resolved_model'), resolved_effort=reply.get('resolved_effort'),
                               skill_invoked=invoked if type(invoked) is bool else None, skill_evidence=evidence,
                               skill_loading=reply.get('skill_loading', cfg['skill_loading']))

    def grade(self, prompt, schema, cwd, tmp, tools):
        g = self.m.grader
        return self.call(g['harness'], 'grade', self.request(tmp, prompt=prompt, schema=schema,
                         cwd=cwd, tools=tools, model=g['model'], effort=g['effort']))

    def match(self, case, token, review, text, tmp):
        cwd = tmp / 'empty'
        cwd.mkdir(mode=0o700)
        prompt, schema = grader.match_prompt(case, text)
        reply = self.grade(prompt, schema, cwd, tmp / 'm', 'none')
        parsed = grader.parse_match(reply.get('parsed') or reply.get('text'), case)
        reason = ('rate-limit' if reply.get('rate_limited') else
                  one_line(reply['error'], self.ctx.secrets) if reply.get('error') else
                  None if parsed else 'unparsed grader reply')
        verdict, method = grader.verdict(text, case['skill'])
        if verdict is None:
            verdict, method = (parsed or {}).get('verdict'), 'grader'
        fields = dict(review_attempt=review['attempt'], outcome='graded' if parsed and not reason else 'ungraded',
                      reason=reason, reported=(parsed or {}).get('reported', []),
                      expected=(parsed or {}).get('expected', {}), verdict=verdict, verdict_method=method,
                      grader_usage=usage(reply.get('usage')),
                      grader_cost_usd=price(self.m.grader['model'], reply.get('usage')))
        record = self.ledger.add('match', token, **fields)
        write_json(self.run_dir / 'trials' / token / 'match.json', scrub_value(record, self.ctx.secrets))
        return record

    def trial(self, case, cfg, trial, snap, mb, budget, share):
        token = matrix.token(case['id'], cfg['key'], trial)
        state = results.read_records(self.run_dir / 'trials.jsonl')
        previous = state.reviews.get(token)
        if self.regrade and (previous is None or previous['outcome'] != 'ok'):
            return
        run_review = review_needed(previous, self.retry_errors)
        match = state.matches.get(token)
        if not run_review and (previous['outcome'] != 'ok' or match and match['outcome'] == 'graded'):
            return
        if self.stopped.is_set():
            raise Interrupted()
        with self.condition:
            broken = cfg['harness'] in self.broken
        if run_review and broken:
            self.review_record(case, cfg, trial, token, outcome='env-unavailable', reason='rate-limit')
            return
        reservation = budget.trial_estimate(cfg, self.m.grader['model'], share, run_review)
        if not budget.reserve(token, reservation):
            if run_review:
                self.review_record(case, cfg, trial, token, outcome='skipped', reason='budget')
            return
        tmp, copy = self.work / (token + '-tmp'), self.work / token
        tmp.mkdir(mode=0o700)
        cost = 0
        try:
            folder, raw = self.run_dir / 'trials' / token, self.run_dir / 'raw' / token
            if run_review:
                if folder.exists():
                    clean(folder, folder.parent, self.ctx)
                folder.mkdir(mode=0o700)
                if raw.exists():
                    clean(raw, raw.parent, self.ctx)
                raw.mkdir(mode=0o700)
                snapshot.clone_copy(snap, copy)
                reply = self.call(cfg['harness'], 'review', self.request(tmp, trial_copy=copy,
                                  base=case['base'], head=case['head'], merge_base=mb,
                                  skill=case['skill'], skill_loading=cfg['skill_loading'], export_dir=self.work / 'export',
                                  model=cfg['model'], effort=cfg['effort'], raw_dir=raw))
                text = harnesses.scrub(reply.get('text', ''), self.ctx.secrets)
                (folder / 'review.md').write_text(text)
                meta = {k: reply.get(k) for k in ('usage', 'resolved_model', 'resolved_effort', 'skill_invoked',
                                                 'skill_evidence', 'argv', 'harness_version')}
                meta.update(metadata(text, self.ctx.secrets))
                write_json(folder / 'review-meta.json', scrub_value(meta, self.ctx.secrets))
                stderr = raw / 'stderr.txt'
                tail = stderr.read_bytes()[-8192:].decode('utf-8', 'replace') if stderr.exists() else ''
                (folder / 'stderr-tail.txt').write_text(harnesses.scrub(tail, self.ctx.secrets))
                for path in raw.iterdir():
                    if path.is_file() and not path.is_symlink():
                        path.write_text(harnesses.scrub(path.read_text(errors='replace'), self.ctx.secrets))
                previous = self.review_record(case, cfg, trial, token, reply)
                cost += previous['cost_usd'] or 0
                budget.charge(token, previous['cost_usd'])
            else:
                text = (folder / 'review.md').read_text()
            if previous['outcome'] == 'ok':
                match = self.match(case, token, previous, text, tmp)
                cost += match['grader_cost_usd'] or 0
                budget.charge(token, match['grader_cost_usd'])
        except Interrupted:
            raise
        except Exception as exc:
            if self.stopped.is_set():
                raise Interrupted() from None
            if run_review and (previous is None or previous is state.reviews.get(token)):
                self.review_record(case, cfg, trial, token, outcome='error', reason=one_line(exc, self.ctx.secrets))
            else:
                raise
        finally:
            clean(tmp, self.work, self.ctx)
            clean(copy, self.work, self.ctx)
            budget.finish(token, cfg['key'], cost, share)

    def extras(self, case, snap, budget):
        state = results.read_records(self.run_dir / 'trials.jsonl')
        reviews = {t: r for t, r in state.reviews.items() if r['case_id'] == case['id'] and r['outcome'] == 'ok'}
        tokens = sorted(reviews)
        if not tokens or any(t not in state.matches for t in tokens):
            return
        existing = state.extras.get(case['id'])
        if existing and existing['outcome'] == 'graded':
            return
        claims = [dict(f, token=t) for t in tokens for f in state.matches[t]['reported'] if f['names'] == ['extra']]
        covers = {t: {'review_attempt': reviews[t]['attempt'], 'match_attempt': state.matches[t]['attempt']}
                  for t in tokens}
        tmp, cwd = self.work / 'extras-tmp', self.work / 'extras'
        tmp.mkdir(mode=0o700)
        try:
            if claims:
                snapshot.clone_copy(snap, cwd)
                prompt, schema, order = grader.extras_prompt(case, claims, self.manifest['run_id'])
                reply = self.grade(prompt, schema, cwd, tmp, 'read-only')
                parsed = grader.parse_extras(reply.get('parsed') or reply.get('text'), order)
            else:
                reply, parsed = {'usage': {}}, {'groups': []}
            cost = price(self.m.grader['model'], reply.get('usage'))
            self.ledger.add('extras', case['id'], tokens=tokens, covers=covers,
                            outcome='graded' if parsed and not reply.get('error') and not reply.get('rate_limited') else 'ungraded',
                            groups=(parsed or {}).get('groups', []), grader_usage=usage(reply.get('usage')),
                            grader_cost_usd=cost)
            budget.charge('extras', cost)
        finally:
            clean(tmp, self.work, self.ctx)
            clean(cwd, self.work, self.ctx)
            with budget.lock:
                budget.reserved.clear()

    def snapshot(self, case):
        if shutil.disk_usage(self.work).free < max(10 * 1024**3, 2 * self.largest):
            return None, None, 'snapshot: insufficient free space'
        dest = self.work / ('s' + hashlib.sha256(case['id'].encode()).hexdigest()[:12])
        try:
            source = repos.resolve(case['repo']['identity'])
            mb, error = snapshot.make_snapshot(source, case['base'], case['head'], dest, self.m.timeout_s)
        except Exception as exc:
            if self.stopped.is_set():
                raise Interrupted() from None
            return dest, None, 'snapshot: ' + one_line(exc, self.ctx.secrets)
        if error:
            return dest, mb, error
        total, pending = 0, [dest]
        while pending:
            with os.scandir(pending.pop()) as entries:
                for entry in entries:
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(Path(entry.path))
                    else:
                        total += entry.stat(follow_symlinks=False).st_size
        self.largest = max(self.largest, total)
        shortstat = caselib.git(dest, 'diff', '--shortstat', mb + '..' + case['head'])
        self.manifest.setdefault('derived_tags', {})[case['id']] = ['diff_over_200'] if diff_over_200(shortstat) else []
        write_json(self.run_dir / 'run.json', self.manifest)
        return dest, mb, None

    def run(self, cases, regrade=False):
        self.regrade = regrade
        if self.work.exists():
            clean(self.work, self.work.parent, self.ctx)
        self.work.mkdir(mode=0o700, parents=True)
        self.ledger = Ledger(self.run_dir / 'trials.jsonl', self.ctx.secrets)
        budget = Budget(self.m.budget_usd, [] if regrade else results.read_records(self.ledger.path).records,
                        self.m.configs, self.m.grader['model'])
        handlers = {}

        def stop(signum, frame):
            if self.stopped.is_set():
                return
            self.stopped.set()
            procs.kill_all()
            raise Interrupted()

        try:
            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                handlers[sig] = signal.signal(sig, stop)
            snapshot.export_skills(REPO, self.m.skills_ref, self.work / 'export')
            share = estimate(self.m.grader['model'], 'extras') / (len(self.m.configs) * self.m.trials)
            with ThreadPoolExecutor(max_workers=self.jobs) as pool:
                for case in cases:
                    snap, mb, error = self.snapshot(case)
                    try:
                        if self.stopped.is_set():
                            raise Interrupted()
                        if error:
                            if not regrade:
                                state = results.read_records(self.ledger.path)
                                for cfg in self.m.configs:
                                    for trial in range(1, self.m.trials + 1):
                                        t = matrix.token(case['id'], cfg['key'], trial)
                                        if review_needed(state.reviews.get(t), self.retry_errors):
                                            self.review_record(case, cfg, trial, t, outcome='env-unavailable', reason=error)
                            continue
                        futures = [pool.submit(self.trial, case, cfg, trial, snap, mb, budget, share)
                                   for cfg in self.m.configs for trial in range(1, self.m.trials + 1)]
                        for future in futures:
                            future.result()
                        self.extras(case, snap, budget)
                    finally:
                        if snap:
                            clean(snap, self.work, self.ctx)
        finally:
            self.stopped.set()
            self.ledger.close()
            clean(self.work, self.work.parent, self.ctx)
            for sig, handler in handlers.items():
                signal.signal(sig, handler)


def supported(m):
    for cfg in m.configs:
        if cfg['skill_loading'] not in harnesses.supported_loading(cfg['harness']):
            raise harnesses.Refusal(f'{cfg["harness"]} does not support {cfg["skill_loading"]} skill loading')
    if not callable(getattr(harnesses.load(m.grader['harness']), 'grade', None)):
        raise harnesses.Refusal('grader harness cannot grade')


def finish(run_dir):
    results.write(run_dir)
    build_report.build_run(run_dir)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise harnesses.Refusal(message)


def parser():
    p = Parser(description=__doc__)
    p.add_argument('--matrix', type=Path)
    p.add_argument('--output', type=Path)
    p.add_argument('--spend', action='store_true')
    p.add_argument('--resume', type=Path, metavar='RUN_DIR')
    p.add_argument('--retry-errors', action='store_true')
    p.add_argument('--jobs', type=int, default=4)
    p.add_argument('--case', action='append', dest='case_ids')
    p.add_argument('--budget-usd', type=float)
    return p


def positive_options(args):
    if args.jobs <= 0:
        raise harnesses.Refusal('--jobs must be positive')
    if args.budget_usd is not None and (not math.isfinite(args.budget_usd) or args.budget_usd <= 0):
        raise harnesses.Refusal('--budget-usd must be finite and positive')


def main(argv=None):
    ctx = harnesses.Context(caselib.scrubbed_env(), procs.run_group, [],
                            lambda msg: print(one_line(msg, ctx.secrets), file=sys.stderr))
    try:
        args = parser().parse_args(argv)
        positive_options(args)
        procs.reset_registry()
        if args.resume:
            if args.output or args.case_ids:
                raise harnesses.Refusal('--resume cannot be combined with --output or --case')
            run_dir = args.resume.resolve()
            manifest = json.loads((run_dir / 'run.json').read_text())
            run_id = manifest['run_id']
            if (not isinstance(run_id, str) or run_id in ('', '.', '..') or Path(run_id).name != run_id):
                raise harnesses.Refusal('invalid run_id')
            expected_work = (Path.home() / '.borkweb-skills/eval-work').resolve() / run_id
            if Path(manifest['work_root']) != expected_work:
                raise harnesses.Refusal('work_root drift')
            m = stored_matrix(manifest['matrix'])
            if (matrix_hash(m.raw) != manifest['matrix_sha256'] or
                    args.matrix and matrix_hash(matrix.load(args.matrix).raw) != manifest['matrix_sha256']):
                raise harnesses.Refusal('matrix_sha256 drift')
            if caselib.git(REPO, 'rev-parse', m.skills_ref + '^{commit}') != manifest['skills_sha']:
                raise harnesses.Refusal('skills_sha drift')
            cases, paths = load_cases(run_dir / 'cases')
            current = {cid: m.cases_dir / path.name for cid, path in paths.items()}
            if case_hash(current) != manifest['case_set_sha256'] or case_hash(paths) != manifest['case_set_sha256']:
                raise harnesses.Refusal('case_set_sha256 drift')
            if m.grader != manifest['grader']:
                raise harnesses.Refusal('grader drift')
            output_allowed(run_dir, new=False)
        else:
            if not args.matrix or not args.output or args.retry_errors:
                raise harnesses.Refusal('give --matrix and --output; --retry-errors requires --resume')
            m = matrix.load(args.matrix)
            cases, paths = load_cases(m.cases_dir)
            if args.case_ids and set(args.case_ids) - set(paths):
                raise harnesses.Refusal('unknown --case id')
            cases = matrix.select_cases(m, cases, args.case_ids)
            if not cases:
                raise harnesses.Refusal('no cases selected')
            paths = {c['id']: paths[c['id']] for c in cases}
            run_dir = args.output.resolve()
            output_allowed(run_dir)
            run_id = uuid.uuid4().hex
            work = (Path.home() / '.borkweb-skills/eval-work' / run_id).resolve()
            manifest = dict(schema='bork-review-run/1', run_id=run_id, started_at=now(), eval='review',
                            eval_version='1', matrix_sha256=matrix_hash(m.raw), matrix=resolved_matrix(m),
                            skills_ref=m.skills_ref, skills_sha=caselib.git(REPO, 'rev-parse', m.skills_ref + '^{commit}'),
                            case_set_sha256=case_hash(paths), grader=m.grader, context='skill-only',
                            export='skills-only', work_root=str(work), derived_tags={}, notes=[])
            if not any(c.get('expected_verdict') not in (None, 'DO NOT LAND', 'FAIL', 'INCOMPLETE') for c in cases):
                manifest['notes'] = ['v1 verdict accuracy is block sensitivity only; a reviewer that always blocks scores 100%.',
                                     'Measured under a no-independent-pass delegation limit.']
        if args.budget_usd is not None:
            m = replace(m, budget_usd=args.budget_usd)
            manifest.setdefault('budget_overrides', []).append({'at': now(), 'budget_usd': args.budget_usd})
            manifest['matrix'] = resolved_matrix(m)
        supported(m)
        check_work_paths(run_dir, Path(manifest['work_root']), deny_paths(run_dir, m.cases_dir))
        matrix.plan(m, cases)
        if not args.spend and any(h != 'fake' for h in
                                 [c['harness'] for c in m.configs] + [m.grader['harness']]):
            return 0
        for name in sorted({c['harness'] for c in m.configs} | {m.grader['harness']}):
            harnesses.load(name).preflight(ctx)
        if not args.resume:
            run_dir.mkdir(mode=0o700, parents=True)
        with RunLock(run_dir, ctx.log):
            if not args.resume:
                for name in ('cases', 'trials', 'raw'):
                    (run_dir / name).mkdir(mode=0o700)
                for cid, path in paths.items():
                    shutil.copyfile(path, run_dir / 'cases' / (cid + '.json'))
            write_json(run_dir / 'run.json', manifest)
            engine = Engine(run_dir, manifest, m, ctx, args.jobs, args.retry_errors)
            engine.run(cases)
            finish(run_dir)
        return 0
    except (harnesses.Refusal, matrix.MatrixError, check_cases.repos.RepoError, ValueError, OSError) as exc:
        print('refusing: ' + one_line(exc, ctx.secrets), file=sys.stderr)
        return 2
    except Interrupted:
        print('interrupted: resume this run to finish pending work', file=sys.stderr)
        return 1
    except Exception as exc:
        print('failed: ' + one_line(exc, ctx.secrets), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
