import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

import type { Counts, Limit, Meter, Snapshot } from '../types'

const PANE = 'token-meter'
const ZERO: Counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const EMPTY: Meter = {
  total: ZERO,
  pending: ZERO,
  last: null,
  model: null,
  turns: 0,
  snapshot: null,
}

// Change the tag when Meter's fields change: it declines what an earlier
// version stored, which outlives a reload.
const meter = atom({ plugin: 'token-meter', key: 'meter' } as const, EMPTY, {
  shape: 'meter-1',
})
const isQuiet = atom({ plugin: 'token-meter', key: 'isQuiet' } as const, false)

const add = (a: Counts, b: Counts): Counts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

const sum = (c: Counts): number =>
  c.input + c.output + c.cacheRead + c.cacheWrite

/** 950 -> "950", 12345 -> "1.2万", 123456789 -> "1.2亿". */
const short = (n: number): string => {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`

  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const limitName = (kind: string): string => {
  if (kind === 'five_hour') return '5小时额度'
  if (kind === 'seven_day') return '每周额度'
  if (kind.startsWith('seven_day_')) return `每周额度(${kind.slice(10)})`
  if (kind === 'spend_limit') return '消费额度'

  return kind
}

const resetIn = (resetsAt: string | undefined, now: number): string => {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) return ''
  const minutes = Math.round((at - now) / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `，约 ${days}天${hours}小时后重置`
  if (hours > 0) return `，约 ${hours}小时${minutes % 60}分后重置`

  return `，约 ${Math.max(1, minutes)}分钟后重置`
}

const bar = (percent: number): string => {
  const filled = Math.min(10, Math.max(0, Math.round(percent / 10)))

  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

const breakdown = (c: Counts): string =>
  `输入 ${short(c.input + c.cacheWrite)} · 输出 ${short(c.output)} · 缓存读取 ${short(c.cacheRead)}`

const toSnapshot = (usage: SessionUsage, readAt: number): Snapshot => {
  const limits: Limit[] = usage.rateLimits.map(one =>
    one.resetsAt === undefined
      ? { kind: one.kind, percentUsed: one.percentUsed }
      : { kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt },
  )
  const snapshot: Snapshot = {
    contextWindow: usage.context.window,
    limits,
    readAt,
  }
  if (usage.context.tokens !== undefined) {
    snapshot.contextTokens = usage.context.tokens
  }
  if (usage.context.percent !== undefined) {
    snapshot.contextPercent = usage.context.percent
  }
  if (usage.cost !== undefined) snapshot.usd = usage.cost.usd

  return snapshot
}

/** The short tail both the per-turn line and the status line end with. */
const tail = (snapshot: Snapshot | null): string => {
  if (snapshot === null) return ''
  const parts: string[] = []
  if (snapshot.contextPercent !== undefined) {
    parts.push(`上下文 ${snapshot.contextPercent}%`)
  }
  for (const one of snapshot.limits) {
    parts.push(`${limitName(one.kind)} ${one.percentUsed}%`)
  }

  return parts.length === 0 ? '' : ` ｜ ${parts.join(' · ')}`
}

const turnLine = (m: Meter): string =>
  `Token 本轮 ${short(sum(m.last ?? ZERO))}（${breakdown(m.last ?? ZERO)}）${tail(m.snapshot)}`

const statusLine = (m: Meter): string =>
  `Token 累计 ${short(sum(m.total))}${tail(m.snapshot)}`

/** The full report, one string per row: the command's text and the pane's. */
const report = (m: Meter, quiet: boolean, now: number): string[] => {
  const rows = ['Token 用量（本次对话）', '']
  if (m.last !== null) {
    rows.push(`本轮合计 ${short(sum(m.last))}`, `  ${breakdown(m.last)}`)
  }
  rows.push(
    `累计合计 ${short(sum(m.total))}（共 ${m.turns} 轮）`,
    `  ${breakdown(m.total)}`,
  )
  const snapshot = m.snapshot
  if (snapshot !== null) {
    rows.push('')
    if (snapshot.contextPercent !== undefined) {
      const used =
        snapshot.contextTokens === undefined
          ? ''
          : `（${short(snapshot.contextTokens)} / ${short(snapshot.contextWindow)}）`
      rows.push(
        `上下文占用 ${bar(snapshot.contextPercent)} ${snapshot.contextPercent}%${used}`,
      )
    }
    for (const one of snapshot.limits) {
      rows.push(
        `${limitName(one.kind)} ${bar(one.percentUsed)} 已用 ${one.percentUsed}%${resetIn(one.resetsAt, now)}`,
      )
    }
    if (snapshot.usd !== undefined) {
      rows.push(
        `按 API 标价折算约 $${snapshot.usd.toFixed(2)}（订阅用户不会因此另外扣费）`,
      )
    }
  }
  if (m.model !== null) rows.push(`当前模型 ${m.model}`)
  rows.push(
    '',
    `每轮结束后的用量提示：${quiet ? '已关闭' : '已开启'}`,
    '/tokens off 关闭提示 · /tokens on 打开提示 · /tokens panel 打开面板',
  )

  return rows
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: '查看 token 用量：本轮、累计、上下文占用和订阅额度',
      argumentHint: '[on|off|panel]',
    })
    const m = await read($, meter)
    if (m.turns > 0) $.ui.status(statusLine(m))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const spent = e.usage
    const isMain = e.agentId === undefined

    if (spent !== undefined) {
      const counts: Counts = {
        input: spent.input_tokens,
        output: spent.output_tokens,
        cacheRead: spent.cache_read_input_tokens,
        cacheWrite: spent.cache_creation_input_tokens,
      }
      await update($, meter, m => ({
        ...m,
        total: add(m.total, counts),
        pending: add(m.pending, counts),
        model: isMain ? spent.model : m.model,
      }))
    }

    // A subagent's run is counted above and shown with the turn it ran in.
    if (!isMain) return done

    const snapshot = toSnapshot(await $.session.usage(), await $.clock.now())
    const m = await update($, meter, old => ({
      ...old,
      last: old.pending,
      pending: ZERO,
      turns: old.turns + 1,
      snapshot,
    }))
    $.ui.status(statusLine(m))

    if (sum(m.last ?? ZERO) === 0 || (await read($, isQuiet))) return done

    const line = turnLine(m)

    return { ...done, text: done.text === e.answer ? line : `${done.text}\n${line}` }
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === '关') {
      await update($, isQuiet, () => true)

      return { text: '已关闭每轮结束后的 token 用量提示。输入 /tokens on 可重新打开。' }
    }

    if (arg === 'on' || arg === '开') {
      await update($, isQuiet, () => false)

      return { text: '已打开每轮结束后的 token 用量提示。' }
    }

    const now = await $.clock.now()
    const snapshot = toSnapshot(await $.session.usage(), now)
    const m = await update($, meter, old => ({ ...old, snapshot }))

    if (arg === 'panel' || arg === '面板') {
      const opened = await $.ui.open({ id: PANE, title: 'Token 用量' })

      return {
        text: opened.isPlaced
          ? '已打开 Token 用量面板。'
          : '这个界面暂时放不下面板，下面是文字版：\n' +
            report(m, await read($, isQuiet), now).join('\n'),
      }
    }

    return { text: report(m, await read($, isQuiet), now).join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const m = await read($, meter)
    const rows = report(m, await read($, isQuiet), await $.clock.now())

    return (
      <Box flexDirection="column">
        {rows.map((row, index) => (
          <Text bold={index === 0} dimColor={row.startsWith('/tokens')}>
            {row === '' ? ' ' : row}
          </Text>
        ))}
      </Box>
    )
  })
}
