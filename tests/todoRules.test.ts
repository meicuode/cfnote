import { describe, it, expect } from 'vitest'
import {
  parseUtc, toIso, addMonths, addWorkdays, shiftLocal, computeRemindAt, nextDueAt,
  todoBucket, dueAction, fmtDue, fmtSpan, describeGap, countWorkdays,
  resolveChannels, parseChannels, serializeChannels,
  OVERDUE_MAX_REMINDS, TIME_UNITS, UNIT_LABEL, DEFAULT_LEAD,
} from '../src/lib/todoRules'

const TZ = 480      // UTC+8
const HOUR = 3_600_000
const DAY = 86_400_000

describe('parseUtc', () => {
  it('ISO 与 D1 空格格式都按 UTC 解析', () => {
    expect(parseUtc('2026-08-10T09:00:00Z')).toBe(Date.parse('2026-08-10T09:00:00Z'))
    // D1 的 datetime('now') 没有时区后缀,但语义是 UTC;当成本地时间读会整体偏移一个时区
    expect(parseUtc('2026-08-10 09:00:00')).toBe(Date.parse('2026-08-10T09:00:00Z'))
  })

  it('带显式偏移的原样尊重,不再补 Z', () => {
    expect(parseUtc('2026-08-10T17:00:00+08:00')).toBe(Date.parse('2026-08-10T09:00:00Z'))
  })

  it('空值与坏值给 null 而不是 NaN', () => {
    expect(parseUtc(null)).toBeNull()
    expect(parseUtc(undefined)).toBeNull()
    expect(parseUtc('')).toBeNull()
    expect(parseUtc('   ')).toBeNull()
    expect(parseUtc('明天')).toBeNull()
  })
})

describe('toIso', () => {
  it('输出秒级,不带毫秒', () => {
    expect(toIso(Date.parse('2026-08-10T09:00:00.456Z'))).toBe('2026-08-10T09:00:00Z')
  })
})

describe('addMonths(溢出夹到月末)', () => {
  it('1 月 31 日 + 1 个月 = 2 月末,不是 3 月初', () => {
    // 滚到 3 月 3 日的话,「每月最后一天」这种周期会越滚越靠后,几个月后跑到月中
    expect(toIso(addMonths(Date.parse('2026-01-31T09:00:00Z'), 1))).toBe('2026-02-28T09:00:00Z')
  })

  it('闰年的 2 月末取 29 日', () => {
    expect(toIso(addMonths(Date.parse('2028-01-31T09:00:00Z'), 1))).toBe('2028-02-29T09:00:00Z')
  })

  it('跨年往后与往前都对', () => {
    expect(toIso(addMonths(Date.parse('2026-12-15T09:00:00Z'), 1))).toBe('2027-01-15T09:00:00Z')
    expect(toIso(addMonths(Date.parse('2026-01-15T09:00:00Z'), -1))).toBe('2025-12-15T09:00:00Z')
  })

  it('月末往前也夹住(3 月 31 日 - 1 个月)', () => {
    expect(toIso(addMonths(Date.parse('2026-03-31T09:00:00Z'), -1))).toBe('2026-02-28T09:00:00Z')
  })

  it('时刻保持不变', () => {
    expect(toIso(addMonths(Date.parse('2026-03-10T23:45:00Z'), 2))).toBe('2026-05-10T23:45:00Z')
  })
})

describe('addWorkdays(跳过周末)', () => {
  // 2026-08-10 是周一
  const mon = Date.parse('2026-08-10T09:00:00Z')

  it('周一 + 5 个工作日 = 下周一', () => {
    expect(toIso(addWorkdays(mon, 5))).toBe('2026-08-17T09:00:00Z')
  })

  it('周五 + 1 = 下周一(跳过周末)', () => {
    const fri = Date.parse('2026-08-14T09:00:00Z')
    expect(toIso(addWorkdays(fri, 1))).toBe('2026-08-17T09:00:00Z')
  })

  it('往前数也跳周末:周一 - 1 = 上周五', () => {
    expect(toIso(addWorkdays(mon, -1))).toBe('2026-08-07T09:00:00Z')
  })

  it('周一 - 3 = 上周三', () => {
    expect(toIso(addWorkdays(mon, -3))).toBe('2026-08-05T09:00:00Z')
  })

  it('n=0 原样返回', () => {
    expect(addWorkdays(mon, 0)).toBe(mon)
  })

  it('从周六出发往后数,第一个工作日是周一', () => {
    const sat = Date.parse('2026-08-15T09:00:00Z')
    expect(toIso(addWorkdays(sat, 1))).toBe('2026-08-17T09:00:00Z')
  })
})

