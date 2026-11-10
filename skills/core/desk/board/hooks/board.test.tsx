import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// The board's register layer, run through the real engine. Nothing sits beneath the plugin, so every
// `fs.*`, `process.run`, `ui.*` and `env.get` call is answered here, by a hook that stands for the engine.

const HOME = '/Users/t'
const RUNS = `${HOME}/.agent-handoffs/runs`
const NOW = Date.parse('2026-11-10T12:00:00Z')
const MIN = 60e3
const HOUR = 3600e3
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const BIN = '/opt/homebrew/bin/herdr'
const TAB_GET = '{"id":"cli:tab:get","result":{"tab":{"agent_status":"working","focused":false,"label":"do: skills","number":7,"pane_count":1,"tab_id":"w66:t7","workspace_id":"w66"},"type":"tab_info"}}'

const rec = (id: string, patch: Record<string, unknown> = {}) => ({
  schema: 1, id, run_dir: `${RUNS}/${id}`, repo: '/code/skills', goal: 'Ship the board', task: null, state: 'running',
  summary: '', delivery: null, questions: [],
  architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: 'w66:t7', pane: 'w66:p8' }, launched_by: 'orchestrator',
  revision: 1, signal_revision: 0, orchestrator_ack: 0, created_at: iso(HOUR), updated_at: iso(MIN), history: [], ...patch,
})
const asking = (id: string, patch: Record<string, unknown> = {}): Dir => ({
  rec: rec(id, {
    state: 'needs-me',
    questions: [{ id: 'Q1', question: 'Which db?', options: [], status: 'open' }],
    ...patch,
  }),
})

type Dir = {
  rec?: Record<string, unknown>
  text?: string
  size?: number
  mtimeMs?: number
  noRunJson?: boolean
  statFails?: string
  readFails?: string
}
type Ran = { exitCode: number; stdout?: string; stderr?: string } | 'reject' | 'slow-reject'
type World = {
  dirs: Record<string, Dir>
  extra: { name: string; kind: 'dir' | 'file' | 'other'; isLink?: boolean }[]
  listFails: string | null
  env: Record<string, string | undefined>
  run: (argv: readonly string[]) => Ran
  panes: string[]
  statExists: string[]
  list: string[]
  read: string[]
  stat: string[]
  process: { argv: readonly string[]; timeoutMs: number | undefined }[]
  toasts: string[]
  opened: Record<string, unknown>[]
  registered: string[]
  stateSets: number
  holdList: Promise<void> | null
  stateGetFails: number
}
const OK_RUN: World['run'] = (argv) =>
  argv[1] === 'tab' && argv[2] === 'get' ? { exitCode: 0, stdout: TAB_GET } : { exitCode: 0 }
const world = (dirs: Record<string, Dir> = {}, patch: Partial<World> = {}): World => ({
  dirs, extra: [], listFails: null, env: {}, run: OK_RUN, panes: [], statExists: [BIN], list: [], read: [], stat: [], process: [],
  toasts: [], opened: [], registered: [], stateSets: 0, holdList: null, stateGetFails: 0, ...patch,
})
const good = (name: string, patch: Record<string, unknown> = {}): Dir => ({ rec: rec(name, patch) })
const textOf = (d: Dir) => d.text ?? JSON.stringify(d.rec)

