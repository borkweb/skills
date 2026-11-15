# run-env.sh — sourced by dispatch-slice.sh and dispatch.sh. One liveness predicate for the
# BORK_RUN_DIR pointer, so the dispatcher's run-dir fallback and the builder's launch env agree
# (stop-hook.mjs envRunDir() is the JS twin; test_k1_env.mjs checks that they agree on every row).
#
# env_run_dir_live: succeeds while $BORK_RUN_DIR names a live run: a directory that exists whose
# run.json (when there is one) is not done or failed. A run.json that is missing or unreadable
# counts as live; a missing directory does not.
env_run_dir_live() {
  [ -n "${BORK_RUN_DIR:-}" ] && [ -d "$BORK_RUN_DIR" ] || return 1
  node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1]+"/run.json","utf8")).state;process.exit(s==="done"||s==="failed"?1:0)}catch{}' "$BORK_RUN_DIR"
}
