// model.ts — the pure half of the desk board: record checks, text safety, grouping, the view
// model and the herdr press helpers. No `$`, no JSX: `node --test` runs it (tests/test_model.mjs).
// The record checks mirror runs.mjs `invalidReason`; tests/test_model.mjs holds them to the real CLI.

import type { DeskBoard as Board, DeskGroup as Group, DeskRow as Row } from '../types'

export const STATES = ['running', 'needs-me', 'blocked', 'done', 'failed'] as const
export type RunState = (typeof STATES)[number]

export const DAY_MS = 24 * 3600e3
export const MAX_RECORD_BYTES = 4 * 1024 * 1024
export const TEXT_CAP = 200
export const HERDR_MSG_CAP = 120

const DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// The only text that may reach herdr's argv. It cannot start with `-`, so it cannot be a flag.
const HERDR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/

export type Question = { id: string; question?: unknown; status: string; options: unknown[] }
export type Rec = {
  id: string
  state: RunState
  goal: string
  repo?: unknown
  summary?: unknown
  delivery?: unknown
  questions: Question[]
  architect: { frontend?: unknown; tab?: unknown; pane?: unknown }
  messages?: unknown
  created_at: string
  updated_at: string
}
export type Item = { dir: string; rec: Rec }

// ---- ids ---------------------------------------------------------------------------

export const isDirName = (name: unknown): name is string =>
  typeof name === 'string' && DIR_RE.test(name) && !name.includes('..')
export const isHerdrId = (v: unknown): v is string => typeof v === 'string' && HERDR_ID_RE.test(v)
export const isTerminalApp = (v: unknown): v is string => typeof v === 'string' && APP_RE.test(v)
const isAbsolute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/')

// BORK_RUNS_HOME, else AGENT_HANDOFFS_DIR/runs, else HOME/.agent-handoffs/runs; each only when absolute.
export function runsHome(bork?: string, handoffs?: string, home?: string): string | null {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  if (isAbsolute(bork)) return trim(bork)
  if (isAbsolute(handoffs)) return `${trim(handoffs)}/runs`
  if (isAbsolute(home)) return `${trim(home)}/.agent-handoffs/runs`
  return null
}
export const homeDisplay = (path: string, home?: string) =>
  isAbsolute(home) && home.length > 1 && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

// ---- text from records and herdr is data ------------------------------------------------

