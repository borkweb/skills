"""Run a child in its own process group, so a timeout or an interrupt kills everything the child started."""
import os
import signal
import subprocess

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


def run_group(command, input=None, env=None, cwd=None, timeout=None, merge_stderr=False, grace=GRACE):
    """subprocess.run with a new session. Raises TimeoutExpired (or lets KeyboardInterrupt through) after
    the whole group is dead. stdin is closed unless `input` is given."""
    proc = subprocess.Popen(command, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
                            text=True, errors='replace', env=env, cwd=cwd, start_new_session=True)
    try:
        out, err = proc.communicate(input, timeout=timeout)
    except BaseException:
        kill_group(proc, grace)
        raise
    return subprocess.CompletedProcess(command, proc.returncode, out, err)
