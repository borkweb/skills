# Launch options

Read this when the user is leaving a running fleet (closing the laptop, clearing, walking away), when a slice genuinely needs an MCP tool, or when `harness.mjs select` exits 3. The first two extend [Dispatch](SKILL.md#dispatch); the third extends *Resolve the builder harness*.

**Leaving the run unattended.** The `NEXT` bridge is a background task of this
session and dies with it. When the user is leaving (closing the laptop, clearing,
walking away), hand the fleet to detached wakes instead: run
`bash "<core>/complete/unattended.sh" "$PWD"` as the last action before the
session closes, or pass `--unattended` to `dispatch-slice.sh` so each new slice
arms a detached bridge + `architect-wake.sh` chain directly. When a bridge fires,
the chain resumes this architect session headlessly (`claude -p --resume`) with
the `WAITER:` line and board as the prompt, under `--permission-mode auto`
(`OFFLOAD_WAKE_PERMISSIONS=bypass` for the builders' posture; say so plainly when
you choose it). Claude architects only. While the interactive session is still
open the resume is refused and logged, so do not keep working after handing off;
on return, read the `.wake.log` beside each handoff and the board.

**Lean builder boot.** A claude builder launches with no MCP servers
(`OFFLOAD_BUILDER_MCP=none`, the default): it needs node and the skills, not the
machine's MCP fleet or its tool schemas on every turn. Set
`OFFLOAD_BUILDER_MCP=inherit` for the user's full MCP configuration, or a path to
load exactly that `--mcp-config` file, when a slice genuinely needs an MCP tool.

**Builder credentials.** Every builder, headless or in a tab, starts without the
exported variables whose names hold a secret word as a whole `_`-separated part
(`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`,
`CREDENTIALS` and their close forms), so `GITHUB_PERSONAL_ACCESS_TOKEN` and
`AWS_SECRET_ACCESS_KEY` never reach a builder whose gates are off. It keeps the
model-provider keys a harness signs in with (`ANTHROPIC_*`, `CLAUDE_*`,
`OPENAI_*`, `CODEX_*`, `XAI_*`, `GROK_*`, `OPENROUTER_*`, `GEMINI_*`) and
`SSH_AUTH_SOCK`, because builders sign their commits. When a frozen gate needs
a secret, pass its name in `OFFLOAD_BUILDER_PASS_ENV` (space-separated) and name
it in the slice spec. `OFFLOAD_BUILDER_ENV=inherit` turns the scrub off; say so
plainly when you use it. The scrub covers environment variables only: a tool
that reads its own keychain or config file (`gh`, cloud CLIs) still works.

## No builder config (exit 3)

**Exit 3 (`missing-config`) means the config doesn't exist yet.** Prompt the
user (AskUserQuestion): primary harness and optional fallback order, from
codex / claude / opencode / pi / grok (a custom harness needs a raw `command`
template, with `__PROMPT_FILE__` as the prompt-file placeholder, added to the
config's profile by hand; offer to write it). Then persist the answer:
`node "<…>/harness.mjs" init --use <primary,fallback,...>` and re-run `select`.
