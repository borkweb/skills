"""Isolated review repositories and link-safe disposable trees."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
import threading

import caselib


class SnapshotError(RuntimeError):
    pass


def make_clone(repo, base, branch, clone, timeout):
    """A disposable trial repo holding exactly one ref (`branch`, at `base`) and nothing after it: `git init`, then
    a fetch of that one commit, then a checkout. No other branch, no tag, no later commit, no remote, no reflog or
    FETCH_HEAD naming `repo`, no alternates and no hardlink to its object store. Returns an error string or None."""
    steps = (('init', clone.parent, ('init', '-q', str(clone))),
             ('config', clone, ('config', 'core.logAllRefUpdates', 'false')),
             ('fetch', clone, ('-c', 'core.logAllRefUpdates=false', '-c', 'uploadpack.allowAnySHA1InWant=true', 'fetch',
                               '-q', '--no-tags', '--no-write-fetch-head', str(repo), f'{base}:refs/heads/{branch}')),
             ('checkout', clone, ('checkout', '-q', branch)))
    for label, where, args in steps:
        done = caselib.git(where, *args, check=False, timeout=timeout)
        if done.returncode != 0:
            return f'clone failed ({label}): {done.stderr.strip()[-200:]}'
    return None


def remove_tree(path, root):
    """Delete an owned descendant through pinned directory descriptors, never links."""
    path, root = Path(path), Path(root).resolve()
    path = Path(os.path.normpath(str(path.parent.resolve() / path.name)))
    if path == root or root not in path.parents or path.is_symlink():
        raise SnapshotError(f'remove: {path} is not an owned tree below {root}')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def open_directory(name, parent_fd, info):
        fd = os.open(name, flags, dir_fd=parent_fd)
        try:
            if not os.path.samestat(info, os.fstat(fd)):
                raise SnapshotError('remove: directory changed while opening')
        except BaseException:
            os.close(fd)
            raise
        return fd

    def remove(name, parent_fd, top=False):
        try:
            info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if top and stat.S_ISLNK(info.st_mode):
            raise SnapshotError('remove: tree became a symlink')
        if stat.S_ISDIR(info.st_mode):
            fd = open_directory(name, parent_fd, info)
            try:
                os.fchmod(fd, info.st_mode | stat.S_IRWXU)
                with os.scandir(fd) as entries:
                    for entry in entries:
                        remove(entry.name, fd)
            finally:
                os.close(fd)
            os.rmdir(name, dir_fd=parent_fd)
        else:
            os.unlink(name, dir_fd=parent_fd)

    descriptors = []
    try:
        fd = os.open(root, flags)
        descriptors.append(fd)
        parts = path.relative_to(root).parts
        for name in parts[:-1]:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            fd = open_directory(name, fd, info)
            descriptors.append(fd)
        remove(parts[-1], fd, top=True)
    except (OSError, RuntimeError) as exc:
        raise SnapshotError(f'remove: {" ".join(str(exc).splitlines())}') from exc
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def _cleanup_error(dest, error):
    try:
        remove_tree(dest, dest.parent)
    except (OSError, RuntimeError) as exc:
        return f'{error}; cleanup failed: {" ".join(str(exc).splitlines())}'
    return error


def make_snapshot(source, base, head, dest, timeout, max_depth=5000):
    """Fetch only the review history, preserving merge-base and the complete range."""
    dest = Path(dest)
    created = False
    step = 'dest'
    try:
        if os.path.lexists(dest):
            raise SnapshotError('destination exists')

        step = 'refs'
        for ref in (base, head):
            if not isinstance(ref, str) or not ref or ref.startswith('-'):
                raise SnapshotError('option-like or empty ref')

        def git(where, *args):
            result = caselib.git(where, *args, timeout=timeout, check=False)
            if result.returncode:
                raise SnapshotError(' '.join(result.stderr.strip().splitlines())[-500:] or 'git failed')
            return result.stdout.strip()

        step = 'merge-base'
        bases = git(source, 'merge-base', '--all', base, head).splitlines()
        if len(bases) != 1:
            raise SnapshotError('more than one merge-base' if len(bases) > 1 else 'no merge-base')
        mb = bases[0]
        step = 'boundary'
        boundary = [s[1:] for s in git(source, 'rev-list', '--boundary', head, '^' + base).splitlines()
                    if s.startswith('-')]
        if not boundary:
            step = 'range'
            raise SnapshotError('head adds no commits to base')
        depth = 1 + max(int(git(source, 'rev-list', '--count', s + '..' + base))
                        for s in boundary)
        count = int(git(source, 'rev-list', '--count', base + '..' + head))
        if depth > max_depth:
            return None, f'snapshot: too deep (D={depth})'
        step = 'init'
        dest.mkdir(mode=0o700)
        created = True
        git(dest, 'init', '-q', '--template=')
        git(dest, 'config', 'core.logAllRefUpdates', 'false')
        url = Path(source).resolve().as_uri()
        for step, extra, ref, branch in (
                ('fetch-base', ['--depth', str(depth)], base, 'review-base'),
                ('fetch-target', [], head, 'review-target')):
            git(dest, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', *extra, url,
                f'{ref}:refs/heads/{branch}')
        step = 'assert'
        if git(dest, 'merge-base', 'review-base', 'review-target') != mb:
            raise SnapshotError('merge-base mismatch')
        if int(git(dest, 'rev-list', '--count', 'review-base..review-target')) != count:
            raise SnapshotError('range count mismatch')
        step = 'checkout'
        git(dest, 'checkout', '-q', 'review-target')
        return mb, None
    except subprocess.TimeoutExpired:
        error = f'timeout after {timeout:g}s'
    except (OSError, RuntimeError, ValueError) as exc:
        error = str(exc)
    if created:
        error = _cleanup_error(dest, error)
    return None, f'snapshot: {step}: {error}'


_apfs_devices = {}
_apfs_lock = threading.Lock()


def clone_copy(src, dest):
    """Clone a snapshot on the same APFS device; refuse full-copy fallback volumes."""
    src, dest = Path(src).resolve(), Path(dest)
    if os.path.lexists(dest):
        raise SnapshotError('copy: destination exists')
    try:
        device = src.stat().st_dev
        if device != dest.parent.stat().st_dev:
            raise SnapshotError('copy: source and destination must share an APFS device')
        with _apfs_lock:
            if device not in _apfs_devices:
                mounts = subprocess.run(['/sbin/mount'], capture_output=True, text=True, check=True,
                                        env=caselib.scrubbed_env())
                found = False
                for line in mounts.stdout.splitlines():
                    match = re.match(r'.+ on (.+) \(apfs(?:,|\))', line)
                    if match and Path(match[1]).stat().st_dev == device:
                        found = True
                        break
                _apfs_devices[device] = found
            if not _apfs_devices[device]:
                raise SnapshotError('copy: device is not APFS')
        subprocess.run(['/bin/cp', '-c', '-R', str(src), str(dest)], check=True, capture_output=True,
                       env=caselib.scrubbed_env())
    except (OSError, subprocess.SubprocessError, SnapshotError) as exc:
        error = _cleanup_error(dest, str(exc)) if os.path.lexists(dest) else str(exc)
        raise SnapshotError(f'copy: {error}') from exc


def export_skills(repo, ref, dest):
    """Export a committed skills tree, preserving links and removing hook entrypoints."""
    dest = Path(dest)
    if not isinstance(ref, str) or not ref or ref.startswith('-'):
        raise SnapshotError('export: option-like or empty ref')
    if os.path.lexists(dest):
        raise SnapshotError('export: destination exists')
    created = False
    try:
        sha = caselib.git(repo, 'rev-parse', '--verify', ref + '^{commit}')
        dest.mkdir(mode=0o700)
        created = True
        with tempfile.TemporaryDirectory(prefix='skills-archive-') as scratch:
            archive = Path(scratch) / 'tree.tar'
            caselib.git(repo, 'archive', '--format=tar', '--output=' + str(archive), sha)
            with tarfile.open(archive) as tar:
                for member in tar:
                    name = Path(member.name)
                    if name.is_absolute() or '..' in name.parts:
                        raise SnapshotError('export: unsafe archive path')
                    target = dest / name
                    parents = target.relative_to(dest).parents
                    if any((dest / p).is_symlink() for p in parents):
                        raise SnapshotError('export: archive writes through a link')
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                    elif member.issym():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.symlink_to(member.linkname)
                    elif member.isfile():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with target.open('xb') as out, tar.extractfile(member) as data:
                            while block := data.read(1024 * 1024):
                                out.write(block)
                        target.chmod(member.mode & 0o777)
                    else:
                        raise SnapshotError('export: unsupported archive entry')
        for where, dirs, files in os.walk(dest, followlinks=False):
            for name in files:
                path = Path(where) / name
                if name == 'hooks.json' and path.parent.name == 'hooks':
                    path.unlink()
                elif name in ('plugin.json', 'gemini-extension.json'):
                    resolved = path.resolve()
                    if dest.resolve() not in resolved.parents:
                        raise SnapshotError('export: manifest link escapes export')
                    if 'hooks' in json.loads(path.read_text()):
                        raise SnapshotError(f'export: hooks key in {path.relative_to(dest)}')
        return sha
    except (OSError, RuntimeError, ValueError, tarfile.TarError) as exc:
        error = _cleanup_error(dest, str(exc)) if created else str(exc)
        raise SnapshotError(f'export: {error}') from exc
