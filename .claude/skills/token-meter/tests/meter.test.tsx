import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const NOW = Date.parse('2026-11-10T10:00:00Z')

const USAGE: SessionUsage = {
  startedAt: NOW,
  context: { tokens: 82_000, window: 200_000, percent: 41 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-11-10T12:15:00Z' },
    { kind: 'seven_day', percentUsed: 8, resetsAt: '2026-11-13T10:00:00Z' },
  ],
  cost: { usd: 0.42 },
}

const PANE = {
  plugin: 'token-meter',
  component: 'Pane',
  requestId: 'token-meter',
  props: {
    title: 'Token 用量',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** Stands for the engine beneath the plugin; returns the status lines set. */
const world = (on: On): string[] => {
  const status: string[] = []
  mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.status', (_, e) => {
    status.push(e.text ?? '')

    return { value: undefined }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return status
}

const turn = (id: string, output: number, agentId?: string) => ({
  answer: 'done',
  durationMs: 1000,
  isAborted: false,
  turnId: id,
  reason: 'answer' as const,
  ...(agentId === undefined ? {} : { agentId }),
  usage: {
    input_tokens: 2,
    output_tokens: output,
    cache_read_input_tokens: 78_912,
    cache_creation_input_tokens: 2_030,
    model: 'test-model',
  },
})

const run = (args = '') => ({
  command: 'tokens',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 80 },
})

test('a turn shows its tokens, the context and the limits', async ($, on) => {
  const status = world(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })

  const done = await $.turn.complete(turn('t1', 1_296))

  // 2 + 1,296 + 78,912 + 2,030 = 82,240
  expect(done.text).toBe(
    'Token 本轮 8.2万（输入 2,032 · 输出 1,296 · 缓存读取 7.9万） ｜ 上下文 41% · 5小时额度 23% · 每周额度 8%',
  )
  expect(status.at(-1)).toBe(
    'Token 累计 8.2万 ｜ 上下文 41% · 5小时额度 23% · 每周额度 8%',
  )
})

test('a subagent counts toward the turn it ran in, and the total', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })

  const sub = await $.turn.complete(turn('s1', 704, 'agent-1'))
  expect(sub.text).toBe('done')

  await $.turn.complete(turn('t1', 1_296))
  await $.turn.complete(turn('t2', 296))
  const { text = '' } = await $.command.run(run())

  // last turn: 2 + 296 + 78,912 + 2,030 = 81,240; all three: 245,240
  expect(text).toContain('本轮合计 8.1万')
  expect(text).toContain('累计合计 24.5万（共 2 轮）')
  expect(text).toContain('上下文占用 ████░░░░░░ 41%（8.2万 / 20.0万）')
  expect(text).toContain('5小时额度 ██░░░░░░░░ 已用 23%，约 2小时15分后重置')
  expect(text).toContain('每周额度 █░░░░░░░░░ 已用 8%，约 3天0小时后重置')
  expect(text).toContain('$0.42')
})

test('/tokens off silences the line and /tokens on restores it', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })

  await $.command.run(run('off'))
  expect((await $.turn.complete(turn('t1', 1_296))).text).toBe('done')

  await $.command.run(run('on'))
  expect((await $.turn.complete(turn('t2', 1_296))).text).toContain('Token 本轮')
})

test('the pane draws the report on every surface', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  await $.turn.complete(turn('t1', 1_296))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /累计合计 8\.2万/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5小时额度/ })).toBeDefined()
    await ui.unmount()
  }
})
