# Codex as host

Read this file when Step 0 finds you are **not** in Claude Code — no `Agent`
tool and no `AskUserQuestion` (Codex, or a restricted session). You are still
the host. The peer is Claude.

## Checkpoints

Make every checkpoint a plain numbered question in chat, and wait for the
answer. Step 1 is still one message with all its questions, not several
rounds.

## Step 0: Prefetch

Codex has no `run_in_background`. Launch the prefetch commands with `nohup sh
-c '…; echo $? > <scratchpad>/prefetch.exit' > /dev/null 2>&1 &`, like the peer
below. Before Step 2, wait for `prefetch.exit` with the same polling loop as the
peer join.

## Step 3b: Host pass

Invoke `bork:review` inline, with the 3b contract as a preamble. If Codex
multi-agent is enabled (`spawn_agent`), you may dispatch it there instead, with
the same contract. Use the native runtime's supported dispatch and result
mechanism. Do not assume Claude agent naming rules apply.

## Step 3a: Launch the Claude peer

Restrict the toolset so the peer stays read-only:

```bash
nohup sh -c '
  cd <review-dir> || exit 1
  claude -p "$(cat <scratchpad>/peer-brief.txt)" \
    --add-dir <review-dir> \
    --allowedTools "Read,Grep,Glob,Bash(git:*),Skill" \
    < /dev/null > <scratchpad>/peer.out 2> <scratchpad>/peer.err
  echo $? > <scratchpad>/peer.exit
' > /dev/null 2>&1 &
```

`--allowedTools` is what keeps the peer read-only. Don't add
`--permission-mode plan` as well, or it may try to exit plan mode instead of
returning findings. `< /dev/null` stops the detached job from waiting on an
inherited stdin.

## Step 3c: Join with a ceiling

Codex gets no completion notice for a detached job, so poll the sentinel. The
`peer.exit` file appears only after `peer.out` is complete. Never poll
`peer.out` itself; you'll read a half-written file.

```bash
for i in $(seq 1 120); do
  [ -f <scratchpad>/peer.exit ] && break
  sleep 5
done
cat <scratchpad>/peer.exit 2>/dev/null || echo "TIMEOUT"
```

Ten minutes is the ceiling. On timeout, follow the peer-failure rules in
[edge-cases.md](edge-cases.md). Wait on pending CI the same way: poll the check
runs every 30 seconds up to the same ceiling.
