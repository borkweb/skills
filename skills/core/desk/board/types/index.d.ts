export type DeskRow = {
  /** The run dir name: the Button's key. */
  key: string
  repo: string
  state: 'running' | 'needs-me' | 'blocked' | 'done' | 'failed'
  age: string
  isStale: boolean
  /** The run's architect pane is this session's own. */
  isThis: boolean
  /** A checked herdr tab id, or null when the row cannot be pressed. */
  tab: string | null
  goal: string
  line2: string
  isDimLine: boolean
  isDimRow: boolean
}

/** `finished` is the last 24 h, drawn as cards; `earlier` is 24 to 48 h, drawn as one Yesterday line. */
export type DeskGroup = { id: 'needs' | 'motion' | 'finished' | 'earlier'; title: string; rows: DeskRow[] }

/** The whole drawn view: a tick builds it, a drawing only reads it. */
export type DeskBoard = {
  /** When the view last changed, `$.clock.now()` ms; the board has read once it is set. */
  readAt: number
  home: string
  groups: DeskGroup[]
  bad: number
  error: string | null
  /** Needs you, not counting this session's own runs. */
  needs: number
  motion: number
  rows: number
}

declare module 'claude-code' {
  interface PluginState {
    'desk-board': { board: Shaped<DeskBoard | null> }
  }
}
