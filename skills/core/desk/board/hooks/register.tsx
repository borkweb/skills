import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeskBoard, DeskRow } from '../types'
import {
  bandText, buildBoard, clean, emptyText, fit, footerText, GROUP_COLOR, headOf, herdrMessage, homeDisplay, isDirName, isHerdrId,
  isTerminalApp, labelOf, lookOf, MAX_RECORD_BYTES, parseAgentList, parseRecord, reasonOf, runsHome, toast, workspaceOf,
} from './model.ts'
import type { Item, Rec } from './model.ts'

const PANE = 'desk-board'
const TICK_MS = 5000
// A tick that has run this long no longer blocks the next one; its late result is dropped.
const STUCK_MS = 30_000
const PRESS_TIMEOUT_MS = 5000
const AGENT_TIMEOUT_MS = 2000
// The last good agent map is shown for 3 ticks after the read that made it, and a failed read is not retried for 3 ticks.
const AGENT_HOLD_MS = 3 * TICK_MS
const HERDR_FALLBACKS = ['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr']

// Change the tag when the view model's fields change: it declines what an earlier version stored.
const board = atom({ plugin: 'desk-board', key: 'board' } as const, null, { shape: 'board-3' })
// A card's round border and its padding take this many columns.
const CARD_CHROME = 4

// Module state: a reload loses it and the next tick rebuilds it from the files.
type Outcome = { rec: Rec } | 'bad'
const cache = new Map<string, { mtimeMs: number; size: number; outcome: Outcome }>()
let timer: { cancel: () => void } | null = null
let inflight: { at: number } | null = null
let herdrBin: Promise<string> | null = null
// Clock times, never in the published view: a tick that changes nothing must write nothing.
let agentsGood: { map: Map<string, string>; at: number } | null = null
let agentsFailedAt: number | null = null

const messageOf = (err: unknown) => String((err as { message?: unknown } | null)?.message ?? err)
const isMissing = (err: unknown) => (err as { code?: unknown } | null)?.code === 'ENOENT' || /ENOENT|no such file/i.test(messageOf(err))

// ---- reading the runs home -----------------------------------------------------------------------

// A run dir's record: 'none' when there is no run.json (a dir still being made, or not a run),
// 'bad' when it cannot be trusted. A failed read is never cached, so a repaired file is read again.
async function loadRecord($: EngineInterface, home: string, name: string): Promise<Outcome | 'none'> {
  const hit = cache.get(name)
  const path = `${home}/${name}/run.json`
  let st
  try { st = await $.fs.stat(path) } catch (err) {
    cache.delete(name)
    return isMissing(err) ? 'none' : 'bad'
  }
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.outcome
  let outcome: Outcome
  if (st.kind !== 'file' || st.size > MAX_RECORD_BYTES) outcome = 'bad'
  else {
    let text: string
    try { text = await $.fs.read(path) } catch (err) {
      cache.delete(name)
      return isMissing(err) ? 'none' : 'bad'
    }
    const parsed = parseRecord(text, name)
    outcome = 'rec' in parsed ? { rec: parsed.rec } : 'bad'
  }
  cache.set(name, { mtimeMs: st.mtimeMs, size: st.size, outcome })
  return outcome
}

type Read = { board: DeskBoard } | { error: string; home: string }

async function readBoard($: EngineInterface, now: number): Promise<Read> {
  const userHome = await $.env.get('HOME')
  const home = runsHome(await $.env.get('BORK_RUNS_HOME'), await $.env.get('AGENT_HANDOFFS_DIR'), userHome)
  const thisPane = (await $.env.get('HERDR_PANE_ID')) ?? null
  if (home === null) return { error: "Can't read the runs home: HOME is not set", home: '' }
  const shown = homeDisplay(home, userHome)
  let entries
  try { entries = await $.fs.list(home) } catch (err) {
    if (!isMissing(err)) return { error: `Can't read ${shown}: ${reasonOf(messageOf(err))}`, home: shown }
    cache.clear()
    return { board: buildBoard({ items: [], bad: 0, now, home: shown, thisPane, readAt: now }) }
  }
  const names = entries.filter((x) => x.kind === 'dir' && isDirName(x.name)).map((x) => x.name).sort()
  for (const key of cache.keys()) if (!names.includes(key)) cache.delete(key)
  const items: Item[] = []
  let bad = 0
  for (const name of names) {
    const got = await loadRecord($, home, name)
    if (got === 'bad') bad += 1
    else if (got !== 'none') items.push({ dir: name, rec: got.rec })
  }
  const agents = await readAgents($, now)
  return { board: buildBoard({ items, bad, now, home: shown, thisPane, readAt: now, agents }) }
}

