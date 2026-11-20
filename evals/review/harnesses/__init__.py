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


def supported_loading(harness):
    """Return the loading modes declared by the selected harness."""
    return load(harness).SKILL_LOADING


__all__ = ['Refusal', 'Context', 'TimeoutExpired', 'load', 'scrub', 'review_prompt', 'supported_loading']
