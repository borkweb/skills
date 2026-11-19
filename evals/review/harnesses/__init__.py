"""Review-eval harness package: shared contract types, loader, scrubber, prompt and link-safe cleanup."""
from dataclasses import dataclass
import importlib
import os
from pathlib import Path
import re
import stat
from subprocess import TimeoutExpired
from typing import Any

_HARNESS_NAME = re.compile(r'^[a-z][a-z0-9_]*$')

DELEGATION_LIMIT_LINE = (
    'This request sets a delegation limit: no subagent or independent reviewer is available in this run. '
    'Record the independent review as unavailable in the Coverage table. '
    'Under this limit, an unavailable independent review is a coverage gap, not missing required evidence. '
    'Base the verdict on the findings and the other gates.'
)


class Refusal(Exception):
    """Raised before a model call when a harness, credential, or request cannot be used."""


@dataclass
class Context:
    env_base: dict
    run_group: Any
    secrets: list
    log: Any


def load(harness):
    """Import and return the adapter module for `harness`, verifying its HARNESS declaration."""
    if not isinstance(harness, str) or not _HARNESS_NAME.match(harness):
        raise Refusal(f'unknown harness {harness!r}')
    try:
        mod = importlib.import_module(f'{__name__}.{harness}')
    except (ImportError, ValueError) as exc:
        raise Refusal(f'unknown harness {harness!r}: {exc}') from None
    if getattr(mod, 'HARNESS', None) != harness:
        raise Refusal(f'harness module {harness!r} declares HARNESS={getattr(mod, "HARNESS", None)!r}')
    return mod


def scrub(text, secrets):
    """Replace every secret of 8 or more characters in `text` with `[redacted]`, longest first."""
    if not isinstance(text, str) or not text or not secrets:
        return text
    ordered = sorted({s for s in secrets if isinstance(s, str) and len(s) >= 8}, key=len, reverse=True)
    for secret in ordered:
        text = text.replace(secret, '[redacted]')
    return text


def review_prompt(req, invoke):
    """Build the shared diff-review prompt using only refs, commit SHAs, and the harness invoke text."""
    base = req['base']
    head = req['head']
    merge_base = req['merge_base']
    return (
        f'{invoke}\n\n'
        f'Review the diff from ref `review-base` ({base}) to ref `review-target` ({head}), '
        f'with merge-base {merge_base}.\n\n'
        'Report only. Do not edit files, commit, or push.\n'
        'Do not dispatch subagents or an independent reviewer.\n'
        f'{DELEGATION_LIMIT_LINE}\n'
    )


def _is_under_root(path, root_real):
    real = os.path.realpath(path)
    return real == root_real or real.startswith(root_real + os.sep)


def remove_tree_link_safe(path, root, created_inodes=None):
    """Remove `path` recursively without following symlinks, leaving `root`, or touching foreign hard links."""
    root_real = os.path.realpath(str(root))
    target = Path(path)
    try:
        st = os.lstat(target)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(st.st_mode):
        if not _is_under_root(str(target.parent), root_real):
            raise Refusal(f'refusing to remove link outside root {root_real}: {target}')
        os.unlink(target)
        return
    if not _is_under_root(str(target), root_real):
        raise Refusal(f'refusing to remove path outside root {root_real}: {target}')
    created = set(created_inodes or ())
    if not stat.S_ISDIR(st.st_mode):
        if st.st_nlink > 1 and (st.st_dev, st.st_ino) not in created:
            return
        os.unlink(target)
        return

    def _walk(directory):
        kept = False
        try:
            with os.scandir(directory) as entries:
                items = list(entries)
        except OSError:
            return True
        for entry in items:
            entry_path = entry.path
            try:
                est = os.lstat(entry_path)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(est.st_mode):
                try:
                    os.unlink(entry_path)
                except OSError:
                    kept = True
            elif stat.S_ISDIR(est.st_mode):
                if not _is_under_root(entry_path, root_real):
                    kept = True
                    continue
                if _walk(entry_path):
                    kept = True
            else:
                if est.st_nlink > 1 and (est.st_dev, est.st_ino) not in created:
                    kept = True
                    continue
                try:
                    os.unlink(entry_path)
                except OSError:
                    kept = True
        if not kept:
            try:
                os.rmdir(directory)
            except OSError:
                kept = True
        return kept

    _walk(str(target))


__all__ = ['Refusal', 'Context', 'TimeoutExpired', 'load', 'scrub', 'review_prompt', 'remove_tree_link_safe']