// The agent status, one `agent list` per tick while the Desk pane is open (display only; the file pass has already run).
// A failed read adds nothing: the last good map stays for AGENT_HOLD_MS, and no new read is made for as long.
// Nothing here may reject: a throw from `$.ui.panes()`, `herdrPath` or the call counts as a failed read, so the tick's
// file pass is still published with the last good map.
async function readAgents($: EngineInterface, now: number): Promise<Map<string, string> | null> {
  try {
    if (!(await isOpen($))) { agentsGood = null; return null }
    if (agentsFailedAt === null || now - agentsFailedAt > AGENT_HOLD_MS) {
      const ran = await runHerdr($, [await herdrPath($), 'agent', 'list'], AGENT_TIMEOUT_MS)
      const map = 'r' in ran && ran.r.exitCode === 0 && !ran.r.isStdoutTruncated ? parseAgentList(ran.r.stdout) : null
      if (map) { agentsGood = { map, at: now }; agentsFailedAt = null } else agentsFailedAt = now
    }
  } catch {
    agentsFailedAt = now
  }
  if (agentsGood && now - agentsGood.at > AGENT_HOLD_MS) agentsGood = null
  return agentsGood?.map ?? null
}

// Writes `$.state` only when the view's JSON text changed; `readAt` moves with a change, not with a tick.
async function publish($: EngineInterface, view: DeskBoard, now: number): Promise<void> {
  const prev = await read($, board)
  if (prev && JSON.stringify({ ...view, readAt: prev.readAt }) === JSON.stringify(prev)) return
  await update($, board, () => ({ ...view, readAt: now }))
}

async function refresh($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (inflight && now - inflight.at < STUCK_MS) return
  const mine = { at: now }
  inflight = mine
  try {
    const got = await readBoard($, now)
    if (inflight !== mine) return
    if ('board' in got) await publish($, got.board, now)
    else {
      // The home exists but cannot be listed: keep the last good rows and say why.
      const prev = await read($, board)
      const base = prev ?? buildBoard({ items: [], bad: 0, now, home: got.home, thisPane: null, readAt: now })
      await publish($, { ...base, error: got.error }, now)
    }
  } catch {
    // Keep the last good state; the next tick tries again.
  } finally {
    if (inflight === mine) inflight = null
  }
}

// Idempotent. /desk-board calls it too: a plugin installed or updated mid-session never sees that session's
// start, so polling would otherwise never begin. Renders must not: their `$` ends with the render.
function startPolling($: EngineInterface): void {
  if (timer) return
  timer = $.clock.every(TICK_MS, () => { void refresh($) })
  void refresh($)
}

// ---- the pane and its command ------------------------------------------------------------------------

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some((p) => p.id === PANE)
}

async function openDesk($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Desk', focus: true, columns: 56 })
  $.ui.invalidate('ui.render')
}

async function toggleDesk($: EngineInterface): Promise<{ text: string }> {
  if (await isOpen($)) {
    await $.ui.close({ id: PANE })
    $.ui.invalidate('ui.render')
    return { text: 'Desk closed.' }
  }
  await openDesk($)
  return { text: 'Desk opened.' }
}

// ---- press: take the user to the run's herdr tab --------------------------------------------------------

async function resolveHerdr($: EngineInterface): Promise<string> {
  const set = await $.env.get('HERDR_BIN_PATH')
  if (typeof set === 'string' && set.startsWith('/')) return set
  for (const path of HERDR_FALLBACKS) {
    try { await $.fs.stat(path); return path } catch { /* try the next */ }
  }
  return 'herdr'
}
function herdrPath($: EngineInterface): Promise<string> {
  // A rejected lookup is not kept: the next call asks again.
  return (herdrBin ??= resolveHerdr($).catch((err) => { herdrBin = null; throw err }))
}

type Ran = { r: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean } } | { isTimeout: boolean }

// A rejection at or after the timeout is a hung herdr; an earlier one means the command could not start.
async function runHerdr($: EngineInterface, argv: string[], timeoutMs = PRESS_TIMEOUT_MS): Promise<Ran> {
  const t0 = await $.clock.now()
  try {
    return { r: await $.process.run(argv, { timeoutMs }) }
  } catch {
    return { isTimeout: (await $.clock.now()) - t0 >= timeoutMs }
  }
}

type Press = { tab: string; repo: string; isDesktop: boolean; app: string | null }

// The board never fails a press silently: anything unexpected ends in the manual-command toast.
async function press($: EngineInterface, p: Press): Promise<void> {
  try {
    await switchTab($, p)
  } catch {
    $.ui.toast(toast.cannot(p.tab))
  }
}

