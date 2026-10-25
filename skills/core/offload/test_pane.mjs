// test_pane.mjs — verifyPane proves a recorded pane came from dispatch.sh.
//
// A tab's label is not part of that proof any more: anyone may rename a herdr
// tab. With a handoff, the proof is the `<handoff>.pane` sidecar dispatch.sh
// writes (frontend, pane and tab as whole lines) plus a tab holding one pane.
// Without a handoff, the label rule is the only proof and must not change.
//
// herdr is replaced by a stub placed first on PATH, so no case can reach the
// real CLI. tabInfo() caches per tab id for the life of the process, so every
// case builds its own tab id.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import test from 'node:test';
import { BUILDER_TAB_LABEL, UNMANAGED_PANE_CONSEQUENCE, verifyPane } from './pane.mjs';

const BOX = mkdtempSync(join(tmpdir(), 'pane-'));
process.on('exit', () => rmSync(BOX, { recursive: true, force: true }));

// Same JSON shapes the ledger tests' fake prints, which come from real herdr.
const FAKEBIN = join(BOX, 'fakebin');
const EMPTYBIN = join(BOX, 'emptybin');
mkdirSync(FAKEBIN);
mkdirSync(EMPTYBIN);
writeFileSync(join(FAKEBIN, 'herdr'), `#!/usr/bin/env bash
# FAKE_PANE_TAB="pane=tab;pane=tab"   FAKE_TAB_INFO="tab=label:pane_count;..."
lookup() { local kv k; for kv in \${1//;/ }; do k="\${kv%%=*}"; [ "$k" = "$2" ] && { printf '%s' "\${kv#*=}"; return 0; }; done; return 1; }
case "$1 $2" in
  "pane get")
    t=$(lookup "$FAKE_PANE_TAB" "$3") || { echo "no such pane" >&2; exit 1; }
    printf '{"result":{"pane":{"pane_id":"%s","tab_id":"%s"}},"type":"pane_info"}\\n' "$3" "$t" ;;
  "tab get")
    v=$(lookup "$FAKE_TAB_INFO" "$3") || { echo "no such tab" >&2; exit 1; }
    printf '{"result":{"tab":{"tab_id":"%s","label":"%s","pane_count":%s}},"type":"tab_info"}\\n' "$3" "\${v%%:*}" "\${v##*:}" ;;
  *) exit 2 ;;
esac
`);
chmodSync(join(FAKEBIN, 'herdr'), 0o755);

const ORIGINAL_PATH = process.env.PATH;
function useHerdr(env) {
  process.env.HERDR_ENV = '1';
  process.env.PATH = `${FAKEBIN}:${ORIGINAL_PATH}`;
  process.env.FAKE_PANE_TAB = env.panes;
  process.env.FAKE_TAB_INFO = env.tabs;
}
function noHerdrCli() {
  process.env.HERDR_ENV = '1';
  process.env.PATH = EMPTYBIN;
}
function outsideHerdr() {
  delete process.env.HERDR_ENV;
}
test.afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.HERDR_ENV;
  delete process.env.FAKE_PANE_TAB;
  delete process.env.FAKE_TAB_INFO;
});

let n = 0;
// A pane inside a tab nobody else has used. `count` may be 'null' for a tab
// whose pane_count herdr did not report.
function scene({ pane = `w1:p${100 + ++n}`, label = 'David', count = 1 } = {}) {
  const tab = `w1:t${n}`;
  useHerdr({ panes: `${pane}=${tab}`, tabs: `${tab}=${label}:${count}` });
  return { pane, tab, handoff: join(BOX, `h${n}.md`) };
}

// dispatch.sh: printf 'frontend=%s\npane=%s\ntab=%s\nharness=%s\n'
const sidecarText = (frontend, pane, tab, harness = 'claude') =>
  `frontend=${frontend}\npane=${pane}\ntab=${tab}\nharness=${harness}\n`;
const writeSidecar = (handoff, text) => writeFileSync(`${handoff}.pane`, text);
const KEYS = ['label', 'paneCount', 'reason', 'skipped', 'tabId', 'verified'];

test('BUILDER_TAB_LABEL stays "builder" and the consequence text is kept', () => {
  assert.equal(BUILDER_TAB_LABEL, 'builder');
  assert.match(UNMANAGED_PANE_CONSEQUENCE, /wait bridge can never fire/);
});

// --- renamed tab, with a handoff --------------------------------------------

test('renamed tab with matching sidecar and one pane is verified', () => {
  const s = scene();
  writeSidecar(s.handoff, sidecarText('herdr', s.pane, s.tab));
  const v = verifyPane(s.pane, s.handoff);
  assert.deepEqual(v, { verified: true, skipped: false, reason: '', tabId: s.tab, label: 'David', paneCount: 1 });
});

test('a sidecar without a trailing newline still verifies', () => {
  const s = scene();
  writeSidecar(s.handoff, `frontend=herdr\npane=${s.pane}\ntab=${s.tab}`);
  assert.equal(verifyPane(s.pane, s.handoff).verified, true);
});