// Line breaks and tabs become one space, every other control character goes, the rest is cut to `cap`.
export function clean(text: unknown, cap = TEXT_CAP): string {
  if (typeof text !== 'string') return ''
  const flat = text.slice(0, cap * 4).replace(/[\t\n\r]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  return Array.from(flat).slice(0, cap).join('')
}
// The first line of an engine error without the engine's own lead (plugin name, then the failed call).
// Seen live: `desk-board: <dollar>.fs.list(<abs path>) failed: EACCES`; the test kit leads with
// `desk-board: <dollar>.fs.list: ` instead (and wraps a denied reason in it). Both leads are removed, in that order.
export const reasonOf = (message: string): string =>
  firstLine(message.replace(/^[\w-]+: \$\.[\w.]+: /, '').replace(/^[\w-]+: \$\.fs\.\w+\([^\n]*\) failed: /, ''))
export const firstLine = (text: unknown): string =>
  typeof text === 'string' ? clean(text.split(/[\r\n]+/).find((l) => l.trim() !== '') ?? '') : ''
export const fit = (text: string, columns: number): string => {
  const chars = Array.from(text)
  return chars.length <= columns ? text : `${chars.slice(0, Math.max(0, columns - 1)).join('')}…`
}
const nonEmpty = (v: unknown): string => {
  const c = clean(v)
  return c.trim() === '' ? '' : c
}

export function repoName(repo: unknown): string {
  if (typeof repo !== 'string') return '-'
  return clean(repo.replace(/\/+$/, '').split('/').pop()) || '-'
}

export function ageText(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (!(s >= 60)) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// ---- record checks ------------------------------------------------------------------------

// The same checks as runs.mjs `invalidReason`, plus what the board itself relies on: both timestamps parse.
export function invalidReason(rec: unknown, dirName: string): string | null {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'not a JSON object'
  const r = rec as Record<string, unknown>
  if (r.schema !== 1) return 'unsupported schema'
  if (!STATES.includes(r.state as RunState)) return 'unknown state'
  if (!Array.isArray(r.questions)) return 'questions is not a list'
  if (!Array.isArray(r.history)) return 'history is not a list'
  for (const k of ['revision', 'signal_revision', 'orchestrator_ack']) if (!Number.isInteger(r[k])) return `${k} is not an integer`
  if (r.id !== dirName) return 'id does not match the run dir name'
  if (typeof r.goal !== 'string') return 'goal is not a string'
  if (!r.architect || typeof r.architect !== 'object') return 'architect is missing'
  if (!['orchestrator', 'self'].includes(r.launched_by as string)) return 'launched_by is missing'
  for (const q of r.questions as Record<string, unknown>[]) {
    if (!q || typeof q.id !== 'string' || !/^Q\d+$/.test(q.id) || !['open', 'answered', 'withdrawn'].includes(q.status as string) || !Array.isArray(q.options)) return 'a question is malformed'
  }
  // The same rule as runs.mjs: messages may be absent; present, every element needs id (M<n>), text and at.
  if (r.messages !== undefined && (!Array.isArray(r.messages) || r.messages.some((m: Record<string, unknown> | null) => !m || typeof m.id !== 'string' || !/^M\d+$/.test(m.id) || typeof m.text !== 'string' || typeof m.at !== 'string'))) return 'messages is malformed'
  for (const k of ['created_at', 'updated_at']) if (typeof r[k] !== 'string' || Number.isNaN(Date.parse(r[k] as string))) return `${k} is not a date`
  return null
}

export type Parsed = { rec: Rec } | { bad: string }
export function parseRecord(text: string, dirName: string): Parsed {
  let rec: unknown
  try { rec = JSON.parse(text) } catch { return { bad: 'malformed JSON' } }
  const why = invalidReason(rec, dirName)
  return why ? { bad: why } : { rec: rec as Rec }
}

// A finished run is a card for its first day, one entry on the Yesterday line for its second, then gone.
// Its record is still stat'ed every tick: a reopen (`tell`, `reopen`) makes an old run live again.
export const isOldFinished = (rec: Rec, now: number): boolean =>
  (rec.state === 'done' || rec.state === 'failed') && now - Date.parse(rec.updated_at) > 2 * DAY_MS

// ---- the view model ---------------------------------------------------------------------------

const openQuestions = (rec: Rec) => rec.questions.filter((q) => q.status === 'open')

function line2Of(rec: Rec, goal: string): string {
  const summary = nonEmpty(rec.summary)
  if (rec.state === 'needs-me') {
    const q = openQuestions(rec).at(-1)
    const text = q ? nonEmpty(q.question) : ''
    return text ? `${q!.id}: ${text}` : summary || 'waiting on you'
  }
  if (rec.state === 'done') return nonEmpty(rec.delivery) || summary || goal
  if (rec.state === 'running') return goal
  return summary || goal
}

// ---- the herdr agent status ---------------------------------------------------------------------------

export const AGENT_WORD: Record<string, string> = {
  working: 'agent working', blocked: 'agent blocked', idle: 'agent idle', done: 'agent turn ended', unknown: 'agent unknown',
}

// `herdr agent list` stdout as pane -> agent_status (a word herdr adds later is `unknown`); null when it is not that list.
// Only pane_id and agent_status are read: terminal_title and the rest are other people's text.
export function parseAgentList(stdout: string): Map<string, string> | null {
  let agents: unknown
  try { agents = JSON.parse(stdout)?.result?.agents } catch { return null }
  if (!Array.isArray(agents)) return null
  const map = new Map<string, string>()
  for (const a of agents) if (typeof a?.pane_id === 'string') map.set(a.pane_id, typeof a.agent_status === 'string' && Object.hasOwn(AGENT_WORD, a.agent_status) ? a.agent_status : 'unknown')
  return map
}

export function buildBoard(input: { items: Item[]; bad: number; now: number; home: string; thisPane: string | null; readAt: number; agents?: Map<string, string> | null }): Board {
  const { now } = input
  type Slot = { at: number; row: Row }
  const rows: Record<Group['id'], Slot[]> = { needs: [], motion: [], finished: [], earlier: [] }
  for (const { dir, rec } of input.items) {
    const updated = Date.parse(rec.updated_at)
    const age = now - updated
    const goal = firstLine(rec.goal)
    const tab = rec.architect.frontend === 'herdr' && isHerdrId(rec.architect.tab) ? rec.architect.tab : null
    const group: Group['id'] | null =
      rec.state === 'needs-me' || rec.state === 'blocked' ? 'needs'
        : rec.state === 'running' ? 'motion'
          : age <= DAY_MS ? 'finished'
            : age <= 2 * DAY_MS ? 'earlier' : null
    if (!group) continue
    const row: Row = {
      // Every Yesterday entry would read 1d, so they are aged in hours.
      key: dir, repo: repoName(rec.repo), state: rec.state, age: group === 'earlier' ? `${Math.floor(age / 3600e3)}h` : ageText(age), goal, tab,
      isStale: rec.state === 'running' && age > DAY_MS,
      isThis: input.thisPane !== null && input.thisPane !== '' && rec.architect.pane === input.thisPane,
      // A pane the list does not hold is gone; a run with no pane, a finished run or no list at all has no status.
      agent: input.agents && typeof rec.architect.pane === 'string' && rec.architect.pane !== '' && (rec.state !== 'done' && rec.state !== 'failed') ? (input.agents.get(rec.architect.pane) ?? 'gone') as Row['agent'] : null,
      line2: line2Of(rec, goal), isDimLine: rec.state !== 'needs-me', isDimRow: group === 'finished' || group === 'earlier',
    }
    // Needs you and Finished: newest first. In motion: oldest created first, so rows stay put.
    rows[group].push({ at: group === 'motion' ? Date.parse(rec.created_at) : -updated, row })
  }
  const title = (name: string, n: number) => `${name} · ${n}`
  const groups: Group[] = []
  for (const [id, name] of [['needs', 'Needs you'], ['motion', 'In motion'], ['finished', 'Finished today'], ['earlier', 'Yesterday']] as const) {
    const list = rows[id].sort((a, b) => a.at - b.at || (a.row.key < b.row.key ? -1 : 1)).map((x) => x.row)
    if (list.length) groups.push({ id, title: title(name, list.length), rows: list })
  }
  const all = groups.flatMap((g) => g.rows)
  return {
    readAt: input.readAt, home: input.home, groups, bad: input.bad, error: null,
    needs: all.filter((r) => (r.state === 'needs-me' || r.state === 'blocked') && !r.isThis).length,
    motion: all.filter((r) => r.state === 'running').length,
    rows: all.length,
  }
}

// ---- the card look ------------------------------------------------------------------------------

// Colors are theme keys, so they follow the person's theme.
export type Look = { glyph: string; color: string; word: string }
const LOOKS: Record<RunState, Look> = {
  'needs-me': { glyph: '◆', color: 'warning', word: 'needs you' },
  blocked: { glyph: '■', color: 'error', word: 'blocked' },
  running: { glyph: '●', color: 'suggestion', word: 'running' },
  done: { glyph: '✓', color: 'success', word: 'done' },
  failed: { glyph: '✗', color: 'error', word: 'failed' },
}
export const lookOf = (r: Pick<Row, 'state' | 'isStale'>): Look =>
  r.isStale ? { glyph: '○', color: 'inactive', word: 'stale' } : { ...LOOKS[r.state] }
export const GROUP_COLOR: Record<Group['id'], string> = { needs: 'warning', motion: 'suggestion', finished: 'success', earlier: 'success' }

// A card's first line, without its glyph and age: the repo, what the run is doing, what its agent is doing, then its tags.
export const agentWordOf = (r: Pick<Row, 'agent'>): string | null => (r.agent === null ? null : r.agent === 'gone' ? 'architect gone' : AGENT_WORD[r.agent] ?? 'agent unknown')
export const headOf = (r: Row): string =>
  [r.repo, lookOf(r).word, agentWordOf(r), r.isThis && '(this session)', r.tab === null && 'no tab'].filter(Boolean).join(' · ')
export const labelOf = (r: Row): string => `Go to ${r.repo}: ${r.goal} (${r.state}, ${r.age})`
export const footerText = (bad: number) => `${bad} run record${bad === 1 ? '' : 's'} could not be read`
export const emptyText = (home: string) => `No runs in ${home}`
export const bandText = (b: Board, isDesktop: boolean): string | null => {
  if (b.needs === 0 && !(isDesktop && b.rows > 0)) return null
  return `Desk: ${b.needs > 0 ? `${b.needs} ${b.needs === 1 ? 'needs' : 'need'} you · ` : ''}${b.motion} in motion`
}

// ---- press: herdr output and toast text ------------------------------------------------------

// `herdr tab get` stdout: the workspace id, only when it is well-formed.
export function workspaceOf(stdout: string): string | null {
  try {
    const ws = JSON.parse(stdout)?.result?.tab?.workspace_id
    return isHerdrId(ws) ? ws : null
  } catch { return null }
}

// herdr's failure text: the JSON error message when stderr is that, else its first line.
export function herdrMessage(stderr: string, exitCode: number): string {
  let msg = ''
  try {
    const m = JSON.parse(stderr)?.error?.message
    if (typeof m === 'string') msg = m
  } catch { /* not JSON */ }
  if (!msg.trim()) msg = stderr.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  return clean(msg, HERDR_MSG_CAP).trim() || `herdr exited ${exitCode}`
}

export const toast = {
  switched: (repo: string, tab: string, tail: boolean) => `Switched herdr to ${repo} (${tab})${tail ? ' — switch to your terminal' : ''}`,
  failed: (repo: string, msg: string) => `Could not switch to ${repo}: ${msg}`,
  timeout: (repo: string) => `Could not switch to ${repo}: herdr did not answer`,
  noWorkspace: (repo: string, tab: string) => `Could not switch to ${repo}: herdr gave no workspace for ${tab}`,
  cannot: (tab: string) => `Can't switch tabs from here: run herdr tab focus ${tab}`,
}