describe('shiftLocal', () => {
  const base = Date.parse('2026-08-10T09:00:00Z')

  it('各单位往后平移', () => {
    expect(toIso(shiftLocal(base, { n: 3, unit: 'hour' }, 1))).toBe('2026-08-10T12:00:00Z')
    expect(toIso(shiftLocal(base, { n: 2, unit: 'day' }, 1))).toBe('2026-08-12T09:00:00Z')
    expect(toIso(shiftLocal(base, { n: 1, unit: 'week' }, 1))).toBe('2026-08-17T09:00:00Z')
    expect(toIso(shiftLocal(base, { n: 1, unit: 'month' }, 1))).toBe('2026-09-10T09:00:00Z')
  })

  it('dir=-1 是提前量', () => {
    expect(toIso(shiftLocal(base, { n: 2, unit: 'day' }, -1))).toBe('2026-08-08T09:00:00Z')
  })

  it('n 为 0 / 负 / 坏值一律不平移', () => {
    expect(shiftLocal(base, { n: 0, unit: 'day' }, 1)).toBe(base)
    expect(shiftLocal(base, { n: -5, unit: 'day' }, 1)).toBe(base)
    expect(shiftLocal(base, { n: NaN, unit: 'day' }, 1)).toBe(base)
  })
})

describe('computeRemindAt(截止 + 提前量)', () => {
  it('提前 2 小时', () => {
    expect(computeRemindAt('2026-08-10T09:00:00Z', { n: 2, unit: 'hour' }, TZ)).toBe('2026-08-10T07:00:00Z')
  })

  it('提前量为空则提醒时间等于截止时间', () => {
    expect(computeRemindAt('2026-08-10T09:00:00Z', null, TZ)).toBe('2026-08-10T09:00:00Z')
  })

  it('没有截止时间就没有提醒时间', () => {
    expect(computeRemindAt(null, { n: 1, unit: 'day' }, TZ)).toBeNull()
    expect(computeRemindAt('乱填', { n: 1, unit: 'day' }, TZ)).toBeNull()
  })

  it('工作日按本地历法数,不按 UTC —— 这是时区最容易差一天的地方', () => {
    // 本地(UTC+8)周一 06:00 = UTC 周日 22:00。
    // 按 UTC 数的话出发点落在周日,会把周日当成"要跳过的那天",结果差一整天。
    // 本地周一 06:00 提前 1 个工作日 → 本地上周五 06:00 = UTC 上周四 22:00
    expect(computeRemindAt('2026-08-09T22:00:00Z', { n: 1, unit: 'workday' }, TZ))
      .toBe('2026-08-06T22:00:00Z')
  })

  it('tz=0 时本地即 UTC', () => {
    expect(computeRemindAt('2026-08-10T09:00:00Z', { n: 1, unit: 'workday' }, 0)).toBe('2026-08-07T09:00:00Z')
  })
})

describe('nextDueAt(周期任务)', () => {
  it('按周期往后推一次', () => {
    expect(nextDueAt('2026-08-10T09:00:00Z', { n: 1, unit: 'week' }, TZ)).toBe('2026-08-17T09:00:00Z')
    expect(nextDueAt('2026-01-31T09:00:00Z', { n: 1, unit: 'month' }, TZ)).toBe('2026-02-28T09:00:00Z')
  })

  it('没有周期规则就没有下一次', () => {
    expect(nextDueAt('2026-08-10T09:00:00Z', null, TZ)).toBeNull()
    expect(nextDueAt('2026-08-10T09:00:00Z', { n: 0, unit: 'week' }, TZ)).toBeNull()
  })

  it('没有截止时间也就无从推算', () => {
    expect(nextDueAt(null, { n: 1, unit: 'week' }, TZ)).toBeNull()
  })
})