test('a relative handoff path resolves to the same sidecar', () => {
  const s = scene();
  writeSidecar(s.handoff, sidecarText('herdr', s.pane, s.tab));
  const cwd = process.cwd();
  process.chdir(BOX);
  try {
    assert.equal(verifyPane(s.pane, `./${s.handoff.split('/').pop()}`).verified, true);
  } finally {
    process.chdir(cwd);
  }
});

test('renamed tab without a usable sidecar is refused, never thrown', () => {
  const marker = 'SIDECAR-MARKER-9f3a';
  const states = {
    'missing file': () => {},
    'empty file': (h) => writeSidecar(h, ''),
    'directory at the sidecar path': (h) => mkdirSync(`${h}.pane`),
    'unreadable file': (h) => { writeSidecar(h, 'x'); chmodSync(`${h}.pane`, 0o000); },
    'fifo at the sidecar path': (h) => execFileSync('mkfifo', [`${h}.pane`]),
    'endless device behind a symlink': (h) => symlinkSync('/dev/zero', `${h}.pane`),
    'binary file': (h, s) => writeSidecar(h, Buffer.concat([Buffer.from(sidecarText('herdr', s.pane, s.tab)), Buffer.from([0, 1, 2, 255])])),
    'one megabyte of garbage after valid lines': (h, s) => writeSidecar(h, sidecarText('herdr', s.pane, s.tab) + `${marker}\n`.repeat(100000)),
    'marker line only': (h) => writeSidecar(h, `${marker}\n`),
  };
  for (const [name, arrange] of Object.entries(states)) {
    const s = scene();
    arrange(s.handoff, s);
    let v;
    assert.doesNotThrow(() => { v = verifyPane(s.pane, s.handoff); }, name);
    assert.equal(v.verified, false, name);
    assert.equal(v.skipped, false, name);
    assert.deepEqual(Object.keys(v).sort(), KEYS, name);
    assert.match(v.reason, /"David"/, `${name}: names the label`);
    assert.match(v.reason, /no dispatch sidecar for this handoff names pane/, name);
    assert.doesNotMatch(v.reason, new RegExp(marker), `${name}: no sidecar content in the reason`);
  }
});

test('handoff values that cannot name a sidecar are refused', () => {
  const s = scene();
  writeSidecar(s.handoff, sidecarText('herdr', s.pane, s.tab));
  for (const bad of [`${s.handoff}/`, `${BOX}/sub/../${s.handoff.split('/').pop()}`, `${s.handoff}\0x`, join(BOX, 'no-such-dir', 'h.md')]) {
    let v;
    assert.doesNotThrow(() => { v = verifyPane(s.pane, bad); }, JSON.stringify(bad));
    assert.equal(v.verified, false, JSON.stringify(bad));
    assert.equal(v.skipped, false, JSON.stringify(bad));
  }
});

