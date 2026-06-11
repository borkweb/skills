#!/usr/bin/env node
// Cross-platform installer: copies mailbox.mjs and budget-hook.mjs to the mailbox
// dir on a stable path, then prints the reinit directive and the settings.json
// hook snippet with absolute paths already substituted (forward slashes so the
// commands work on every OS — Node accepts / on Windows too).
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs');
mkdirSync(DIR, { recursive: true });

const mailbox = join(DIR, 'mailbox.mjs');
const hook = join(DIR, 'budget-hook.mjs');
copyFileSync(join(HERE, 'mailbox.mjs'), mailbox);
copyFileSync(join(HERE, 'budget-hook.mjs'), hook);

const mb = mailbox.replace(/\\/g, '/');
const hk = hook.replace(/\\/g, '/');

console.log(`Installed:\n  ${mb}\n  ${hk}\n(Re-run this installer after updating the skill to refresh them.)\n`);

console.log(`Add this block to your shared AGENTS.md / CLAUDE.md (the symlinked instruction file):

----------------------------------------------------------------------
## Session handoff reinit
At the start of every session, run: \`node "${mb}" reinit\`
- Output \`NONE\` → do nothing.
- Output ending in \`CONSUME_TOKEN=<t>\` → the text above it is your prior-session briefing; treat it as context, then run \`node "${mb}" consume <t>\`.
- Output starting with \`MENU\` → show the numbered list to the user, ask which to load, then \`node "${mb}" show <token>\` for the chosen entry, treat it as context, and \`node "${mb}" consume <token>\`.
----------------------------------------------------------------------
`);

const hookConfig = {
  hooks: {
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: `node "${hk}"` }] },
    ],
  },
};

console.log(`Add this to your Claude Code settings.json (proactive budget nudge — Claude Code only):

----------------------------------------------------------------------
${JSON.stringify(hookConfig, null, 2)}
----------------------------------------------------------------------
Tune via env: BUDGET_HOOK_THRESHOLD_BYTES (default 1500000), BUDGET_HOOK_BAND_BYTES (default 750000).
`);