describe('todoBucket', () => {
  const now = Date.parse('2026-08-10T12:00:00Z')

  it('已完成优先:做完了就不算逾期', () => {
    // 反过来的话,逾期之后再点完成,它仍然挂在「已逾期」里,看着像没生效
    expect(todoBucket({ status: 'done', due_at: '2026-08-01T00:00:00Z' }, now)).toBe('done')
  })

  it('过了截止是逾期,没过是待办', () => {
    expect(todoBucket({ status: 'pending', due_at: '2026-08-10T11:59:00Z' }, now)).toBe('overdue')
    expect(todoBucket({ status: 'pending', due_at: '2026-08-10T12:01:00Z' }, now)).toBe('pending')
  })

  it('无截止时间永远是待办,不会自己变逾期', () => {
    expect(todoBucket({ status: 'pending', due_at: null }, now)).toBe('pending')
  })
})

describe('dueAction(cron 的全部判断)', () => {
  const now = Date.parse('2026-08-10T12:00:00Z')

  it('已完成永不提醒', () => {
    expect(dueAction({ status: 'done', due_at: '2026-08-01T00:00:00Z', overdue_reminds: 0 }, now).kind).toBe('none')
  })

  it('到了提醒时间且没推过 → 推一次提前提醒', () => {
    expect(dueAction({ status: 'pending', due_at: '2026-08-11T09:00:00Z', remind_at: '2026-08-10T09:00:00Z' }, now))
      .toEqual({ kind: 'remind', reason: 'upcoming' })
  })

  it('提醒时间还没到 → 不推', () => {
    expect(dueAction({ status: 'pending', due_at: '2026-08-12T09:00:00Z', remind_at: '2026-08-11T09:00:00Z' }, now).kind).toBe('none')
  })

  it('提前提醒已经推过 → 不重复推', () => {
    expect(dueAction({
      status: 'pending', due_at: '2026-08-11T09:00:00Z',
      remind_at: '2026-08-10T09:00:00Z', reminded_at: '2026-08-10T09:05:00Z',
    }, now).kind).toBe('none')
  })

  it('逾期第一次:即使提前提醒已经推过也要推 —— 最容易写错的一处', () => {
    // 若沿用「reminded_at IS NULL 才推」那条件,逾期提醒永远不会发生:
    // 提前提醒推完 reminded_at 就有值了。而这个错误完全静默——到点之后再没有任何消息
    expect(dueAction({
      status: 'pending', due_at: '2026-08-10T11:00:00Z',
      remind_at: '2026-08-10T09:00:00Z', reminded_at: '2026-08-10T09:05:00Z',
      overdue_reminds: 0,
    }, now)).toEqual({ kind: 'remind', reason: 'overdue', nth: 1 })
  })

  it('逾期第一次不等 24 小时', () => {
    // 等的话「到点了」这条消息要隔一天才来,那时人已经错过了
    expect(dueAction({
      status: 'pending', due_at: '2026-08-10T11:59:00Z',
      reminded_at: '2026-08-10T11:00:00Z', overdue_reminds: 0,
    }, now)).toEqual({ kind: 'remind', reason: 'overdue', nth: 1 })
  })

  it('逾期第二次要隔满一天', () => {
    expect(dueAction({
      status: 'pending', due_at: '2026-08-09T00:00:00Z',
      reminded_at: '2026-08-10T06:00:00Z', overdue_reminds: 1,
    }, now).kind).toBe('none')
    expect(dueAction({
      status: 'pending', due_at: '2026-08-09T00:00:00Z',
      reminded_at: '2026-08-09T06:00:00Z', overdue_reminds: 1,
    }, now)).toEqual({ kind: 'remind', reason: 'overdue', nth: 2 })
  })

  it('推满两次就永久停下', () => {
    expect(dueAction({
      status: 'pending', due_at: '2026-08-01T00:00:00Z',
      reminded_at: '2026-08-05T06:00:00Z', overdue_reminds: OVERDUE_MAX_REMINDS,
    }, now).kind).toBe('none')
    // 拖再久也不再响:通知疲劳会把**其他**待办的提醒一起废掉
    expect(dueAction({
      status: 'pending', due_at: '2026-01-01T00:00:00Z',
      reminded_at: '2026-01-03T06:00:00Z', overdue_reminds: 9,
    }, now).kind).toBe('none')
  })

  it('无截止无提醒 → 永不推(纯记事用法)', () => {
    expect(dueAction({ status: 'pending', due_at: null, remind_at: null }, now).kind).toBe('none')
  })

  it('有截止但没设提醒时间,到点后仍会走逾期提醒', () => {
    expect(dueAction({ status: 'pending', due_at: '2026-08-10T11:00:00Z', remind_at: null, overdue_reminds: 0 }, now))
      .toEqual({ kind: 'remind', reason: 'overdue', nth: 1 })
  })
})