test('a sidecar must match the pane, the tab and herdr as whole lines', () => {
  const cases = {
    'other pane': (p, t) => sidecarText('herdr', 'w1:p999', t),
    'pane is a prefix of the sidecar pane': (p, t) => sidecarText('herdr', `${p}8`, t),
    'sidecar pane is a prefix of the pane': (p, t) => sidecarText('herdr', p.slice(0, -1), t),
    'substring line xpane=': (p, t) => `frontend=herdr\nxpane=${p}\ntab=${t}\n`,
    'commented pane line': (p, t) => `frontend=herdr\n# pane=${p}\ntab=${t}\n`,
    'indented pane line': (p, t) => `frontend=herdr\n pane=${p}\ntab=${t}\n`,
    'other tab': (p) => sidecarText('herdr', p, 'w1:t999'),
    'tab line missing': (p) => `frontend=herdr\npane=${p}\nharness=claude\n`,
    'tab is a prefix': (p, t) => sidecarText('herdr', p, `${t}0`),
    'tmux frontend': (p, t) => sidecarText('tmux', p, t),
    'headless frontend': (p, t) => sidecarText('headless', p, t),
    'terminal frontend': (p, t) => sidecarText('terminal', p, t),
    'frontend line missing': (p, t) => `pane=${p}\ntab=${t}\nharness=claude\n`,
    'frontend herdr2': (p, t) => sidecarText('herdr2', p, t),
    'CRLF line endings': (p, t) => sidecarText('herdr', p, t).replace(/\n/g, '\r\n'),
    'one matching and one other pane line': (p, t) => `frontend=herdr\npane=${p}\npane=w1:p999\ntab=${t}\n`,
    'one other and one matching pane line': (p, t) => `frontend=herdr\npane=w1:p999\npane=${p}\ntab=${t}\n`,
    'the same pane line twice': (p, t) => `frontend=herdr\npane=${p}\npane=${p}\ntab=${t}\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const s = scene({ pane: 'w1:p38' });
    writeSidecar(s.handoff, text(s.pane, s.tab));
    const v = verifyPane(s.pane, s.handoff);
    assert.equal(v.verified, false, name);
    assert.equal(v.skipped, false, name);
    assert.match(v.reason, /no dispatch sidecar for this handoff names pane/, name);
  }
});

test('a sidecar written for another pane never verifies this one', () => {
  const s = scene({ pane: 'w1:p3' });
  writeSidecar(s.handoff, sidecarText('herdr', 'w1:p38', s.tab));
  assert.equal(verifyPane(s.pane, s.handoff).verified, false);
});

test('renamed tab holding two panes is refused even with a sidecar', () => {
  const s = scene({ count: 2 });
  writeSidecar(s.handoff, sidecarText('herdr', s.pane, s.tab));
  const v = verifyPane(s.pane, s.handoff);
  assert.equal(v.verified, false);
  assert.equal(v.paneCount, 2);
  assert.match(v.reason, /holds 2 panes/);
});

test('renamed tab with a zero or unreported pane count is refused even with a sidecar', () => {
  for (const count of ['0', 'null']) {
    const s = scene({ count });
    writeSidecar(s.handoff, sidecarText('herdr', s.pane, s.tab));
    const v = verifyPane(s.pane, s.handoff);
    assert.equal(v.verified, false, count);
    assert.match(v.reason, /holds 0 panes/, count);
  }
});

test('a tab still labeled builder verifies by label when the sidecar is missing', () => {
  const s = scene({ label: 'builder' });
  assert.deepEqual(verifyPane(s.pane, s.handoff), { verified: true, skipped: false, reason: '', tabId: s.tab, label: 'builder', paneCount: 1 });
});

test('a tab labeled builder and split is refused even with a sidecar', () => {
  const s = scene({ label: 'builder', count: 2 });
  writeSidecar(s.handoff, sidecarText('herdr', s.pane, s.tab));
  assert.match(verifyPane(s.pane, s.handoff).reason, /holds 2 panes/);
});

test('a hand-rolled tab labeled with a slice name and a split is rejected', () => {
  const s = scene({ label: 'multicol', count: 2 });
  for (const handoff of [s.handoff, undefined, '']) {
    const v = verifyPane(s.pane, handoff);
    assert.equal(v.verified, false);
    assert.equal(v.skipped, false);
  }
});

test('a hand-rolled one-pane tab with no sidecar is rejected', () => {
  const s = scene({ label: 'multicol' });
  assert.equal(verifyPane(s.pane, s.handoff).verified, false);
});

// --- without a handoff: the legacy label rule, unchanged ---------------------

test('tab labeled builder with one pane is verified without a handoff', () => {
  const s = scene({ label: 'builder' });
  assert.deepEqual(verifyPane(s.pane), { verified: true, skipped: false, reason: '', tabId: s.tab, label: 'builder', paneCount: 1 });
});

test('a renamed tab with one pane is refused with the label reason when no handoff is given', () => {
  for (const handoff of [undefined, '', null]) {
    const s = scene();
    writeSidecar(s.handoff, sidecarText('herdr', s.pane, s.tab));
    const v = verifyPane(s.pane, handoff);
    assert.equal(v.verified, false);
    assert.equal(v.reason, `its tab ${s.tab} is labeled "David", not "builder" — dispatch.sh always labels the builder tab "builder"`);
  }
});

test('a split builder tab keeps the legacy panes reason without a handoff', () => {
  const s = scene({ label: 'builder', count: 3 });
  assert.equal(verifyPane(s.pane).reason, `its tab ${s.tab} holds 3 panes — dispatch.sh runs the builder in the tab's only pane, so a split means the builder was started by hand`);
});

// --- skipped and unknown outcomes do not depend on the handoff ---------------

test('skipped and unknown-id outcomes are identical with and without a handoff', () => {
  const h = join(BOX, 'unused.md');
  writeSidecar(h, sidecarText('herdr', 'w1:p1', 'w1:t1'));
  const ghostTab = `w1:t${900 + ++n}`;
  const table = {
    'no pane recorded': { arrange: () => useHerdr({ panes: '', tabs: '' }), pane: '', skipped: true, reason: /no pane recorded/ },
    'outside herdr': { arrange: outsideHerdr, pane: 'w1:p1', skipped: true, reason: /not inside a herdr session/ },
    'no herdr CLI': { arrange: noHerdrCli, pane: 'w1:p1', skipped: true, reason: /not on PATH/ },
    'unknown pane': { arrange: () => useHerdr({ panes: 'w1:p7=w1:t7', tabs: '' }), pane: 'w1:p1', skipped: false, reason: /does not know pane w1:p1/ },
    'unknown tab': { arrange: () => useHerdr({ panes: `w1:p1=${ghostTab}`, tabs: '' }), pane: 'w1:p1', skipped: false, reason: /does not know tab/ },
  };
  for (const [name, c] of Object.entries(table)) {
    c.arrange();
    const without = verifyPane(c.pane);
    c.arrange();
    const withHandoff = verifyPane(c.pane, h);
    assert.deepEqual(withHandoff, without, name);
    assert.equal(withHandoff.skipped, c.skipped, name);
    assert.match(withHandoff.reason, c.reason, name);
  }
});
