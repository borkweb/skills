#!/usr/bin/env python3
"""Pin branch-review scope; run in the subject checkout. Does not fetch or write.
Use --base <verified-ref> [--include-local]. Compare snapshot after review.
Review branch_patch plus local_patch and untracked files only if requested.
Snapshot also detects tracked checkout edits even when local patches are excluded.
Untracked contents are hashed, not printed. Paths are JSON strings, never shell.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE)


def capture(base, include_local=False):
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    def repo(*args):
        return git("-C", str(root), *args)
    base_sha = repo("rev-parse", "--verify", "--end-of-options", base + "^{commit}").decode().strip()
    head = repo("rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    merge_base = repo("merge-base", base_sha, head).decode().strip()
    branch_patch = repo("diff", "--no-ext-diff", "--no-textconv", "--binary", merge_base, head, "--")
    branch_files = repo("diff", "--name-only", "-z", merge_base, head, "--").decode().split("\0")[:-1]
    result = {"root": str(root), "base": base_sha, "head": head, "merge_base": merge_base,
              "branch_files": branch_files, "branch_patch": branch_patch.decode(errors="replace"),
              "include_local": include_local}
    digest = hashlib.sha256(base_sha.encode() + head.encode() + branch_patch)
    result["branch_snapshot"] = digest.hexdigest()
    local = repo("diff", "--no-ext-diff", "--no-textconv", "--binary", head, "--")
    staged = repo("diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", head, "--")
    status = repo("status", "--porcelain=v1", "-z", "--untracked-files=all")
    digest.update(local + staged + status)
    if include_local:
        paths = repo("ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")[:-1]
        untracked = []
        for path in paths:
            f = root / path
            if not f.is_symlink() and not f.is_file():
                raise ValueError(f"untracked path is not a regular file: {path}")
            content = str(f.readlink()).encode() if f.is_symlink() else f.read_bytes()
            untracked.append({"path": path, "sha256": hashlib.sha256(content).hexdigest()})
        digest.update(json.dumps(untracked, sort_keys=True).encode())
        result.update(local_patch=local.decode(errors="replace"), staged_patch=staged.decode(errors="replace"),
                      unstaged_patch=repo("diff", "--no-ext-diff", "--no-textconv", "--binary", "--").decode(errors="replace"),
                      untracked=untracked,
                      status=status.decode(errors="replace").split("\0")[:-1])
    if repo("rev-parse", "HEAD").decode().strip() != head:
        raise ValueError("HEAD changed while capturing scope; retry from a stable checkout")
    result["snapshot"] = digest.hexdigest()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--include-local", action="store_true")
    args = parser.parse_args()
    try:
        result = capture(args.base, args.include_local)
    except (subprocess.CalledProcessError, OSError, ValueError) as error:
        detail = error.stderr.decode(errors="replace").strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"cannot capture review scope: {detail}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
