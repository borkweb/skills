// test_harness.mjs — config resolution, quota demotion, init round-trip.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, 'harness.mjs');
const BOX = mkdtempSync(join(tmpdir(), 'ofl-h-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

// Stub binaries so PATH checks are deterministic regardless of the host machine.
const BIN = join(BOX, 'bin');
mkdirSync(BIN, { recursive: true });
const stub = (name) => {
  const p = join(BIN, name);
  writeFileSync(p, '#!/usr/bin/env bash\n');
  chmodSync(p, 0o755);
};
['codex', 'claude', 'opencode'].forEach(stub); // pi/grok deliberately absent
// The real quota-axi may live next to the node binary (kept on PATH below), so
// shadow it with a failing stub: quota tests inject data via --quota-json only.
writeFileSync(join(BIN, 'quota-axi'), '#!/usr/bin/env bash\nexit 1\n');
chmodSync(join(BIN, 'quota-axi'), 0o755);

// node must stay reachable for execFileSync('node', ...) under the stripped PATH.
const NODE_DIR = dirname(process.execPath);

const CONFIG = join(BOX, 'config.json');
const writeConfig = (use) => writeFileSync(CONFIG, JSON.stringify({
  keepMe: true,
  dispatch: { rules: [{ when: 'builder dispatch', use, why: 'test' }] },
}));

const run = (args, { env = {}, ok = true } = {}) => {
  try {
    const stdout = execFileSync('node', [HARNESS, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${BIN}:${NODE_DIR}`, BORKWEB_SKILLS_CONFIG: CONFIG, ...env },
    });
    return { status: 0, stdout };
  } catch (e) {
    if (ok) throw e;
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

test('select with no config file exits 3 with missing-config', () => {
  rmSync(CONFIG, { force: true });
  const r = run(['select'], { ok: false });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /missing-config/);
});

test('select with empty rules exits 3', () => {
  writeFileSync(CONFIG, JSON.stringify({ dispatch: { rules: [] } }));
  const r = run(['select'], { ok: false });
  assert.equal(r.status, 3);
});

test('select returns profiles in config order when quota is unavailable', () => {
  writeConfig([{ harness: 'codex' }, { harness: 'claude' }]);
  const out = JSON.parse(run(['select']).stdout);
  assert.equal(out.chosen.harness, 'codex');
  assert.deepEqual(out.candidates.map((c) => c.harness), ['codex', 'claude']);
  // quota-axi is not on the stub PATH -> degrade note, no failure.
  assert.ok(out.notes.some((n) => /quota-axi unavailable/.test(n)));
});

test('select skips harnesses missing from PATH', () => {
  writeConfig([{ harness: 'pi' }, { harness: 'claude' }]);
  const out = JSON.parse(run(['select']).stdout);
  assert.equal(out.chosen.harness, 'claude');
  assert.ok(out.notes.some((n) => /skipped pi/.test(n)));
});

test('select exits 4 when every profile is unlaunchable', () => {
  writeConfig([{ harness: 'pi' }, { harness: 'grok' }]);
  const r = run(['select'], { ok: false });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /no-usable-profile/);
});

test('quota exhaustion demotes but does not drop a harness', () => {
  writeConfig([{ harness: 'codex' }, { harness: 'claude' }]);
  const quota = join(BOX, 'quota.json');
  writeFileSync(quota, JSON.stringify({
    providers: [
      { provider: 'codex', windows: [
        { id: 'five_hour', percentRemaining: 3 },
        { id: 'weekly', percentRemaining: 40 },
      ] },
      { provider: 'claude', windows: [
        { id: 'five_hour', percentRemaining: 80 },
        { id: 'seven_day', percentRemaining: 60 },
      ] },
    ],
  }));
  const out = JSON.parse(run(['select', '--quota-json', quota]).stdout);
  assert.deepEqual(out.candidates.map((c) => c.harness), ['claude', 'codex']);
  assert.equal(out.candidates[1].exhausted, true);
  assert.equal(out.candidates[1].quotaMin, 3);
});

test('model-kind windows and unknown providers are ignored for exhaustion', () => {
  writeConfig([{ harness: 'codex' }, { harness: 'opencode' }]);
  const quota = join(BOX, 'quota.json');
  writeFileSync(quota, JSON.stringify({
    providers: [{ provider: 'codex', windows: [
      { id: 'five_hour', percentRemaining: 2, kind: 'model' }, // ignored
      { id: 'weekly', percentRemaining: 50 },
    ] }],
  }));
  const out = JSON.parse(run(['select', '--quota-json', quota]).stdout);
  assert.equal(out.chosen.harness, 'codex');
  assert.equal(out.candidates[0].exhausted, false);
  assert.equal(out.candidates[1].quotaMin, null); // opencode: no quota mapping
});

test('unparseable quota fixture degrades to preference order', () => {
  writeConfig([{ harness: 'codex' }]);
  const quota = join(BOX, 'quota.json');
  writeFileSync(quota, 'not json');
  const out = JSON.parse(run(['select', '--quota-json', quota]).stdout);
  assert.equal(out.chosen.harness, 'codex');
  assert.ok(out.notes.some((n) => /unparseable/.test(n)));
});

test('--plain emits tab-separated candidate lines', () => {
  writeConfig([
    { harness: 'claude', model: 'opus', permissionMode: 'acceptEdits' },
    { harness: 'codex' },
  ]);
  const { stdout } = run(['select', '--plain']);
  const lines = stdout.trim().split('\n');
  assert.equal(lines[0], 'claude\topus\t-\tacceptEdits\t-');
  assert.equal(lines[1], 'codex\t-\t-\t-\t-');
});

test('custom command profiles pass through without a PATH check', () => {
  writeConfig([{ harness: 'mytool', command: 'mytool --yolo "$(cat __PROMPT_FILE__)"' }]);
  const out = JSON.parse(run(['select']).stdout);
  assert.equal(out.chosen.command, 'mytool --yolo "$(cat __PROMPT_FILE__)"');
});

test('init writes a default rule and preserves other top-level keys', () => {
  writeFileSync(CONFIG, JSON.stringify({ keepMe: { nested: 1 } }));
  run(['init', '--use', 'codex,claude:opus']);
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  assert.deepEqual(cfg.keepMe, { nested: 1 });
  assert.equal(cfg.dispatch.rules.length, 1);
  assert.deepEqual(cfg.dispatch.rules[0].use, [
    { harness: 'codex' },
    { harness: 'claude', model: 'opus' },
  ]);
  assert.match(cfg.dispatch.rules[0].when, /builder dispatch/);
});

test('init creates the config directory when absent', () => {
  const fresh = join(BOX, 'deep', 'nested', 'config.json');
  run(['init', '--use', 'codex'], { env: { BORKWEB_SKILLS_CONFIG: fresh } });
  const cfg = JSON.parse(readFileSync(fresh, 'utf8'));
  assert.equal(cfg.dispatch.rules[0].use[0].harness, 'codex');
});

test('init rejects unknown harness names', () => {
  const r = run(['init', '--use', 'codex,vibetool'], { ok: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown harness 'vibetool'/);
});
