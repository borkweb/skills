#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { start, change, inspect, status } from './engine.mjs';
import { writePacket } from './packet.mjs';
import { readRun, recoverLock } from './store.mjs';
import { compile, requireThat, validateContract } from './policy.mjs';

function receipt(state) {
  const recorded = state.history.at(-1);
  const node = state.nodes.find(n => n.id === recorded?.node);
  const decision = (state.decisions ?? []).find(d => d.id === recorded?.decision);
  let scheduling;
  try {
    const current = status(state);
    scheduling = { state: current.state, next: current.next, budgetExhausted: current.budgetExhausted };
    if (!['active', 'complete'].includes(current.state) || current.budgetExhausted) scheduling.attention = {
      changed: current.changed, blocked: current.blocked, evidenceInvalid: current.evidenceInvalid,
      verificationStale: current.verificationStale, decisions: current.decisions,
    };
  } catch (error) {
    // The mutation is already durable. Preserve its receipt; never invite replay
    // by presenting a post-commit inspection failure as a failed mutation.
    scheduling = { state: 'inspection-required', next: [], inspectionError: error.message };
  }
  return { runId: state.runId, runDir: state.runDir, revision: state.revision, owner: state.owner,
    snapshot: { digest: state.snapshot.digest, entries: state.snapshot.entries }, recorded,
    nodeState: node?.state ?? null, attempt: node?.attempts.at(-1) ?? null, decision: decision ?? null, ...scheduling };
}

export function main(argv) {
  const [command, ...args] = argv; const options = {};
  if (!command || ['help', '--help', '-h'].includes(command)) return {
    usage: 'node /absolute/path/scripts/do/cli.mjs COMMAND --key value',
    commands: {
      plan: '--input CONTRACT.json (read-only validation and graph)',
      start: '--input CONTRACT.json --owner CONTROLLER_ID [--root PRIVATE_STATE_DIR]',
      status: '--run ABSOLUTE_RUN_DIR', next: '--run ABSOLUTE_RUN_DIR (same as status)',
      show: '--run ABSOLUTE_RUN_DIR (full journal-derived state)',
      packet: '--run DIR --node NODE --attempt ATTEMPT --input CONTEXT.json --out NEW_PRIVATE_FILE (draft only; review then brief)',
      'question | decide | reopen-decision | claim | claim-host | brief | attach | result | recover-result | retry | correct | invalidate | replan | cancel | reconcile | adopt': '--run DIR --owner ID --revision INTEGER --input PAYLOAD.json',
      'recover-lock': '--run DIR (only a verified dead local writer PID)',
    },
    note: 'The CLI never launches tools or agents. The host executes returned assignments under runtime permissions. See skills/core/do/references/runner.md for contracts and host protocol.',
  };
  const allowed = {
    plan: ['input'], start: ['input', 'owner', 'root'], status: ['run'], next: ['run'], show: ['run'], packet: ['run', 'node', 'attempt', 'input', 'out'], 'recover-lock': ['run'],
  };
  const mutations = ['question', 'decide', 'reopen-decision', 'claim', 'claim-host', 'brief', 'attach', 'result', 'recover-result', 'retry', 'correct', 'invalidate', 'replan', 'cancel', 'reconcile', 'adopt'];
  const keys = allowed[command] ?? (mutations.includes(command) ? ['run', 'owner', 'revision', 'input'] : null);
  requireThat(keys, `unknown command ${command}`);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    requireThat(args[i]?.startsWith('--') && keys.includes(key) && !(key in options) && args[i + 1] !== undefined, `invalid option ${args[i]}`);
    options[key] = args[i + 1];
  }
  const json = () => JSON.parse(readFileSync(options.input, 'utf8'));
  if (command === 'plan') { const contract = validateContract(json()); return { contract, nodes: compile(contract) }; }
  if (command === 'start') return receipt(start(json(), options.owner, options.root));
  requireThat(options.run?.startsWith('/'), '--run must be an absolute path');
  if (command === 'show') return readRun(options.run).state;
  if (command === 'packet') return writePacket(readRun(options.run).state, options.node, options.attempt, json(), options.out);
  if (['status', 'next'].includes(command)) return inspect(options.run);
  if (command === 'recover-lock') return recoverLock(options.run);
  requireThat(/^\d+$/.test(options.revision ?? ''), '--revision is required and must be an integer');
  return receipt(change(options.run, options.owner, Number(options.revision), command, json()));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