async function switchTab($: EngineInterface, p: Press): Promise<void> {
  const say = (text: string) => $.ui.toast(text)
  const bin = await herdrPath($)
  const steps: { argv: string[]; ws?: true }[] = [{ argv: [bin, 'tab', 'get', p.tab], ws: true }]
  let ws = ''
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    const ran = await runHerdr($, step.argv)
    if ('isTimeout' in ran) return say(ran.isTimeout ? toast.timeout(p.repo) : toast.cannot(p.tab))
    if (ran.r.exitCode !== 0) return say(toast.failed(p.repo, herdrMessage(ran.r.stderr.trim() ? ran.r.stderr : ran.r.stdout, ran.r.exitCode)))
    if (step.ws) {
      ws = workspaceOf(ran.r.stdout) ?? ''
      if (!ws) return say(toast.noWorkspace(p.repo, p.tab))
      steps.push({ argv: [bin, 'workspace', 'focus', ws] }, { argv: [bin, 'tab', 'focus', p.tab] })
      if (p.app) steps.push({ argv: ['/usr/bin/open', '-b', p.app] })
    }
  }
  say(toast.switched(p.repo, p.tab, p.isDesktop && !p.app))
}

// ---- the mod ---------------------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const app = isTerminalApp(options.terminalApp) ? options.terminalApp : null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'desk-board', description: 'Open or close the desk board: bork do runs in motion, waiting on you, finished' })
    // A session with no surface (claude -p, the SDK) never polls; it starts on attach instead.
    if (e.surface !== null || e.isInteractive) startPolling($)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    startPolling($)
    return next(e)
  })

  on('command.run', { command: 'desk-board' }, async ($) => {
    startPolling($)
    return toggleDesk($)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, board)
    if (e.props.hasSurvey || b === null || (await isOpen($))) return next(e)
    const text = bandText(b, e.surface === 'desktop')
    if (text === null) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>{text} </Text>
        <Button key="open" label="Open desk" onPress={() => openDesk($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const b = await read($, board)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isDesktop = e.surface === 'desktop'
    const inner = Math.max(1, e.props.bodyColumns - CARD_CHROME)
    const pressOf = (row: DeskRow) => () => press($, { tab: row.tab!, repo: row.repo, isDesktop, app })
    const canPress = (row: DeskRow) => row.tab !== null && isHerdrId(row.tab)

    if (b === null) return <Text dimColor>Reading runs…</Text>

    // A run's card: the head (glyph, bold repo, what it is doing) with the age at the right, the goal,
    // then what needs saying. A head with a herdr tab is the press target.
    const card = (row: DeskRow) => {
      const look = lookOf(row)
      const head = Array.from(fit(`${look.glyph} ${headOf(row)}`, Math.max(1, inner - Array.from(row.age).length - 1)))
      const after = head.slice(2).join('')
      const repo = after.startsWith(row.repo) ? row.repo : after
      const parts = [
        <Text color={look.color}>{head[0] ?? ''}</Text>,
        ' ',
        <Text weight="bold">{repo}</Text>,
        <Text dimColor>{after.slice(repo.length)}</Text>,
      ]
      const needsYou = row.state === 'needs-me' || row.state === 'blocked'
      return (
        <Box key={`card-${row.key}`} flexDirection="column" borderStyle="round" borderColor={look.color} borderDimColor={row.isDimRow} paddingX={1} hover={{ borderStyle: 'bold' }}>
          <Box justifyContent="space-between">
            {canPress(row)
              ? <Button key={row.key} plain label={labelOf(row)} dimColor={row.isDimRow} onPress={pressOf(row)}>{parts}</Button>
              : <Text dimColor={row.isDimRow}>{parts}</Text>}
            <Text dimColor>{row.age}</Text>
          </Box>
          <Text dimColor={row.isDimRow} wrap="truncate-end">{fit(row.goal, inner)}</Text>
          {needsYou
            ? <Text color={look.color} wrap="wrap">{row.line2}</Text>
            : row.line2 !== row.goal && <Text dimColor wrap="truncate-end">{fit(row.line2, inner)}</Text>}
        </Box>
      )
    }

    // Runs that finished 24 to 48 h ago: one entry each on a single wrapping line.
    const yesterday = (rows: DeskRow[]) => (
      <Box key="g-earlier" flexWrap="wrap" columnGap={2}>
        <Text dimColor>Yesterday</Text>
        {rows.map((row) => {
          const look = lookOf(row)
          const parts = [<Text color={look.color}>{look.glyph}</Text>, ` ${fit(`${row.repo} ${row.age}`, Math.max(1, inner - 2))}`]
          return canPress(row)
            ? <Button key={row.key} plain label={labelOf(row)} dimColor onPress={pressOf(row)}>{parts}</Button>
            : <Text dimColor>{parts}</Text>
        })}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {b.error !== null && <Text color="error">{clean(b.error, 400)}</Text>}
        {b.error === null && b.rows === 0 && <Text dimColor>{emptyText(b.home)}</Text>}
        {b.groups.map((g) => g.id === 'earlier' ? yesterday(g.rows) : (
          <Box key={`g-${g.id}`} flexDirection="column">
            <Text weight="bold" color={GROUP_COLOR[g.id]}>{fit(g.title, inner)}</Text>
            {g.rows.map(card)}
          </Box>
        ))}
        {b.bad > 0 && <Text dimColor>{footerText(b.bad)}</Text>}
      </Box>
    )
  })
}
