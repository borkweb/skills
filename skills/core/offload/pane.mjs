#!/usr/bin/env node
// pane.mjs — prove that a recorded builder pane actually came from dispatch.sh.
//
// WHY THIS EXISTS
// `complete` says every builder launch goes through offload's dispatch.sh, and
// says it only in prose. An architect that improvises instead — `herdr tab create
// --label <slug>` followed by `herdr agent start --tab <t> --split …` — produces
// something that LOOKS dispatched: a tab per slice, an agent running in it, a pane
// id to write into the ledger. It is not. A hand-rolled builder has no
// `$HANDOFF.builder` marker (so the duplicate guard is blind), no `$HANDOFF.activity`
// sidecar and no turn-end hook (so the wait bridge can never fire), and no
// OFFLOAD_HANDOFF in its environment (so it never reports gates). The loop then
// waits forever on a builder it cannot hear.
//
// dispatch.sh leaves a signature that hand-rolling does not:
//   * the tab is labeled exactly "builder" (dispatch.sh always passes --label builder)
//   * the harness runs in that tab's ROOT pane, so the tab holds exactly one pane
// `herdr agent start --split` breaks both: the tab carries the slice's own label
// and holds two panes — an empty root shell plus the split the agent lives in.
//
// Checking the signature turns the prose invariant into a refusal.
import { execFileSync } from 'node:child_process';

// dispatch.sh's tab label. Changing it here without changing dispatch.sh makes
// every dispatch look hand-rolled; launch_contract.test.mjs pins both.
export const BUILDER_TAB_LABEL = 'builder';

// Tab lookups repeat across a board's slices; one process, one probe per tab.
const tabCache = new Map();

function herdr(args) {
  try {
    return { out: execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (e) {
    // ENOENT means no herdr CLI at all — that is "cannot check", not "failed".
    return { missing: e.code === 'ENOENT', out: '' };
  }
}

function json(out) {
  try { return JSON.parse(out); } catch { return null; }
}

function tabInfo(tabId) {
  if (tabCache.has(tabId)) return tabCache.get(tabId);
  const { missing, out } = herdr(['tab', 'get', tabId]);
  const info = missing ? { missing: true } : (json(out)?.result?.tab ?? null);
  tabCache.set(tabId, info);
  return info;
}

const skip = (reason) => ({ verified: false, skipped: true, reason });

/**
 * Does `paneId` look like a pane dispatch.sh created?
 *
 * Returns `{ verified, skipped, reason, tabId, label, paneCount }`. `skipped` is
 * the honest third answer — no pane recorded, not inside herdr, no herdr CLI —
 * and callers must treat it as "cannot tell", never as a failure. A dispatch that
 * landed in tmux or Terminal.app records no pane at all and must not be punished
 * for it.
 */
export function verifyPane(paneId) {
  if (!paneId) return skip('no pane recorded');
  if (!process.env.HERDR_ENV) return skip('not inside a herdr session — pane provenance is unverifiable here');

  const pane = herdr(['pane', 'get', paneId]);
  if (pane.missing) return skip('the herdr CLI is not on PATH');
  const tabId = json(pane.out)?.result?.pane?.tab_id;
  if (!tabId) {
    return { verified: false, skipped: false, reason: `herdr does not know pane ${paneId} — it is gone, or it never existed` };
  }

  const tab = tabInfo(tabId);
  if (tab?.missing) return skip('the herdr CLI is not on PATH');
  if (!tab) {
    return { verified: false, skipped: false, tabId, reason: `herdr does not know tab ${tabId}, which pane ${paneId} claims to be in` };
  }

  const label = tab.label ?? '';
  const paneCount = Number(tab.pane_count ?? 0);
  const base = { skipped: false, tabId, label, paneCount };

  if (label !== BUILDER_TAB_LABEL) {
    return {
      ...base,
      verified: false,
      reason: `its tab ${tabId} is labeled "${label || '(none)'}", not "${BUILDER_TAB_LABEL}" — dispatch.sh always labels the builder tab "${BUILDER_TAB_LABEL}"`,
    };
  }
  if (paneCount !== 1) {
    return {
      ...base,
      verified: false,
      reason: `its tab ${tabId} holds ${paneCount} panes — dispatch.sh runs the builder in the tab's only pane, so a split means the builder was started by hand`,
    };
  }
  return { ...base, verified: true, reason: '' };
}

// The refusal/flag text. Kept here so the ledger's `set` error and the board's
// flag say the same thing — a builder that bypassed dispatch.sh is unreachable by
// the wait bridge, and that is the consequence worth naming both times.
export const UNMANAGED_PANE_CONSEQUENCE =
  'a builder started outside dispatch.sh has no builder marker, no activity sidecar and no turn-end hook, so its wait bridge can never fire';
