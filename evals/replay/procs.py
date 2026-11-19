"""Run a child in its own process group, so a timeout or an interrupt kills everything the child started."""
import os
import queue
import signal
import subprocess
import threading
import time

GRACE = 3.0


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
                try:
                    kind, payload = q.get_nowait()
                except queue.Empty:
                    raise subprocess.TimeoutExpired(command, timeout, ''.join(stdout_lines),
                                                    None if merge_stderr else ''.join(stderr_chunks))
            else:
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
    proc = subprocess.Popen(command, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
                            text=True, errors='replace', env=env, cwd=cwd, start_new_session=True)
    try:
        if on_stdout_line is None:
            out, err = proc.communicate(input, timeout=timeout)
            return subprocess.CompletedProcess(command, proc.returncode, out, err)
        return _run_group_streaming(proc, command, input, timeout, merge_stderr, grace, on_stdout_line)
    except BaseException:
        kill_group(proc, grace)
        raise
