#!/usr/bin/env node
// Deterministic builder-harness resolver for the offload/complete skills.
// Reads the shared borkweb-skills config (firstmate-style dispatch rules) and
// resolves one rule's ordered `use` chain into launchable candidates: profiles
// whose binary is missing are skipped, and harnesses whose quota-axi general
// windows are effectively exhausted (< 5% remaining) are demoted below fresh
// ones — order within each group stays the config's preference order.
//
//   node harness.mjs select [--rule N] [--quota-json <file>] [--plain]
//       JSON {chosen, candidates, notes} on stdout; --plain emits one
//       tab-separated line per candidate (harness model effort permissionMode
//       command, '-' = unset) with notes on stderr for shell consumers.
//   node harness.mjs init --use <harness[:model[:effort]],...>
//       Write the config's single default dispatch rule (replaces existing
//       dispatch.rules; every other top-level key is preserved). Prints path.
//   node harness.mjs config
//       Print the config path and contents.
//
// Config path: $BORKWEB_SKILLS_CONFIG or ~/.borkweb-skills/config.json.
// Exit codes: 0 ok · 2 usage/bad input · 3 missing config/rules (the skills'
// prompt-the-user signal) · 4 no usable profile.
// Quota data can only DEMOTE candidates — every quota failure mode (missing
// quota-axi, nonzero exit, junk JSON) degrades to preference order with a note.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const KNOWN = ['codex', 'claude', 'opencode', 'pi', 'grok'];
// General (non-model) quota windows per provider, as quota-axi reports them.
const GENERAL_WINDOWS = { claude: ['five_hour', 'seven_day'], codex: ['five_hour', 'weekly'] };
const EXHAUSTED_BELOW_PCT = 5;
const DEFAULT_WHEN =
  'builder dispatch from offload/complete: implementation slices whose deliverable is code committed to the repo';

const configPath = () =>
  process.env.BORKWEB_SKILLS_CONFIG || join(homedir(), '.borkweb-skills', 'config.json');

function die(code, msg) { process.stderr.write(msg.replace(/\n*$/, '\n')); process.exit(code); }

function flagValue(rest, flag) {
  const i = rest.indexOf(flag);
  if (i !== -1) return rest[i + 1];
  const pref = rest.find((a) => a.startsWith(`${flag}=`));
  return pref ? pref.slice(flag.length + 1) : undefined;
}

function readConfig() {
  const p = configPath();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { die(2, `harness: cannot parse ${p}: ${e.message}`); }
}

function onPath(bin) {
  return (process.env.PATH || '').split(delimiter)
    .some((d) => d && existsSync(join(d, bin)));
}

// Accept a single profile object or an array; drop entries with no harness/command.
function normalizeProfiles(use) {
  const arr = Array.isArray(use) ? use : (use && typeof use === 'object' ? [use] : []);
  return arr.filter((p) => p && typeof p === 'object' && (p.harness || p.command));
}