describe('fmtSpan / describeGap / countWorkdays（P18.2 填表时的即时反馈）', () => {
  const now = Date.parse('2026-08-10T12:00:00Z')   // 周一

  it('fmtSpan 取最大量级 + 一位余数', () => {
    expect(fmtSpan(3 * DAY)).toBe('3 天')
    expect(fmtSpan(3 * DAY + 5 * HOUR)).toBe('3 天 5 小时')
    expect(fmtSpan(5 * HOUR)).toBe('5 小时')
    expect(fmtSpan(5 * HOUR + 20 * 60000)).toBe('5 小时 20 分钟')
    expect(fmtSpan(20 * 60000)).toBe('20 分钟')
  })

  it('fmtSpan 不足一分钟也说 1 分钟,不说 0', () => {
    expect(fmtSpan(30_000)).toBe('1 分钟')
    expect(fmtSpan(0)).toBe('1 分钟')
  })

  it('countWorkdays 跳过周末,不含起点当天', () => {
    // 周一 → 周五：二三四五 = 4 个
    expect(countWorkdays(Date.parse('2026-08-10T00:00:00Z'), Date.parse('2026-08-14T23:59:00Z'))).toBe(4)
    // 周五 → 下周一：只有下周一 = 1 个（周末跳过）
    expect(countWorkdays(Date.parse('2026-08-14T00:00:00Z'), Date.parse('2026-08-17T23:59:00Z'))).toBe(1)
  })

  it('countWorkdays 终点早于起点给 0,不给负数', () => {
    expect(countWorkdays(now, now - DAY)).toBe(0)
    expect(countWorkdays(now, now)).toBe(0)
  })

  it('describeGap 给多个维度,第一个永远是自然时长', () => {
    // 这正是加它的理由：跨周末时「3 天」与「2 个工作日」差出一整天
    const g = describeGap('2026-08-13T12:00:00Z', now, 0)
    expect(g[0]).toBe('3 天')
    expect(g).toContain('3 个工作日')
  })

  it('describeGap 跨周末时工作日明显少于自然日', () => {
    // 周一 → 下周一：7 天，但只有 5 个工作日
    const g = describeGap('2026-08-17T12:00:00Z', now, 0)
    expect(g[0]).toBe('7 天')
    expect(g).toContain('5 个工作日')
  })

  it('describeGap 不足一天时不提工作日（「0 个工作日」是废话）', () => {
    const g = describeGap('2026-08-10T18:00:00Z', now, 0)
    expect(g).toEqual(['6 小时'])
  })

  it('describeGap 超过一周才给周数', () => {
    expect(describeGap('2026-08-13T12:00:00Z', now, 0).some((s) => s.includes('周'))).toBe(false)
    expect(describeGap('2026-09-10T12:00:00Z', now, 0).some((s) => s.includes('周'))).toBe(true)
  })

  it('describeGap 已过截止说「已过去」', () => {
    expect(describeGap('2026-08-08T12:00:00Z', now, 0)).toEqual(['已过去 2 天'])
  })

  it('describeGap 没有截止时间给空数组', () => {
    expect(describeGap(null, now, 0)).toEqual([])
    expect(describeGap('乱填', now, 0)).toEqual([])
  })
})

describe('分钟维度（P18.2）', () => {
  it('minute 参与平移', () => {
    const base = Date.parse('2026-08-10T09:00:00Z')
    expect(toIso(shiftLocal(base, { n: 30, unit: 'minute' }, -1))).toBe('2026-08-10T08:30:00Z')
  })

  it('提前 30 分钟算得出提醒时间', () => {
    expect(computeRemindAt('2026-08-10T09:00:00Z', { n: 30, unit: 'minute' }, TZ)).toBe('2026-08-10T08:30:00Z')
  })

  it('minute 在单位白名单里,且排在最前(最细的粒度)', () => {
    expect(TIME_UNITS[0]).toBe('minute')
    expect(UNIT_LABEL.minute).toBe('分钟')
  })

  it('默认提前量是 30 分钟', () => {
    // 默认 0（到点才提醒）意味着「提醒」与「已经晚了」同时发生，那时来不及做任何事
    expect(DEFAULT_LEAD).toEqual({ n: 30, unit: 'minute' })
    expect(computeRemindAt('2026-08-10T09:00:00Z', DEFAULT_LEAD, TZ)).toBe('2026-08-10T08:30:00Z')
  })
})

