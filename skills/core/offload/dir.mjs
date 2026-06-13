// dir.mjs — isolate offload handoffs under <base>/offload, then re-export the
// session-budget mailbox helpers. mailbox.mjs computes its DIR from
// AGENT_HANDOFFS_DIR at import time, so we set that env var BEFORE importing it.
// A dynamic import() is required (not `export *`): static imports are hoisted and
// would run before this module body mutates the env. Dynamic import runs at the
// await, after the mutation, so mailbox.mjs reads the isolated offload dir.
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs');
process.env.AGENT_HANDOFFS_DIR = join(BASE, 'offload');

// NOTE: dir.mjs must be the first importer of mailbox.mjs in its process. If
// mailbox.mjs were already cached (some host importing both session-budget and
// offload in one process), import() returns the cached module with the original
// DIR. Hook/CLI usage is a fresh subprocess each time, so this holds in practice.
const mb = await import('../session-budget/mailbox.mjs');

export const DIR = mb.DIR;
export const hash = mb.hash;
export const tokenOf = mb.tokenOf;
export const fileFor = mb.fileFor;
export const listFiles = mb.listFiles;
export const field = mb.field;
export const age = mb.age;
export const prune = mb.prune;
