"""Run a child in its own process group, so a timeout or an interrupt kills everything the child started."""
import os
import queue
import signal
import subprocess
import threading
import time

GRACE = 3.0
_registry_lock = threading.RLock()
_groups = set()
_stopping = False


def reset_registry():
    """Begin a new run only after every previous child has been reaped."""
    global _stopping
    with _registry_lock:
        if _groups:
            raise RuntimeError('process groups still active')
        _stopping = False


def kill_all(grace=GRACE):
    """Close admission atomically, then stop all groups with one shared grace period."""
    global _stopping
    with _registry_lock:
        _stopping = True
        groups = tuple(_groups)
    for proc in groups:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + grace
    for proc in groups:
        try:
            proc.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    for proc in groups:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def kill_group(proc, grace=GRACE):
    """TERM the group and give its leader `grace` seconds (none when grace is 0), then always KILL whatever is left,
    even when a signal handler raises while waiting. Idempotent."""
    try:
        if grace:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=grace)
    except (ProcessLookupError, PermissionError, subprocess.TimeoutExpired):
        pass
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait()
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            if pipe:
                pipe.close()


def _run_group_streaming(proc, command, input, timeout, merge_stderr, grace, on_stdout_line):
    q = queue.Queue()
    stderr_chunks = []

    def _feed_stdin():
        try:
            proc.stdin.write(input)
        except (BrokenPipeError, OSError, ValueError):
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    def _read_stderr():
        try:
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                stderr_chunks.append(chunk)
        except (OSError, ValueError):
            pass

    def _read_stdout():
        try:
            for line in proc.stdout:
                q.put(('line', line))
        except (OSError, ValueError):
            pass
        finally:
            q.put(('eof', None))

    threads = []
    if input is not None:
        t_in = threading.Thread(target=_feed_stdin, daemon=True)
        t_in.start()
        threads.append(t_in)
    t_err = None
    if not merge_stderr and proc.stderr is not None:
        t_err = threading.Thread(target=_read_stderr, daemon=True)
        t_err.start()
        threads.append(t_err)
    t_out = threading.Thread(target=_read_stdout, daemon=True)
    t_out.start()
    threads.append(t_out)

    deadline = (time.monotonic() + timeout) if timeout is not None else None
    stdout_lines = []
    aborted = False
    while True:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout, ''.join(stdout_lines),
                                                None if merge_stderr else ''.join(stderr_chunks))
            try:
                kind, payload = q.get(timeout=min(remaining, 0.25))
            except queue.Empty:
                continue
        else:
            try:
                kind, payload = q.get(timeout=0.25)
            except queue.Empty:
                continue
        if kind == 'eof':
            break
        stdout_lines.append(payload)
        if on_stdout_line(payload) is False:
            aborted = True
            kill_group(proc, grace)
            break

    if aborted:
        for t in threads:
            t.join(timeout=0.5)
        return subprocess.CompletedProcess(command, proc.returncode, ''.join(stdout_lines),
                                           None if merge_stderr else ''.join(stderr_chunks))

    wait_timeout = max(0.0, deadline - time.monotonic()) if deadline is not None else None
    proc.wait(timeout=wait_timeout)
    for t in threads:
        t.join(timeout=1.0)
    for pipe in (proc.stdin, proc.stdout, proc.stderr):
        if pipe:
            try:
                pipe.close()
            except OSError:
                pass
    return subprocess.CompletedProcess(command, proc.returncode, ''.join(stdout_lines),
                                       None if merge_stderr else ''.join(stderr_chunks))


def run_group(command, input=None, env=None, cwd=None, timeout=None, merge_stderr=False, grace=GRACE,
              on_stdout_line=None):
    """subprocess.run with a new session. Raises TimeoutExpired (or lets KeyboardInterrupt through) after
    the whole group is dead. stdin is closed unless `input` is given.

    When `on_stdout_line` is provided, stdout is read line by line while draining stderr concurrently;
    returning False from the callback kills the process group immediately and returns a CompletedProcess
    with the partial stdout, stderr read so far, and returncode.
    """
    proc = None
    try:
        with _registry_lock:
            if _stopping:
                raise RuntimeError('process registry is stopping')
            # Defer main-thread handlers until the child is registered. Unlike a
            # blocked signal mask, caught handlers reset at exec and do not stop
            # the child from receiving TERM. Workers use the registry lock.
            handlers, pending = {}, []
            if threading.current_thread() is threading.main_thread():
                for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                    handlers[sig] = signal.signal(sig, lambda signum, frame: pending.append((signum, frame)))
            try:
                proc = subprocess.Popen(command, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
                                        text=True, errors='replace', env=env, cwd=cwd, start_new_session=True)
                _groups.add(proc)
            finally:
                for sig, handler in handlers.items():
                    signal.signal(sig, handler)
                for sig, frame in pending:
                    handler = handlers[sig]
                    if callable(handler):
                        handler(sig, frame)
                    elif handler == signal.SIG_DFL:
                        os.kill(os.getpid(), sig)
        if on_stdout_line is None:
            out, err = proc.communicate(input, timeout=timeout)
            return subprocess.CompletedProcess(command, proc.returncode, out, err)
        return _run_group_streaming(proc, command, input, timeout, merge_stderr, grace, on_stdout_line)
    except BaseException:
        if proc is not None:
            kill_group(proc, grace)
        raise
    finally:
        with _registry_lock:
            _groups.discard(proc)