// `surface: undefined` sends no session.start: the plugin loaded after the session began (an install or update mid-session).
async function boot($: Engine, on: On, w: World, start: { surface?: Surface | null; isInteractive: boolean } = { surface: 'terminal', isInteractive: true }) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, Object.fromEntries(Object.entries({ HOME, HERDR_PANE_ID: 'w9:p9', ...w.env }).filter((kv): kv is [string, string] => kv[1] !== undefined)))
  on('command.register', (_, e) => {
    w.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.end', () => ({ sessionId: 'test' }))
  // Beneath the plugin the band's `next(e)` draws this: its presence says the board yielded.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('fs.list', async (_, e) => {
    w.list.push(e.path)
    if (w.listFails) return { deny: w.listFails }
    // The listing is the world as it stands now, even when this call is held and answered later.
    const entries = [
      ...Object.keys(w.dirs).map((name) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
      ...w.extra.map((x) => ({ name: x.name, kind: x.kind, size: 0, mtimeMs: 0, isLink: x.isLink ?? false })),
    ]
    const hold = w.holdList
    w.holdList = null
    if (hold) await hold
    return { value: entries }
  })
  on('fs.stat', (_, e) => {
    w.stat.push(e.path)
    const m = /^\/Users\/t\/.agent-handoffs\/runs\/([^/]+)\/run\.json$/.exec(e.path)
    if (!m) return w.statExists.includes(e.path) ? { value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT: no such file' }
    const d = w.dirs[m[1]!]
    if (!d || d.noRunJson) return { deny: 'ENOENT: no such file or directory' }
    if (d.statFails) return { deny: d.statFails }
    return { value: { kind: 'file' as const, size: d.size ?? textOf(d).length, mtimeMs: d.mtimeMs ?? 1, isLink: false } }
  })
  on('fs.read', (_, e) => {
    w.read.push(e.path)
    const d = w.dirs[e.path.split('/').at(-2)!]
    if (!d || d.noRunJson) return { deny: 'ENOENT: no such file or directory' }
    if (d.readFails) return { deny: d.readFails }
    return { value: textOf(d) }
  })
  on('process.run', async (_, e) => {
    w.process.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    const r = w.run(e.argv)
    if (r === 'reject') return { deny: 'spawn herdr ENOENT' }
    if (r === 'slow-reject') {
      await clock.sleep(e.init?.timeoutMs ?? 0)
      return { deny: 'timed out' }
    }
    return { value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    w.opened.push({ ...e })
    if (!w.panes.includes(e.id)) w.panes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    w.panes = w.panes.filter((p) => p !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: w.panes.map((id) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('state.get', (_, e, next) => {
    if (w.stateGetFails > 0) {
      w.stateGetFails -= 1
      return { deny: 'state is unavailable' }
    }
    return next(e)
  })
  on('state.set', (_, e, next) => {
    w.stateSets += 1
    return next(e)
  })
  if (start.surface !== undefined) await $.session.start({ cwd: '/', surface: start.surface, isInteractive: start.isInteractive })
  await clock.settle()
  return clock
}

const paneProps = (cols: number) =>
  ({ title: 'Desk', isFocused: false, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }) as const
const bandProps = (over: { hasSurvey?: boolean } = {}) =>
  ({ hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 5, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {}, ...over }) as const
const mountPane = ($: Engine, surface: Surface, cols = 56) =>
  $.ui.mount({ plugin: 'desk-board', surface, component: 'Pane', requestId: 'desk-board', props: paneProps(cols) })
const mountBand = ($: Engine, surface: Surface, over: { hasSurvey?: boolean } = {}) =>
  $.ui.mount({ plugin: 'desk-board', surface, component: 'AbovePrompt', props: bandProps(over) })
// The person typing /desk-board at the prompt.
const runDesk = ($: Engine) =>
  $.command.run({ command: 'desk-board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

type Handle = Awaited<ReturnType<typeof mountPane>>
// One look at the pane: what it draws, as data, with the instance unmounted again.
const snap = async ($: Engine, surface: Surface, cols = 56) => {
  const ui: Handle = await mountPane($, surface, cols)
  const texts = await ui.findAll({ type: 'Text' })
  const buttons = await ui.findAll({ type: 'Button' })
  const boxes = await ui.findAll({ type: 'Box' })
  const markdown = await ui.find({ type: 'Markdown' })
  await ui.unmount()
  const lines = [...texts.map((t) => t.text), ...buttons.map((b) => b.text)]
  return { texts, buttons, boxes, markdown, lines, all: lines.join('\n'), keys: buttons.map((b) => b.key) }
}
// One look at the band: whether it yielded to the engine, and what it drew otherwise.
const bandSnap = async ($: Engine, surface: Surface, over: { hasSurvey?: boolean } = {}) => {
  const ui = await mountBand($, surface, over)
  const yielded = (await ui.find({ type: 'Text', text: /engine/ })) !== undefined
  const text = (await ui.find({ type: 'Text', text: /Desk:/ }))?.text
  const button = await ui.find({ type: 'Button', key: 'open' })
  await ui.unmount()
  return { yielded, text, button }
}

// ---- first read, empty, missing, unreadable --------------------------------------------------------------------

const noBtn = { architect: { harness: 'claude', session_id: null, frontend: null, tab: null, pane: null } }
const tabOf = (tab: unknown, frontend = 'herdr') => ({ architect: { harness: 'claude', session_id: null, frontend, tab, pane: 'w1:p1' } })

for (const surface of SURFACES) {
  test(`${surface}: before the first read the pane says Reading runs…`, async ($, on) => {
    await boot($, on, world(), { surface: null, isInteractive: false })
    const { all } = await snap($, surface)
    expect(all).toContain('Reading runs…')
    expect(all).not.toContain('No runs in')
  })

  test(`${surface}: an empty home names the resolved path with ~ for HOME`, async ($, on) => {
    await boot($, on, world())
    expect((await snap($, surface)).all).toContain('No runs in ~/.agent-handoffs/runs')
  })

  test(`${surface}: a missing home is an empty board, not an error`, async ($, on) => {
    await boot($, on, world({}, { listFails: 'ENOENT: no such file or directory' }))
    const { all } = await snap($, surface)
    expect(all).toContain('No runs in ~/.agent-handoffs/runs')
    expect(all).not.toContain("Can't read")
  })

  test(`${surface}: a home that cannot be listed on the first read shows Can't read, never No runs in`, async ($, on) => {
    await boot($, on, world({}, { listFails: 'EACCES: permission denied, scandir\nsecond line' }))
    const { all } = await snap($, surface)
    expect(all).toContain("Can't read ~/.agent-handoffs/runs: EACCES: permission denied, scandir")
    expect(all).not.toContain('second line')
    expect(all).not.toContain('No runs in')
  })

  test(`${surface}: a home that stops listing keeps the last good rows, and a good tick clears the line`, async ($, on) => {
    const w = world({ a: good('a') })
    const clock = await boot($, on, w)
    w.listFails = 'EACCES: permission denied'
    await clock.advance(5000)
    let all = (await snap($, surface)).all
    expect(all).toContain("Can't read ~/.agent-handoffs/runs: EACCES: permission denied")
    expect(all).toContain('skills · running')
    expect(all).not.toContain('No runs in')
    w.listFails = null
    await clock.advance(5000)
    all = (await snap($, surface)).all
    expect(all).not.toContain("Can't read")
    expect(all).toContain('skills · running')
  })

  test(`${surface}: the engine's own lead is dropped from a Can't read reason`, async ($, on) => {
    await boot($, on, world({}, { listFails: `desk-board: $.fs.list(${RUNS}) failed: EACCES` }))
    const { all } = await snap($, surface)
    expect(all).toContain(`Can't read ~/.agent-handoffs/runs: EACCES`)
    expect(all).not.toContain('desk-board:')
    expect(all).not.toContain('failed:')
  })

  for (const [name, stored] of [['another shape tag', { value: { rows: 1 }, version: 3, shape: 'board-0' }], ['no shape tag', { value: { rows: 1 }, version: 3 }]] as const) {
    test(`${surface}: a value stored with ${name} draws Reading runs…`, async ($, on) => {
      on('state.get', () => ({ value: stored }))
      expect((await snap($, surface)).all).toContain('Reading runs…')
    })
  }
}

const HOMES: [string, Record<string, string>, string][] = [
  ['a relative BORK_RUNS_HOME is ignored', { BORK_RUNS_HOME: 'runs' }, RUNS],
  ['a relative AGENT_HANDOFFS_DIR is ignored', { AGENT_HANDOFFS_DIR: 'rel' }, RUNS],
  ['an absolute AGENT_HANDOFFS_DIR gets /runs', { AGENT_HANDOFFS_DIR: '/data/handoffs' }, '/data/handoffs/runs'],
  ['an absolute BORK_RUNS_HOME wins over AGENT_HANDOFFS_DIR', { BORK_RUNS_HOME: '/data/runs', AGENT_HANDOFFS_DIR: '/data/handoffs' }, '/data/runs'],
]
for (const [name, env, expected] of HOMES) {
  test(`runs home: ${name}`, async ($, on) => {
    const w = world({}, { env })
    await boot($, on, w)
    expect(w.list[0]).toBe(expected)
  })
}

// ---- bad records -------------------------------------------------------------------------------------------

for (const surface of SURFACES) {
  test(`${surface}: one bad record among good ones shows the footer and the good rows`, async ($, on) => {
    await boot($, on, world({ a: good('a'), b: { text: '{' }, c: good('c', { repo: '/code/other' }) }))
    const { all } = await snap($, surface)
    expect(all).toContain('1 run record could not be read')
    expect(all).toContain('skills · running')
    expect(all).toContain('other · running')
  })

  test(`${surface}: two bad records read 2 run records could not be read`, async ($, on) => {
    await boot($, on, world({ a: good('a'), b: { text: '{' }, c: { text: '[]' } }))
    expect((await snap($, surface)).all).toContain('2 run records could not be read')
  })

  test(`${surface}: a run.json read that fails with EACCES is counted, and the other rows still draw`, async ($, on) => {
    await boot($, on, world({ a: good('a'), b: { rec: rec('b'), readFails: 'EACCES: permission denied' } }))
    const { all } = await snap($, surface)
    expect(all).toContain('1 run record could not be read')
    expect(all).toContain('skills · running')
  })

  test(`${surface}: a run.json of 4194305 bytes is counted without a read`, async ($, on) => {
    const w = world({ a: good('a'), b: { rec: rec('b'), size: 4194305 } })
    await boot($, on, w)
    expect((await snap($, surface)).all).toContain('1 run record could not be read')
    expect(w.read.map((p) => p.split('/').at(-2))).toEqual(['a'])
  })

  test(`${surface}: a run dir without run.json is not a run and not counted`, async ($, on) => {
    await boot($, on, world({ a: good('a'), fresh: { noRunJson: true } }))
    const { all } = await snap($, surface)
    expect(all).not.toContain('could not be read')
    expect(all).toContain('In motion · 1')
  })

  test(`${surface}: a stat that rejects on one run dir does not hide the others`, async ($, on) => {
    await boot($, on, world({ a: good('a'), b: { rec: rec('b'), statFails: 'EIO: i/o error' } }))
    const { all } = await snap($, surface)
    expect(all).toContain('In motion · 1')
    expect(all).toContain('1 run record could not be read')
  })

  test(`${surface}: a copied run dir (id differs from the dir name) is bad and makes no second row`, async ($, on) => {
    await boot($, on, world({ a: good('a'), copy: { rec: rec('a') } }))
    const { all, keys } = await snap($, surface)
    expect(all).toContain('1 run record could not be read')
    expect(keys).toEqual(['a'])
  })
}

test('a failed read is not cached: the same stat reads again and the row appears', async ($, on) => {
  const w = world({ a: { rec: rec('a'), readFails: 'EACCES: permission denied' } })
  const clock = await boot($, on, w)
  expect((await snap($, 'terminal')).all).toContain('1 run record could not be read')
  delete w.dirs.a!.readFails
  await clock.advance(5000)
  const { all } = await snap($, 'terminal')
  expect(all).toContain('In motion · 1')
  expect(all).not.toContain('could not be read')
})

for (const name of ['..x', 'a..b', '.hidden', '-x', 'a b']) {
  test(`child dir ${JSON.stringify(name)} is neither a row nor counted`, async ($, on) => {
    const w = world({ ok: good('ok') })
    w.extra = [{ name, kind: 'dir' }]
    await boot($, on, w)
    const { all, keys } = await snap($, 'terminal')
    expect(all).not.toContain('could not be read')
    expect(keys).toEqual(['ok'])
    expect(w.stat.filter((p) => p.startsWith(RUNS))).toEqual([`${RUNS}/ok/run.json`])
  })
}

test('a symlink and a stray file in the runs home are skipped', async ($, on) => {
  const w = world({ ok: good('ok') })
  w.extra = [{ name: 'link', kind: 'other', isLink: true }, { name: 'stray.txt', kind: 'file' }]
  await boot($, on, w)
  const { all, keys } = await snap($, 'terminal')
  expect(all).not.toContain('could not be read')
  expect(keys).toEqual(['ok'])
})

// ---- rows, groups, text ---------------------------------------------------------------------------------------

for (const surface of SURFACES) {
  test(`${surface}: groups carry counts`, async ($, on) => {
    await boot($, on, world({
      n1: asking('n1'), n2: good('n2', { state: 'blocked', summary: 'stuck' }), m1: good('m1'),
      f1: good('f1', { state: 'done', delivery: 'merged' }),
    }))
    const { all } = await snap($, surface)
    expect(all).toContain('Needs you · 2')
    expect(all).toContain('In motion · 1')
    expect(all).toContain('Finished today · 1')
  })

  test(`${surface}: a group with no rows is not drawn`, async ($, on) => {
    await boot($, on, world({ m1: good('m1') }))
    const { all } = await snap($, surface)
    expect(all).toContain('In motion · 1')
    expect(all).not.toContain('Needs you')
    expect(all).not.toContain('Finished')
    expect(all).not.toContain('Yesterday')
  })

  test(`${surface}: a needs-me row shows the last open question undimmed; with none it falls back`, async ($, on) => {
    await boot($, on, world({
      q: asking('q', { questions: [
        { id: 'Q1', question: 'first?', options: [], status: 'open' },
        { id: 'Q2', question: 'second?', options: [], status: 'open' },
      ] }),
      s: asking('s', { questions: [], summary: 'needs a call' }),
      w: asking('w', { questions: [] }),
    }))
    const { texts } = await snap($, surface)
    const byText = (t: string) => texts.find((x) => x.text === t)
    expect(byText('Q2: second?')).toBeDefined()
    expect(byText('Q2: second?')?.props.dimColor).not.toBe(true)
    expect(byText('needs a call')?.props.dimColor).not.toBe(true)
    expect(byText('waiting on you')?.props.dimColor).not.toBe(true)
    expect(texts.some((x) => x.text.includes('Q1: first?'))).toBe(false)
  })

  test(`${surface}: a row without a herdr tab is Text with no tab and no Button`, async ($, on) => {
    await boot($, on, world({ a: good('a', noBtn) }))
    const { all, keys } = await snap($, surface)
    expect(all).toContain('skills · running · no tab')
    expect(keys).toEqual([])
  })

  test(`${surface}: a run is a round card colored by state, its head one plain Button keyed by the dir`, async ($, on) => {
    await boot($, on, world({ 'run-1': good('run-1', { goal: 'Ship the board\nsecond line' }) }))
    const { buttons, texts, boxes } = await snap($, surface)
    const b = buttons.find((x) => x.key === 'run-1')
    expect(b?.props.plain).toBe(true)
    expect(b?.props.variant).toBeUndefined()
    expect(b?.props.hotkey).toBeUndefined()
    expect(b?.props.label).toBe('Go to skills: Ship the board (running, 1m)')
    expect(b?.text).toBe('● skills · running')
    expect(texts.filter((t) => t.text === 'Ship the board')).toHaveLength(1)
    expect(texts.some((t) => t.text === '1m')).toBe(true)
    const card = boxes.find((x) => x.key === 'card-run-1')
    expect(card?.props.borderStyle).toBe('round')
    expect(card?.props.borderColor).toBe('suggestion')
  })

  test(`${surface}: each card's border takes its state's color, and finished cards are dim`, async ($, on) => {
    await boot($, on, world({
      n: asking('n'), b: good('b', { state: 'blocked' }), s: good('s', { updated_at: iso(25 * HOUR) }),
      d: good('d', { state: 'done' }), f: good('f', { state: 'failed' }),
    }))
    const { boxes } = await snap($, surface)
    const card = (k: string) => boxes.find((x) => x.key === `card-${k}`)?.props
    expect(card('n')?.borderColor).toBe('warning')
    expect(card('b')?.borderColor).toBe('error')
    expect(card('s')?.borderColor).toBe('inactive')
    expect(card('d')?.borderColor).toBe('success')
    expect(card('f')?.borderColor).toBe('error')
    expect(card('d')?.borderDimColor).toBe(true)
    expect(card('n')?.borderDimColor).not.toBe(true)
  })

  test(`${surface}: a run finished 24 to 48 h ago is one dim entry on the Yesterday line, not a card`, async ($, on) => {
    await boot($, on, world({
      y: good('y', { state: 'done', delivery: 'merged', updated_at: iso(30 * HOUR) }),
      z: good('z', { ...noBtn, state: 'failed', repo: '/code/zed', updated_at: iso(40 * HOUR) }),
    }))
    const { all, buttons, texts, boxes, keys } = await snap($, surface)
    expect(texts.some((t) => t.text === 'Yesterday')).toBe(true)
    const y = buttons.find((x) => x.key === 'y')
    expect(y?.props.plain).toBe(true)
    expect(y?.props.dimColor).toBe(true)
    expect(y?.text).toBe('✓ skills 30h')
    expect(texts.some((t) => t.text === '✗ zed 40h')).toBe(true)
    expect(keys).toEqual(['y'])
    expect(all).not.toContain('merged')
    expect(boxes.some((x) => x.key?.startsWith('card-'))).toBe(false)
  })

  test(`${surface}: a finished row with a herdr tab is pressable`, async ($, on) => {
    await boot($, on, world({ f: good('f', { state: 'done', delivery: 'merged' }) }))
    expect((await snap($, surface)).keys).toEqual(['f'])
  })

  for (const tab of ['-x', 'w1 t2', '', 'a/b', 123, null]) {
    test(`${surface}: herdr tab ${JSON.stringify(tab)} draws no Button and says no tab`, async ($, on) => {
      await boot($, on, world({ a: good('a', tabOf(tab)) }))
      const { all, keys } = await snap($, surface)
      expect(keys).toEqual([])
      expect(all).toContain('no tab')
    })
  }

  test(`${surface}: a valid tab on another frontend draws no Button`, async ($, on) => {
    await boot($, on, world({ a: good('a', tabOf('w1:t1', 'tmux')) }))
    expect((await snap($, surface)).keys).toEqual([])
  })

  test(`${surface}: control characters never reach the tree, text is cut to 200 and nothing is Markdown`, async ($, on) => {
    const bad = '\u001b[31mred\u0007bell\rreturn'
    await boot($, on, world({
      a: good('a', { goal: `**bold** [x](https://e.com) ${bad}`, summary: `${bad}${'s'.repeat(300)}` }),
      b: asking('b', { questions: [{ id: 'Q1', question: bad + 'q'.repeat(300), options: [], status: 'open' }] }),
    }))
    const { lines, buttons, markdown } = await snap($, surface, 400)
    const everything = [...lines, ...buttons.map((x) => String(x.props.label))]
    for (const t of everything) expect(/[\u0000-\u001f\u007f-\u009f]/.test(t), JSON.stringify(t)).toBe(false)
    expect(markdown).toBeUndefined()
    expect(everything.some((t) => t.includes('**bold** [x](https://e.com)'))).toBe(true)
    expect(everything.some((t) => /^Q1: .*q{150,}/.test(t))).toBe(true)
    expect(everything.some((t) => /s{150,}/.test(t) || /q{150,}/.test(t))).toBe(true)
    expect(everything.every((t) => !/s{201}|q{201}/.test(t))).toBe(true)
  })

  test(`${surface}: records whose repo, summary, delivery or question are not strings do not throw`, async ($, on) => {
    await boot($, on, world({
      a: good('a', { repo: 7, state: 'blocked', summary: { x: 1 } }),
      b: good('b', { repo: { x: 1 }, state: 'done', delivery: 9, summary: [] }),
      c: asking('c', { questions: [{ id: 'Q1', question: { x: 1 }, options: [], status: 'open' }] }),
      d: good('d', { repo: null }),
    }))
    const { all } = await snap($, surface)
    expect(all).toContain('- · running')
    expect(all).toContain('Needs you · 2')
    expect(all).toContain('Finished today · 1')
    expect(all).not.toContain('could not be read')
  })
}

for (const cols of [40, 64]) {
  test(`pane at ${cols} columns: no drawn line is wider than the pane`, async ($, on) => {
    const long = 'long words '.repeat(20)
    await boot($, on, world({
      a: good('a', { goal: long, repo: '/code/' + 'r'.repeat(30) }),
      b: asking('b', { questions: [{ id: 'Q1', question: long, options: [], status: 'open' }] }),
      c: good('c', { state: 'done', delivery: long }),
      d: good('d', { state: 'failed', summary: long }),
      e: good('e', { ...noBtn, goal: long, repo: '/code/' + 'q'.repeat(30) }),
      y: good('y', { state: 'done', repo: '/code/' + 'y'.repeat(60), updated_at: iso(30 * HOUR) }),
    }))
    for (const surface of SURFACES) {
      // A card's border and padding take 4 columns. A wrapping Text (the question) folds instead of overflowing.
      const { texts, buttons } = await snap($, surface, cols)
      const lines = [...texts.filter((t) => t.props.wrap !== 'wrap'), ...buttons].map((x) => x.text)
      expect(lines.length).toBeGreaterThan(6)
      for (const l of lines) expect(Array.from(l).length, l).toBeLessThanOrEqual(cols - 4)
      expect(texts.find((t) => t.text.startsWith('Q1: long words'))?.props.wrap).toBe('wrap')
    }
  })
}

test('the board orders Needs you newest first, In motion oldest created first, Finished and Yesterday newest first and hides past 48 h', async ($, on) => {
  await boot($, on, world({
    n1: asking('n1', { updated_at: iso(3 * HOUR) }),
    n2: asking('n2', { updated_at: iso(MIN) }),
    n3: good('n3', { state: 'blocked', updated_at: iso(2 * HOUR) }),
    m1: good('m1', { created_at: iso(5 * HOUR) }),
    m2: good('m2', { created_at: iso(9 * HOUR) }),
    m3: good('m3', { created_at: iso(7 * HOUR) }),
    f1: good('f1', { state: 'done', updated_at: iso(5 * HOUR) }),
    f2: good('f2', { state: 'failed', updated_at: iso(MIN) }),
    f3: good('f3', { state: 'done', updated_at: iso(25 * HOUR) }),
    f4: good('f4', { state: 'done', updated_at: iso(23 * HOUR + 59 * MIN) }),
    f5: good('f5', { state: 'failed', updated_at: iso(47 * HOUR) }),
    f6: good('f6', { state: 'done', updated_at: iso(49 * HOUR) }),
  }))
  expect((await snap($, 'terminal')).keys).toEqual(['n2', 'n3', 'n1', 'm2', 'm3', 'm1', 'f2', 'f1', 'f4', 'f3', 'f5'])
})

test('ages come from the tick: a clock move with no tick leaves the drawn age', async ($, on) => {
  const w = world({ a: good('a', { updated_at: iso(59e3) }) })
  const clock = await boot($, on, w)
  const age = async () => (await snap($, 'terminal')).texts.some((t) => t.text === 'now') ? 'now' : (await snap($, 'terminal')).texts.some((t) => t.text === '1m') ? '1m' : '?'
  expect(await age()).toBe('now')
  await clock.advance(4000)
  expect(await age()).toBe('now')
  await clock.advance(1000)
  expect(await age()).toBe('1m')
})

// ---- refresh --------------------------------------------------------------------------------------------------------

test('an unchanged tick writes no state', async ($, on) => {
  const w = world({ a: good('a') })
  const clock = await boot($, on, w)
  const first = w.stateSets
  expect(first).toBeGreaterThan(0)
  await clock.advance(5000)
  await clock.advance(5000)
  expect(w.stateSets).toBe(first)
  expect(w.list.length).toBe(3)
})

test('a record whose stat is unchanged is not read again; a changed stat is', async ($, on) => {
  const w = world({ a: good('a') })
  const clock = await boot($, on, w)
  await clock.advance(5000)
  expect(w.read.length).toBe(1)
  w.dirs.a!.mtimeMs = 2
  await clock.advance(5000)
  expect(w.read.length).toBe(2)
})

test('a done record older than 48 h is read once and never again, even after its stat changes', async ($, on) => {
  const w = world({ a: good('a', { state: 'done', updated_at: iso(50 * HOUR) }) })
  const clock = await boot($, on, w)
  expect(w.read.length).toBe(1)
  w.dirs.a!.mtimeMs = 2
  await clock.advance(5000)
  expect(w.read.length).toBe(1)
})

test('a done record on the Yesterday line is read again when its stat changes', async ($, on) => {
  const w = world({ a: good('a', { state: 'done', updated_at: iso(30 * HOUR) }) })
  const clock = await boot($, on, w)
  expect(w.read.length).toBe(1)
  w.dirs.a!.mtimeMs = 2
  await clock.advance(5000)
  expect(w.read.length).toBe(2)
})

test('a run dir deleted between ticks leaves no row', async ($, on) => {
  const w = world({ a: good('a'), b: good('b', { repo: '/code/b' }) })
  const clock = await boot($, on, w)
  delete w.dirs.b
  await clock.advance(5000)
  const { all, keys } = await snap($, 'terminal')
  expect(all).toContain('In motion · 1')
  expect(keys).toEqual(['a'])
})

test('a tick that fails is followed by a tick that runs', async ($, on) => {
  const w = world({ a: good('a') })
  const clock = await boot($, on, w, { surface: null, isInteractive: false })
  w.listFails = 'EIO: i/o error'
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()
  expect((await snap($, 'desktop')).all).toContain("Can't read")
  w.listFails = null
  await clock.advance(5000)
  expect((await snap($, 'desktop')).all).toContain('In motion · 1')
})

test('a tick that throws is followed by a tick that runs (the in-flight mark clears on the failure path)', async ($, on) => {
  const w = world({ a: good('a') }, { stateGetFails: 1 })
  const clock = await boot($, on, w)
  expect((await snap($, 'terminal')).all).toContain('Reading runs…')
  await clock.advance(5000)
  expect((await snap($, 'terminal')).all).toContain('In motion · 1')
})

test('a tick whose fs.list is pending blocks later periods; after 30 s a new tick runs', async ($, on) => {
  const w = world({ a: good('a') })
  let release = () => {}
  w.holdList = new Promise<void>((r) => { release = r })
  const clock = await boot($, on, w)
  await clock.advance(10000)
  expect(w.list.length).toBe(1)
  await clock.advance(25000)
  expect(w.list.length).toBeGreaterThan(1)
  release()
  await clock.settle()
})

test('the late result of an expired tick is discarded: the newer tick\u2019s view and state stay', async ($, on) => {
  const w = world({ a: good('a') })
  let release = () => {}
  w.holdList = new Promise<void>((r) => { release = r })
  const clock = await boot($, on, w)
  // The held tick listed only run a. A run appears; 30 s later a newer tick lists both and publishes.
  w.dirs.b = good('b', { repo: '/code/b' })
  await clock.advance(35000)
  expect((await snap($, 'terminal')).all).toContain('In motion · 2')
  const writes = w.stateSets
  release()
  await clock.settle()
  expect((await snap($, 'terminal')).all).toContain('In motion · 2')
  expect(w.stateSets).toBe(writes)
})

test('session.start then two session.attach polls once per period', async ($, on) => {
  const w = world({ a: good('a') })
  const clock = await boot($, on, w)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  await clock.settle()
  const before = w.list.length
  await clock.advance(5000)
  expect(w.list.length - before).toBe(1)
})

test('a session with no surface never polls until a surface attaches', async ($, on) => {
  const w = world({ a: good('a') })
  const clock = await boot($, on, w, { surface: null, isInteractive: false })
  await clock.advance(15000)
  expect(w.list).toEqual([])
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()
  expect(w.list.length).toBe(1)
})

// A plugin installed or updated mid-session never sees that session's session.start.
for (const surface of SURFACES) {
  test(`${surface}: loaded mid-session, /desk-board starts polling and the pane draws the runs`, async ($, on) => {
    const w = world({ a: good('a') })
    const clock = await boot($, on, w, { surface: undefined, isInteractive: true })
    expect(w.list).toEqual([])
    await runDesk($)
    await clock.settle()
    expect((await snap($, surface)).all).toContain('In motion · 1')
    const before = w.list.length
    await clock.advance(5000)
    expect(w.list.length).toBe(before + 1)
  })

  test(`${surface}: loaded mid-session with the pane left open, /desk-board closes it and still starts polling`, async ($, on) => {
    const w = world({ a: good('a') }, { panes: ['desk-board'] })
    const clock = await boot($, on, w, { surface: undefined, isInteractive: true })
    expect((await snap($, surface)).all).toContain('Reading runs…')
    expect((await runDesk($)).text).toBe('Desk closed.')
    await clock.settle()
    expect((await runDesk($)).text).toBe('Desk opened.')
    expect((await snap($, surface)).all).toContain('In motion · 1')
  })
}

test('/desk-board is registered even with no surface', async ($, on) => {
  const w = world()
  await boot($, on, w, { surface: null, isInteractive: false })
  expect(w.registered).toEqual(['desk-board'])
})

test('the board keeps refreshing after session.end with reason clear', async ($, on) => {
  const w = world({ a: good('a') })
  const clock = await boot($, on, w)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const before = w.list.length
  await clock.advance(5000)
  expect(w.list.length).toBe(before + 1)
})

// ---- the command, the pane and the band -------------------------------------------------------------------------

test('/desk-board opens the pane focused at 56 columns without holdToasts; a second one closes it', async ($, on) => {
  const w = world()
  await boot($, on, w)
  expect((await runDesk($)).text).toBe('Desk opened.')
  expect(w.opened).toEqual([{ id: 'desk-board', title: 'Desk', focus: true, columns: 56 }])
  expect((await runDesk($)).text).toBe('Desk closed.')
  expect(w.panes).toEqual([])
})

test('a pane the engine closed itself lets the band draw and the next /desk-board open it', async ($, on) => {
  const w = world({ n: asking('n') })
  await boot($, on, w)
  await runDesk($)
  expect((await bandSnap($, 'terminal')).yielded).toBe(true)
  w.panes = []
  expect((await bandSnap($, 'terminal')).text).toContain('Desk:')
  expect((await runDesk($)).text).toBe('Desk opened.')
})

test('terminal band: hidden at zero Needs you, then 1 needs you, then 2 need you', async ($, on) => {
  const w = world({ m: good('m'), m2: good('m2', { repo: '/code/b' }) })
  const clock = await boot($, on, w)
  expect((await bandSnap($, 'terminal')).yielded).toBe(true)
  w.dirs.n1 = asking('n1')
  await clock.advance(5000)
  expect((await bandSnap($, 'terminal')).text).toContain('Desk: 1 needs you · 2 in motion')
  w.dirs.n2 = asking('n2')
  await clock.advance(5000)
  expect((await bandSnap($, 'terminal')).text).toContain('Desk: 2 need you · 2 in motion')
})

test('desktop band: draws with any rows, without need you at zero Needs you', async ($, on) => {
  await boot($, on, world({ m: good('m') }))
  const { yielded, text } = await bandSnap($, 'desktop')
  expect(yielded).toBe(false)
  expect(text).toContain('Desk: 1 in motion')
  expect(text).not.toContain('need')
})

test('desktop band: yields when the board has no rows at all', async ($, on) => {
  await boot($, on, world())
  expect((await bandSnap($, 'desktop')).yielded).toBe(true)
})

for (const surface of SURFACES) {
  test(`${surface}: the band yields before the first read`, async ($, on) => {
    await boot($, on, world({ n: asking('n') }), { surface: null, isInteractive: false })
    expect((await bandSnap($, surface)).yielded).toBe(true)
  })

  test(`${surface}: the band yields while a survey holds it`, async ($, on) => {
    await boot($, on, world({ n: asking('n') }))
    expect((await bandSnap($, surface)).yielded).toBe(false)
    expect((await bandSnap($, surface, { hasSurvey: true })).yielded).toBe(true)
  })

  test(`${surface}: the band yields while the pane is open`, async ($, on) => {
    const w = world({ n: asking('n') })
    await boot($, on, w)
    w.panes = ['desk-board']
    expect((await bandSnap($, surface)).yielded).toBe(true)
  })

  test(`${surface}: pressing the band's Open desk opens the pane like /desk-board, with no digit hotkey`, async ($, on) => {
    const w = world({ n: asking('n') })
    await boot($, on, w)
    const ui = await mountBand($, surface)
    const button = await ui.find({ type: 'Button', key: 'open' })
    expect(button?.props.label).toBe('Open desk')
    expect(button?.props.hotkey === undefined || button.props.hotkey === 'd').toBe(true)
    await ui.press({ key: 'open' })
    expect(w.opened).toEqual([{ id: 'desk-board', title: 'Desk', focus: true, columns: 56 }])
  })
}

test('the terminal band does not count this session’s own run, but the pane draws it', async ($, on) => {
  const w = world({ own: asking('own', { architect: { harness: 'claude', session_id: null, frontend: 'herdr', tab: 'w9:t9', pane: 'w9:p9' } }) })
  await boot($, on, w)
  expect((await bandSnap($, 'terminal')).yielded).toBe(true)
  expect((await snap($, 'terminal')).all).toContain('skills · needs you · (this session)')
})

test('with HERDR_PANE_ID unset a run whose architect pane is null is not this session', async ($, on) => {
  const w = world({ n: asking('n', { architect: { harness: 'claude', session_id: null, frontend: null, tab: null, pane: null } }) }, { env: { HERDR_PANE_ID: undefined } })
  await boot($, on, w)
  expect((await bandSnap($, 'terminal')).text).toContain('1 needs you')
})

test('with HERDR_PANE_ID unset no run is this session', async ($, on) => {
  const w = world({ n: asking('n', { architect: {} }) }, { env: { HERDR_PANE_ID: undefined } })
  await boot($, on, w)
  expect((await bandSnap($, 'terminal')).text).toContain('1 needs you')
})

// ---- press ----------------------------------------------------------------------------------------------------------------

const tabbed = (w: World): World => {
  w.dirs.a = good('a')
  return w
}
const argvs = (w: World) => w.process.map((p) => [...p.argv])
const press = async ($: Engine, surface: Surface) => {
  const ui = await mountPane($, surface)
  await ui.press({ key: 'a' })
  await ui.unmount()
}

for (const surface of SURFACES) {
  test(`${surface}: a press runs tab get, workspace focus, tab focus with timeoutMs 5000 and toasts`, async ($, on) => {
    const w = tabbed(world())
    await boot($, on, w)
    await press($, surface)
    expect(argvs(w)).toEqual([[BIN, 'tab', 'get', 'w66:t7'], [BIN, 'workspace', 'focus', 'w66'], [BIN, 'tab', 'focus', 'w66:t7']])
    expect(w.process.every((p) => p.timeoutMs === 5000)).toBe(true)
    expect(w.toasts).toEqual([`Switched herdr to skills (w66:t7)${surface === 'desktop' ? ' — switch to your terminal' : ''}`])
  })

  test(`${surface}: a non-zero exit toasts herdr's error.message and stops`, async ($, on) => {
    const w = tabbed(world())
    w.run = () => ({ exitCode: 1, stderr: '{"error":{"code":"tab_not_found","message":"tab w66:t7 not found"},"id":"cli:tab:get"}' })
    await boot($, on, w)
    await press($, surface)
    expect(w.toasts).toEqual(['Could not switch to skills: tab w66:t7 not found'])
    expect(argvs(w).length).toBe(1)
  })

  test(`${surface}: a stderr that is not JSON gives its first line`, async ($, on) => {
    const w = tabbed(world())
    w.run = () => ({ exitCode: 2, stderr: 'herdr: socket gone\nmore detail' })
    await boot($, on, w)
    await press($, surface)
    expect(w.toasts).toEqual(['Could not switch to skills: herdr: socket gone'])
  })

  test(`${surface}: herdr's message and the repo are stripped of control characters and cut to 120`, async ($, on) => {
    const w = tabbed(world())
    w.dirs.a = good('a', { repo: '/code/sk\u0007ills' })
    w.run = () => ({ exitCode: 1, stderr: JSON.stringify({ error: { message: `\u001b[31m${'m'.repeat(300)}` } }) })
    await boot($, on, w)
    await press($, surface)
    const t = w.toasts[0]!
    expect(/[\u0000-\u001f]/.test(t)).toBe(false)
    expect(t.startsWith('Could not switch to skills: ')).toBe(true)
    expect(t.length).toBe('Could not switch to skills: '.length + 120)
  })

  test(`${surface}: a process.run that rejects at once toasts the manual command`, async ($, on) => {
    const w = tabbed(world())
    w.run = () => 'reject'
    await boot($, on, w)
    await press($, surface)
    expect(w.toasts).toEqual(["Can't switch tabs from here: run herdr tab focus w66:t7"])
    expect(argvs(w).length).toBe(1)
  })

  test(`${surface}: a rejection at the timeout toasts that herdr did not answer`, async ($, on) => {
    const w = tabbed(world())
    w.run = () => 'slow-reject'
    const clock = await boot($, on, w)
    const ui = await mountPane($, surface)
    const pressed = ui.press({ key: 'a' })
    await clock.advance(5000)
    await pressed
    expect(w.toasts).toEqual(['Could not switch to skills: herdr did not answer'])
  })

  test(`${surface}: workspace focus failing stops before tab focus and open`, { options: { terminalApp: 'com.mitchellh.ghostty' } }, async ($, on) => {
    const w = tabbed(world())
    w.run = (argv) => (argv[1] === 'workspace' ? { exitCode: 1, stderr: '{"error":{"message":"workspace w66 not found"}}' } : OK_RUN(argv))
    await boot($, on, w)
    await press($, surface)
    expect(argvs(w).map((a) => a[1])).toEqual(['tab', 'workspace'])
    expect(w.toasts).toEqual(['Could not switch to skills: workspace w66 not found'])
  })

  for (const [name, stdout] of [['not JSON', 'not json'], ['no result', '{}'], ['a flag as workspace id', '{"result":{"tab":{"workspace_id":"-rf"}}}'],
    ['an error body', '{"error":{"code":"tab_not_found","message":"gone"}}'], ['a numeric workspace id', '{"result":{"tab":{"workspace_id":7}}}']] as const) {
    test(`${surface}: tab get exiting 0 with ${name} runs nothing further`, async ($, on) => {
      const w = tabbed(world())
      w.run = () => ({ exitCode: 0, stdout })
      await boot($, on, w)
      await press($, surface)
      expect(argvs(w).length).toBe(1)
      expect(w.toasts).toEqual(['Could not switch to skills: herdr gave no workspace for w66:t7'])
    })
  }
}

test('tab focus failing runs no open even with a terminalApp', { options: { terminalApp: 'com.mitchellh.ghostty' } }, async ($, on) => {
  const w = tabbed(world())
  w.run = (argv) => (argv[1] === 'tab' && argv[2] === 'focus' ? { exitCode: 1, stderr: 'no such tab' } : OK_RUN(argv))
  await boot($, on, w)
  await press($, 'terminal')
  expect(argvs(w).some((a) => a[0] === '/usr/bin/open')).toBe(false)
  expect(w.toasts).toEqual(['Could not switch to skills: no such tab'])
})

test('a tab that does not exist toasts plain text, not JSON', async ($, on) => {
  const w = tabbed(world())
  w.run = () => ({ exitCode: 1, stderr: '{"error":{"code":"tab_not_found","message":"tab w66:t99999 not found"},"id":"cli:tab:get"}' })
  await boot($, on, w)
  await press($, 'terminal')
  expect(w.toasts[0]).toBe('Could not switch to skills: tab w66:t99999 not found')
})

test('the herdr binary is resolved once per session: Homebrew stat made once', async ($, on) => {
  const w = tabbed(world())
  await boot($, on, w)
  await press($, 'terminal')
  await press($, 'terminal')
  expect(w.stat.filter((p) => p === BIN).length).toBe(1)
  expect(argvs(w).every((a) => a[0] === BIN)).toBe(true)
})

test('an absolute HERDR_BIN_PATH wins and no Homebrew path is stat-ed', async ($, on) => {
  const w = tabbed(world({}, { env: { HERDR_BIN_PATH: '/x/herdr' } }))
  await boot($, on, w)
  await press($, 'terminal')
  expect(argvs(w)[0]![0]).toBe('/x/herdr')
  expect(w.stat.filter((p) => p.endsWith('/herdr'))).toEqual([])
})

test('a relative HERDR_BIN_PATH is ignored and herdr falls back to PATH when no known path exists', async ($, on) => {
  const w = tabbed(world({}, { env: { HERDR_BIN_PATH: 'herdr2' }, statExists: [] }))
  await boot($, on, w)
  await press($, 'terminal')
  expect(argvs(w)[0]![0]).toBe('herdr')
  expect(w.stat.filter((p) => p.endsWith('/herdr'))).toEqual([BIN, '/usr/local/bin/herdr'])
})

test('the second Homebrew-style path is used when the first is missing', async ($, on) => {
  const w = tabbed(world({}, { statExists: ['/usr/local/bin/herdr'] }))
  await boot($, on, w)
  await press($, 'terminal')
  expect(argvs(w)[0]![0]).toBe('/usr/local/bin/herdr')
})

test('terminalApp adds /usr/bin/open -b as the fourth argv and drops the switch-your-terminal tail', { options: { terminalApp: 'com.mitchellh.ghostty' } }, async ($, on) => {
  const w = tabbed(world())
  await boot($, on, w)
  await press($, 'desktop')
  expect(argvs(w).at(-1)).toEqual(['/usr/bin/open', '-b', 'com.mitchellh.ghostty'])
  expect(argvs(w).length).toBe(4)
  expect(w.process.at(-1)?.timeoutMs).toBe(5000)
  expect(w.toasts).toEqual(['Switched herdr to skills (w66:t7)'])
})

for (const bad of ['-a', 'com.x y', 'com.x;rm', '.com', '']) {
  test(`terminalApp ${JSON.stringify(bad)} runs no open and desktop says to switch to the terminal`, { options: { terminalApp: bad } }, async ($, on) => {
    const w = tabbed(world())
    await boot($, on, w)
    await press($, 'desktop')
    expect(argvs(w).some((a) => a[0] === '/usr/bin/open')).toBe(false)
    expect(w.toasts[0]!.endsWith(' — switch to your terminal')).toBe(true)
  })
}

test('the default terminalApp is empty: a terminal press adds no open', async ($, on) => {
  const w = tabbed(world())
  await boot($, on, w)
  await press($, 'terminal')
  expect(argvs(w).length).toBe(3)
  expect(w.toasts[0]).toBe('Switched herdr to skills (w66:t7)')
})