describe('推送渠道的选择（P18.3）', () => {
  const CH = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: true },
    { id: 'c', enabled: false },   // 配了但没启用
  ]

  it('null = 跟随全部已启用（不是当时那几个的快照）', () => {
    // 存快照的话，以后新加的渠道不会自动纳入，而人不会回头去逐条勾
    expect(resolveChannels(null, CH).map((c) => c.id)).toEqual(['a', 'b'])
    expect(resolveChannels(undefined, CH).map((c) => c.id)).toEqual(['a', 'b'])
    expect(resolveChannels([], CH).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('指定了就只发那几个，且仍要过「已启用」这一关', () => {
    expect(resolveChannels(['a'], CH).map((c) => c.id)).toEqual(['a'])
    // c 被停用了，选中也不发
    expect(resolveChannels(['a', 'c'], CH).map((c) => c.id)).toEqual(['a'])
  })

  it('选中的渠道全被停用 → 空数组，而不是回落到其他渠道', () => {
    // 回落看着更"安全"，实际是拿一个人没选的渠道去发他的私事，
    // 而这条待办恰恰是他亲手指定过渠道的，说明他在意发到哪里。
    // 静默不发同样不可接受，所以推送侧要据此写日志 + 界面上标红
    expect(resolveChannels(['c'], CH)).toEqual([])
    expect(resolveChannels(['不存在的id'], CH)).toEqual([])
  })

  it('一个渠道都没配时给空数组', () => {
    expect(resolveChannels(null, [])).toEqual([])
    expect(resolveChannels(['a'], [])).toEqual([])
  })

  it('parseChannels 认得 JSON 数组，坏值一律当「跟随全部」', () => {
    expect(parseChannels('["a","b"]')).toEqual(['a', 'b'])
    // 坏值不该导致「不提醒」——宁可发给全部，也不要因为一个坏字段就静默
    expect(parseChannels(null)).toBeNull()
    expect(parseChannels('')).toBeNull()
    expect(parseChannels('不是 JSON')).toBeNull()
    expect(parseChannels('{"a":1}')).toBeNull()
    expect(parseChannels('[]')).toBeNull()
    expect(parseChannels('[1,2,null]')).toBeNull()
  })

  it('serializeChannels 把「全选」收敛成 null', () => {
    // 全选存成 ["a","b"] 的话，以后新加渠道 d，这条待办不会发给 d——
    // 而人当初勾的是"全部"，不是"a 和 b"
    expect(serializeChannels(['a', 'b'], ['a', 'b'])).toBeNull()
    expect(serializeChannels(null, ['a', 'b'])).toBeNull()
    expect(serializeChannels([], ['a', 'b'])).toBeNull()
  })

  it('serializeChannels 只存仍然启用的那几个', () => {
    expect(serializeChannels(['a'], ['a', 'b'])).toBe('["a"]')
    // 选了个已经不存在的，过滤后为空 → 当作「跟随全部」而不是存一个死 id
    expect(serializeChannels(['已删除'], ['a', 'b'])).toBeNull()
  })
})

describe('fmtDue', () => {
  const now = Date.parse('2026-08-10T12:00:00Z')

  it('未到与已过分别说人话', () => {
    expect(fmtDue('2026-08-13T12:00:00Z', now)).toBe('还有 3 天')
    expect(fmtDue('2026-08-10T15:00:00Z', now)).toBe('还有 3 小时')
    expect(fmtDue('2026-08-10T12:20:00Z', now)).toBe('还有 20 分钟')
    expect(fmtDue('2026-08-08T12:00:00Z', now)).toBe('已逾期 2 天')
    expect(fmtDue('2026-08-10T10:00:00Z', now)).toBe('已逾期 2 小时')
  })

  it('不足一分钟也显示 1 分钟,不显示 0', () => {
    expect(fmtDue('2026-08-10T12:00:30Z', now)).toBe('还有 1 分钟')
  })

  it('无截止时间', () => {
    expect(fmtDue(null, now)).toBe('无截止')
  })
})