function quotaData(fixture, notes) {
  let raw;
  if (fixture) {
    try { raw = readFileSync(fixture, 'utf8'); }
    catch { notes.push('quota fixture unreadable; using preference order'); return null; }
  } else {
    try {
      raw = execFileSync('quota-axi', ['--json'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { notes.push('quota-axi unavailable; using preference order'); return null; }
  }
  try {
    const q = JSON.parse(raw);
    if (!q || !Array.isArray(q.providers)) throw new Error('no providers array');
    return q;
  } catch { notes.push('quota-axi output unparseable; using preference order'); return null; }
}

// Min percentRemaining across a harness's general windows, or null when the
// provider/windows are absent from the quota report (unknown = available).
function quotaMin(quota, harness) {
  const ids = GENERAL_WINDOWS[harness];
  if (!quota || !ids) return null;
  const provider = quota.providers.find((p) => p && p.provider === harness);
  const pcts = (provider?.windows || [])
    .filter((w) => w && ids.includes(w.id) && (w.kind ?? '') !== 'model'
      && typeof w.percentRemaining === 'number')
    .map((w) => w.percentRemaining);
  return pcts.length ? Math.min(...pcts) : null;
}

function select(rest) {
  const notes = [];
  const cfg = readConfig();
  const rules = cfg?.dispatch?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    die(3, `missing-config: no dispatch rules at ${configPath()}\n` +
      'The invoking skill should prompt the user for a harness chain, then run: ' +
      'harness.mjs init --use <harness[,harness...]>');
  }
  const ruleIdx = Number(flagValue(rest, '--rule') ?? 0);
  const rule = rules[ruleIdx];
  if (!rule) die(2, `harness: no rule ${ruleIdx} (config has ${rules.length})`);
  const profiles = normalizeProfiles(rule.use);
  if (!profiles.length) die(2, `harness: rule ${ruleIdx} has no usable \`use\` profiles`);

  const quota = quotaData(flagValue(rest, '--quota-json'), notes);
  const annotated = [];
  for (const p of profiles) {
    if (!p.command && !onPath(p.harness)) {
      notes.push(`skipped ${p.harness}: not on PATH`);
      continue;
    }
    const min = p.command ? null : quotaMin(quota, p.harness);
    const exhausted = min != null && min < EXHAUSTED_BELOW_PCT;
    if (exhausted) {
      notes.push(`demoted ${p.harness}: quota ${min}% remaining (< ${EXHAUSTED_BELOW_PCT}%)`);
    }
    annotated.push({ ...p, quotaMin: min, exhausted });
  }
  const ordered = [
    ...annotated.filter((c) => !c.exhausted),
    ...annotated.filter((c) => c.exhausted),
  ];
  if (!ordered.length) {
    die(4, 'no-usable-profile: no configured harness is launchable ' +
      `(${profiles.map((p) => p.harness || '(command)').join(', ')})`);
  }
  if (rest.includes('--plain')) {
    for (const c of ordered) {
      process.stdout.write([
        c.harness ?? '-', c.model ?? '-', c.effort ?? '-',
        c.permissionMode ?? '-', c.command ?? '-',
      ].join('\t') + '\n');
    }
    for (const n of notes) process.stderr.write(`note: ${n}\n`);
  } else {
    process.stdout.write(JSON.stringify(
      { chosen: ordered[0], candidates: ordered, notes }, null, 2,
    ) + '\n');
  }
}

function init(rest) {
  const spec = flagValue(rest, '--use');
  if (!spec) die(2, 'usage: harness.mjs init --use <harness[:model[:effort]],...>');
  const use = spec.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const [harness, model, effort] = item.split(':');
    if (!KNOWN.includes(harness)) {
      die(2, `harness: unknown harness '${harness}' (known: ${KNOWN.join(', ')}). ` +
        'For anything else, add a profile with a raw `command` template to the config by hand.');
    }
    const p = { harness };
    if (model) p.model = model;
    if (effort) p.effort = effort;
    return p;
  });
  if (!use.length) die(2, 'harness: --use resolved to no profiles');
  const p = configPath();
  const cfg = readConfig() || {};
  cfg.dispatch = cfg.dispatch || {};
  cfg.dispatch.rules = [{
    when: DEFAULT_WHEN,
    use,
    why: `recorded from user answer ${new Date().toISOString().slice(0, 10)}`,
  }];
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  process.stdout.write(p + '\n');
}

function showConfig() {
  const p = configPath();
  if (!existsSync(p)) die(3, `missing-config: ${p} does not exist`);
  process.stdout.write(`${p}\n${readFileSync(p, 'utf8')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'select': select(rest); break;
    case 'init':   init(rest); break;
    case 'config': showConfig(); break;
    default:
      process.stderr.write('usage: harness.mjs {select|init|config} ...\n');
      process.exit(2);
  }
}
