"""Self-test for the sentinel guard in scripts/test-all.sh (K1, T3).

Each case runs a deliberate child through `test-all.sh --guard -- <cmd>`, which sets up the sentinel
tree, runs only that child and then checks the tree, without running the whole suite. The failing cases are
paired with a child that touches nothing, so the guard is shown to catch real changes and not to fail
for every run. The child environments here are built from scratch, never from os.environ.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test-all.sh")
PATH = os.environ.get("PATH", "/usr/bin:/bin")
HOME = os.environ.get("HOME", "/")


def tree_hash(root):
    """Sorted (relative path, content hash) pairs for a tree: what must not change."""
    out = []
    for base, dirs, files in os.walk(root):
        for name in sorted(dirs + files):
            full = os.path.join(base, name)
            digest = "dir"
            if os.path.isfile(full):
                with open(full, "rb") as f:
                    digest = hashlib.sha256(f.read()).hexdigest()
            out.append((os.path.relpath(full, root), digest))
    return sorted(out)


class SentinelGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="test-all-selftest.")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def guard(self, code, extra_env=None, timeout=120):
        """Run python `code` as the child under the guard; returns the finished process (text output)."""
        env = {"PATH": PATH, "HOME": HOME, "TMPDIR": self.tmp}
        env.update(extra_env or {})
        return subprocess.run(
            ["bash", SCRIPT, "--guard", "--", sys.executable, "-c", code],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=timeout,
        )

    def assertTripped(self, proc, *paths_endings):
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        for ending in paths_endings:
            self.assertTrue(
                any(line.startswith("SENTINEL") and line.rstrip().endswith(ending) for line in proc.stdout.splitlines()),
                "no SENTINEL line naming ...%s in:\n%s" % (ending, proc.stdout),
            )

    # -- a clean child --------------------------------------------------------------------------------

    def test_a_child_that_touches_nothing_passes(self):
        proc = self.guard("pass")
        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertNotIn("SENTINEL", proc.stdout)
        # a passing run leaves nothing in the invoking TMPDIR
        self.assertEqual(os.listdir(self.tmp), [])

    def test_a_failing_child_fails_the_guard(self):
        self.assertNotEqual(self.guard("raise SystemExit(3)").returncode, 0)

    # -- changes the guard must catch ----------------------------------------------------------------

    def test_a_history_entry_appended_to_the_sentinel_run_json_is_caught(self):
        code = (
            "import json, os\n"
            "p = os.path.join(os.environ['BORK_RUN_DIR'], 'run.json')\n"
            "r = json.load(open(p))\n"
            "r['history'].append({'at': 'x', 'state': 'done', 'note': 'touched'})\n"
            "json.dump(r, open(p, 'w'), indent=2)\n"
        )
        self.assertTripped(self.guard(code), "/sentinel-run/run.json")

    def test_a_new_file_in_the_runs_home_is_caught(self):
        code = "import os\nopen(os.path.join(os.environ['BORK_RUNS_HOME'], 'new-file.txt'), 'w').write('x')\n"
        self.assertTripped(self.guard(code), "/runs-home/new-file.txt")

    def test_a_new_file_in_each_other_pointer_tree_is_caught(self):
        for var, tree in (("AGENT_HANDOFFS_DIR", "agent-handoffs"), ("ORCHESTRATOR_HOME", "orchestrator"), ("BORK_REPO_RULES_DIR", "repo-rules")):
            code = "import os\nopen(os.path.join(os.environ[%r], 'stray.txt'), 'w').write('x')\n" % var
            self.assertTripped(self.guard(code), "/%s/stray.txt" % tree)

    def test_same_length_rewrite_with_the_mtime_restored_is_caught(self):
        code = (
            "import os\n"
            "p = os.environ['OFFLOAD_HANDOFF']\n"
            "st = os.stat(p)\n"
            "data = open(p, 'rb').read()\n"
            "open(p, 'wb').write(data.replace(b'sentinel', b'SENTINEL'))\n"
            "os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))\n"
            "assert os.stat(p).st_size == st.st_size\n"
        )
        self.assertTripped(self.guard(code), "/handoffs/h.md")

    def test_deleting_the_handoff_sentinel_is_caught(self):
        self.assertTripped(self.guard("import os\nos.remove(os.environ['OFFLOAD_HANDOFF'])\n"), "/handoffs/h.md")

    def test_a_file_in_the_suite_tmpdir_that_names_a_sentinel_path_is_caught(self):
        code = "import os\nopen(os.path.join(os.environ['TMPDIR'], 'leak.txt'), 'w').write(os.environ['BORK_RUN_DIR'])\n"
        proc = self.guard(code)
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertTrue(any("SENTINEL LEAK" in l and "leak.txt" in l for l in proc.stdout.splitlines()), proc.stdout)

    def test_a_failed_run_names_the_directory_it_kept(self):
        proc = self.guard("import os\nos.remove(os.environ['OFFLOAD_HANDOFF'])\n")
        kept = [d for d in os.listdir(self.tmp)]
        self.assertEqual(len(kept), 1)
        self.assertIn(os.path.join(self.tmp, kept[0]), proc.stdout.replace("/private", ""))

    # -- setup -----------------------------------------------------------------------------------------

    def test_a_sentinel_that_is_not_running_is_refused_before_the_child_runs(self):
        marker = os.path.join(self.tmp, "ran")
        proc = self.guard("open(%r, 'w').write('x')" % marker, {"TEST_ALL_SENTINEL_STATE": "done"})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not running", proc.stdout)
        self.assertFalse(os.path.exists(marker), "the child must not run against a dead sentinel")

    def test_unknown_arguments_exit_2(self):
        proc = subprocess.run(["bash", SCRIPT, "--nope"], env={"PATH": PATH, "HOME": HOME, "TMPDIR": self.tmp},
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=60)
        self.assertEqual(proc.returncode, 2)

    # -- the child environment -----------------------------------------------------------------------

    def test_the_invoking_pointers_and_secrets_never_reach_the_child_and_stay_untouched(self):
        hostile_run = os.path.join(self.tmp, "hostile-run")
        hostile_home = os.path.join(self.tmp, "hostile-runs-home")
        os.makedirs(hostile_run)
        os.makedirs(hostile_home)
        with open(os.path.join(hostile_run, "run.json"), "w") as f:
            json.dump({"schema": 1, "state": "running", "history": []}, f)
        before = tree_hash(self.tmp)
        probe = os.path.join(self.tmp, "..", os.path.basename(self.tmp) + ".probe.json")
        probe = os.path.abspath(probe)
        self.addCleanup(lambda: os.path.exists(probe) and os.remove(probe))
        canary = "K1_CANARY_%s" % os.urandom(4).hex()
        code = (
            "import json, os\n"
            "keys = ['BORK_RUN_DIR', 'BORK_RUN_ID', 'BORK_RUNS_HOME', 'OFFLOAD_HANDOFF', 'OFFLOAD_SESSION_ID', 'AGENT_HANDOFFS_DIR', 'ORCHESTRATOR_HOME', 'BORK_REPO_RULES_DIR', 'TMPDIR', 'HOME']\n"
            "run = json.load(open(os.path.join(os.environ['BORK_RUN_DIR'], 'run.json')))\n"
            "json.dump({'names': sorted(os.environ), 'values': {k: os.environ.get(k) for k in keys}, 'run': {'schema': run['schema'], 'state': run['state']}}, open(%r, 'w'))\n"
        ) % probe
        extra = {
            canary: "1", "ANTHROPIC_API_KEY": "hostile", "OPENAI_API_KEY": "hostile", "CLAUDE_CODE_SESSION_ID": "hostile",
            "BORK_RUN_DIR": hostile_run, "BORK_RUN_ID": "hostile-id", "BORK_RUNS_HOME": hostile_home,
            "OFFLOAD_HANDOFF": "/hostile/h.md", "OFFLOAD_SESSION_ID": "hostile-session",
            "AGENT_HANDOFFS_DIR": "/hostile/ah", "ORCHESTRATOR_HOME": "/hostile/orch", "BORK_REPO_RULES_DIR": "/hostile/rules",
        }
        proc = self.guard(code, extra)
        self.assertEqual(proc.returncode, 0, proc.stdout)
        with open(probe) as f:
            seen = json.load(f)
        self.assertNotIn(canary, seen["names"])
        for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_SESSION_ID"):
            self.assertNotIn(name, seen["names"])
        self.assertEqual(seen["run"], {"schema": 1, "state": "running"})
        v = seen["values"]
        sentinel_root = os.path.dirname(v["OFFLOAD_HANDOFF"])
        sentinel_root = os.path.dirname(sentinel_root)
        for name in ("BORK_RUN_DIR", "BORK_RUNS_HOME", "OFFLOAD_HANDOFF", "AGENT_HANDOFFS_DIR", "ORCHESTRATOR_HOME", "BORK_REPO_RULES_DIR"):
            self.assertTrue(v[name].startswith(sentinel_root + os.sep), "%s=%s is not under the sentinel root %s" % (name, v[name], sentinel_root))
            self.assertNotIn("hostile", v[name])
        self.assertEqual(v["BORK_RUN_ID"], os.path.basename(v["BORK_RUN_DIR"]))
        self.assertNotEqual(v["OFFLOAD_SESSION_ID"], "hostile-session")
        self.assertNotEqual(os.path.realpath(v["TMPDIR"]), os.path.realpath(self.tmp), "the child gets a fresh TMPDIR")
        self.assertEqual(v["HOME"], HOME, "HOME stays real")
        # the invoking pointers' trees were not touched
        after = [(p, h) for p, h in tree_hash(self.tmp) if not p.endswith(".probe.json")]
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
